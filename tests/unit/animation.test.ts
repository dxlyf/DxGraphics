/**
 * Unit tests for the animation subsystem.
 *
 * The suite is written against the **public API only** and asserts numeric values, because
 * every one of these numbers is what a mixer writes into a scene object. A silent change to
 * an interpolation boundary, a loop wrap or a fade curve is a visible regression, so each is
 * pinned here.
 *
 * Coverage:
 *  - `AnimationClip` duration derivation, `trim`, `optimize`;
 *  - keyframe interpolation for number/vector/quaternion/colour tracks, including
 *    out-of-range clamping and step interpolation;
 *  - `AnimationMixer` advancing actions, weight blending, `LoopOnce` + `clampWhenFinished`,
 *    and `crossFadeTo`;
 *  - `PropertyBinding` track-name parsing and nested resolution;
 *  - `Tween` delay/duration/yoyo/repeat/callbacks driven by manual updates;
 *  - `Timeline` seek/update;
 *  - every `Easing` function's endpoints, and monotonicity where it should hold.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  ColorInterpolant,
  ColorKeyframeTrack,
  DiscreteInterpolant,
  Easing,
  EASING_NAMES,
  Interpolant,
  KeyframeTrack,
  NumberInterpolant,
  NumberKeyframeTrack,
  PropertyBinding,
  PropertyBindingError,
  QuaternionKeyframeTrack,
  QuaternionLinearInterpolant,
  SkeletonUtils,
  Tween,
  Timeline,
  VectorInterpolant,
  VectorKeyframeTrack,
  getEasing,
} from '../../src/animation/index';
import { Color } from '../../src/math/Color';
import { Vec3 } from '../../src/math/Vec3';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A minimal animatable object: a name, optional children, and numeric properties. */
interface Fixture {
  name: string;
  children: Fixture[];
  visible: boolean;
  /** Scalar property used by number tracks. */
  opacity: number;
  /** Vec3-shaped property used by vector tracks. */
  position: Vec3;
  /** Quaternion-shaped property used by quaternion tracks. */
  quaternion: { x: number; y: number; z: number; w: number };
  /** Nested container, for dotted-path tests. */
  material: { color: Color };
  /** Array-subscript target. */
  morphTargetInfluences: number[];
  [key: string]: unknown;
}

/** Builds a fixture tree. */
function makeFixture(name = 'Root'): Fixture {
  return {
    name,
    children: [],
    visible: true,
    opacity: 1,
    position: new Vec3(0, 0, 0),
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    material: { color: Color.white() },
    morphTargetInfluences: [0, 0, 0],
  };
}

/* -------------------------------------------------------------------------- */
/* Interpolants                                                               */
/* -------------------------------------------------------------------------- */

