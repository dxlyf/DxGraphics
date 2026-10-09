# Controls

Camera and pointer controls: orbit, map, trackball, fly and first-person camera controllers, plus pointer, touch and gesture handling.

> **Note:** this module is still stabilising — `src/controls/` has landed and exports the classes below, but it has not yet been exercised against the examples. Treat the API as accurate (it is read from the source) and the behaviour as unproven.

## The base class

Every control extends `Controls`, which owns the shared state: the target, damping, the DOM
connection and the spherical-coordinate accessors.

```ts
abstract class Controls<TObject = unknown> {
  readonly object: TObject;              // the object being moved (usually a camera)
  domElement: EventTargetLike | null;
  enabled: boolean;
  readonly target: Vec3;                 // the point the controls look at
  enableDamping: boolean;
  dampingFactor: number;
  preventDefault: boolean;

  connect(element: EventTargetLike): this;
  disconnect(): this;
  hasDomListener(type: string): boolean;

  saveState(): this;                     // snapshot, for a "reset view" button
  reset(): this;                         // restore the snapshot
  getState(): ControlsState | null;
  setState(state: ControlsState): this;

  getSpherical(): SphericalState | null;
  setSpherical(state: SphericalState): this;
  getDistance(): number;
  getPolarAngle(): number;
  getAzimuthalAngle(): number;
  getPolarAngleDegrees(): number;
  getAzimuthalAngleDegrees(): number;

  lookAtTarget(): this;
  abstract update(delta: number): boolean;   // returns whether anything moved
}
```

Two details that shape how you use every subclass:

- **`update(delta)` returns a boolean.** `true` means the controls changed the object this frame.
  That is the hook for skipping work on an idle scene: `if (controls.update(delta)) reupload()`.
- **Damping requires calling `update` every frame.** With `enableDamping = true` the motion is
  asymptotic, so it keeps producing `true` until it settles.

`connect(element)` attaches the DOM listeners; `disconnect()` removes them. `hasDomListener(type)`
exists so teardown can assert it actually detached — an audio of leaks in control code is a
listener left on `window` after the canvas is gone.

## Orbit

```ts
import { OrbitControls, PerspectiveCamera, Vec3 } from '@dxyl/graphics';

const camera = new PerspectiveCamera({ fov: 50, aspect: 16 / 9, near: 0.1, far: 1000 });
camera.position.set(0, 3, 8);

const controls = new OrbitControls(camera, {
  target: new Vec3(0, 0, 0),
  enableDamping: true,
  dampingFactor: 0.08,
  minDistance: 2,
  maxDistance: 40,
  maxPolarAngle: Math.PI * 0.49,   // stay above the horizon
});

controls.connect(canvas);

renderer.setAnimationLoop((_time, delta) => {
  controls.update(delta);
  renderer.render(scene, camera);
}, { autoStart: true });

// Teardown
controls.disconnect();
```

| Member | Purpose |
| --- | --- |
| `update(delta)` | Apply damping and move the camera. Returns whether it moved. |
| `rotateByPixels(dx, dy)` | Drive rotation programmatically (a minimap, a trackpad, a test). |
| `panByPixels(dx, dy)` | Drive panning programmatically. |
| `setDistanceLimits(min, max)` | Clamp the orbit radius. |
| `setPolarLimits(min, max)` | Clamp the polar angle, in radians. |
| `setAzimuthLimits(min, max)` | Clamp the azimuth, in radians. |
| `setPolarLimitsDegrees(min, max)` | The same, in degrees. |

The option interfaces are `OrbitControlsOptions`, `OrbitMouseButtons` (which button does what)
and `OrbitKeyModifiers` (modifier keys that switch the gesture), so button mappings are
configurable rather than hard-coded.

`rotateByPixels`/`panByPixels` are the hook for a custom input source — a scrollbar, a gamepad,
or a test that needs to move the camera without synthesising pointer events.

## The other camera controls

| Class | Interaction |
| --- | --- |
| `MapControls` | Orbit's cousin, tuned for top-down maps: panning is the primary gesture and the azimuth is typically locked. |
| `TrackballControls` | Free rotation without a fixed up vector, so the view can roll. |
| `FlyControls` | Six-degrees-of-freedom flying with no orbit constraint. |
| `FirstPersonControls` | Yaw/pitch from pointer movement, with the camera pinned to a position. |

All five live under `src/controls/camera/` and share the `Controls` base, so `connect`,
`disconnect`, `update(delta)` and the state helpers work identically. `OrbitControls` and
`MapControls` are the two that suit a product viewer; the rest suit an editor or a flying
camera.

## Pointer, touch and gesture handling

`PointerControls`, `TouchControls` and `GestureControls` are the lower-level input layers, under
`src/controls/pointer/` and `src/controls/gesture/`. Reach for them when the motion is not a
camera orbit — dragging an object, lassoing a selection, pinch-zooming a 2D canvas.

The pattern is the same three calls:

```ts
const pointer = new PointerControls(target, { /* … */ });
pointer.connect(canvas);
// per frame:
pointer.update(delta);
// teardown:
pointer.disconnect();
```

## Writing your own controls

If the input shape you need does not exist, the base class is small enough to extend, and the
pieces that matter are all in `Controls`:

```ts
import { Controls, Vec2 } from '@dxyl/graphics';

class PanZoomControls extends Controls<{ position: Vec3; zoom: number }> {
  private dragging = false;
  private last = new Vec2();

  public override update(delta: number): boolean {
    if (!this.dragging) return false;
    const zoom = (this.object as { zoom: number }).zoom;
    (this.object as { position: Vec3 }).position.x -= this.last.x / zoom * delta;
    this.last.set(0, 0);
    return true;
  }
}
```

Four practical notes from the examples in this repository, which implement their input by hand
because they need the gestures to work on the Canvas2D backends:

1. **Use `setPointerCapture` on `pointerdown`**, so a drag that leaves the canvas keeps
   tracking. Handle both `pointerup` and `pointercancel`, or a cancelled gesture leaves the drag
   stuck.
2. **Register `wheel` with `{ passive: false }`** or `preventDefault()` cannot stop the page
   from scrolling while the scene zooms.
3. **Zoom about the cursor, not the centre.** Convert the pointer to world space before and
   after the scale change, then move the camera by the difference expressed in the rotated
   world frame.
4. **Rotate pan deltas into the camera's frame**, or dragging right stops moving the world right
   once the view is rotated.

See [examples/controls](../../examples/controls/README.md) for all four, working.

## Where the camera comes from

The 2D backends read a camera **structurally** — `position`, `zoom`, `rotation` — so a controls
class that mutates those three members works with Canvas2D and SVG with no adapter:

```ts
const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 34, rotation: 0 };
const orbit = new OrbitControls(camera, { target: new Vec3() });
```

`OrbitControls.object` is typed loosely for exactly this reason: it is whatever the caller wants
moved.

> **Note:** the 3D branch of the Canvas2D backend reads `camera.viewMatrix`, which no camera
> class defines in this checkout. If you drive a `PerspectiveCamera` with `OrbitControls` and
> render through `Canvas2DRenderer`, the renderer falls back to the 2D pan/zoom transform. See
> [rendering-backends.md](rendering-backends.md#webgl-specifics).

## See also

- [picking.md](picking.md) — turning a pointer position into a hit.
- [performance.md](performance.md) — why `update()`'s return value matters.
- [examples/controls](../../examples/controls/README.md) — hand-written pan, zoom and rotate.
