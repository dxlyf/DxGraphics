/**
 * `RenderList` / `RenderQueue` ordering with real `Renderable`-shaped objects.
 *
 * The render queue is the one place where a subtle comparator change silently
 * reorders draws (correctness for transparency, performance for state changes),
 * so this file pins the documented order with concrete objects rather than with
 * the renderer's internals:
 *
 * ```
 * scene graph walk  ->  RenderList.push()  ->  RenderQueue.sort()
 *                   ->  DrawOrderEntry[] / buckets
 * ```
 *
 * The objects here mirror what a scene node exposes to the renderer
 * (`visible`, `renderOrder`, `material`, `depth`, `render(painter)`), which is the
 * contract `Renderable2D` describes.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  RenderList,
  type Renderable2D,
} from '../../src/renderer/core/RenderList';
import {
  compareMaterialIds,
  RenderBucket,
  RenderQueue,
} from '../../src/renderer/core/RenderQueue';

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

/** A renderable with the same shape a scene node exposes to the renderer. */
class FakeRenderable implements Renderable2D {
  public visible = true;
  public readonly render = vi.fn();
  public material: { transparent?: boolean; id?: string | number } | null;
  public renderOrder: number;
  public depth: number;
  public opaque?: boolean;

  constructor(
    public readonly id: string,
    options: {
      renderOrder?: number;
      depth?: number;
      materialId?: string | number;
      transparent?: boolean;
      visible?: boolean;
    } = {},
  ) {
    this.renderOrder = options.renderOrder ?? 0;
    this.depth = options.depth ?? 0;
    this.visible = options.visible ?? true;
    this.material =
      options.materialId === undefined && options.transparent === undefined
        ? null
        : { id: options.materialId, transparent: options.transparent };
  }
}

/** Ids of the produced draw order, in draw sequence. */
function orderIds(queue: RenderQueue<Renderable2D>): string[] {
  return queue.order.map((entry) => String((entry.object as FakeRenderable).id));
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('RenderList bucketing', () => {
  it('separates opaque, transparent and explicitly ordered objects', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('opaque'));
    list.push(new FakeRenderable('see-through', { transparent: true }));
    list.push(new FakeRenderable('ui', { renderOrder: 10 }));

    expect(list.getStats()).toEqual({ total: 3, opaque: 1, transparent: 1, ordered: 1 });
    expect(list.length).toBe(3);
  });

  it('counts invisible objects as culled and never submits them', () => {
    const list = new RenderList<Renderable2D>();
    const hidden = new FakeRenderable('hidden', { visible: false });

    expect(list.push(hidden)).toBeNull();
    expect(list.culledCount).toBe(1);
    expect(list.length).toBe(0);
  });

  it('recycles entries between frames so a reset cannot leak state', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('a', { depth: 3 }));
    list.reset();

    expect(list.length).toBe(0);
    expect(list.culledCount).toBe(0);

    const entry = list.push(new FakeRenderable('b'));
    expect(entry?.depth).toBe(0);
    expect(entry?.sequence).toBe(0);
  });

  it('treats a transparent material as transparent and honours `opaque` overrides', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('glass', { transparent: true }));
    const forced = new FakeRenderable('forced', { transparent: true });
    forced.opaque = true;
    list.push(forced);

    expect(list.transparent.map((entry) => String((entry.object as FakeRenderable).id))).toEqual([
      'glass',
    ]);
    expect(list.opaque.map((entry) => String((entry.object as FakeRenderable).id))).toEqual([
      'forced',
    ]);
  });
});