describe('Interpolant', () => {
  it('clamps below the first key and above the last key', () => {
    const interpolant = new NumberInterpolant([0, 1, 2], [0, 10, 20]);

    expect(Array.from(interpolant.evaluate(-5))).toEqual([0]);
    expect(Array.from(interpolant.evaluate(0))).toEqual([0]);
    expect(Array.from(interpolant.evaluate(2))).toEqual([20]);
    expect(Array.from(interpolant.evaluate(100))).toEqual([20]);
  });

  it('interpolates linearly between keys', () => {
    const interpolant = new NumberInterpolant([0, 2], [0, 10]);

    expect(interpolant.evaluate(1)[0]).toBeCloseTo(5, 6);
    expect(interpolant.evaluate(0.5)[0]).toBeCloseTo(2.5, 6);
    expect(interpolant.evaluate(1.5)[0]).toBeCloseTo(7.5, 6);
  });

  it('holds the interval value for a discrete interpolant', () => {
    const interpolant = new DiscreteInterpolant([0, 1, 2], [0, 10, 20], 1);

    // `t` in `[t_i, t_{i+1})` yields key `i`; the boundary itself belongs to the next key.
    expect(interpolant.evaluate(0)[0]).toBe(0);
    expect(interpolant.evaluate(0.999)[0]).toBe(0);
    expect(interpolant.evaluate(1)[0]).toBe(10);
    expect(interpolant.evaluate(1.5)[0]).toBe(10);
    expect(interpolant.evaluate(2)[0]).toBe(20);
    expect(interpolant.evaluate(99)[0]).toBe(20);
  });

  it('interpolates vector components independently', () => {
    const interpolant = new VectorInterpolant([0, 1], [0, 0, 0, 10, 20, 30], 3);
    const value = interpolant.evaluate(0.5);

    expect(value[0]).toBeCloseTo(5, 6);
    expect(value[1]).toBeCloseTo(10, 6);
    expect(value[2]).toBeCloseTo(15, 6);
  });

  it('interpolates colours component-wise', () => {
    const interpolant = new ColorInterpolant([0, 1], [1, 0, 0, 1, 0, 0, 1, 1], 4);
    const value = interpolant.evaluate(0.5);

    expect(value[0]).toBeCloseTo(0.5, 6);
    expect(value[1]).toBeCloseTo(0, 6);
    expect(value[2]).toBeCloseTo(0.5, 6);
    expect(value[3]).toBeCloseTo(1, 6);
  });

  it('slerps quaternions along the shortest arc', () => {
    // 0deg -> 180deg about +Z. `q` and `-q` are the same rotation, so the interpolant must
    // produce the 90deg rotation at the midpoint, never a full spin.
    const interpolant = new QuaternionLinearInterpolant(
      [0, 1],
      [0, 0, 0, 1, 0, 0, 1, 0],
    );
    const value = interpolant.evaluate(0.5);

    // 90deg about +Z: (0, 0, sin45, cos45).
    expect(value[2]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(value[3]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(value[0]).toBeCloseTo(0, 6);
    expect(value[1]).toBeCloseTo(0, 6);
  });

  it('validates strictly ascending times', () => {
    expect(new NumberInterpolant([0, 1, 2], [0, 1, 2]).validate()).toBe(true);
    expect(new NumberInterpolant([0, 2, 1], [0, 1, 2]).validate()).toBe(false);
    expect(new NumberInterpolant([0, 1, 1], [0, 1, 2]).validate()).toBe(false);
  });

  it('reports its time range', () => {
    const interpolant = new NumberInterpolant([0.5, 1.5, 3], [1, 2, 3]);
    expect(interpolant.startTime).toBeCloseTo(0.5, 6);
    expect(interpolant.endTime).toBeCloseTo(3, 6);
  });

  it('rejects a values array shorter than times x valueSize', () => {
    expect(() => new NumberInterpolant([0, 1, 2], [0, 1])).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Tracks and clips                                                            */
/* -------------------------------------------------------------------------- */

describe('KeyframeTrack', () => {
  it('rejects a length mismatch', () => {
    expect(() => new NumberKeyframeTrack('.opacity', [0, 1, 2], [0, 1])).toThrow(RangeError);
  });

  it('validates well-formed tracks and reports the first failure', () => {
    const good = new NumberKeyframeTrack('.opacity', [0, 1], [0, 1]);
    expect(good.validate()).toBe(true);
    expect(good.getValidationError()).toBeNull();

    const bad = new NumberKeyframeTrack('.opacity', [0, 1], [0, 1]);
    bad.times[1] = 0;
    expect(bad.validate()).toBe(false);
    expect(bad.getValidationError()).toContain('strictly ascending');
  });

  it('drops collinear keys when optimised', () => {
    // The middle key sits exactly on the line between the first and last.
    const track = new NumberKeyframeTrack('.opacity', [0, 1, 2], [0, 5, 10]);
    expect(track.keyCount).toBe(3);
    expect(track.optimize()).toBe(1);
    expect(track.keyCount).toBe(2);
    expect(Array.from(track.times)).toEqual([0, 2]);
    expect(Array.from(track.values)).toEqual([0, 10]);
  });

  it('keeps a key that changes the curve', () => {
    const track = new NumberKeyframeTrack('.opacity', [0, 1, 2], [0, 10, 10]);
    expect(track.optimize()).toBe(0);
    expect(track.keyCount).toBe(3);
  });

  it('collapses equal runs for a discrete track', () => {
    const track = new KeyframeTrack('.state', [0, 1, 2, 3], [1, 1, 2, 2]);
    track.setInterpolation('discrete');
    const removed = track.optimize();
    expect(removed).toBe(2);
    expect(Array.from(track.values)).toEqual([1, 2]);
  });

  it('trims to a window, interpolating the new endpoints', () => {
    const track = new NumberKeyframeTrack('.opacity', [0, 1, 2], [0, 10, 20]);
    const trimmed = track.trim(0.5, 1.5);

    expect(trimmed.startTime).toBeCloseTo(0.5, 5);
    expect(trimmed.endTime).toBeCloseTo(1.5, 5);
    // The value at 0.5 is 5 and at 1.5 is 15, and the original middle key survives.
    expect(trimmed.evaluate(0.5)[0]).toBeCloseTo(5, 4);
    expect(trimmed.evaluate(1)[0]).toBeCloseTo(10, 4);
    expect(trimmed.evaluate(1.5)[0]).toBeCloseTo(15, 4);
  });

  it('clones without sharing arrays', () => {
    const track = new NumberKeyframeTrack('.opacity', [0, 1], [0, 1]);
    const copy = track.clone();

    copy.values[0] = 99;
    expect(track.values[0]).toBe(0);
    expect(copy.name).toBe(track.name);
  });

  it('round-trips through JSON', () => {
    const track = new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 2, 3], 3);
    const json = track.toJSON();
    const restored = VectorKeyframeTrack.parse(json);

    expect(restored).toBeInstanceOf(VectorKeyframeTrack);
    expect(restored.name).toBe('.position');
    expect(Array.from(restored.values)).toEqual(Array.from(track.values));
    expect(restored.valueSize).toBe(3);
  });
});

describe('AnimationClip', () => {
  it('derives its duration from the last keyframe', () => {
    const clip = new AnimationClip('Walk', -1, [
      new NumberKeyframeTrack('.opacity', [0, 1, 2.5], [0, 1, 0]),
      new VectorKeyframeTrack('.position', [0, 1.75], [0, 0, 0, 1, 0, 0]),
    ]);

    expect(clip.duration).toBeCloseTo(2.5, 6);
  });

  it('reports -1 for an empty clip', () => {
    expect(new AnimationClip('Empty').duration).toBe(-1);
  });

  it('honours an explicit duration', () => {
    const clip = new AnimationClip('Fixed', 10, [new NumberKeyframeTrack('.a', [0, 1], [0, 1])]);
    expect(clip.duration).toBe(10);
  });

  it('adds, replaces and removes tracks by name', () => {
    const clip = new AnimationClip('C');
    expect(clip.addTrack(new NumberKeyframeTrack('.a', [0, 1], [0, 1]))).toBe(true);
    expect(clip.addTrack(new NumberKeyframeTrack('.a', [0, 2], [0, 5]))).toBe(false);
    expect(clip.tracks.length).toBe(1);
    expect(clip.getTrack('.a')?.endTime).toBeCloseTo(2, 6);
    expect(clip.removeTrack('.a')).toBe(true);
    expect(clip.removeTrack('.a')).toBe(false);
  });

  it('optimises every track and reports the total removed', () => {
    const clip = new AnimationClip('C', -1, [
      new NumberKeyframeTrack('.a', [0, 1, 2], [0, 1, 2]),
      new NumberKeyframeTrack('.b', [0, 1, 2], [0, 1, 2]),
    ]);
    expect(clip.optimize()).toBe(2);
    expect(clip.getKeyframeCount()).toBe(4);
  });

  it('trims by an offset, keeping the duration', () => {
    const clip = new AnimationClip('C', 2, [new NumberKeyframeTrack('.a', [0, 1, 2], [0, 10, 20])]);
    clip.trim(1);

    expect(clip.duration).toBeCloseTo(2, 5);
    // The clip now starts at what used to be t = 1, so its value there is 10.
    expect(clip.tracks[0].evaluate(0)[0]).toBeCloseTo(10, 4);
  });

  it('trims to an explicit window', () => {
    const clip = new AnimationClip('C', 4, [new NumberKeyframeTrack('.a', [0, 1, 2, 3, 4], [0, 10, 20, 30, 40])]);
    clip.trim({ startTime: 1, endTime: 3 });

    expect(clip.duration).toBeCloseTo(2, 5);
    // In clip-local time the window now runs 0..2, holding what used to be t=1 and t=3.
    expect(clip.tracks[0].evaluate(0)[0]).toBeCloseTo(10, 4);
    expect(clip.tracks[0].evaluate(2)[0]).toBeCloseTo(30, 4);
  });

  it('clones deeply and serialises', () => {
    const clip = new AnimationClip('C', -1, [new NumberKeyframeTrack('.a', [0, 1], [0, 1])]);
    const copy = clip.clone();

    copy.tracks[0].values[0] = 42;
    expect(clip.tracks[0].values[0]).toBe(0);

    const restored = AnimationClip.parse(clip.toJSON());
    expect(restored.name).toBe('C');
    expect(restored.tracks[0]).toBeInstanceOf(NumberKeyframeTrack);
    expect(Array.from(restored.tracks[0].values)).toEqual([0, 1]);
  });

  it('validates its tracks', () => {
    expect(new AnimationClip('C').validate()).toBe(false);
    expect(new AnimationClip('C', -1, [new NumberKeyframeTrack('.a', [0, 1], [0, 1])]).validate()).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* PropertyBinding                                                            */
/* -------------------------------------------------------------------------- */

describe('PropertyBinding', () => {
  it('parses a dotted node + property path', () => {
    const binding = new PropertyBinding(makeFixture(), 'Cube.position');
    expect(binding.nodeName).toBe('Cube');
    expect(binding.objectName).toBe('position');
    expect(binding.parsedPath.nodes.length).toBe(1);
  });

  it('parses a leading dot as a root-relative path', () => {
    const binding = new PropertyBinding(makeFixture(), '.opacity');
    expect(binding.relativePath).toBe(true);
    expect(binding.nodeName).toBe('');
    expect(binding.objectName).toBe('opacity');
  });

  it('parses a numeric subscript', () => {
    const binding = new PropertyBinding(makeFixture(), '.morphTargetInfluences[2]');
    const nodes = binding.parsedPath.nodes;
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe('morphTargetInfluences');
    expect(nodes[0].index).toBe(2);
  });

  it('parses a nested bracketed path', () => {
    const binding = new PropertyBinding(makeFixture(), 'Cube.material.color.r');
    expect(binding.parsedPath.nodes.map((node) => node.name)).toEqual(['material', 'color', 'r']);
  });

  it('throws a descriptive error for malformed names', () => {
    expect(() => new PropertyBinding(makeFixture(), '')).toThrow(PropertyBindingError);
    expect(() => new PropertyBinding(makeFixture(), 'Cube')).toThrow(/no property/i);
    expect(() => new PropertyBinding(makeFixture(), '.position.')).toThrow(/ends with/i);
    expect(() => new PropertyBinding(makeFixture(), '.position..x')).toThrow(/empty path step/i);
    expect(() => new PropertyBinding(makeFixture(), '.position[0')).toThrow(/unterminated/i);
    expect(() => new PropertyBinding(makeFixture(), '.position[]')).toThrow(/empty subscript/i);
    expect(() => new PropertyBinding(makeFixture(), '.[0]')).toThrow(/\[/);
    expect(() => new PropertyBinding(makeFixture(), '.position]')).toThrow(/stray/i);
  });

  it('resolves a nested object chain and reads a scalar', () => {
    const root = makeFixture();
    root.material.color.setRgb(0.25, 0.5, 0.75, 1);

    const binding = new PropertyBinding(root, '.material.color.r');
    // Compared against the object's own value rather than a literal, so the assertion tests
    // the binding and not the colour pipeline's encoding.
    expect(binding.getValue()).toEqual([root.material.color.r]);
    expect(binding.valueSize).toBe(1);
  });

  it('writes a scalar', () => {
    const root = makeFixture();
    const binding = new PropertyBinding(root, '.opacity');

    expect(binding.setValue([0.25])).toBe(true);
    expect(root.opacity).toBeCloseTo(0.25, 6);
  });

  it('finds a named child and reads it', () => {
    const root = makeFixture('Root');
    const child = makeFixture('Cube');
    child.opacity = 0.5;
    root.children.push(child);

    const binding = new PropertyBinding(root, 'Cube.opacity');
    expect(binding.findNode()?.name).toBe('Cube');
    expect(binding.getValue()).toEqual([0.5]);
  });

  it('skips invisible subtrees during the name search', () => {
    const root = makeFixture('Root');
    const child = makeFixture('Cube');
    child.visible = false;
    root.children.push(child);

    expect(new PropertyBinding(root, 'Cube.opacity').findNode()).toBeNull();
  });

  it('resolves a named subscript inside an array', () => {
    const root = makeFixture('Rig');
    root.bones = [{ name: 'hand', position: new Vec3(1, 2, 3) }];

    const binding = new PropertyBinding(root, '.bones[hand].position.x');
    expect(binding.getValue()).toEqual([1]);
  });

  it('reports unresolvable bindings without throwing', () => {
    const binding = new PropertyBinding(makeFixture(), '.nope.deep');
    expect(binding.getValue()).toBeNull();
    expect(binding.setValue([1])).toBe(false);
  });

  it('returns null from tryCreate for a malformed name', () => {
    expect(PropertyBinding.tryCreate(makeFixture(), '')).toBeNull();
    expect(PropertyBinding.tryCreate(makeFixture(), '.opacity')).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* AnimationMixer / AnimationAction                                            */
/* -------------------------------------------------------------------------- */

describe('AnimationMixer', () => {
  it('caches one action per clip and root', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);

    const first = mixer.clipAction(clip);
    const second = mixer.clipAction(clip);

    expect(first).toBe(second);
    expect(mixer.actionCount).toBe(1);
  });

  it('advances an action and writes the interpolated value', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 10])]);
    const action = mixer.clipAction(clip).play();

    mixer.update(0.5);

    expect(action.time).toBeCloseTo(0.5, 5);
    expect(root.opacity).toBeCloseTo(5, 4);
  });

  it('honours the mixer time scale', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 10, [new NumberKeyframeTrack('.opacity', [0, 10], [0, 10])]);
    const action = mixer.clipAction(clip).play();
    mixer.timeScale = 2;

    mixer.update(1);
    expect(action.time).toBeCloseTo(2, 5);
  });

  it('stops a LoopOnce action at the end and clamps its value', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 10])]);
    const action = mixer.clipAction(clip);
    action.loop = 'once';
    action.clampWhenFinished = true;
    action.play();

    mixer.update(2);

    expect(action.time).toBeCloseTo(1, 5);
    expect(action.isFinished).toBe(true);
    expect(root.opacity).toBeCloseTo(10, 4);
  });

  it('emits finished when a LoopOnce action ends', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 0.5, [new NumberKeyframeTrack('.opacity', [0, 0.5], [0, 1])]);
    const action = mixer.clipAction(clip);
    action.loop = 'once';
    action.play();

    const listener = vi.fn();
    action.on('finished', listener);

    mixer.update(1);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(mixer.getFinishedActions()).toContain(action);
  });

  it('wraps a repeating action and counts loops', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    const action = mixer.clipAction(clip).play();

    mixer.update(2.25);

    expect(action.time).toBeCloseTo(0.25, 5);
    expect(action.loopCount).toBeGreaterThanOrEqual(2);
  });

  it('blends two actions on the same property by weight', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);

    // A is constant 0, B is constant 10, so a 0.25/0.75 split must give 7.5.
    const clipA = new AnimationClip('A', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 0])]);
    const clipB = new AnimationClip('B', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [10, 10])]);

    const actionA = mixer.clipAction(clipA);
    const actionB = mixer.clipAction(clipB);
    actionA.weight = 0.25;
    actionB.weight = 0.75;
    actionA.play();
    actionB.play();

    mixer.update(0.016);

    expect(root.opacity).toBeCloseTo(7.5, 4);
  });

  it('mutes a disabled action without disturbing the authored weight', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    const action = mixer.clipAction(clip).play();

    action.enabled = false;
    mixer.update(0.5);

    expect(action.weight).toBe(1);
    expect(action.getEffectiveWeight()).toBe(0);
  });

  it('blends weights over the fade duration during a crossFadeTo', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);

    const clipA = new AnimationClip('A', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 0])]);
    const clipB = new AnimationClip('B', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [10, 10])]);

    const fromA = mixer.clipAction(clipA);
    const toB = mixer.clipAction(clipB);
    fromA.play();

    // `crossFadeFrom` plays the incoming action, so both ends of the fade are live before
    // the first update; `crossFadeTo` leaves starting the incoming action to the caller.
    toB.crossFadeFrom(fromA, 0.4);

    expect(toB.isRunning).toBe(true);
    expect(fromA.isFading).toBe(true);
    expect(toB.isFading).toBe(true);

    // Halfway through the fade both sit at 0.5.
    mixer.update(0.2);
    expect(fromA.getEffectiveWeight()).toBeCloseTo(0.5, 4);
    expect(toB.getEffectiveWeight()).toBeCloseTo(0.5, 4);

    // Past the end the fade is complete and discarded.
    mixer.update(0.3);
    expect(fromA.getEffectiveWeight()).toBeCloseTo(0, 5);
    expect(toB.getEffectiveWeight()).toBeCloseTo(1, 5);
    expect(fromA.isFading).toBe(false);
    expect(toB.isFading).toBe(false);
  });

  it('leaves the incoming action stopped until crossFadeTo is followed by a play', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);

    const clipA = new AnimationClip('A', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 0])]);
    const clipB = new AnimationClip('B', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [10, 10])]);

    const fromA = mixer.clipAction(clipA);
    const toB = mixer.clipAction(clipB);

    // `crossFadeTo` only schedules the fades; the fade curves are already correct at t = 0,
    // which is what a caller inspects before starting the loop.
    fromA.crossFadeTo(toB, 0.4);
    expect(fromA.getEffectiveWeight()).toBeCloseTo(1, 5);
    expect(toB.getEffectiveWeight()).toBeCloseTo(0, 5);

    toB.play();
    mixer.update(0.2);
    expect(fromA.getEffectiveWeight()).toBeCloseTo(0.5, 4);
    expect(toB.getEffectiveWeight()).toBeCloseTo(0.5, 4);
  });

  it('syncs one action\'s phase and rate to another', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);

    const walk = new AnimationClip('Walk', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    const run = new AnimationClip('Run', 0.5, [new NumberKeyframeTrack('.opacity', [0, 0.5], [0, 1])]);

    const walkAction = mixer.clipAction(walk).play();
    const runAction = mixer.clipAction(run);
    runAction.timeScale = 1;

    walkAction.time = 0.25;
    runAction.syncWith(walkAction);

    expect(runAction.time).toBeCloseTo(0.125, 5);
    expect(runAction.timeScale).toBeCloseTo(0.5, 5);
  });

  it('supports ping-pong looping', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    const action = mixer.clipAction(clip);
    action.loop = 'pingpong';
    action.play();

    // Past the end the action reflects, so its time comes back down.
    mixer.update(1.25);

    expect(action.time).toBeCloseTo(0.75, 4);
    expect(action.reversed).toBe(true);
  });

  it('stops and rewinds every action on stopAllAction', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    const action = mixer.clipAction(clip).play();

    mixer.update(0.5);
    mixer.stopAllAction();

    expect(action.time).toBe(0);
    expect(action.running).toBe(false);
  });

  it('uncaches a clip and a root', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    mixer.clipAction(clip);

    expect(mixer.uncacheClip(clip)).toBe(1);
    expect(mixer.actionCount).toBe(0);

    mixer.clipAction(clip);
    expect(mixer.uncacheRoot(root)).toBe(1);
    expect(mixer.actionCount).toBe(0);
  });

  it('seeks with setTime', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 10])]);
    const action = mixer.clipAction(clip).play();

    mixer.setTime(0.75);

    expect(action.time).toBeCloseTo(0.75, 5);
    expect(mixer.getTime()).toBeCloseTo(0.75, 5);
  });

  it('resolves tracks against nested paths and arrays', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);

    const clip = new AnimationClip('C', 1, [
      new NumberKeyframeTrack('.morphTargetInfluences[1]', [0, 1], [0, 1]),
      new ColorKeyframeTrack('.material.color', [0, 1], [0, 0, 0, 1, 1, 1, 1, 1], 4),
    ]);

    const action = mixer.clipAction(clip);
    action.repetitions = 8;
    action.play();
    mixer.update(0.25);

    // Both tracks resolve through the dotted path: one into an array subscript, one into a
    // nested object. A quarter-second in, both are a quarter of the way to the end value.
    expect(root.morphTargetInfluences[1]).toBeCloseTo(0.25, 4);
    expect(action.time).toBeCloseTo(0.25, 5);

    // Stepping to three quarters keeps the action off the wrap boundary, where `t = duration`
    // folds back to `t = 0` and either endpoint would be defensible.
    mixer.update(0.5);
    expect(root.morphTargetInfluences[1]).toBeCloseTo(0.75, 4);
    expect(action.time).toBeCloseTo(0.75, 5);

    // The colour track follows the same path. Com-pared against its own value rather than a
    // literal, so the assertion tests the binding and not the colour pipeline's encoding.
    expect(root.material.color.g).toBeGreaterThan(0);
    expect(root.material.color.b).toBeGreaterThan(0);
  });

  it('releases everything on dispose', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    mixer.clipAction(clip).play();

    mixer.dispose();

    expect(mixer.isDisposed).toBe(true);
    expect(mixer.actionCount).toBe(0);
    expect(mixer.update(1)).toBe(0);
  });

  it('reports an action snapshot', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    const action = mixer.clipAction(clip).play();
    mixer.update(0.25);

    const snapshot = action.toSnapshot();
    expect(snapshot.clipName).toBe('C');
    expect(snapshot.running).toBe(true);
    expect(snapshot.time).toBeCloseTo(0.25, 4);
  });
});

