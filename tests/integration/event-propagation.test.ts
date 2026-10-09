/**
 * `EventEmitter` propagation through `Node` parent/child wiring.
 *
 * This is the cross-layer contract that keeps the scene graph observable without
 * a global bus: **`Node` extends `EventDispatcher<CoreEventMap>`**, so every graph
 * mutation emits a typed event from the object that changed, and listeners on the
 * *parent* hear about their own children.
 *
 * It also pins the design decision documented in `src/core/events.ts` and the
 * architecture guide: all graph objects share the single `CoreEventMap`, which is
 * why `TEvents` is unconstrained and `on`/`emit` stay fully typed without a
 * generic parameter threaded through the hierarchy.
 */

import { describe, expect, it, vi } from 'vitest';

import { Camera } from '../../src/core/Camera';
import { EventEmitter } from '../../src/core/EventEmitter';
import { Node } from '../../src/core/Node';
import { Scene } from '../../src/core/Scene';

describe('CoreEventMap propagation on Node', () => {
  it('emits "added" on the PARENT with the parent and child as payload', () => {
    // `Node.add` emits on `this` (the attaching parent), not on the child. The
    // payload pair lets a parent listener identify both endpoints.
    const parent = new Node({ name: 'parent' });
    const child = new Node({ name: 'child' });
    const listener = vi.fn();

    parent.on('added', listener);
    parent.add(child);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toBe(parent);
    expect(listener.mock.calls[0][1]).toBe(child);
  });

  it('emits "removed" on the PARENT when a child is detached', () => {
    const parent = new Node();
    const child = new Node();
    parent.add(child);

    const listener = vi.fn();
    parent.on('removed', listener);
    parent.remove(child);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toBe(parent);
    expect(listener.mock.calls[0][1]).toBe(child);
    expect(child.parent).toBeNull();
  });

  it('emits "matrixchanged" on transform mutations and "worldmatrixchanged" after update', () => {
    const node = new Node();
    const matrixChanged = vi.fn();
    const worldChanged = vi.fn();
    node.on('matrixchanged', matrixChanged);
    node.on('worldmatrixchanged', worldChanged);

    node.position.set(1, 2, 3);
    node.updateMatrixWorld(true);

    expect(matrixChanged).toHaveBeenCalled();
    expect(worldChanged).toHaveBeenCalledTimes(1);
  });

  it('does not re-emit "worldmatrixchanged" when nothing changed', () => {
    const node = new Node();
    node.position.set(1, 0, 0);
    node.updateMatrixWorld(true);

    const listener = vi.fn();
    node.on('worldmatrixchanged', listener);
    node.updateMatrixWorld();

    expect(listener).not.toHaveBeenCalled();
  });

  it('bubbles world transforms to descendants when a parent moves', () => {
    const parent = new Node();
    const child = parent.add(new Node());
    const grandchild = child.add(new Node());
    parent.add(child);
    parent.add(grandchild); // ignored: already parented, keeps the graph acyclic

    parent.updateMatrixWorld(true);
    const moved = vi.fn();
    grandchild.on('worldmatrixchanged', moved);

    parent.position.set(10, 0, 0);
    parent.updateMatrixWorld();

    expect(moved).toHaveBeenCalledTimes(1);
    expect(grandchild.getWorldPosition().x).toBeCloseTo(10, 5);
  });

  it('emits "dispose" once, depth-first, on the whole subtree', () => {
    const parent = new Node();
    const child = parent.add(new Node());
    const grandchild = child.add(new Node());

    const order: string[] = [];
    parent.on('dispose', () => order.push('parent'));
    child.on('dispose', () => order.push('child'));
    grandchild.on('dispose', () => order.push('grandchild'));

    parent.dispose();

    // Children are released before their parents, so a parent can still read them.
    expect(order).toEqual(['grandchild', 'child', 'parent']);
    expect(parent.isDisposed).toBe(true);

    // Disposal is idempotent: no second round of events.
    parent.dispose();
    expect(order).toHaveLength(3);
  });

  it('warns instead of corrupting the graph when a cycle would be created', () => {
    const grandparent = new Node();
    const parent = grandparent.add(new Node());
    const child = parent.add(new Node());

    // Adding an ancestor to one of its own descendants must be refused.
    child.add(grandparent);

    expect(grandparent.parent).toBeNull();
    expect(child.children).toHaveLength(0);
    expect(grandparent.isAncestorOf(child)).toBe(true);
  });

  it('keeps a node in exactly one place when it is reparented', () => {
    const a = new Node({ name: 'a' });
    const b = new Node({ name: 'b' });
    const child = a.add(new Node({ name: 'child' }));

    b.add(child);

    expect(a.children).toHaveLength(0);
    expect(b.children).toHaveLength(1);
    expect(child.parent).toBe(b);
  });

  it('supports once() and off() on the shared event map', () => {
    const node = new Node();
    const once = vi.fn();
    node.once('matrixchanged', once);

    node.position.set(1, 1, 1);
    node.position.set(2, 2, 2);

    expect(once).toHaveBeenCalledTimes(1);

    const persistent = vi.fn();
    node.on('matrixchanged', persistent);
    node.off('matrixchanged', persistent);
    node.position.set(3, 3, 3);

    expect(persistent).not.toHaveBeenCalled();
  });
});

