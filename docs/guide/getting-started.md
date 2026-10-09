# Getting started

One scene, four backends, and the smallest amount of code that actually renders something.

## The four-step shape

Every program with this library has the same four parts:

```ts
import { Canvas2DRenderer, Color, detectBackendStrict, BackendNames, type Canvas2DPainter, type Renderable2D } from '@dxyl/graphics';

// 1. A surface: an HTML <canvas> (or a <div> for the SVG backend).
const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;

// 2. A backend, chosen at runtime.
const backend = detectBackendStrict(BackendNames.Canvas2D, canvas);
if (backend !== BackendNames.Canvas2D) throw new Error('needs a 2D canvas context');
const renderer = new Canvas2DRenderer({ canvas, clearColor: '#11151d', autoResize: true });

// 3. A scene: anything the renderer can walk. A plain object works.
class Box implements Renderable2D {
  public visible = true;
  public renderOrder = 0;
  public depth = 0;
  public x = 0;
  public y = 0;

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.beginPath();
    p.rect(this.x - 1, this.y - 1, 2, 2);
    p.fillStyle = new Color('#2f6fdf').toCssString();
    p.fill();
  }
}

const boxes = [new Box(), new Box()];
boxes[1].x = 3;
const scene = { children: boxes as Renderable2D[] };

// 4. A loop. `delta` is in SECONDS.
renderer.setAnimationLoop((_time, delta) => {
  for (const box of boxes) box.x += delta;
  renderer.render(scene, { position: { x: 0, y: 0, z: 0 }, zoom: 32, rotation: 0 });
}, { autoStart: true });
```

The `index.html` that goes with it:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      canvas { display: block; width: 100%; height: 100%; }
      body { margin: 0; background: #0d1017; }
    </style>
  </head>
  <body>
    <canvas id="stage" style="width: 100vw; height: 100vh"></canvas>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

## The scene contract

`renderer.render(scene, camera)` does not require a library `Scene`. It resolves the work in
three steps, in this order:

1. If the scene has a **`collectRenderables(list, camera)`** method, call it. That is how a
   scene graph owns its own traversal.
2. Otherwise, if the scene has a **`children`** array, submit each child that has a `render`
   function.
3. Otherwise, submit the scene itself.

And a renderable is anything with `visible` and `render(painter)`:

```ts
interface Renderable2D {
  readonly visible: boolean;
  render(painter: unknown): void;
  readonly material?: { id?: string | number; transparent?: boolean; renderOrder?: number } | null;
  readonly renderOrder?: number;
  readonly depth?: number;
  readonly id?: string | number;
  readonly opaque?: boolean;
  readonly transparent?: boolean;
  updateDepth?(camera: unknown): void;
  dispose?(): void;
}
```

Because the contract is structural, you do not need to subclass anything. Two consequences
worth knowing up front:

- **`depth` is the sort key**, not a z-buffer. The 2D backends have no depth buffer, so nearer
  objects must sort later. Set `depth` to the camera distance.
- **`renderOrder` wins over depth.** An object with a non-zero `renderOrder` goes into the
  `ordered` bucket, which is drawn before opaque and transparent geometry.

## The camera contract

The 2D backends read the camera structurally too. Only these three members matter:

```ts
const camera = {
  position: { x: 0, y: 0, z: 0 }, // pan, in world units
  zoom: 32,                       // world units -> logical pixels
  rotation: 0,                    // radians about the view axis
};
```

The resulting transform is `translate(centre − position · zoom)`, then `rotate(−rotation)`,
then `scale(zoom, −zoom)`. Two things follow:

- **World `+Y` points up**, even though canvas `+Y` points down. The `−zoom` on the Y axis does
  that, and it is why you never flip `y` by hand.
- **The world origin is the centre of the viewport.** `position` is the world point that lands
  at the centre.

Pass `null` to render with the identity transform and work in logical pixels instead — that is
what the text and effects examples do.

## The animation loop

```ts
renderer.setAnimationLoop((timeMs, deltaSeconds) => { … }, { autoStart: true });
```

- `timeMs` is milliseconds since the page origin (`performance.now()`).
- `deltaSeconds` is **seconds** and is clamped, so a backgrounded tab cannot teleport the
  animation. Do not assume it is `1/60`.
- `{ autoStart: true }` starts the loop. Without it, call `renderer.start()`.
- `renderer.setAnimationLoop(null)` stops it and clears the callback.
- A callback that throws is caught and logged, so one bad frame cannot kill the loop.

The loop runs through the renderer's own clock, which is why motion written against `delta` is
frame-rate independent.

## Choosing a backend

```ts
import { BackendNames, detectBackend, detectBackendStrict, getSupportedBackendNames } from '@dxyl/graphics';

getSupportedBackendNames();                        // e.g. ['webgl2', 'webgl', 'canvas2d', 'svg']
detectBackend([BackendNames.WebGPU, BackendNames.Canvas2D]);   // BackendName, never null
detectBackendStrict([BackendNames.WebGPU]);                    // BackendName | null
```

Use the **strict** form for feature detection: it probes by actually creating a canvas and
requesting the context, which is the only reliable test in a browser, and returns `null` when
nothing is usable. `detectBackend` falls back to `'canvas2d'` and is the convenience call for
"give me something".

Backends are constructed directly — there is no factory:

| Backend | Constructor | Host element |
| --- | --- | --- |
| Canvas2D | `new Canvas2DRenderer({ canvas })` | `<canvas>` |
| SVG | `new SVGRenderer({ container })` | `<div>` |
| WebGL | `new WebGLRenderer({ canvas })` | `<canvas>` |

## Handling "no backend"

Every backend reports whether it can draw, and the honest thing to do is show a message rather
than let the user see a blank canvas:

```ts
const renderer = new Canvas2DRenderer({ canvas, autoResize: true });

if (renderer.isHeadless) {
  // No canvas could be bound. Construction, setSize, setPixelRatio, clear and dispose all
  // still work; only render() throws.
  notice.textContent = 'This browser could not create a 2D canvas context.';
} else {
  renderer.setAnimationLoop(frame, { autoStart: true });
}
```

`SVGRenderer` differs in one respect: without a DOM it constructs without throwing and reports
`renderer.isLive === false`, but `render()` **throws**. Check `isLive` before the first frame.

## Resizing

The renderer sizes its own drawing buffer from the CSS size times `devicePixelRatio`, and
`autoResize: true` re-reads the display size every frame:

```ts
const renderer = new Canvas2DRenderer({ canvas, autoResize: true });
```

Without `autoResize`, drive it yourself — from a `ResizeObserver` on the container, so the
buffer follows the layout rather than the window:

```ts
const observer = new ResizeObserver(([entry]) => {
  renderer.setSize(entry.contentRect.width, entry.contentRect.height, false);
});
observer.observe(container);
```

Pass `false` as the third argument to leave the CSS size under your control.

## Disposal

A renderer owns a canvas context, listeners and an animation loop. Release them:

```ts
function dispose(): void {
  renderer.setAnimationLoop(null); // stop the loop and clear the callback
  renderer.dispose();              // releases the context and every held resource
}

window.addEventListener('beforeunload', dispose);
```

`dispose()` is idempotent, so calling it twice is safe — which matters when `beforeunload` and
an explicit teardown path can both fire.

## Where to go next

| Next | Page |
| --- | --- |
| The maths you will actually write | [math-conventions.md](math-conventions.md) |
| Backend differences and capability probing | [rendering-backends.md](rendering-backends.md) |
| Nodes, transforms, traversal | [scene-graph.md](scene-graph.md) |
| Working code for every feature | the [guide index](README.md) |