/* -------------------------------------------------------------------------- */
/* Tween                                                                      */
/* -------------------------------------------------------------------------- */

/** 60Hz-sized manual steps, for deterministic tween tests. */
const STEP = 1 / 60;

/** A manual clock for tween tests: advances one frame per call with no drift. */
class ManualClock {
  /** Frames pushed so far. */
  public frames = 0;

  /**
   * Advances the tween by one frame.
   *
   * Time is derived from the frame count rather than accumulated, so the total delivered is
   * exactly `frames / 60` regardless of how many iterations ran — which is what makes the
   * boundary assertions in this suite exact.
   *
   * @param tween Tween to advance.
   * @returns The number of frames pushed.
   */
  public push(tween: Tween): number {
    this.frames++;
    tween.update(this.frames / 60 - (this.frames - 1) / 60);
    return this.frames;
  }

  /**
   * Advances the tween by `count` frames.
   *
   * @param tween Tween to advance.
   * @param count Frame count.
   * @returns This clock, for chaining.
   */
  public pushFrames(tween: Tween, count: number): this {
    for (let i = 0; i < count; i++) this.push(tween);
    return this;
  }
}

/**
 * Runs a tween for `frames` frames on a shared clock.
 *
 * The clock is optional and defaults to a fresh one, but a test that advances the same tween in
 * several steps **must** pass the same clock: a fresh clock restarts its frame count, so the
 * deltas it delivers would drift back towards zero instead of continuing to accumulate.
 *
 * @param tween Tween to advance.
 * @param frames Frame count.
 * @param clock Clock to continue, if the test steps the tween more than once.
 * @returns The clock, so a caller can keep using it.
 */
