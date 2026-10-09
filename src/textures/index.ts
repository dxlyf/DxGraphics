/**
 * Texture layer.
 *
 * Backend-neutral descriptions of sampling resources: the channel layout
 * (`formats`), the sampling state (`Sampler`), the UV transform and the source
 * images themselves. Nothing here touches a GPU — the WebGL and WebGPU backends
 * read these objects and create their own handles — so the whole layer can be
 * exercised in a Node test run.
 *
 * ```ts
 * import { DataTexture, Sampler, WrapMode, getResizePlan } from '@dxyl/graphics';
 *
 * const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
 * texture.wrapS = WrapMode.Repeat;
 * const sampler = Sampler.fromTexture(texture);
 * ```
 *
 * | Module | Contents |
 * | --- | --- |
 * | `Texture` | the base sampling resource, its UV matrix and its events |
 * | `DataTexture` | CPU texel data |
 * | `CanvasTexture` | canvases, bitmaps and video frames |
 * | `VideoTexture` | a texture that follows a video element |
 * | `CubeTexture` | six faces, sampled by direction |
 * | `CompressedTexture` | pre-compressed GPU blocks |
 * | `DepthTexture` | a sampleable depth/stencil buffer |
 * | `RenderTargetTexture` | the sampleable view of a render target |
 * | `Sampler` | texture-independent sampling state |
 * | `TextureUtils` | sizing, mipmaps, NPOT plans, byte accounting, placeholders |
 * | `formats` | `TextureFormat`, `PixelFormat`, `CompressedFormat` |
 *
 * ### Name resolution
 *
 * `TextureFilter` and `PixelFormat` also exist in `renderer/interfaces/types`
 * (they describe the same three-value/filter taxonomy from the backend's point of
 * view). `export *` treats a duplicated name as ambiguous, so importing both
 * barrels into one module — `src/index.ts` does — leaves the ambiguous name
 * unavailable from the umbrella entry point. Import them from `@dxyl/graphics/textures`
 * (or `renderer/interfaces/types`) when both layers are in scope.
 *
 * @packageDocumentation
 */

export * from './types';
export * from './formats';
export * from './Texture';
export * from './DataTexture';
export * from './CanvasTexture';
export * from './VideoTexture';
export * from './CubeTexture';
export * from './CompressedTexture';
export * from './DepthTexture';
export * from './RenderTargetTexture';
export * from './Sampler';
export * from './TextureUtils';
