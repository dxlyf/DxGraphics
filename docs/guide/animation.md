# Animation

Two authoring styles: **clips and mixers** for imported or serialisable animation, and
**tweens and timelines** for imperative UI and camera motion.

> **Note:** `src/animation/` is present and exports everything below. It is also **not** imported
> by `src/scene/`: it addresses objects structurally (`{ name, children }` plus arbitrary
> properties) and resolves track names through `PropertyBinding`, so `Object3D`, `Bone` and
> `Skeleton` satisfy it unchanged.

## Clip-based: `AnimationClip` + `AnimationMixer` + `AnimationAction`

This is the three.js-shaped API. Tracks are named property paths, actions carry
weight/speed/loop state, and the mixer blends them.

```ts
import { AnimationClip, AnimationMixer, KeyframeTrack, Object3D } from '@dxyl/graphics';

const character = new Object3D({ name: 'character' });

const clip = new AnimationClip({
  name: 'walk',
  duration: 2,
  tracks: [
    new KeyframeTrack({
      name: 'character.position',          // a property path resolved against the root
      times: new Float32Array([0, 1, 2]),
      values: new Float32Array([0, 0, 0, 0, 0.2, 0, 0, 0, 0]),
      interpolation: 'linear',             // 'linear' | 'step' | 'cubic' | 'smooth'
    }),
    new KeyframeTrack({
      name: 'character.quaternion',
      times: new Float32Array([0, 2]),
      values: new Float32Array([0, 0, 0, 1, 0, 0.7071, 0, 0.7071]),
    }),
  ],
});

const mixer = new AnimationMixer(character);
const walk = mixer.clipAction(clip).play();

// Per frame, in seconds:
mixer.update(0.016);
```

`mixer.update(delta)` returns the number of actions it advanced, which makes it easy to confirm
the mixer actually has work rather than silently doing nothing.

### `AnimationMixer`

| Member | Purpose |
| --- | --- |
| `clipAction(clip, root?)` | Creates (or reuses) an action bound to a root. |
| `existingAction(clip, root?)` | The cached action, or `null`. |
| `getRoot()` | The root the mixer was constructed with. |
| `getActions()` / `getActiveActions()` / `getFinishedActions()` | Action sets. |
| `clearFinishedActions()` | Drops finished actions so they stop being updated. |
| `update(delta)` | Advances every active action. |
| `setTime(time, timeScale?)` / `getTime()` | Deterministic scrubbing. |
| `sample(time)` | Evaluates every track at `time` without advancing, returning the values. |
| `uncacheClip` / `uncacheRoot` / `uncacheAction` | Release the mixer's binding caches. |
| `stopAllAction()` | Stops every action. |
| `resetBindings()` | Re-resolves property paths, after the graph changed shape. |
| `on(name, listener)` / `off(name, listener)` | Mixer events; `on` returns an unsubscribe. |
| `dispose()` | Releases bindings and listeners. |

`mixer.sample(time)` is the tool for a deterministic test or a scrub bar: it evaluates without
touching the mixer's own clock.

### `AnimationAction`

| Member | Purpose |
| --- | --- |
| `play()` / `pause()` / `stop()` / `reset()` | Transport. |
| `setWeight(w)` / `setEffectiveWeight(w)` / `getEffectiveWeight()` | Blending weight. |
| `fadeIn(d)` / `fadeOut(d)` | Fades over `d` seconds (`DEFAULT_FADE_DURATION` is `0.3`). |
| `crossFadeTo(other, duration, warp?)` / `crossFadeFrom(...)` | Paired fades. |
| `setFadeEasing(easing)` | An `EasingFunction` or a name from `Easing`. |
| `syncWith(other)` | Locks the time and time scale to another action. |
| `getClip()` / `getRoot()` / `getMixer()` | Accessors. |
| `getValues()` / `getSlotValues(out)` | The contributions this action computed. |

The usual idle↔walk transition:

```ts
const idle = mixer.clipAction(idleClip).play();
const walk = mixer.clipAction(walkClip);

walk.setEffectiveWeight(1).play();
idle.crossFadeTo(walk, 0.35);
```

### `AnimationClip` and `KeyframeTrack`

```ts
clip.addTrack(track);            // false when a track with that name already exists
clip.getTrack('character.position');
clip.removeTrack('character.position');
clip.getKeyframeCount();
clip.resetDuration();            // recompute `duration` from the tracks
clip.optimize(1e-6);             // drop redundant keyframes; returns how many went
clip.trim(0.5, 1.8);             // or clip.trim({ start, end })
clip.validate();                 // true when every track has matching times/values lengths
clip.getValidationError();       // why it does not, when it does not
```

`KeyframeTrack.evaluate(time)` returns a plain `number[]`, and `createInterpolant(kind?)`
returns the reusable evaluator when you want to avoid that allocation. `optimize(tolerance)`
removes keyframes that linear interpolation already reproduces within the tolerance — worth
calling once on an imported clip, because exporters rarely deduplicate.

Tracks serialise independently:

```ts
const json = clip.toJSON();
const restored = AnimationClip.fromJSON(json);   // or AnimationClip.parse(json)
```

`AnimationClip.validate()` and `getValidationError()` exist so a malformed import reports a
specific reason rather than throwing somewhere inside the interpolant.

## Imperative: `Tween` and `Timeline`

No asset pipeline, no name resolution — just `update(delta)`.

```ts
import { Timeline } from '@dxyl/graphics';

const timeline = new Timeline({ /* driver, loop, … */ });

timeline.add({
  duration: 0.6,
  onUpdate: (t) => { camera.position.y = 1 + t * 2; },
  easing: 'cubicOut',
});

timeline.addLabel('rise', 0.6);
timeline.play();

// Per frame:
timeline.update(delta);
timeline.seekToLabel('rise');   // jump to a named time
```