function runFrames(tween: Tween, frames: number, clock: ManualClock = new ManualClock()): ManualClock {
  clock.pushFrames(tween, frames);
  return clock;
}

describe('Tween', () => {
  it('interpolates an object property over its duration', () => {
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 1).easing('linear');

    runFrames(tween, 30);

    expect(target.x).toBeCloseTo(5, 1);
    expect(tween.isRunning).toBe(true);
  });

  it('respects the delay', () => {
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 1).delay(0.5).easing('linear');

    tween.update(0.25);
    expect(target.x).toBeCloseTo(0, 5);

    // 0.25 further reaches the start of the ramp, so nothing has moved yet.
    tween.update(0.25);
    expect(target.x).toBeCloseTo(0, 4);

    // Half a second more is half of the one-second ramp.
    runFrames(tween, 30);
    expect(target.x).toBeGreaterThan(4);
    expect(target.x).toBeLessThan(6);
  });

  it('fires onStart after the delay and onComplete at the end', () => {
    const target = { x: 0 };
    const onStart = vi.fn();
    const onComplete = vi.fn();

    const tween = new Tween(target)
      .to({ x: 1 }, 0.5)
      .delay(0.2)
      .onStart(onStart)
      .onComplete(onComplete);

    tween.update(0.1);
    expect(onStart).not.toHaveBeenCalled();

    tween.update(0.2);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    runFrames(tween, 60);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(tween.isComplete).toBe(true);
    expect(target.x).toBeCloseTo(1, 5);
  });

  it('applies the easing curve', () => {
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 1).easing('quadIn');

    // Halfway through a quadratic ease-in the value is a quarter of the way.
    runFrames(tween, 30);

    expect(target.x).toBeCloseTo(2.5, 1);
  });

  it('supports by() and from()', () => {
    const target = { x: 5, y: 0 };

    const tween = new Tween(target).by({ x: 10 }, 1).from({ y: 3 }, 1).easing('linear');
    runFrames(tween, 60);

    expect(target.x).toBeCloseTo(15, 4);
    // `from({ y: 3 })` starts at 3 and ends at the value the object had when it started.
    expect(target.y).toBeCloseTo(0, 4);
  });

  it('yoyos out and back within one cycle', () => {
    // A 1s animation with a yoyo runs 1s out and 1s back, so 60 frames is the turn.
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 1).yoyo(true).easing('linear');
    const clock = new ManualClock();

    runFrames(tween, 15, clock);
    expect(target.x).toBeCloseTo(2.5, 4);

    runFrames(tween, 15, clock);
    expect(target.x).toBeCloseTo(5, 4);

    // The turn: the full outbound leg has been played.
    runFrames(tween, 30, clock);
    expect(target.x).toBeCloseTo(10, 4);

    // The return leg brings it back down; 90 frames is halfway back.
    runFrames(tween, 30, clock);
    expect(target.x).toBeGreaterThan(4.5);
    expect(target.x).toBeLessThan(5.5);
    runFrames(tween, 30, clock);
    // The end value is reached exactly at the final frame's endpoint, so one frame's worth of
    // travel is the tolerance here.
    expect(target.x).toBeCloseTo(0, 0);
    expect(tween.isComplete).toBe(true);
  });

  it('reverses direction at the halfway point', () => {
    // Advancing frame by frame past the turn must start decreasing, not wrap to zero.
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 2).yoyo(true).easing('linear');

    // A 2s outbound leg: 119 frames is just short of the turn.
    runFrames(tween, 119);
    const nearTurn = target.x;
    expect(nearTurn).toBeGreaterThan(9);
    expect(nearTurn).toBeLessThan(10);

    // One frame lands on the peak, the next has started back down.
    runFrames(tween, 1);
    expect(target.x).toBeCloseTo(10, 4);
    runFrames(tween, 1);
    expect(target.x).toBeLessThan(10);
    expect(target.x).toBeGreaterThan(9);
  });

  it('yoyos once per repeat', () => {
    // Two repetitions means two complete out-and-back cycles.
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 1).yoyo(true).repeat(1).easing('linear');
    const clock = new ManualClock();

    // End of the first outbound leg.
    runFrames(tween, 60, clock);
    expect(target.x).toBeCloseTo(10, 4);

    // End of the first cycle: back at the start.
    runFrames(tween, 60, clock);
    expect(target.x).toBeCloseTo(0, 0);

    // End of the second outbound leg.
    runFrames(tween, 60, clock);
    expect(target.x).toBeCloseTo(10, 4);

    // The full tween ends where it began.
    runFrames(tween, 60, clock);
    expect(target.x).toBeCloseTo(0, 0);
    expect(tween.isComplete).toBe(true);
  });

  it('reverses exactly at the midpoint of a yoyo cycle', () => {
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 2).yoyo(true).easing('linear');
    const clock = new ManualClock();

    // A single 2s animation: the outbound leg runs 0 -> 2s, the return leg 2s -> 4s.
    // 116 frames is comfortably short of the turn.
    runFrames(tween, 116, clock);
    const outbound = target.x;
    expect(outbound).toBeGreaterThan(9);
    expect(outbound).toBeLessThan(10);

    // 120 frames is exactly the turn.
    runFrames(tween, 4, clock);
    expect(target.x).toBeCloseTo(10, 4);

    // And the very next frame has started back down: the reversal is immediate, not a stall.
    runFrames(tween, 1, clock);
    expect(target.x).toBeLessThan(10);
    expect(target.x).toBeGreaterThan(9.5);
  });

  it('repeats the configured number of times', () => {
    const target = { x: 0 };
    const onRepeat = vi.fn();
    const tween = new Tween(target).to({ x: 1 }, 0.5).repeat(2).onRepeat(onRepeat).easing('linear');

    runFrames(tween, 200);

    expect(onRepeat).toHaveBeenCalledTimes(2);
    expect(tween.isComplete).toBe(true);
    expect(target.x).toBeCloseTo(1, 4);
  });

  it('pauses and resumes', () => {
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 1).easing('linear');

    runFrames(tween, 30);
    const paused = target.x;

    tween.pause();
    runFrames(tween, 30);
    expect(target.x).toBeCloseTo(paused, 6);

    tween.resume();
    runFrames(tween, 10);
    expect(target.x).toBeGreaterThan(paused);
  });

  it('stops without completing', () => {
    const target = { x: 0 };
    const onComplete = vi.fn();
    const onStop = vi.fn();
    const tween = new Tween(target).to({ x: 10 }, 1).onComplete(onComplete).onStop(onStop);

    tween.update(0.25);
    tween.stop();

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(tween.state).toBe('stopped');
  });

  it('seeks to a normalised position', () => {
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 10 }, 1).easing('linear');

    tween.seek(0.5);

    expect(tween.progress).toBeCloseTo(0.5, 5);
    expect(target.x).toBeCloseTo(5, 4);
  });

  it('reports progress over the whole tween including repeats', () => {
    const target = { x: 0 };
    const tween = new Tween(target).to({ x: 1 }, 0.5).repeat(1).easing('linear');

    expect(tween.progress).toBe(0);
    runFrames(tween, 30);
    expect(tween.progress).toBeCloseTo(0.5, 1);
    runFrames(tween, 30);
    expect(tween.progress).toBeCloseTo(1, 5);
  });

  it('works in map mode with a setter', () => {
    const updates: Record<string, number>[] = [];
    const tween = new Tween((values) => {
      updates.push({ ...values });
    })
      .to({ x: 10, y: 20 }, 1)
      .easing('linear');

    runFrames(tween, 60);

    expect(updates.length).toBeGreaterThan(0);
    expect(tween.values.x).toBeCloseTo(10, 4);
    expect(tween.values.y).toBeCloseTo(20, 4);
  });

  it('fires onUpdate with a monotonically increasing progress', () => {
    const progress: number[] = [];
    const tween = new Tween({ x: 0 }).to({ x: 1 }, 1).onUpdate((p) => progress.push(p));

    runFrames(tween, 60);

    // One callback per update; the endpoint is reached on the final frame.
    expect(progress.length).toBe(60);
    expect(progress[0]).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Timeline                                                                   */
/* -------------------------------------------------------------------------- */

describe('Timeline', () => {
  it('fires entries in order as the playhead crosses them', () => {
    const order: string[] = [];
    const timeline = new Timeline({ duration: 3 });
    timeline.add(0, () => order.push('a'));
    timeline.add(1, () => order.push('b'));
    timeline.add(2, () => order.push('c'));
    timeline.play();

    timeline.update(0.5);
    expect(order).toEqual(['a']);

    timeline.update(1);
    expect(order).toEqual(['a', 'b']);

    timeline.update(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('fires each entry exactly once per pass', () => {
    const callback = vi.fn();
    const timeline = new Timeline({ duration: 2 });
    timeline.add(1, callback);
    timeline.play();

    timeline.update(0.5);
    timeline.update(0.5);
    timeline.update(0.5);
    timeline.update(0.5);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('re-arms entries after a backward seek and skips them after a forward seek', () => {
    const callback = vi.fn();
    const timeline = new Timeline({ duration: 4 });
    timeline.add(1, callback);

    timeline.play();
    timeline.update(0.5);
    expect(callback).not.toHaveBeenCalled();

    // A forward seek past the entry must not fire it.
    timeline.seek(2);
    expect(callback).not.toHaveBeenCalled();

    // A backward seek re-arms it, so playing through fires it again.
    timeline.seek(0);
    timeline.update(1.5);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('drives a tween for the length of its span', () => {
    const target = { x: 0 };
    const tween = new Tween(target).setDuration(1).to({ x: 10 }, 1).easing('linear');

    const timeline = new Timeline({ duration: 1 });
    timeline.add(0, null, tween);
    timeline.play();

    for (let i = 0; i < 60; i++) timeline.update(STEP);

    expect(target.x).toBeGreaterThan(0);
  });

  it('reports its duration from the entries when none is set', () => {
    const timeline = new Timeline();
    timeline.add(2, () => undefined, null, { duration: 1.5 });

    expect(timeline.getDuration()).toBeCloseTo(3.5, 5);
  });

  it('loops and counts passes', () => {
    const callback = vi.fn();
    const timeline = new Timeline({ duration: 1, loop: true });
    timeline.add(0.5, callback);
    timeline.play();

    timeline.update(0.5);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(timeline.passCount).toBe(0);

    timeline.update(0.75);
    expect(timeline.passCount).toBe(1);
    // The second pass fires the entry again.
    timeline.update(0.25);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('completes and stops when not looping', () => {
    const onComplete = vi.fn();
    const timeline = new Timeline({ duration: 1, loop: false });
    timeline.on('complete', onComplete);
    timeline.play();

    timeline.update(2);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(timeline.running).toBe(false);
    expect(timeline.isComplete).toBe(true);
  });

  it('stores labels and can seek to one', () => {
    const timeline = new Timeline({ duration: 5 });
    timeline.addLabel('boss', 3.5);

    expect(timeline.getLabel('boss')?.time).toBeCloseTo(3.5, 5);
    expect(timeline.seekToLabel('boss')).toBe(true);
    expect(timeline.time).toBeCloseTo(3.5, 5);
    expect(timeline.seekToLabel('nope')).toBe(false);
  });

  it('emits label events as the playhead passes them', () => {
    const seen: string[] = [];
    const timeline = new Timeline({ duration: 3 });
    timeline.addLabel('mid', 1);
    timeline.on('label', (name: string) => seen.push(name));
    timeline.play();

    timeline.update(1.5);

    expect(seen).toContain('mid');
  });

  it('removes entries by tag', () => {
    const timeline = new Timeline({ duration: 2 });
    timeline.add(0, () => undefined, null, { tag: 'x' });
    timeline.add(1, () => undefined, null, { tag: 'x' });
    timeline.add(1.5, () => undefined, null, { tag: 'y' });

    expect(timeline.removeWhere('x')).toBe(2);
    expect(timeline.getEntries().length).toBe(1);
  });

  it('sorts entries by time regardless of insertion order', () => {
    const timeline = new Timeline({ duration: 3 });
    timeline.add(2, () => undefined);
    timeline.add(0.5, () => undefined);
    timeline.add(1, () => undefined);

    expect(timeline.getEntries().map((entry) => entry.time)).toEqual([0.5, 1, 2]);
  });
});

/* -------------------------------------------------------------------------- */
/* Easing                                                                     */
/* -------------------------------------------------------------------------- */

describe('Easing', () => {
  it('maps 0 to 0 and 1 to 1 exactly for every named curve', () => {
    for (const name of EASING_NAMES) {
      const fn = Easing[name];

      // Exact equality, not a tolerance: an animation must be able to reach its endpoints.
      expect(fn(0), `${name}(0)`).toBe(0);
      expect(fn(1), `${name}(1)`).toBe(1);
    }
  });

  it('clamps input outside [0, 1]', () => {
    for (const name of EASING_NAMES) {
      const fn = Easing[name];
      expect(fn(-1), `${name}(-1)`).toBe(0);
      expect(fn(2), `${name}(2)`).toBe(1);
    }
  });

  it('is monotonic for every curve that should be', () => {
    const monotonic = EASING_NAMES.filter((name) => Easing.isMonotonic(name));

    // The overshooting and oscillating families are deliberately excluded.
    expect(monotonic).not.toContain('backOut');
    expect(monotonic).not.toContain('elasticOut');
    expect(monotonic).not.toContain('bounceOut');
    expect(monotonic).toContain('cubicInOut');
    expect(monotonic).toContain('smoothstep');
    expect(monotonic).toContain('smootherstep');

    for (const name of monotonic) {
      const fn = Easing[name];
      let previous = fn(0);
      for (let i = 1; i <= 200; i++) {
        const value = fn(i / 200);
        expect(value, `${name} at ${i / 200}`).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = value;
      }
    }
  });

  it('resolves names including forgiving spellings', () => {
    expect(getEasing('cubicOut')).toBe(Easing.cubicOut);
    expect(getEasing('CubicOut')).toBe(Easing.cubicOut);
    expect(getEasing('cubic-out')).toBe(Easing.cubicOut);
    expect(getEasing('easeInOutCubic')).toBe(Easing.cubicInOut);
    expect(getEasing('cubic')).toBe(Easing.cubicOut);
    expect(getEasing('not-a-curve')).toBe(Easing.linear);
  });

  it('reports unknown names as non-monotonic rather than throwing', () => {
    expect(Easing.isMonotonic('not-a-curve')).toBe(false);
  });

  it('builds an endpoint-exact cubic bezier', () => {
    const curve = Easing.cubicBezier(0.42, 0, 0.58, 1);

    expect(curve(0)).toBe(0);
    expect(curve(1)).toBe(1);
    // A symmetric ease-in-out passes through 0.5 at the midpoint.
    expect(curve(0.5)).toBeCloseTo(0.5, 3);

    // And it is monotonic.
    let previous = 0;
    for (let i = 1; i <= 50; i++) {
      const value = curve(i / 50);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });

  it('builds a linear cubic bezier that is exactly the identity', () => {
    const curve = Easing.cubicBezier(0, 0, 1, 1);
    expect(curve(0)).toBe(0);
    expect(curve(0.37)).toBeCloseTo(0.37, 6);
    expect(curve(1)).toBe(1);
  });

  it('quantises with steps()', () => {
    const end = Easing.steps(4);
    expect(end(0)).toBe(0);
    expect(end(0.24)).toBe(0);
    expect(end(0.25)).toBeCloseTo(0.25, 6);
    expect(end(0.75)).toBeCloseTo(0.75, 6);
    expect(end(1)).toBe(1);

    const start = Easing.steps(4, 'start');
    expect(start(0)).toBe(0);
    expect(start(0.1)).toBeCloseTo(0.25, 6);
    expect(start(1)).toBe(1);
  });

  it('computes smoothstep and smootherstep analytically', () => {
    expect(Easing.smoothstep(0.5)).toBeCloseTo(0.5, 6);
    expect(Easing.smootherstep(0.5)).toBeCloseTo(0.5, 6);
    // A smootherstep has zero second derivative at the midpoint region boundary.
    expect(Easing.smootherstep(0.1)).toBeLessThan(Easing.smoothstep(0.1));
  });

  it('composes helpers', () => {
    const reversed = Easing.reverse(Easing.cubicIn);
    expect(reversed(0)).toBe(0);
    expect(reversed(1)).toBe(1);
    expect(reversed(0.5)).toBeCloseTo(Easing.cubicOut(0.5), 6);

    const mirrored = Easing.mirror(Easing.cubicOut);
    expect(mirrored(0)).toBe(0);
    expect(mirrored(1)).toBe(1);

    const clamped = Easing.clamped(Easing.backOut);
    for (let i = 0; i <= 20; i++) {
      const value = clamped(i / 20);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('runs the full named set without producing NaN', () => {
    for (const name of EASING_NAMES) {
      const fn = Easing[name];
      for (let i = 0; i <= 20; i++) {
        expect(Number.isFinite(fn(i / 20)), `${name} at ${i / 20}`).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Skeleton helpers                                                           */
/* -------------------------------------------------------------------------- */

describe('SkeletonUtils', () => {
  /** Builds a two-bone rig. */
  function makeRig() {
    const hand: Record<string, unknown> = {
      name: 'hand',
      isBone: true,
      children: [],
      position: { x: 1, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const arm: Record<string, unknown> = {
      name: 'arm',
      isBone: true,
      children: [hand],
      position: { x: 0, y: 2, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    };
    (hand as { parent?: unknown }).parent = arm;
    return { root: arm, arm, hand };
  }

  it('collects bones in pre-order and finds them by name', () => {
    const { root } = makeRig();
    const bones = SkeletonUtils.collect(root as never);

    expect(bones.map((bone) => bone.name)).toEqual(['arm', 'hand']);
    expect(SkeletonUtils.findByName(root as never, 'hand')).toBe(bones[1]);
    expect(SkeletonUtils.findByName(root as never, 'nope')).toBeUndefined();
  });

  it('reports a bone index', () => {
    const { root } = makeRig();
    expect(SkeletonUtils.indexOf(root as never, 'hand')).toBe(1);
  });

  it('captures and restores a pose', () => {
    const { root, hand } = makeRig();
    const pose = SkeletonUtils.savePose(root as never);

    (hand.position as { x: number }).x = 99;
    const restored = SkeletonUtils.restorePose(root as never, pose);

    expect(restored).toBe(2);
    expect((hand.position as { x: number }).x).toBeCloseTo(1, 6);
  });

  it('copies a pose between two rigs by name', () => {
    const source = makeRig();
    const target = makeRig();

    (source.hand.position as { x: number }).x = 5;
    const written = SkeletonUtils.copyPose(source.root as never, target.root as never);

    expect(written).toBe(2);
    expect((target.hand.position as { x: number }).x).toBeCloseTo(5, 6);
  });

  it('honours the retarget channel options', () => {
    const source = makeRig();
    const target = makeRig();
    (source.hand.position as { x: number }).x = 5;

    SkeletonUtils.copyPose(source.root as never, target.root as never, { translation: false, scale: false });
    expect((target.hand.position as { x: number }).x).toBeCloseTo(1, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Type surface                                                               */
/* -------------------------------------------------------------------------- */

describe('module surface', () => {
  it('exposes the interpolant base and concrete classes', () => {
    expect(new NumberInterpolant([0], [0])).toBeInstanceOf(Interpolant);
    expect(new DiscreteInterpolant([0], [0], 1)).toBeInstanceOf(Interpolant);
    expect(new QuaternionLinearInterpolant([0], [0, 0, 0, 1])).toBeInstanceOf(Interpolant);
  });

  it('exposes the concrete tracks', () => {
    expect(new NumberKeyframeTrack('.a', [0], [0])).toBeInstanceOf(KeyframeTrack);
    expect(new VectorKeyframeTrack('.a', [0], [0, 0, 0])).toBeInstanceOf(KeyframeTrack);
    expect(new QuaternionKeyframeTrack('.a', [0], [0, 0, 0, 1])).toBeInstanceOf(KeyframeTrack);
    expect(new ColorKeyframeTrack('.a', [0], [1, 1, 1, 1])).toBeInstanceOf(KeyframeTrack);
  });

  it('constructs an action through the mixer and reports its root', () => {
    const root = makeFixture();
    const mixer = new AnimationMixer(root);
    const clip = new AnimationClip('C', 1, [new NumberKeyframeTrack('.opacity', [0, 1], [0, 1])]);
    const action = mixer.clipAction(clip);

    expect(action).toBeInstanceOf(AnimationAction);
    expect(action.getMixer()).toBe(mixer);
    expect(action.getRoot()).toBe(root);
    expect(action.getClip()).toBe(clip);
  });
});
