/**
 * Resource-lifetime integration: `Disposable` + `Pool` + `BoundingVolume` cache
 * invalidation, wired the way the library wires them.
 *
 * The `Cache` / `LoaderManager` classes the `src/assets` layer was specified to
 * own **do not exist yet** (see `docs/architecture/resource-lifetimes.md`), so this
 * file pins the cross-layer lifetime contract that *is* implemented and that the
 * asset layer will have to satisfy:
 *
 * ```
 * Disposable.addDisposables(child)     -> one owner releases the whole tree
 * Disposable.addDisposeCallback(fn)    -> non-Disposable resources are released too
 * Pool.acquire()/release()             -> per-frame scratch reuse, with a reset hook
 * BoundingVolume.version               -> derived data can be memoised safely
 * ```
 *
 * Every assertion here is about *ordering and idempotence*, which is exactly what
 * breaks in real applications (double-frees, leaked GPU buffers, stale caches).
 */

import { describe, expect, it, vi } from 'vitest';

import { BoundingVolume } from '../../src/core/BoundingVolume';
import { createDisposable, Disposable, disposeAll, DisposableRef } from '../../src/core/Disposable';
import { BufferAttribute } from '../../src/geometry/core/BufferAttribute';
import { BufferGeometry } from '../../src/geometry/core/BufferGeometry';
import { Mat4 } from '../../src/math/Mat4';
import { Vec3 } from '../../src/math/Vec3';
import { Pool } from '../../src/utils/Pool';

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

/** A resource that records its own release, standing in for a GPU buffer. */
class FakeBuffer extends Disposable<'FakeBuffer'> {
  public override readonly label = 'FakeBuffer' as const;
  public readonly releases = vi.fn();

  protected override onDispose(): void {
    this.releases();
  }
}

/** Builds an indexed triangle geometry whose bounding box is centred on the origin. */
function makeTriangle(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2]);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Disposable                                                                 */
/* -------------------------------------------------------------------------- */

describe('Disposable ownership', () => {
  it('runs onDispose(), then children, then dispose callbacks — exactly once', () => {
    const order: string[] = [];
    const child = createDisposable('child', () => order.push('child'));

    const owner = createOrderRecordingDisposable(order, 'owner-hook');
    owner.addDisposables(child);
    owner.addDisposeCallback(() => order.push('owner-callback'));

    owner.dispose();
    owner.dispose(); // idempotent

    expect(order).toEqual(['owner-hook', 'child', 'owner-callback']);
    expect(owner.isDisposed).toBe(true);
    expect(child.isDisposed).toBe(true);
  });

  it('tracks and releases registered children through disposableCount', () => {
    const owner = new FakeBuffer();
    const a = new FakeBuffer();
    const b = new FakeBuffer();
    owner.addDisposables(a, b);

    expect(owner.disposableCount).toBe(2);
    owner.removeDisposable(b);
    expect(owner.disposableCount).toBe(1);

    owner.dispose();
    expect(a.isDisposed).toBe(true);
    expect(b.isDisposed).toBe(false);
    expect(a.releases).toHaveBeenCalledTimes(1);
  });

  it('disposes a child registered after the owner was already released', () => {
    // This is the async-load race: the request resolves after teardown.
    const owner = new FakeBuffer();
    owner.dispose();

    const late = new FakeBuffer();
    owner.addDisposable(late);

    expect(late.isDisposed).toBe(true);
    expect(late.releases).toHaveBeenCalledTimes(1);
  });

  it('refuses to release twice through DisposableRef reference counting', () => {
    const buffer = new FakeBuffer();
    const ref = new DisposableRef(buffer);

    ref.retain();
    expect(ref.refCount).toBe(2);

    ref.release();
    expect(buffer.isDisposed).toBe(false);

    ref.release();
    expect(buffer.isDisposed).toBe(true);
    expect(buffer.releases).toHaveBeenCalledTimes(1);
  });

  it('releases every geometry attribute and the index exactly once', () => {
    const geometry = makeTriangle();
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    expect(position).toBeDefined();
    expect(index).toBeDefined();
    if (!position || !index) return;

    const positionDispose = vi.spyOn(position, 'dispose');
    const indexDispose = vi.spyOn(index, 'dispose');

    geometry.dispose();
    geometry.dispose();

    expect(positionDispose).toHaveBeenCalledTimes(1);
    expect(indexDispose).toHaveBeenCalledTimes(1);
    expect(geometry.isDisposed).toBe(true);
    expect(geometry.getAttributeNames()).toHaveLength(0);
  });

  it('disposes a heterogeneous list and reports how many were released', () => {
    const a = new FakeBuffer();
    const b = new FakeBuffer();
    const alreadyDisposed = new FakeBuffer();
    alreadyDisposed.dispose();

    const released = disposeAll([a, b, alreadyDisposed]);

    expect(a.isDisposed).toBe(true);
    expect(b.isDisposed).toBe(true);
    // Every entry counts, including the one that was already released.
    expect(released).toBe(3);
  });

  it('leaves a partially-failed disposal recoverable', () => {
    const owner = new FakeBuffer();
    const failing = createDisposable('failing', () => {
      throw new Error('release failed');
    });
    const healthy = new FakeBuffer();
    owner.addDisposables(failing, healthy);

    // A throwing child must not stop the owner from finishing its own teardown,
    // nor prevent the remaining children from being released.
    expect(() => owner.dispose()).not.toThrow();
    expect(owner.isDisposed).toBe(true);
    expect(healthy.isDisposed).toBe(true);
  });

  it('exposes isUsable / assertUsable as the guard pair', () => {
    const buffer = new FakeBuffer();
    expect(buffer.isUsable).toBe(true);
    buffer.assertUsable();

    buffer.dispose();
    expect(buffer.isUsable).toBe(false);
    expect(() => buffer.assertUsable()).toThrow();
  });
});