| `Timeline` member | Purpose |
| --- | --- |
| `add(entry, options?)` / `addOnce(...)` | Append an entry (a tween or a bare driver). |
| `addDriver(driver)` | Append a raw `TimelineDriver`. |
| `remove(entry)` / `removeWhere(tag)` / `clear()` | Remove entries. |
| `addLabel(name, time)` / `getLabel(name)` / `getLabels()` / `seekToLabel(name)` | Named times. |
| `play()` / `pause()` / `stop()` / `seek(time)` | Transport. |
| `getDuration()` | The timeline's length. |

A `TimelineDriver` is the primitive: anything that can report its duration and update itself
from a normalised `t`. `TweenFacade.ts` re-exports `Tween` and its option types, so a single
tween is just a timeline of one entry.

## Easing

`Easing.ts` exports the classic family as plain functions of a normalised `t`:

`linear`, `quadIn`/`quadOut`/`quadInOut`, `cubicIn`/`cubicOut`/`cubicInOut`,
`quart*`, `quint*`, `sine*`, `expo*`, `circ*`, and the back/elastic/bounce variants.

```ts
import { cubicOut, smoothstep } from '@dxyl/graphics';

const eased = cubicOut(0.4);
```

They are pure functions of one number, so they compose without a curve object:

```ts
const pingPong = (t: number): number => cubicOut(t < 0.5 ? t * 2 : (1 - t) * 2);
```

`src/utils/MathUtils.ts` adds the scalar helpers that animation code reaches for —
`lerp`, `inverseLerp`, `remapClamped`, `smoothstep(edge0, edge1, x)`, `smootherstep`,
`wrapAngle`, `lerpAngle`, `angleDelta`, `pingPong`, `cubicBezier`, `solveCubicBezier` — plus
`seededRandom(seed)` for deterministic samples.

## Time-keeping

Do not use `Date.now()` in an animation loop. The library provides two clocks:

```ts
import { Clock, ManualClock, Timer, FrameAccumulator } from '@dxyl/graphics';

const clock = new Clock();
clock.start();
const delta = clock.getDelta();          // advances, returns seconds (clamped)
const elapsed = clock.getElapsedTime();  // read: total seconds so far
clock.getDeltaMilliseconds();            // read: the delta `getDelta` just returned
clock.fps;                                // read: smoothed frame rate

// A fixed-cadence event that is independent of the frame rate:
const ticker = new Timer(1 / 6, { autoStart: true, repeat: true });
const off = ticker.onTick((count) => { /* … */ });   // returns an unsubscribe
ticker.update(delta);

// Fixed-timestep accumulation, for physics-shaped updates:
const accumulator = new FrameAccumulator(1 / 60, 5);
accumulator.run(delta, (step) => simulate(step));
```

**Only `getDelta()` advances.** `getElapsedTime()`, `getDeltaMilliseconds()`, `delta`,
`elapsed`, `smoothedDelta` and `fps` are reads — they never move the clock and never
produce a delta. Reach for `getDelta(timestamp)` when you want to step time, then read
the others freely; calling an advancing method to *read* a value is the mistake that
made this guide's own example wrong for a while.

`ManualClock` takes time explicitly (`advance(delta)`, `setTime(seconds)`), which is what makes
an animation test deterministic. It steps by **exactly** the amount it is given — the clamp
below belongs to the wall-clock `Clock`, since "advance to 10 s" meaning "advance to 0.1 s"
would defeat the purpose. `Clock.getDelta()` clamps its result to `MAX_DELTA` (0.1 s) so a
backgrounded tab does not teleport the animation on resume, and `elapsed` accumulates that
same clamped delta, so the deltas you were handed always sum to `getElapsedTime()`.

> **`Timer` is one-shot unless you ask otherwise.** `repeat` defaults to `false`, so a
> `new Timer(seconds)` fires **once** and then sets `completed`/`running = false`; every later
> `update()` returns `false` immediately. A recurring cadence — anything registered through
> `onTick` — needs `{ repeat: true }`. The default is deliberate (a non-repeating timer is the
> natural reading of "run this once after N seconds"), but it is the easiest way to spend an
> afternoon wondering why a handler fired exactly one time.

> **Note:** `src/animation` does **not** own a clock. Attach one where you prefer — the
> renderer's `setAnimationLoop` callback already supplies a clamped `delta` in seconds, which is
> usually enough and avoids a second clock reading per frame.

## Mixing both styles

The two styles are not exclusive. A common shape is a timeline driving the camera while a mixer
drives the characters:

```ts
renderer.setAnimationLoop((_time, delta) => {
  cameraTimeline.update(delta);
  characterMixer.update(delta);
  renderer.render(scene, camera);
});
```

Both take the same `delta` in seconds, so the two stay in step.

## A sampling sanity check

The mechanism every interpolator is built on is worth pinning in a test — it is cheap and it
catches an off-by-one in the segment search:

```ts
import { ManualClock } from '@dxyl/graphics';
import { expect, it } from 'vitest';

it('samples a track at its midpoint', () => {
  const clock = new ManualClock();
  clock.setTime(0);
  clock.advance(0.5);

  const t = clock.getElapsedTime();
  expect(t).toBeCloseTo(0.5, 6);
});
```

## See also

- [../benchmarks/README.md](../../benchmarks/README.md) — keyframe sampling and slerp costs.
- [math-conventions.md](math-conventions.md) — quaternion and Euler semantics.
- [performance.md](performance.md) — what to allocate and what to reuse per frame.
