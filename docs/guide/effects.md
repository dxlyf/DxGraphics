# Effects

Post-processing passes, shadows, fog and particles — and the CPU-side compositing toolkit that is
the alternative when a real pass chain is not available.

> **Note:** `src/effects/` has landed and exports everything below. Treat the API as accurate (it
> is read from the source) and the behaviour as unproven against the examples.

## Why a post-processing chain needs render targets

Every effect that reads the frame it is about to draw — bloom, blur, SSAO, tone mapping, a
vignette — needs the frame in a texture. That is a **render target**, and render targets need a
backend that can draw into an offscreen surface.

| Backend | `createRenderTarget` |
| --- | --- |
| Canvas2D | **throws** — "can only draw into its own canvas" |
| SVG | **throws** — "output lives in the document" |
| WebGL | supported (`WebGLRenderTarget`, `WebGLFramebuffer`) |
| WebGPU | a target class exists; the backend is unproven |

So the honest summary: **a real post-processing chain requires a GPU backend.** The CPU backends
get the compositing toolkit in the second half of this page instead.

## The composer

```ts
import { EffectComposer, RenderPass, BloomPass, FXAAPass } from '@dxyl/graphics';

const composer = new EffectComposer(renderer, { /* EffectComposerOptions */ });

composer.add(new RenderPass(scene, camera));   // draw the scene into a target
composer.add(new BloomPass({ strength: 0.8 })); // bright-pass + separable blur + additive blend
composer.add(new FXAAPass());                   // antialias the result

// Per frame, instead of renderer.render(scene, camera):
composer.setSize(width, height);
composer.render(context);
```

| Member | Purpose |
| --- | --- |
| `add(pass, position?)` / `addPass(...)` | Append or insert a pass (`'first' \| 'last'`). |
| `insertPass(pass, index)` | Insert at an explicit index. |
| `remove(pass \| id)` / `removePass(...)` | Remove by instance or by id. |
| `get(id)` / `getPassByName(name)` | Look a pass up. |
| `getEnabledPasses()` | The passes that will actually run, in order. |
| `sort()` | Reorder by pass priority. |
| `clear()` | Remove every pass. |
| `setSize(w, h)` / `setPixelRatio(r)` | Resize every pass and its targets together. |
| `initialise(context)` | Allocate targets and compile shaders. |
| `render(context \| delta)` | Run the chain. Returns a `PipelineExecutionResult`. |
| `swapBuffers()` | Advance the ping-pong pair, for a manual chain. |
| `setRenderTargetFactory(factory)` | Supply targets from outside — which is how a non-WebGL backend could participate. |
| `reset()` | Return to the initial pass list. |

`EffectComposer` extends `Disposable`, so `composer.dispose()` releases every pass and its targets.
`setRenderTargetFactory` is the seam worth noting: the composer does not construct targets itself,
so a caller can supply them — which is what a backend other than WebGL would need.

## Passes

| Pass | Effect |
| --- | --- |
| `Pass` | The base: an id, a name, an `enabled` flag, a priority and a render target pair. |
| `RenderPass` | Draws the scene into a target so later passes have something to read. |
| `ShaderPass` | A full-screen quad through a shader you supply. The base for everything below. |
| `BlurPass` | A separable Gaussian blur — the expensive half of most glow effects. |
| `BloomPass` | Bright-pass, blur, additive composite. `new BloomPass({ strength, … })`. |
| `FXAAPass` | Fast approximate antialiasing. Cheaper than MSAA and works as a post step. |
| `SSAOPass` | Screen-space ambient occlusion. The most expensive pass here, and the one most likely to need tuning. |
| `OutlinePass` | A silhouette outline, driven by an id or depth buffer. |

A custom post-process is a `ShaderPass` with a `ShaderDescriptor`:

```ts
import { ShaderPass } from '@dxyl/graphics';

const vignette = new ShaderPass(
  {
    fragmentShader: `
      precision mediump float;
      uniform sampler2D inputBuffer;
      uniform vec2 resolution;
      varying vec2 vUv;
      void main() {
        vec4 color = texture2D(inputBuffer, vUv);
        float d = distance(vUv, vec2(0.5)) * 1.4;
        gl_FragColor = vec4(color.rgb * smoothstep(1.0, 0.35, d), color.a);
      }
    `,
  },
  { /* ShaderPassOptions */ },
);

composer.add(vignette);
```