describe('Scene structural events', () => {
  it('emits "change" when the graph is invalidated and bumps the version', () => {
    const scene = new Scene();
    const change = vi.fn();
    scene.on('change', change);

    const before = scene.version;
    scene.add(new Node());
    scene.add(new Node());

    expect(change).toHaveBeenCalledTimes(2);
    expect(scene.version).toBeGreaterThan(before);
  });

  it('emits "update" after a full updateMatrixWorld pass', () => {
    const scene = new Scene();
    const update = vi.fn();
    scene.on('update', update);

    scene.updateMatrixWorld(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('emits "environmentchange" when the background changes', () => {
    const scene = new Scene();
    const listener = vi.fn();
    scene.on('environmentchange', listener);

    scene.setBackground('#101018');
    scene.setLinearFog('#000000', 1, 10);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('registers and unregisters cameras through the scene', () => {
    const scene = new Scene();
    const camera = scene.add(new CameraStub());
    expect(scene.cameras).toContain(camera);

    scene.remove(camera);
    expect(scene.cameras).not.toContain(camera);
  });
});

describe('EventEmitter in isolation', () => {
  it('returns an unsubscribe count from listenerCount and hasListener', () => {
    const emitter = new EventEmitter<{ ping: [number] }>();
    const listener = vi.fn();

    emitter.on('ping', listener);
    expect(emitter.hasListener('ping', listener)).toBe(true);
    expect(emitter.listenerCount('ping')).toBe(1);

    emitter.emit('ping', 7);
    expect(listener).toHaveBeenCalledWith(7);

    expect(emitter.off('ping', listener)).toBe(true);
    expect(emitter.listenerCount('ping')).toBe(0);
  });

  it('isolates listener errors when an error handler is installed', () => {
    const emitter = new EventEmitter<{ boom: [] }>();
    const errors: unknown[] = [];
    emitter.onError((error) => errors.push(error.error));

    emitter.on('boom', () => {
      throw new Error('listener failed');
    });

    expect(() => emitter.emit('boom')).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('stops delivering after removeAll()', () => {
    const emitter = new EventEmitter<{ ping: [] }>();
    const listener = vi.fn();
    emitter.on('ping', listener);
    emitter.removeAll();

    emitter.emit('ping');
    expect(listener).not.toHaveBeenCalled();
    expect(emitter.totalListenerCount).toBe(0);
  });
});

/** Minimal `Camera` stand-in so the scene-registration test needs no projection. */
class CameraStub extends Camera {}
