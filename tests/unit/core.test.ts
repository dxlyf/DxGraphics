/**
 * Unit tests for the core layer: events, lifecycle, timing, the scene graph,
 * layers, bounding volumes and the update scheduler.
 *
 * These are the contracts every other layer relies on, so the tests assert
 * observable behaviour (dispatch order, idempotent disposal, matrix propagation,
 * prioritised updates) rather than internal structure.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  Clock,
  Countdown,
  Disposable,
  DisposableRef,
  EventDispatcher,
  EventEmitter,
  FrameAccumulator,
  Layer,
  Layers,
  Lifecycle,
  LifecycleState,
  ManualClock,
  Node,
  RenderGroup,
  RenderSort,
  Scene,
  Timer,
  Transform,
  UpdatePriority,  UpdateScheduler,
  createDisposable,
  createEventEmitter,
  createUpdateable,
  describeRenderable,
  disposeAll,
  isEventDispatcher,
  withEvents,
  withRenderable,
} from '../../src/core';
import type { FrameInfo, IUpdateable } from '../../src/core';
import { Camera } from '../../src/core/Camera';
import { BoundingVolume } from '../../src/core/BoundingVolume';
import { Mat4 } from '../../src/math/Mat4';
import { Vec3 } from '../../src/math/Vec3';

/** A concrete `Disposable` used to observe the disposal contract. */
class TestResource extends Disposable<'TestResource'> {
  public readonly label = 'TestResource' as const;
  public disposeCalls = 0;

  protected onDispose(): void {
    this.disposeCalls++;
  }
}