The whole reason `ShaderPass` exists is that this is the only shape a post-process ever takes:
read the previous target, write the next one. A pass that needs more than one input uses
`swapBuffers()` to ping-pong.

## Shadows

```ts
import { ShadowMap } from '@dxyl/graphics';
```

`ShadowMap` is the pass, and it is backed by shaders that already exist:
`ShaderLib.shadow` (the caster pass: depth only, alpha-tested where a map is bound) and
`ShadowMaterial` (a material that receives shadows and nothing else). `Mesh.castShadow` and
`Mesh.receiveShadow` are the per-object flags the pass reads, and `Scene3D.shadowsEnabled`
switches the whole thing off for a scene.

`DirectionalLight`, `PointLight` and `SpotLight` accept a `shadow` option of shape
`LightShadowLike`: `{ enabled, mapSize: { width, height }, bias, normalBias, near, far, dispose }`.

The two biases matter more than the resolution in practice: `bias` fixes surface acne (self-shadowing
stripes) and `normalBias` fixes the same problem on curved geometry. Raising `mapSize` first is the
usual mistake — it costs memory and does not fix acne.

## Fog

```ts
import { Fog } from '@dxyl/graphics';
```

`src/effects/fog/Fog.ts` provides the fog implementation, and the structural `FogLike` descriptor is
declared in `src/core/types.ts`:

```ts
interface FogLike {
  color: number | string;
  near?: number;   // linear: start distance / exponential: density
  far?: number;    // linear: full-opacity distance
  type?: string;   // 'linear' | 'exp2' | 'none'
}
```

`Scene` (core) and `Scene3D` both expose a `fog` field, and `Scene` adds the two convenience
setters:

```ts
scene.setLinearFog('#0d1017', 10, 60);
scene.setExponentialFog('#0d1017', 0.02);
scene.setFog(null);   // disable
```

A material opts out of fog with `material.fog = false` — which is what a skybox or a UI overlay
wants, and it is on the `Material` base.

## Particles

```ts
import { ParticleEmitter, ParticleMaterial, ParticleSystem } from '@dxyl/graphics';
```

| Class | Role |
| --- | --- |
| `ParticleEmitter` | The spawn description: rate, lifetime, initial velocity, spread, size and colour over life. |
| `ParticleSystem` | The simulation and the buffer it writes into — one `Points` draw. |
| `ParticleMaterial` | The material that renders the system; pairs with `ShaderLib.points`. |

A particle system is the canonical case for the allocation discipline in
[performance.md](performance.md) — thousands of particles, updated every frame, so the emit and
update paths must not allocate. Preallocate the particle array at its maximum and use
`setDrawRange(start, count)` to draw the live prefix, rather than growing the buffer.

## The CPU alternative

The CPU backends have no render targets, but they have the full CSS compositing model, and for
most 2D "effects" that is enough.

### Blend modes

```ts
const p = renderer.painter;

p.fillStyle = '#2f6fdf';
p.fillRect(0, 0, 100, 100);

p.globalCompositeOperation = 'lighter';   // additive — the glow mode
p.beginPath();
p.arc(50, 50, 30, 0, Math.PI * 2);
p.fillStyle = 'rgba(232, 178, 58, 0.6)';
p.fill();

p.globalCompositeOperation = 'source-over';   // ALWAYS restore
```

The eight most useful: `multiply` (darken, shadow), `screen` (lighten, haze), `overlay`
(contrast), `difference` (invert-by-comparison), `lighter` (additive), `hue`/`saturation`/`color`/
`luminosity` (recolour while keeping luminance).

**Always reset to `source-over`.** The mode is canvas state, so a renderable that leaves it set
changes every subsequent draw — and the symptom appears far from the cause.

### Shadows and glows

```ts
p.save();
p.shadowBlur = 26;
p.shadowColor = 'rgba(0, 0, 0, 0.7)';
p.shadowOffsetY = 10;
p.beginPath();
p.roundRect(x, y, w, h, 14);
p.fillStyle = '#141a24';
p.fill();
p.restore();
```