/** Builds a `Disposable` that pushes `hookLabel` when its native hook runs. */
function createOrderRecordingDisposable(order: string[], hookLabel: string): Disposable<'ordered'> {
  class OrderedDisposable extends Disposable<'ordered'> {
    public override readonly label = 'ordered' as const;
    protected override onDispose(): void {
      order.push(hookLabel);
    }
  }
  return new OrderedDisposable();
}

/* -------------------------------------------------------------------------- */
/* BoundingVolume cache invalidation                                          */
/* -------------------------------------------------------------------------- */

describe('BoundingVolume cache invalidation', () => {
  it('exposes a version that only advances when the world volumes are recomputed', () => {
    const geometry = makeTriangle();
    const volume = new BoundingVolume().setFromGeometry(geometry);
    const initial = volume.version;

    volume.update(Mat4.fromTranslation(new Vec3(1, 0, 0)));
    const afterFirstUpdate = volume.version;
    expect(afterFirstUpdate).toBeGreaterThan(initial);

    volume.update(Mat4.fromTranslation(new Vec3(2, 0, 0)));
    expect(volume.version).toBeGreaterThan(afterFirstUpdate);
  });

  it('invalidates so a consumer knows its derived data is stale', () => {
    const volume = new BoundingVolume().setFromGeometry(makeTriangle());
    volume.update(Mat4.identity());
    expect(volume.hasWorldBounds).toBe(true);

    volume.invalidate();
    expect(volume.hasWorldBounds).toBe(false);

    // A memoised derived value keyed on `version` must recompute after an update.
    let memoisedVersion = -1;
    const recompute = () => {
      if (volume.version !== memoisedVersion) {
        memoisedVersion = volume.version;
        return true;
      }
      return false;
    };
    expect(recompute()).toBe(true);
    expect(recompute()).toBe(false);
    volume.update(Mat4.identity());
    expect(recompute()).toBe(true);
  });

  it('hands a copy to a consumer without aliasing the live volume', () => {
    const volume = new BoundingVolume().setFromGeometry(makeTriangle());
    volume.update(Mat4.identity());

    const snapshot = volume.clone();
    volume.update(Mat4.fromTranslation(new Vec3(100, 0, 0)));

    expect(snapshot.box.getCenter().x).toBeCloseTo(0, 4);
    expect(volume.box.getCenter().x).toBeCloseTo(100, 4);
  });
});

/* -------------------------------------------------------------------------- */
/* Pool                                                                       */
/* -------------------------------------------------------------------------- */

describe('Pool reuse across frames', () => {
  it('recycles released objects and creates only when the pool is empty', () => {
    const pool = new Pool<{ value: number }>(() => ({ value: 0 }));

    const first = pool.acquire();
    pool.acquire();
    expect(pool.created).toBe(2);
    expect(pool.activeCount).toBe(2);

    pool.release(first);
    expect(pool.size).toBe(1);

    const reused = pool.acquire();
    expect(pool.created).toBe(2);
    expect(reused).toBe(first);

    pool.releaseAll();
    expect(pool.activeCount).toBe(0);
  });

  it('prewarms the pool so the first frame allocates nothing', () => {
    const pool = new Pool<{ id: number }>(() => ({ id: 0 }), { prewarm: 4 });

    expect(pool.created).toBe(4);
    expect(pool.size).toBe(4);

    for (let i = 0; i < 4; i++) pool.acquire();
    expect(pool.created).toBe(4);
    expect(pool.isEmpty).toBe(true);
  });

  it('resets recycled objects through the onAcquire hook', () => {
    const pool = new Pool<{ depth: number }>(() => ({ depth: 0 }), {
      onAcquire: (item) => {
        item.depth = 0;
      },
    });

    const item = pool.acquire();
    item.depth = 42;
    pool.release(item);

    expect(pool.acquire().depth).toBe(0);
  });

  it('drops objects beyond capacity so a runaway leak cannot grow without bound', () => {
    const pool = new Pool<{ id: number }>(() => ({ id: 0 }), { capacity: 2 });

    const items = [pool.acquire(), pool.acquire(), pool.acquire()];
    for (const item of items) pool.release(item);

    expect(pool.size).toBe(2);
  });

  it('disposes discarded objects on clear()', () => {
    const pool = new Pool<{ id: number }>(() => ({ id: 1 }));
    const item = pool.acquire();
    pool.release(item);

    const dispose = vi.fn();
    pool.clear(dispose);

    expect(dispose).toHaveBeenCalledWith(item);
    expect(pool.size).toBe(0);
  });

  it('releases a pooled object even when the callback throws', () => {
    const pool = new Pool<{ id: number }>(() => ({ id: 1 }));

    expect(() =>
      pool.use(() => {
        throw new Error('work failed');
      }),
    ).toThrow('work failed');
    expect(pool.activeCount).toBe(0);
    expect(pool.size).toBe(1);
  });
});