describe('EventEmitter', () => {
  it('invokes listeners in registration order with the right arguments', () => {
    const emitter = new EventEmitter<{ ping: [number, string] }>();
    const seen: string[] = [];
    emitter.on('ping', (count, label) => seen.push(`a:${count}:${label}`));
    emitter.on('ping', (count) => seen.push(`b:${count}`));

    expect(emitter.emit('ping', 1, 'x')).toBe(true);
    expect(seen).toEqual(['a:1:x', 'b:1']);
  });

  it('returns false when nothing is listening', () => {
    const emitter = new EventEmitter<{ ping: [] }>();
    expect(emitter.emit('ping')).toBe(false);
  });

  it('unsubscribes through the returned function', () => {
    const emitter = new EventEmitter<{ ping: [] }>();
    const listener = vi.fn();
    const off = emitter.on('ping', listener);
    emitter.emit('ping');
    off();
    emitter.emit('ping');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('removes once-listeners after the first call', () => {
    const emitter = new EventEmitter<{ ping: [number] }>();
    const listener = vi.fn();
    emitter.once('ping', listener);
    emitter.emit('ping', 1);
    emitter.emit('ping', 2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);
  });

  it('runs higher-priority listeners first', () => {
    const emitter = new EventEmitter<{ ping: [] }>();
    const order: string[] = [];
    emitter.on('ping', () => order.push('normal'));
    emitter.prependListener('ping', () => order.push('high'), 10);
    emitter.emit('ping');
    expect(order).toEqual(['high', 'normal']);
  });

  it('never lets a throwing listener break the others', () => {
    const emitter = new EventEmitter<{ ping: [] }>();
    const after = vi.fn();
    emitter.onError(() => undefined);
    emitter.on('ping', () => {
      throw new Error('boom');
    });
    emitter.on('ping', after);
    expect(() => emitter.emit('ping')).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('removes a listener that unsubscribes itself mid-dispatch', () => {
    const emitter = new EventEmitter<{ ping: [] }>();
    const calls: string[] = [];
    const offSecond = emitter.on('ping', () => {
      calls.push('second');
      offSecond();
    });
    emitter.on('ping', () => {
      calls.push('first');
      offSecond();
    });
    emitter.emit('ping');
    expect(calls).toEqual(['second', 'first']);
    calls.length = 0;
    emitter.emit('ping');
    expect(calls).toEqual(['first']);
  });

  it('resolves waitFor with the emitted argument tuple', async () => {
    const emitter = new EventEmitter<{ ready: [number, string] }>();
    const promise = emitter.waitFor('ready', 1000);
    emitter.emit('ready', 7, 'ok');
    await expect(promise).resolves.toEqual([7, 'ok']);
  });

  it('rejects waitFor on timeout', async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter<{ ready: [] }>();
    const promise = emitter.waitFor('ready', 50);
    const assertion = expect(promise).rejects.toThrow(/Timed out/);
    vi.advanceTimersByTime(60);
    await assertion;
    vi.useRealTimers();
  });

  it('reports listener counts and names', () => {
    const emitter = createEventEmitter<{ a: []; b: [] }>();
    emitter.on('a', () => undefined);
    emitter.on('b', () => undefined);
    emitter.on('b', () => undefined);
    expect(emitter.listenerCount('a')).toBe(1);
    expect(emitter.listenerCount('b')).toBe(2);
    expect(emitter.totalListenerCount).toBe(3);
    expect(emitter.eventNames().sort()).toEqual(['a', 'b']);
  });
});

describe('EventDispatcher', () => {
  it('bubbles through parents and honours stopPropagation', () => {
    const root = new EventDispatcher<{ ping: [] }>();
    const middle = new EventDispatcher<{ ping: [] }>();
    const leaf = new EventDispatcher<{ ping: [] }>();
    middle.parent = root;
    leaf.parent = middle;

    const seen: string[] = [];
    root.onDispatch('ping', () => seen.push('root'));
    middle.onDispatch('ping', (event) => {
      seen.push('middle');
      event.stopPropagation();
    });
    leaf.onDispatch('ping', () => seen.push('leaf'));

    leaf.dispatchEvent('ping');
    expect(seen).toEqual(['leaf', 'middle']);
  });

  it('reports the target and the current target while bubbling', () => {
    const parent = new EventDispatcher<{ ping: [] }>();
    const child = new EventDispatcher<{ ping: [] }>();
    child.parent = parent;
    const targets: unknown[] = [];
    parent.onDispatch('ping', (event) => targets.push(event.currentTarget));
    child.dispatchEvent('ping');
    expect(targets[0]).toBe(parent);
  });

  it('identifies dispatchers structurally', () => {
    expect(isEventDispatcher(new EventDispatcher())).toBe(true);
    expect(isEventDispatcher({})).toBe(false);
  });

  it('can be mixed into an existing base class', () => {
    class Base {
      public value = 1;
    }
    class Widget extends withEvents(Base) {}
    const widget = new Widget();
    const listener = vi.fn();
    widget.on('click', listener);
    widget.emit('click', 42);
    expect(widget.value).toBe(1);
    expect(listener).toHaveBeenCalledWith(42);
  });

  it('clears listeners on dispose', () => {
    const dispatcher = new EventDispatcher<{ ping: [] }>();
    const listener = vi.fn();
    dispatcher.on('ping', listener);
    dispatcher.dispose();
    dispatcher.emit('ping');
    expect(listener).not.toHaveBeenCalled();
    expect(dispatcher.isDisposed).toBe(true);
  });
});

describe('Disposable', () => {
  it('disposes exactly once, even when called repeatedly', () => {
    const resource = new TestResource();
    expect(resource.isDisposed).toBe(false);
    resource.dispose();
    resource.dispose();
    expect(resource.disposeCalls).toBe(1);
    expect(resource.isDisposed).toBe(true);
    expect(resource.isUsable).toBe(false);
  });

  it('throws when used after disposal', () => {
    const resource = new TestResource();
    resource.dispose();
    expect(() => resource.assertUsable()).toThrow(/TestResource has been disposed/);
  });

  it('disposes child resources and then forgets them', () => {
    const parent = new TestResource();
    const child = new TestResource();
    parent.addDisposable(child);
    expect(parent.disposableCount).toBe(1);

    parent.dispose();
    expect(child.isDisposed).toBe(true);
    expect(parent.disposableCount).toBe(0);
  });

  it('disposes a child added after the parent was already disposed', () => {
    const parent = new TestResource();
    parent.dispose();
    const late = new TestResource();
    parent.addDisposable(late);
    expect(late.isDisposed).toBe(true);
  });

  it('still disposes every child when one of them throws', () => {
    const parent = new TestResource();
    const throwing: Disposable<'bad'> = new (class extends Disposable<'bad'> {
      public readonly label = 'bad' as const;
      protected onDispose(): void {
        throw new Error('nope');
      }
    })();
    const healthy = new TestResource();
    parent.addDisposables(throwing, healthy);
    expect(() => parent.dispose()).not.toThrow();
    expect(healthy.isDisposed).toBe(true);
    expect(parent.isDisposed).toBe(true);
  });

  it('runs dispose callbacks and emits lifecycle events', () => {
    const resource = new TestResource();
    const order: string[] = [];
    resource.addDisposeCallback(() => order.push('callback'));
    resource.on('dispose', () => order.push('event'));
    resource.dispose();
    expect(order).toEqual(['event', 'callback']);
  });

  it('ref-counts a shared resource', () => {
    const resource = new TestResource();
    const reference = new DisposableRef(resource, 'shared');
    reference.retain();
    reference.release();
    expect(resource.isDisposed).toBe(false);
    reference.release();
    expect(resource.isDisposed).toBe(true);
  });

  it('refuses to retain after release', () => {
    const reference = new DisposableRef(new TestResource());
    reference.dispose();
    expect(() => reference.retain()).toThrow();
  });

  it('disposes a collection, reporting how many succeeded', () => {
    const a = new TestResource();
    const b = new TestResource();
    expect(disposeAll([a, b])).toBe(2);
    expect(createDisposable('x', () => undefined).isDisposed).toBe(false);
  });
});

describe('Lifecycle', () => {
  it('runs the initialiser once and reports the final state', async () => {
    const lifecycle = new Lifecycle({ label: 'device' });
    const initializer = vi.fn();
    await lifecycle.initialize(initializer);
    await lifecycle.initialize(initializer);
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(lifecycle.state).toBe(LifecycleState.Initialized);
    expect(lifecycle.isReady).toBe(true);
  });

  it('shares one in-flight initialisation between concurrent callers', async () => {
    const lifecycle = new Lifecycle({ label: 'device' });
    let resolve: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const initializer = vi.fn(() => gate);

    const first = lifecycle.initialize(initializer);
    const second = lifecycle.initialize(initializer);
    resolve?.();
    await Promise.all([first, second]);
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  it('records a failure and moves to the error state', async () => {
    const lifecycle = new Lifecycle({ label: 'device' });
    await expect(
      lifecycle.initialize(() => {
        throw new Error('no adapter');
      }),
    ).rejects.toThrow('no adapter');
    expect(lifecycle.isErrored).toBe(true);
    expect(lifecycle.error?.message).toBe('no adapter');
  });

  it('rejects initialisation after disposal and never leaves the disposed state', async () => {
    const lifecycle = new Lifecycle({ label: 'device' });
    lifecycle.dispose();
    await expect(lifecycle.initialize()).rejects.toThrow(/disposed/);
    lifecycle.dispose();
    expect(lifecycle.isDisposed).toBe(true);
  });

  it('rejects illegal transitions', () => {
    const lifecycle = new Lifecycle({ label: 'device' });
    expect(lifecycle.canTransitionTo(LifecycleState.Initializing)).toBe(true);
    lifecycle.dispose();
    expect(() => lifecycle.transitionTo(LifecycleState.Initialized)).toThrow();
  });

  it('asserts the expected state', () => {
    const lifecycle = new Lifecycle({ label: 'device', startInitialized: true });
    expect(() => lifecycle.assertState(LifecycleState.Initialized)).not.toThrow();
    expect(() => lifecycle.assertState(LifecycleState.Disposed)).toThrow(/is in state/);
  });
});

describe('Clock and timers', () => {
  it('reports the elapsed delta', () => {
    const clock = new ManualClock();
    expect(clock.advance(0.016)).toBeCloseTo(0.016, 6);
    // A ManualClock steps by exactly what it is told: it is the tool for deterministic
    // tests, and a silent clamp would make "advance to 10 s" mean "advance to 0.1 s".
    expect(clock.advance(10)).toBeCloseTo(10, 6);
    expect(clock.elapsed).toBeCloseTo(10.016, 6);
  });

  it('clamps runaway frames on a wall-clock Clock', () => {
    // The clamp exists so a backgrounded tab cannot teleport physics; it belongs to the
    // clock that reads the wall clock, not to the manual one.
    const clock = new Clock({ autoStart: false });
    clock.start(0);

    expect(clock.getDelta(16)).toBeCloseTo(0.016, 6);
    expect(clock.getDelta(10_016)).toBeCloseTo(0.1, 6);
    // `elapsed` accumulates the delta that was reported, so the two agree.
    expect(clock.elapsed).toBeCloseTo(0.116, 6);
    expect(clock.getElapsedTime()).toBeCloseTo(clock.elapsed, 10);
  });

  it('does not advance while stopped', () => {
    const clock = new ManualClock();
    clock.stop();
    expect(clock.getDelta(clock.previousTimestamp + 16)).toBe(0);
  });

  it('tracks elapsed time and frame count', () => {
    const clock = new ManualClock();
    clock.advance(0.25);
    clock.advance(0.25);
    expect(clock.elapsed).toBeCloseTo(0.5, 5);
    expect(clock.frameCount).toBe(2);
  });

  it('quantises deltas in fixed-step mode', () => {
    const clock = new ManualClock();
    clock.fixedDelta = 1 / 60;
    expect(clock.advance(0.5)).toBeCloseTo(1 / 60, 9);
  });

  it('fires a repeating timer once per interval', () => {
    const timer = new Timer(0.5, { repeat: true });
    const ticks = vi.fn();
    timer.onTick(ticks);
    expect(timer.update(0.4)).toBe(false);
    expect(timer.update(0.2)).toBe(true);
    expect(ticks).toHaveBeenCalledWith(1);
    expect(timer.count).toBe(1);
  });

  it('fires several times for a large delta but is bounded', () => {
    const timer = new Timer(0.1, { repeat: true });
    expect(timer.update(0.35)).toBe(true);
    expect(timer.count).toBe(3);
  });

  it('completes a non-repeating timer and stops', () => {
    const timer = new Timer(0.1);
    const complete = vi.fn();
    timer.onComplete(complete);
    timer.update(0.2);
    expect(timer.completed).toBe(true);
    expect(timer.running).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(timer.update(1)).toBe(false);
  });

  it('accumulates fixed steps and drops the backlog', () => {
    const accumulator = new FrameAccumulator(0.1, 3);
    expect(accumulator.advance(0.25)).toBe(2);
    expect(accumulator.alpha).toBeCloseTo(0.5, 5);
    // A giant frame is capped at maxSteps.
    expect(accumulator.advance(100)).toBe(3);
  });

  it('runs a callback once per fixed step', () => {
    const accumulator = new FrameAccumulator(0.1, 5);
    const steps: number[] = [];
    expect(accumulator.run(0.25, (step) => steps.push(step))).toBe(2);
    expect(steps).toEqual([0, 1]);
  });

  it('counts down and reports the frame it finishes', () => {
    const countdown = new Countdown(0.3);
    expect(countdown.update(0.2)).toBe(false);
    expect(countdown.update(0.2)).toBe(true);
    expect(countdown.finished).toBe(true);
    expect(countdown.remaining).toBe(0);
  });
});

describe('Layers', () => {
  it('enables, disables and tests bits', () => {
    const layers = new Layers();
    expect(layers.isEnabled(Layer.Default)).toBe(true);
    expect(layers.isEnabled(Layer.UI)).toBe(false);

    layers.enable(Layer.UI).enable(Layer.Debug);
    expect(layers.count).toBe(3);
    expect(layers.test(new Layers(1 << Layer.UI))).toBe(true);
    expect(layers.test(new Layers(1 << Layer.Text))).toBe(false);

    layers.disable(Layer.Default);
    expect(layers.isEnabled(Layer.Default)).toBe(false);
    expect(layers.toArray()).toEqual([Layer.UI, Layer.Debug]);
    expect(layers.highest).toBe(Layer.Debug);
  });

  it('builds masks and reports intersections', () => {
    expect(Layers.from(Layer.Opaque, Layer.UI).mask).toBe((1 << Layer.Opaque) | (1 << Layer.UI));
    expect(Layers.all().count).toBe(32);
    expect(Layers.none().isEmpty).toBe(true);
    expect(Layers.intersects(Layers.from(Layer.UI), Layers.from(Layer.UI, Layer.Text))).toBe(true);
    expect(Layers.intersects(Layers.from(Layer.UI), Layers.from(Layer.Text))).toBe(false);
  });

  it('describes itself for debug output', () => {
    expect(new Layers(1 << Layer.UI).toString()).toBe('UI');
    expect(Layers.none().toString()).toBe('Layers(none)');
  });
});

describe('Transform', () => {
  it('composes position, rotation and scale into the local matrix', () => {
    const transform = new Transform();
    transform.setPosition(new Vec3(1, 2, 3));
    transform.setScale(2);
    const matrix = transform.updateMatrix();
    expect(matrix.getTranslation().toArray()).toEqual([1, 2, 3]);
    expect(matrix.getScale().toArray()).toEqual([2, 2, 2]);
  });

  it('reports dirty state and notifies on change', () => {
    const onChange = vi.fn();
    const transform = new Transform({ onChange });
    transform.updateMatrix();
    expect(transform.dirty).toBe(false);

    transform.position.x = 5;
    expect(transform.dirty).toBe(true);
    expect(onChange).toHaveBeenCalled();
  });

  it('keeps euler and quaternion in sync in both directions', () => {
    const transform = new Transform();
    transform.setRotation(new Vec3(0, 0, 1) as unknown as never);
    void 0;

    transform.rotation.set(0, 0, Math.PI / 2);
    expect(transform.quaternion.z).toBeCloseTo(Math.sin(Math.PI / 4), 6);

    transform.quaternion.setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2);
    expect(transform.rotation.y).toBeCloseTo(Math.PI / 2, 6);
  });

  it('round-trips through JSON', () => {
    const transform = new Transform();
    transform.setPosition(new Vec3(1, -2, 3));
    transform.setScale(new Vec3(2, 3, 4));
    const restored = new Transform().fromJSON(transform.toJSON());
    expect(restored.position.equals(transform.position, 1e-6)).toBe(true);
    expect(restored.scale.equals(transform.scale, 1e-6)).toBe(true);
  });

  it('detects a degenerate scale', () => {
    const transform = new Transform({ scale: new Vec3(1, 0, 1) });
    expect(transform.isDegenerate()).toBe(true);
    expect(new Transform().isDegenerate()).toBe(false);
  });
});

describe('Node and Scene', () => {
  it('propagates world matrices to children', () => {
    const root = new Node({ name: 'root' });
    const child = new Node({ name: 'child' });
    root.add(child);
    root.position.set(1, 0, 0);
    child.position.set(0, 2, 0);
    root.updateMatrixWorld(true);

    expect(child.getWorldPosition().equals(new Vec3(1, 2, 0), 1e-6)).toBe(true);
  });

  it('reparents a node and keeps one parent at a time', () => {
    const a = new Node({ name: 'a' });
    const b = new Node({ name: 'b' });
    const child = new Node({ name: 'child' });

    a.add(child);
    expect(a.children).toHaveLength(1);
    expect(child.parent).toBe(a);

    b.add(child);
    expect(child.parent).toBe(b);
    expect(b.children).toContain(child);
    // The old parent must have dropped it entirely.
    expect(a.children).toHaveLength(0);
    expect(a.children).not.toContain(child);
  });

  it('refuses to create a cycle', () => {
    const parent = new Node();
    const child = new Node();
    parent.add(child);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    child.add(parent);
    expect(child.children).toHaveLength(0);
    warn.mockRestore();
  });

  it('preserves the world transform through attach and detach', () => {
    const scene = new Node();
    const parent = new Node();
    scene.add(parent);
    parent.position.set(10, 0, 0);

    const child = new Node();
    scene.add(child);
    child.position.set(1, 0, 0);
    scene.updateMatrixWorld(true);
    const worldBefore = child.getWorldPosition().clone();

    parent.attach(child);
    parent.updateMatrixWorld(true);
    expect(child.getWorldPosition().equals(worldBefore, 1e-5)).toBe(true);

    scene.detach(child);
    scene.updateMatrixWorld(true);
    expect(child.getWorldPosition().equals(worldBefore, 1e-5)).toBe(true);
  });

  it('traverses, finds and counts nodes', () => {
    const root = new Node({ name: 'root' });
    const a = new Node({ name: 'a' });
    const b = new Node({ name: 'b' });
    root.add(a, b);
    a.add(new Node({ name: 'a1' }));

    const names: string[] = [];
    root.traverse((node) => names.push(node.name));
    expect(names).toEqual(['root', 'a', 'a1', 'b']);
    expect(root.getNodeCount()).toBe(4);
    expect(root.getNodeByName('a1')?.name).toBe('a1');
    expect(root.getNodeById(a.id)).toBe(a);
    expect(root.getNodeByName('missing')).toBeNull();
  });

  it('skips invisible subtrees during traverseVisible', () => {
    const root = new Node();
    const hidden = new Node();
    const nested = new Node();
    hidden.add(nested);
    root.add(hidden);
    hidden.visible = false;

    const visited: string[] = [];
    root.traverseVisible((node) => visited.push(node.name));
    expect(visited).toEqual([root.name]);
  });

  it('reports local and world transforms', () => {
    const root = new Node();
    root.position.set(1, 1, 1);
    root.updateMatrixWorld(true);

    const local = new Vec3(1, 0, 0);
    expect(root.localToWorld(local.clone()).equals(new Vec3(2, 1, 1), 1e-6)).toBe(true);
    expect(root.worldToLocal(new Vec3(2, 1, 1)).equals(new Vec3(1, 0, 0), 1e-6)).toBe(true);
  });

  it('orients a node with lookAt', () => {
    const node = new Node();
    node.position.set(0, 0, 1);
    node.lookAt(new Vec3(0, 0, 0));
    node.updateMatrixWorld(true);
    // The node's forward (-Z) must point at the target.
    const forward = node.getWorldDirection();
    expect(forward.z).toBeCloseTo(-1, 5);
  });

  it('disposes the whole subtree', () => {
    const root = new Node();
    const child = new Node();
    const grandchild = new Node();
    root.add(child);
    child.add(grandchild);

    const disposed: string[] = [];
    grandchild.on('dispose', () => disposed.push('grandchild'));
    root.dispose();

    expect(disposed).toEqual(['grandchild']);
    expect(root.children).toHaveLength(0);
    expect(root.isDisposed).toBe(true);
  });

  it('registers cameras added to a scene', () => {
    const scene = new Scene();
    const camera = new Camera();
    scene.add(camera);
    expect(scene.cameras).toContain(camera);
    expect(scene.getActiveCamera()).toBe(camera);

    scene.remove(camera);
    expect(scene.cameras).toHaveLength(0);
  });

  it('counts the objects in a scene', () => {
    const scene = new Scene();
    const group = new Node();
    scene.add(group);
    group.add(new Node(), new Node());
    const stats = scene.getStatistics();
    expect(stats.objects).toBe(4);
    expect(stats.cameras).toBe(0);
  });

  it('stores background and fog', () => {
    const scene = new Scene();
    scene.setBackground('#101018');
    expect(scene.background).not.toBeNull();
    scene.setLinearFog('#ffffff', 1, 100);
    expect(scene.fog).toMatchObject({ type: 'linear', near: 1, far: 100 });
    scene.setFog(null);
    expect(scene.fog).toBeNull();
  });

  it('bumps a version so render lists can invalidate', () => {
    const scene = new Scene();
    const before = scene.version;
    scene.add(new Node());
    expect(scene.version).toBeGreaterThan(before);
  });
});

describe('Camera', () => {
  it('builds a view matrix that inverts the camera world matrix', () => {
    const camera = new Camera();
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    expect(camera.matrixWorldInverse.clone().multiply(camera.matrixWorld).isIdentity(1e-5)).toBe(true);
  });

  it('projects world points and unprojects them back', () => {
    const camera = new Camera();
    camera.setOrthographic(-1, 1, 1, -1, 0.1, 10);
    camera.setViewportSize(100, 100);
    camera.position.set(0.5, 0.5, 1);
    camera.updateMatrixWorld(true);

    const screen = camera.worldToScreen(new Vec3(0.5, 0.5, 0));
    expect(screen.x).toBeCloseTo(50, 3);
    expect(screen.y).toBeCloseTo(50, 3);
    expect(screen.behind).toBe(false);
  });

  it('builds a ray through a viewport pixel', () => {
    const camera = new Camera();
    camera.setOrthographic(-1, 1, 1, -1, 0.1, 10);
    camera.setViewportSize(100, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);

    const ray = camera.screenPointToRay(50, 50);
    // The ray starts on the NEAR plane: world z = 5 (camera) - 0.1 (near).
    expect(ray.origin.z).toBeCloseTo(4.9, 4);
    expect(ray.origin.x).toBeCloseTo(0, 5);
    expect(ray.origin.y).toBeCloseTo(0, 5);
    // ... and points straight down -Z towards the scene.
    expect(ray.direction.z).toBeCloseTo(-1, 4);
    expect(ray.direction.x).toBeCloseTo(0, 5);
  });

  it('reports the aspect ratio and updates the frustum', () => {
    const camera = new Camera();
    camera.setViewportSize(200, 100);
    expect(camera.aspect).toBeCloseTo(2, 6);
    expect(camera.updateFrustum()).toBe(camera.frustum);
  });
});

describe('BoundingVolume', () => {
  it('computes local bounds from a geometry-like source', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const geometry = {
      getAttribute: (name: string) =>
        name === 'position'
          ? { array: positions, itemSize: 3, count: 3 }
          : undefined,
    };

    const bounds = new BoundingVolume().setFromGeometry(geometry);
    expect(bounds.hasLocalBounds).toBe(true);
    expect(bounds.localBox.min.toArray()).toEqual([0, 0, 0]);
    expect(bounds.localBox.max.toArray()).toEqual([1, 1, 0]);
    expect(bounds.localSphere.radius).toBeGreaterThan(0);
  });

  it('scales the world sphere with the world matrix', () => {
    const bounds = new BoundingVolume().setFromGeometry({
      getAttribute: () => ({ array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), itemSize: 3, count: 3 }),
    });
    const localRadius = bounds.localSphere.radius;
    bounds.update(new Mat4().makeScale(3, 3, 3));
    expect(bounds.hasWorldBounds).toBe(true);
    expect(bounds.sphere.radius).toBeCloseTo(localRadius * 3, 5);
  });

  it('is empty before any source is assigned', () => {
    expect(new BoundingVolume().isEmpty).toBe(true);
    expect(new BoundingVolume().setFromGeometry(null).isEmpty).toBe(true);
  });
});

describe('Renderable helpers', () => {
  it('describes sensible defaults per render group', () => {
    const opaque = describeRenderable();
    expect(opaque.renderGroup).toBe(RenderGroup.Opaque);
    expect(opaque.transparent).toBe(false);
    expect(opaque.depthWrite).toBe(true);

    const transparent = describeRenderable({ renderGroup: RenderGroup.Transparent });
    expect(transparent.transparent).toBe(true);
    expect(transparent.depthWrite).toBe(false);
    expect(transparent.sortMode).toBe(RenderSort.DistanceDescending);
  });

  it('installs render-queue members through the mixin', () => {
    class Item extends withRenderable(EventDispatcher) {}
    const item = new Item();
    expect(item.visible).toBe(true);
    expect(item.renderOrder).toBe(0);
    expect(item.renderId).toBe(item.renderId);
    const other = new Item();
    expect(item.renderId).not.toBe(other.renderId);
  });
});

describe('UpdateScheduler', () => {
  it('runs updateables in priority order', () => {
    const scheduler = new UpdateScheduler();
    const order: string[] = [];
    scheduler.add(createUpdateable(UpdatePriority.Logic, () => order.push('logic')));
    scheduler.add(createUpdateable(UpdatePriority.Physics, () => order.push('physics')));
    scheduler.add(createUpdateable(UpdatePriority.Camera, () => order.push('camera')));

    scheduler.update(0.016);
    expect(order).toEqual(['physics', 'camera', 'logic']);
  });

  it('skips disabled and paused entries', () => {
    const scheduler = new UpdateScheduler();
    const ran = vi.fn();
    const entry = createUpdateable(UpdatePriority.Logic, ran);
    scheduler.add(entry);

    entry.enabled = false;
    scheduler.update(0.016);
    expect(ran).not.toHaveBeenCalled();

    entry.enabled = true;
    scheduler.pause(entry);
    scheduler.update(0.016);
    expect(ran).not.toHaveBeenCalled();

    scheduler.resume(entry);
    scheduler.update(0.016);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('keeps running the frame when one updateable throws', () => {
    const scheduler = new UpdateScheduler();
    const after = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    scheduler.add(
      createUpdateable(UpdatePriority.Logic, () => {
        throw new Error('bad update');
      }),
    );
    scheduler.add(createUpdateable(UpdatePriority.Post, after));
    expect(() => scheduler.update(0.016)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('counts successes and can be cleared', () => {
    const scheduler = new UpdateScheduler();
    scheduler.addAll(
      createUpdateable(UpdatePriority.Logic, () => undefined),
      createUpdateable(UpdatePriority.Post, () => undefined),
    );
    expect(scheduler.size).toBe(2);
    expect(scheduler.update(0.016)).toBe(2);
    scheduler.clear();
    expect(scheduler.size).toBe(0);
  });

  it('dispatches late and fixed updates when implemented', () => {
    const scheduler = new UpdateScheduler();
    const late = vi.fn();
    const fixed = vi.fn();
    // `add()` takes the minimal `IUpdateable`; `lateUpdate` and `fixedUpdate` are
    // optional *extra* hooks the scheduler probes for at run time (see
    // `UpdateScheduler.lateUpdate`, which reads them through a partial cast). An
    // object literal assigned directly to an `IUpdateable` parameter therefore has to
    // go through a wider local type, otherwise excess-property checking rejects the
    // hooks that the scheduler is specifically designed to find.
    const entry: IUpdateable & {
      lateUpdate(delta: number, frame?: FrameInfo): void;
      fixedUpdate(step: number, frame?: FrameInfo): void;
    } = {
      enabled: true,
      updatePriority: UpdatePriority.Logic,
      update: () => undefined,
      lateUpdate: late,
      fixedUpdate: fixed,
    };
    scheduler.add(entry);

    expect(scheduler.lateUpdate(0.016)).toBe(1);
    expect(scheduler.fixedUpdate(1 / 60)).toBe(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect(fixed).toHaveBeenCalledWith(1 / 60, undefined);
  });
});