`shadowBlur` with a bright colour and a zero offset is a bloom for one draw call.

### Gradients

```ts
const sheen = p.createLinearGradient(x, y, x + w, y + h);   // CanvasGradient | null
sheen?.addColorStop(0, 'rgba(47, 111, 223, 0.35)');
sheen?.addColorStop(1, 'rgba(63, 191, 143, 0.30)');
p.fillStyle = sheen ?? '#2f6fdf';                            // null on a partial implementation
```

All three constructors — linear, radial, conic — return `CanvasGradient | null`, so a fallback is
required rather than optional.

### Masking with `clip`

```ts
p.save();
p.beginPath();
p.roundRect(x, y, w, h, 14);
p.clip();                    // everything after this is confined to the path
p.fillStyle = spotlightGradient;
p.fillRect(x, y, w, h);
p.restore();
```

`clip(path?)` takes an optional `Path2D`, which is faster than rebuilding the mask when it is
reused across frames.

### An offscreen canvas as a render target

This is the practical substitute, and the one to reach for:

```ts
const surface = document.createElement('canvas');
surface.width = 256;
surface.height = 256;
const ctx = surface.getContext('2d');

// Redraw only when it changes — this is a render target, not a per-frame buffer.
ctx.clearRect(0, 0, 256, 256);
ctx.beginPath();
ctx.arc(128, 128, 110, 0, Math.PI * 2);
ctx.fill();

// Blit it as many times as you like.
painter.drawImage(surface, { dx: x, dy: y, dw: 96, dh: 96 });
```

`drawImage` also takes a source rectangle (`sx`, `sy`, `sw`, `sh`), so one buffer can hold an atlas.

### A CPU blur

The canvas context's own `filter` is reachable through `painter.getContext()`:

```ts
const ctx = painter.getContext();
if (ctx) {
  ctx.filter = 'blur(6px)';
  painter.drawImage(surface, { dx, dy, dw, dh });
  ctx.filter = 'none';
}
```

Check `renderer.info.capabilities.includes('css-filter')` first — the backend reports it only when
the context actually exposes `filter`.

### A CPU pixel effect

`getImageData` / `putImageData` are the escape hatch for anything the compositing model cannot
express:

```ts
const image = painter.getImageData(0, 0, w, h);
if (image) {
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = luma;
  }
  painter.putImageData(image, 0, 0);
}
```

Two cautions: this is **O(pixels × channels) in JavaScript**, so it is a still-image or
low-resolution operation; and it forces a GPU→CPU readback, which on some drivers is the most
expensive operation in the frame. `Canvas2DShader` provides a small pixel-program abstraction over
exactly this path.

## Which path to take

| Need | Use |
| --- | --- |
| Bloom, SSAO, FXAA, tone mapping on a GPU scene | `EffectComposer` + the relevant pass |
| A custom full-screen effect | `ShaderPass` with a `ShaderDescriptor` |
| Shadows from a directional or spot light | `ShadowMap`, plus `castShadow`/`receiveShadow` |
| Depth fog | `Fog`, via `scene.setLinearFog`/`setExponentialFog` |
| Thousands of short-lived sprites | `ParticleSystem` + `ParticleMaterial` |
| A glow or a tint on the CPU | `globalCompositeOperation` |
| A drop shadow on the CPU | `shadowBlur`/`shadowColor` |
| A blur on a CPU-rendered 2D scene | `ctx.filter`, or a downscaled `drawImage` round trip |
| A pixel effect on the CPU | `getImageData`/`putImageData`, or `Canvas2DShader` |
| A second surface on the CPU | An offscreen `<canvas>` plus `drawImage` |

## See also

- [rendering-backends.md](rendering-backends.md) — the per-backend capability list.
- [shaders.md](shaders.md) — `ShaderLib`, whose `shadow`, `depth` and `background` programs the
  passes build on.
- [materials-and-textures.md](materials-and-textures.md) — `blending`, `alphaTest`,
  `clippingPlanes`, `fog` and the rest of the material state.
- [examples/effects](../../examples/effects/README.md) — the CPU toolkit, working.