describe('RenderQueue ordering', () => {
  it('emits ordered, then opaque, then transparent', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('transparent', { transparent: true }));
    list.push(new FakeRenderable('opaque'));
    list.push(new FakeRenderable('overlay', { renderOrder: 1 }));

    const queue = new RenderQueue<Renderable2D>();
    const result = queue.sort(list);

    expect(result.buckets).toEqual([
      RenderBucket.Ordered,
      RenderBucket.Opaque,
      RenderBucket.Transparent,
    ]);
    expect(orderIds(queue)).toEqual(['overlay', 'opaque', 'transparent']);
  });

  it('sorts opaque draws front-to-back within a material group', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('far', { depth: 30, materialId: 'stone' }));
    list.push(new FakeRenderable('near', { depth: 2, materialId: 'stone' }));
    list.push(new FakeRenderable('mid', { depth: 10, materialId: 'stone' }));

    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);

    expect(orderIds(queue)).toEqual(['near', 'mid', 'far']);
  });

  it('sorts transparent draws back-to-front', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('near', { depth: 2, transparent: true, materialId: 'glass' }));
    list.push(new FakeRenderable('far', { depth: 30, transparent: true, materialId: 'glass' }));
    list.push(new FakeRenderable('mid', { depth: 10, transparent: true, materialId: 'glass' }));

    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);

    expect(orderIds(queue)).toEqual(['far', 'mid', 'near']);
  });

  it('groups draws by material before depth, to minimise state changes', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('b-far', { depth: 40, materialId: 'b' }));
    list.push(new FakeRenderable('a-far', { depth: 30, materialId: 'a' }));
    list.push(new FakeRenderable('b-near', { depth: 4, materialId: 'b' }));
    list.push(new FakeRenderable('a-near', { depth: 3, materialId: 'a' }));

    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);

    // Material 'a' first (string order), and within it depth ascending.
    expect(orderIds(queue)).toEqual(['a-near', 'a-far', 'b-near', 'b-far']);
  });

  it('can sort purely by depth when material grouping is disabled', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('b-far', { depth: 40, materialId: 'b' }));
    list.push(new FakeRenderable('a-near', { depth: 3, materialId: 'a' }));

    const queue = new RenderQueue<Renderable2D>({ sortByMaterial: false });
    queue.sort(list);

    expect(orderIds(queue)).toEqual(['a-near', 'b-far']);
  });

  it('breaks ties with the submission sequence, so the order is deterministic', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('first', { depth: 5, materialId: 'same' }));
    list.push(new FakeRenderable('second', { depth: 5, materialId: 'same' }));
    list.push(new FakeRenderable('third', { depth: 5, materialId: 'same' }));

    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);

    expect(orderIds(queue)).toEqual(['first', 'second', 'third']);
  });

  it('never mutates the list buckets it reads from', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('far', { depth: 30, materialId: 'm' }));
    list.push(new FakeRenderable('near', { depth: 2, materialId: 'm' }));
    const submitted = list.opaque.map((entry) => String((entry.object as FakeRenderable).id));

    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);

    expect(list.opaque.map((entry) => String((entry.object as FakeRenderable).id))).toEqual(
      submitted,
    );
  });

  it('supports drawing the transparent bucket first', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('opaque'));
    list.push(new FakeRenderable('transparent', { transparent: true }));

    const queue = new RenderQueue<Renderable2D>({ transparentFirst: true });
    const result = queue.sort(list);

    expect(result.buckets[0]).toBe(RenderBucket.Transparent);
    expect(orderIds(queue)).toEqual(['transparent', 'opaque']);
  });

  it('reports a per-bucket draw order through getDrawOrder()', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('overlay', { renderOrder: 2 }));
    list.push(new FakeRenderable('opaque'));
    list.push(new FakeRenderable('transparent', { transparent: true }));

    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);
    const drawOrder = queue.getDrawOrder();

    expect(drawOrder.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(drawOrder.map((entry) => entry.bucket)).toEqual([
      RenderBucket.Ordered,
      RenderBucket.Opaque,
      RenderBucket.Transparent,
    ]);
  });

  it('reports the sort duration and whether the entry count changed', () => {
    const list = new RenderList<Renderable2D>();
    list.push(new FakeRenderable('a'));
    const queue = new RenderQueue<Renderable2D>();

    const first = queue.sort(list);
    expect(first.changed).toBe(true);
    expect(first.duration).toBeGreaterThanOrEqual(0);

    const second = queue.sort(list);
    expect(second.changed).toBe(false);
  });
});

describe('compareMaterialIds', () => {
  it('sorts numbers numerically and strings by code unit', () => {
    expect(compareMaterialIds(2, 10)).toBeLessThan(0);
    expect(compareMaterialIds('b', 'a')).toBeGreaterThan(0);
    expect(compareMaterialIds('a', 'a')).toBe(0);
  });

  it('sorts numeric ids before string ids and undefined last', () => {
    expect(compareMaterialIds(1, 'a')).toBeLessThan(0);
    expect(compareMaterialIds('a', 1)).toBeGreaterThan(0);
    expect(compareMaterialIds(undefined, 1)).toBeGreaterThan(0);
    expect(compareMaterialIds(1, undefined)).toBeLessThan(0);
  });
});

describe('scene walk -> queue integration', () => {
  it('produces a draw order from a parented hierarchy', () => {
    // Mirrors the renderer's fallback traversal: walk `children`, submit anything
    // with a `render` method, then sort.
    const root = {
      children: [
        new FakeRenderable('child-back', { depth: 20, materialId: 'bg' }),
        {
          children: [
            new FakeRenderable('grandchild-front', { depth: 1, materialId: 'bg' }),
            new FakeRenderable('grandchild-ui', { renderOrder: 5 }),
          ],
        },
      ],
    };

    const list = new RenderList<Renderable2D>();
    const visit = (node: { children?: unknown[] } & Partial<Renderable2D>): void => {
      if (typeof node.render === 'function') {
        list.push(node as Renderable2D);
        return;
      }
      for (const child of node.children ?? []) visit(child as never);
    };
    visit(root);

    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);

    expect(orderIds(queue)).toEqual([
      'grandchild-ui',
      'grandchild-front',
      'child-back',
    ]);
  });
});
