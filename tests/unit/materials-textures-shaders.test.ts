/**
 * Unit tests for the material, texture and shader layers.
 *
 * The three layers are tested together because that is how they interact in
 * practice: `RenderState` is derived from a material, a material owns textures,
 * and the shader layer supplies the uniform container and the built-in library.
 * Everything asserted here is reachable without a GPU or a DOM, which is the
 * whole point of keeping these layers backend-neutral.
 */

import { describe, expect, it } from 'vitest';
import { Color } from '../../src/math/Color';
import { Mat3 } from '../../src/math/Mat3';
import { Mat4 } from '../../src/math/Mat4';
import { Vec2 } from '../../src/math/Vec2';
import { Vec3 } from '../../src/math/Vec3';
import {
  BlendMode,
  Blending,
  CullFace,
  DepthFunc,
  DepthMaterial,
  Material,
  MaterialFactoryError,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RenderState,
  Side,
  createMaterial,
  createMaterialFromJSON,
  getBlendFactors,
  getMaterialConstructor,
  listMaterialTypes,
  registerMaterialType,
  requiresDestinationAlpha,
  unregisterMaterialType,
} from '../../src/materials';
import {
  DataTexture,
  MipmapFilter,
  NpotPolicy,
  PixelFormat,
  Sampler,
  Texture,
  TextureFilter,
  TextureFormat,
  WrapMode,
  computeMipmapCount,
  createNormalTexture,
  createWhiteTexture,
  getResizePlan,
  getTextureByteSize,
  isPowerOfTwo,
  needsResize,
} from '../../src/textures';
import {
  ShaderCache,
  ShaderChunkError,
  ShaderCompiler,
  ShaderLib,
  Uniforms,
  buildShaderDescriptor,
  defineChunk,
  getShaderLib,
  getChunk,
  hasChunk,
  inferUniformType,
  listChunks,
  listShaderLib,
  registerShaderLib,
  resolve,
  uniformTypeName,
} from '../../src/shaders';

/* -------------------------------------------------------------------------- */
/* Materials                                                                  */
/* -------------------------------------------------------------------------- */

describe('Material', () => {
  it('bumps version from setValues and ignores unknown keys', () => {
    const material = new Material();
    const start = material.version;

    material.setValues({ opacity: 0.5, transparent: true });
    expect(material.opacity).toBe(0.5);
    expect(material.transparent).toBe(true);
    expect(material.version).toBeGreaterThan(start);

    // An unknown key is skipped (and logged), so the version must not move.
    const before = material.version;
    material.setValues({ notARealParameter: 42 });
    expect(material.version).toBe(before);
    expect((material as unknown as Record<string, unknown>).notARealParameter).toBeUndefined();
  });

  it('bumps version once per setValues call, not once per key', () => {
    const material = new Material();
    const start = material.version;
    material.setValues({ opacity: 0.25, depthWrite: false, alphaTest: 0.5 });
    expect(material.version).toBe(start + 1);
  });

  it('bumps version when needsUpdate is assigned', () => {
    const material = new Material();
    const start = material.version;
    material.needsUpdate = true;
    expect(material.version).toBe(start + 1);
    expect(material.needsUpdate).toBe(false);
  });

  it('emits versionchange with the new revision', () => {
    const material = new Material();
    let seen = -1;
    const off = material.onMaterial('versionchange', (_mat, version) => {
      seen = version;
    });
    material.markNeedsUpdate();
    expect(seen).toBe(material.version);
    off();
    material.markNeedsUpdate();
    expect(seen).toBe(material.version - 1);
  });

  it('coerces structured parameters instead of replacing them', () => {
    const material = new MeshStandardMaterial();
    const color = material.color;
    material.setValues({ color: '#ff0000' });
    expect(material.color).toBe(color);
    expect(material.color.getHex()).toBe(0xff0000);
  });

  it('clones independently: the copy does not share mutable fields', () => {
    const original = new MeshStandardMaterial({
      roughness: 0.2,
      color: '#00ff00',
      defines: { USE_WAVES: true },
    });
    original.normalScale.set(2, 3);

    const clone = original.clone();
    expect(clone).not.toBe(original);
    expect(clone.roughness).toBe(0.2);
    expect(clone.color.getHex()).toBe(0x00ff00);
    expect(clone.normalScale.x).toBe(2);

    clone.roughness = 0.9;
    clone.color.set(0, 0, 1);
    clone.normalScale.set(9, 9);
    clone.defines.USE_WAVES = false;
    clone.userData['touched'] = true;

    expect(original.roughness).toBe(0.2);
    expect(original.color.getHex()).toBe(0x00ff00);
    expect(original.normalScale.x).toBe(2);
    expect(original.defines.USE_WAVES).toBe(true);
    expect(original.userData['touched']).toBeUndefined();
  });

  it('releases owned textures exactly once', () => {
    const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    // `Material` itself has no texture slots, so ownership is asserted through a
    // mesh material, which does.
    const mesh = new MeshStandardMaterial({ map: texture });
    expect(mesh.getTextures()).toContain(texture);
    expect(mesh.disposableCount).toBe(1);

    mesh.dispose();
    expect(texture.isDisposed).toBe(true);

    // A second dispose is a no-op rather than a double release.
    mesh.dispose();
    expect(texture.isDisposed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Blending                                                                   */
/* -------------------------------------------------------------------------- */

describe('BlendMode', () => {
  it('resolves the normal preset to source-over alpha blending', () => {
    const factors = getBlendFactors(BlendMode.NormalBlending);
    expect(factors.enabled).toBe(true);
    expect(factors.src).toBe('src-alpha');
    expect(factors.dst).toBe('one-minus-src-alpha');
    expect(factors.srcAlpha).toBe('one');
    expect(factors.dstAlpha).toBe('one-minus-src-alpha');
    expect(factors.equation).toBe('add');
  });

  it('resolves the additive preset to src-alpha -> one', () => {
    const factors = getBlendFactors(BlendMode.AdditiveBlending);
    expect(factors.enabled).toBe(true);
    expect(factors.src).toBe('src-alpha');
    expect(factors.dst).toBe('one');
    expect(factors.equation).toBe('add');
  });

  it('disables blending for the none preset', () => {
    expect(getBlendFactors(BlendMode.NoBlending).enabled).toBe(false);
  });

  it('reports which presets need a destination alpha channel', () => {
    expect(requiresDestinationAlpha(BlendMode.NormalBlending)).toBe(false);
    expect(requiresDestinationAlpha(BlendMode.AdditiveBlending)).toBe(false);
    // Custom factors are unknown, so the conservative answer wins.
    expect(requiresDestinationAlpha(BlendMode.CustomBlending)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* RenderState                                                                */
/* -------------------------------------------------------------------------- */

describe('RenderState', () => {
  it('derives an equal state from two equal materials', () => {
    const a = new MeshStandardMaterial({ side: Side.FrontSide });
    const b = new MeshStandardMaterial({ side: Side.FrontSide });

    const stateA = RenderState.fromMaterial(a);
    const stateB = RenderState.fromMaterial(b);
    expect(stateA.equals(stateB)).toBe(true);
    expect(stateA.diff(stateB)).toEqual([]);
    expect(stateA.hash()).toBe(stateB.hash());
  });

  it('reports exactly the toggled key in diff', () => {
    const material = new MeshStandardMaterial();
    const before = RenderState.fromMaterial(material);

    material.depthWrite = false;
    const after = RenderState.fromMaterial(material);

    expect(after.diff(before)).toEqual(['depthWrite']);
    expect(after.equals(before)).toBe(false);
    expect(after.hash()).not.toBe(before.hash());
  });

  it('maps the material side onto a cull face', () => {
    const material = new MeshStandardMaterial();
    expect(RenderState.fromMaterial(material).cullFace).toBe(CullFace.Back);

    material.side = Side.DoubleSide;
    expect(RenderState.fromMaterial(material).cullFace).toBe(CullFace.None);

    material.side = Side.BackSide;
    expect(RenderState.fromMaterial(material).cullFace).toBe(CullFace.Front);
  });

  it('uses the material factors only for custom blending', () => {
    const material = new MeshStandardMaterial({ blending: BlendMode.AdditiveBlending });
    // The preset wins over the default factor fields.
    expect(RenderState.fromMaterial(material).blendDst).toBe('one');

    material.blending = BlendMode.CustomBlending;
    material.blendDst = Blending.OneMinusDstColor;
    const state = RenderState.fromMaterial(material);
    expect(state.blendDst).toBe(Blending.OneMinusDstColor);
    expect(state.diff(RenderState.fromMaterial(material))).toEqual([]);
  });

  it('is stable: hash depends on the values, not on identity', () => {
    const state = new RenderState();
    state.depthFunc = DepthFunc.Greater;
    const copy = state.clone();
    expect(copy.hash()).toBe(state.hash());
    expect(state.toKey()).toBe(copy.toKey());

    copy.depthFunc = DepthFunc.Less;
    expect(copy.hash()).not.toBe(state.hash());
  });

  it('reports every member when compared with null', () => {
    const state = new RenderState();
    expect(state.diff(null).length).toBe(12);
    expect(state.equals(null)).toBe(false);
  });

  it('serialises to plain values', () => {
    const json = new RenderState().toJSON();
    expect(json.depthWrite).toBe(true);
    expect(json.depthFunc).toBe('less-equal');
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('derives from a structural material view', () => {
    const view = {
      depthTest: false,
      depthWrite: false,
      depthFunc: DepthFunc.Always,
      side: Side.DoubleSide,
      blending: BlendMode.NoBlending,
      blendSrc: getBlendFactors(BlendMode.NoBlending).src,
      blendDst: getBlendFactors(BlendMode.NoBlending).dst,
      blendEquation: getBlendFactors(BlendMode.NoBlending).equation,
      colorWrite: false,
      alphaToCoverage: true,
      polygonOffset: true,
    };
    const state = RenderState.fromMaterial(view);
    expect(state.depthTest).toBe(false);
    expect(state.colorWrite).toBe(false);
    expect(state.alphaToCoverage).toBe(true);
    expect(state.polygonOffset).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Textures                                                                   */
/* -------------------------------------------------------------------------- */

describe('Texture', () => {
  it('builds the UV matrix from offset, repeat, rotation and center', () => {
    const texture = new Texture();
    expect(Array.from(texture.updateMatrix(true).elements)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // Offset only: pure translation.
    texture.offset.set(0.25, 0.5);
    expect(texture.matrix.elements[6]).toBeCloseTo(0.25, 6);
    expect(texture.matrix.elements[7]).toBeCloseTo(0.5, 6);

    // Repeat only: pure scale, offset reset.
    texture.offset.set(0, 0);
    texture.repeat.set(2, 3);
    expect(texture.matrix.elements[0]).toBeCloseTo(2, 6);
    expect(texture.matrix.elements[4]).toBeCloseTo(3, 6);

    // A quarter turn about the texture centre keeps the centre fixed.
    texture.repeat.set(1, 1);
    texture.center.set(0.5, 0.5);
    texture.rotation = Math.PI / 2;
    const rotated = texture.updateMatrix(true);
    const u = rotated.elements[0] * 0.5 + rotated.elements[3] * 0.5 + rotated.elements[6];
    const v = rotated.elements[1] * 0.5 + rotated.elements[4] * 0.5 + rotated.elements[7];
    expect(u).toBeCloseTo(0.5, 6);
    expect(v).toBeCloseTo(0.5, 6);
  });

  it('skips the recompute while matrixAutoUpdate is disabled', () => {
    const texture = new Texture();
    const matrix = texture.updateMatrix(true).clone();

    texture.matrixAutoUpdate = false;
    texture.offset.set(0.75, 0.25);
    expect(texture.updateMatrix()).toBe(texture.matrix);
    expect(Array.from(texture.matrix.elements)).toEqual(Array.from(matrix.elements));
    expect(Array.from(texture.getMatrix().elements)).toEqual(Array.from(matrix.elements));

    // Re-enabling catches up: the transform fields were never lost.
    texture.matrixAutoUpdate = true;
    expect(texture.getMatrix().elements[6]).toBeCloseTo(0.75, 6);
  });

  it('recomputes automatically for an auto-update texture', () => {
    const texture = new Texture();
    texture.repeat.set(4, 4);
    expect(texture.matrix.elements[0]).toBeCloseTo(4, 6);
  });

  it('versions on needsUpdate and reports events', () => {
    const texture = new Texture();
    let updates = 0;
    texture.onTexture('update', () => {
      updates++;
    });
    const start = texture.version;
    texture.needsUpdate = true;
    expect(texture.version).toBe(start + 1);
    expect(updates).toBe(1);
  });

  it('reports size and readiness from an image-like source', () => {
    const texture = new Texture();
    expect(texture.isReady()).toBe(false);

    texture.setImage({ width: 64, height: 32 } as unknown as Texture['image']);
    expect(texture.getSize().x).toBe(64);
    expect(texture.getSize().y).toBe(32);
    expect(texture.isReady()).toBe(true);
  });

  it('serialises to JSON-safe values', () => {
    const texture = new Texture();
    texture.repeat.set(2, 2);
    const json = texture.toJSON();
    expect(json.wrapS).toBe(WrapMode.ClampToEdge);
    expect(json.magFilter).toBe(TextureFilter.Linear);
    expect(json.repeat).toEqual([2, 2]);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('DataTexture', () => {
  it('reports width, height and readiness', () => {
    const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 2, 3);
    expect(texture.width).toBe(2);
    expect(texture.height).toBe(3);
    expect(texture.getSize().toJSON()).toEqual({ x: 2, y: 3 });
    expect(texture.isReady()).toBe(true);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.flipY).toBe(false);

    const empty = new DataTexture(null, 0, 0);
    expect(empty.width).toBe(1);
    expect(empty.isReady()).toBe(false);
  });

  it('clones without sharing the parameter bag', () => {
    const texture = new DataTexture(new Float32Array(4 * 4), 2, 2, TextureFormat.RGBAFormat, PixelFormat.Float);
    const clone = texture.clone();
    expect(clone.width).toBe(2);
    expect(clone.type).toBe(PixelFormat.Float);
    clone.wrapS = WrapMode.Repeat;
    expect(texture.wrapS).toBe(WrapMode.ClampToEdge);
  });
});

describe('TextureUtils', () => {
  it('computes the mip chain length for 1, 2, 64 and 300 texels', () => {
    expect(computeMipmapCount(1, 1)).toBe(1);
    expect(computeMipmapCount(2, 2)).toBe(2);
    expect(computeMipmapCount(64, 64)).toBe(7);
    expect(computeMipmapCount(300, 300)).toBe(9);
    // The chain follows the largest dimension.
    expect(computeMipmapCount(300, 1)).toBe(9);
  });

  it('computes byte sizes for RGBA8 and Float32', () => {
    const rgba8 = (width: number, height: number): DataTexture =>
      new DataTexture(new Uint8Array(width * height * 4), width, height);

    expect(getTextureByteSize(rgba8(1, 1))).toBe(4);
    expect(getTextureByteSize(rgba8(2, 2))).toBe(16);
    expect(getTextureByteSize(rgba8(64, 64))).toBe(64 * 64 * 4);
    expect(getTextureByteSize(rgba8(300, 300))).toBe(300 * 300 * 4);

    // A 64x64 RGBA8 chain is 16384 + 4096 + ... + 4 = 21844 bytes.
    expect(getTextureByteSize(rgba8(64, 64), { includeMipmaps: true })).toBe(21844);

    const float32 = new DataTexture(
      new Float32Array(16 * 16 * 4),
      16,
      16,
      TextureFormat.RGBAFormat,
      PixelFormat.Float,
    );
    expect(getTextureByteSize(float32)).toBe(16 * 16 * 4 * 4);
    expect(getTextureByteSize(float32, { levels: 2 })).toBe(16 * 16 * 16 + 8 * 8 * 16);
  });

  it('flags powers of two', () => {
    expect(isPowerOfTwo(1)).toBe(true);
    expect(isPowerOfTwo(64)).toBe(true);
    expect(isPowerOfTwo(300)).toBe(false);
    expect(isPowerOfTwo(0)).toBe(false);
  });

  it('plans a power-of-two resize for NPOT sources', () => {
    const plan = getResizePlan(300, 200, { requirePowerOfTwo: true });
    expect(plan.width).toBe(512);
    expect(plan.height).toBe(256);
    expect(plan.resized).toBe(true);
    expect(plan.reason).toBe('power-of-two');
    expect(plan.scaleX).toBeCloseTo(512 / 300, 6);
    expect(plan.scaleY).toBeCloseTo(256 / 200, 6);
    expect(needsResize(300, 200, { requirePowerOfTwo: true })).toBe(true);

    // Already a power of two: nothing to do.
    expect(getResizePlan(64, 64, { requirePowerOfTwo: true }).resized).toBe(false);
    expect(getResizePlan(64, 64, { requirePowerOfTwo: true }).reason).toBe('ok');
  });

  it('clamps to maxSize without exceeding it', () => {
    const clamped = getResizePlan(4096, 2048, { requirePowerOfTwo: true, maxSize: 1024 });
    expect(clamped.width).toBe(1024);
    expect(clamped.height).toBe(512);
    expect(clamped.reason).toBe('max-size');

    // Both constraints apply, so both are reported.
    const both = getResizePlan(300, 200, { requirePowerOfTwo: true, maxSize: 100 });
    expect(both.width).toBe(64);
    expect(both.height).toBe(32);
    expect(both.reason).toBe('power-of-two+max-size');
  });

  it('pads instead of scaling when asked to', () => {
    const plan = getResizePlan(300, 200, { requirePowerOfTwo: true, npotPolicy: NpotPolicy.Pad });
    expect(plan.width).toBe(512);
    expect(plan.height).toBe(256);
    expect(plan.padX).toBe(212);
    expect(plan.padY).toBe(56);
  });

  it('creates GPU-free placeholder textures', () => {
    const white = createWhiteTexture();
    expect(white.width).toBe(1);
    expect(white.isReady()).toBe(true);
    expect(Array.from(white.data as Uint8Array)).toEqual([255, 255, 255, 255]);

    const normal = createNormalTexture();
    expect(Array.from(normal.data as Uint8Array)).toEqual([128, 128, 255, 255]);
  });
});

describe('Sampler', () => {
  it('compares by sampling intent, not by device capability', () => {
    const a = new Sampler({ wrapS: WrapMode.Repeat, mipmapFilter: MipmapFilter.Linear });
    const b = new Sampler({ wrapS: WrapMode.Repeat, mipmapFilter: MipmapFilter.Linear });
    b.maxAnisotropy = 4;
    expect(a.equals(b)).toBe(true);
    expect(a.hash()).toBe(b.hash());

    b.wrapS = WrapMode.ClampToEdge;
    expect(a.equals(b)).toBe(false);
    expect(a.hash()).not.toBe(b.hash());
  });

  it('derives its state from a texture', () => {
    const texture = new DataTexture(new Uint8Array(16), 2, 2);
    texture.wrapS = WrapMode.MirroredRepeat;
    texture.anisotropy = 8;
    const sampler = Sampler.fromTexture(texture);
    expect(sampler.wrapS).toBe(WrapMode.MirroredRepeat);
    expect(sampler.anisotropy).toBe(8);
    expect(sampler.minFilter).toBe(TextureFilter.Nearest);
    expect(sampler.mipmapFilter).toBe(MipmapFilter.None);
  });

  it('exposes a readable canonical key', () => {
    const sampler = new Sampler();
    expect(sampler.toKey().split('|')).toHaveLength(10);
    expect(sampler.clone().equals(sampler)).toBe(true);
    expect(sampler.isComparison).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Shaders                                                                    */
/* -------------------------------------------------------------------------- */

describe('ShaderChunk', () => {
  it('resolves #include directives, including nested ones', () => {
    defineChunk('test/base', 'float baseValue() { return 1.0; }');
    defineChunk('test/middle', '#include <test/base>\nfloat middleValue() { return baseValue() * 2.0; }');
    defineChunk('test/top', 'void main() { float v = 0.0; }\n#include <test/middle>');

    const resolved = resolve('#include <test/top>', { language: 'glsl' });
    expect(resolved).toContain('float baseValue()');
    expect(resolved).toContain('float middleValue()');
    expect(resolved).not.toContain('#include');
    // Dependencies are emitted before the chunk that needs them.
    expect(resolved.indexOf('baseValue()')).toBeLessThan(resolved.indexOf('middleValue()'));
  });

  it('emits a diamond dependency only once', () => {
    defineChunk('test/leaf', 'float leaf();');
    defineChunk('test/left', '#include <test/leaf>\nfloat left();');
    defineChunk('test/right', '#include <test/leaf>\nfloat right();');
    const resolved = resolve(['test/left', 'test/right'], { language: 'glsl' });
    expect(resolved.match(/float leaf\(\)/g)).toHaveLength(1);
  });

  it('supports the WGSL include syntax', () => {
    defineChunk('test/wgsl-common', 'fn helper() -> f32 { return 1.0; }');
    defineChunk('test/wgsl-main', '//!include test/wgsl-common\nfn main() {}');
    const resolved = resolve('#include <test/wgsl-main>', { language: 'wgsl' });
    expect(resolved).toContain('fn helper()');
  });

  it('throws a descriptive error for a cycle', () => {
    defineChunk('test/cycle-a', '#include <test/cycle-b>');
    defineChunk('test/cycle-b', '#include <test/cycle-a>');

    expect(() => resolve('#include <test/cycle-a>')).toThrow(ShaderChunkError);
    try {
      resolve('#include <test/cycle-a>');
      throw new Error('expected resolve() to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/Circular/);
      expect(message).toContain('test/cycle-a');
      expect(message).toContain('test/cycle-b');
      expect((error as ShaderChunkError).chain.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('throws a descriptive error for a missing chunk', () => {
    expect(() => resolve('#include <test/does-not-exist>')).toThrow(/is not defined/);
  });

  it('registers the built-in language chunks on import', () => {
    expect(hasChunk('glsl/common')).toBe(true);
    expect(hasChunk('wgsl/common')).toBe(true);
    expect(getChunk('glsl/lighting')).toContain('physicalShading');
    expect(listChunks()).toContain('glsl/lighting');
    expect(listChunks()).toContain('wgsl/skinning');
  });
});

describe('ShaderLib', () => {
  it('returns a standard descriptor with a GLSL and a WGSL variant', () => {
    const entry = getShaderLib('standard');
    expect(entry.glsl.language).toBe('glsl');
    expect(entry.glsl.vertex).toBeTruthy();
    expect(entry.glsl.fragment).toBeTruthy();

    expect(entry.wgsl).not.toBeNull();
    expect(entry.wgsl?.language).toBe('wgsl');
    expect(entry.wgsl?.vertex).toContain('@vertex');
    expect(entry.wgsl?.fragment).toContain('@fragment');

    expect(buildShaderDescriptor('standard', 'wgsl')).toBe(entry.wgsl);
  });

  it('registers every documented family', () => {
    const names = listShaderLib();
    for (const name of [
      'basic',
      'lambert',
      'phong',
      'standard',
      'physical',
      'points',
      'dashed',
      'sprite',
      'depth',
      'normal',
      'shadow',
      'background',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('documents the family that has no WGSL variant', () => {
    const physical = getShaderLib('physical');
    expect(physical.wgsl).toBeNull();
    expect(physical.wgslUnsupportedReason).toBeTruthy();
    // The fallback reports the limitation instead of throwing.
    expect(physical.buildWGSL?.()).toBeNull();
    expect(() => buildShaderDescriptor('physical', 'wgsl')).toThrow(/no WGSL variant/);
  });

  it('accepts a custom entry and rejects one without a WGSL explanation', () => {
    const before = Object.keys(ShaderLib).length;
    registerShaderLib('test-family', {
      name: 'test-family',
      description: 'test',
      glsl: { name: 'glsl/test-family', language: 'glsl', vertex: 'void main() {}', fragment: 'void main() {}' },
      wgsl: null,
      wgslUnsupportedReason: 'unit test',
    });
    expect(Object.keys(ShaderLib).length).toBe(before + 1);
    expect(getShaderLib('test-family').wgslUnsupportedReason).toBe('unit test');

    expect(() =>
      registerShaderLib('test-bad', {
        name: 'test-bad',
        description: 'test',
        glsl: { name: 'glsl/test-bad', language: 'glsl' },
        wgsl: null,
      }),
    ).toThrow(/must document why/);
  });
});

describe('ShaderCache', () => {
  it('evicts in least-recently-used order and reports stats', () => {
    const cache = new ShaderCache<number>();
    cache.setLimit(2);

    cache.set('a', 1);
    cache.set('b', 2);
    // Touch `a` so `b` becomes the least recently used entry.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('b')).toBe(false);

    const stats = cache.stats();
    expect(stats.size).toBe(2);
    expect(stats.limit).toBe(2);
    expect(stats.evictions).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(0);
    expect(stats.backends).toEqual({ default: 2 });

    // An unbounded cache never evicts.
    cache.setLimit(0);
    cache.set('d', 4);
    expect(cache.size).toBe(3);
  });

  it('namespaces entries per backend', () => {
    const cache = new ShaderCache<string>();
    cache.set('key', 'webgl-program', 'webgl');
    cache.set('key', 'webgpu-program', 'webgpu');

    expect(cache.get('key', 'webgl')).toBe('webgl-program');
    expect(cache.get('key', 'webgpu')).toBe('webgpu-program');
    expect(cache.keys('webgl')).toEqual(['key']);

    expect(cache.clear('webgl')).toBe(1);
    expect(cache.has('key', 'webgl')).toBe(false);
    expect(cache.has('key', 'webgpu')).toBe(true);
  });

  it('keys sources by their stripped text', () => {
    expect(ShaderCache.keyFor('void  main() { /* x */ }')).toBe(ShaderCache.keyFor('void main() { }'));
  });
});

describe('ShaderCompiler', () => {
  it('compiles, caches and releases a descriptor through a backend', () => {
    const calls: string[] = [];
    const compiler = new ShaderCompiler();
    compiler.registerBackend('test', {
      name: 'test',
      languages: ['glsl'],
      compileShader: (stage, source) => {
        calls.push(`${stage}:${source.includes('#include') ? 'unresolved' : 'resolved'}`);
        return { stage, source };
      },
      linkProgram: (compiled) => ({ stages: compiled.length }),
      disposeProgram: () => undefined,
    });

    const descriptor = {
      name: 'test/basic',
      language: 'glsl' as const,
      vertex: 'void main() { gl_Position = vec4(0.0); }',
      fragment: 'void main() { gl_FragColor = vec4(1.0); }',
      defines: { USE_MAP: true },
    };

    const first = compiler.compile(descriptor);
    expect(first.shaders).toHaveLength(2);
    expect(calls).toHaveLength(2);

    const second = compiler.compile(descriptor);
    expect(second).toBe(first);
    expect(calls).toHaveLength(2);

    const stats = compiler.getStats();
    expect(stats.compiles).toBe(1);
    expect(stats.cacheHits).toBe(1);
    expect(stats.programs).toBe(1);

    expect(compiler.hasProgram(first.key)).toBe(true);
    expect(compiler.invalidate(first.key)).toBe(true);
    expect(compiler.getStats().released).toBe(1);
  });

  it('resolves chunk includes while assembling a stage', () => {
    defineChunk('glsl/test-only', 'float testOnly();');
    const compiler = new ShaderCompiler();
    const source = compiler.assembleStage(
      {
        name: 'test/includes',
        language: 'glsl',
        vertex: '#include <test-only>\nvoid main() {}',
        defines: { USE_MAP: true, DISABLED: false },
      },
      'vertex',
    );
    expect(source).toContain('float testOnly();');
    expect(source).toContain('#define USE_MAP');
    expect(source).not.toContain('DISABLED');
  });

  it('rejects a language the backend does not accept', () => {
    const compiler = new ShaderCompiler();
    compiler.registerBackend('glsl-only', {
      name: 'glsl-only',
      languages: ['glsl'],
      compileShader: () => ({}),
      linkProgram: () => ({}),
      disposeProgram: () => undefined,
    });
    expect(() =>
      compiler.compile({ name: 'wgsl/test', language: 'wgsl', vertex: 'fn x() {}' }),
    ).toThrow(/does not accept WGSL/);
  });

  it('fails clearly when no backend is registered', () => {
    const compiler = new ShaderCompiler();
    expect(() => compiler.compile({ name: 'x', language: 'glsl', vertex: 'void main() {}' })).toThrow(
      /No shader backend/,
    );
  });
});

describe('Uniforms', () => {
  it('infers matrix, vector, colour, texture and scalar types', () => {
    expect(inferUniformType(new Mat4())).toBe('mat4');
    expect(inferUniformType(new Mat3())).toBe('mat3');
    expect(inferUniformType(new Vec3(1, 2, 3))).toBe('vec3');
    expect(inferUniformType(new Vec2(1, 2))).toBe('vec2');
    expect(inferUniformType(new Color(1, 0, 0))).toBe('color');
    expect(inferUniformType({ isTexture: true })).toBe('texture');
    expect(inferUniformType({ isSampler: true })).toBe('sampler');
    expect(inferUniformType(0.5)).toBe('float');
    expect(inferUniformType(true)).toBe('bool');
    expect(inferUniformType([1, 2, 3, 4])).toBe('vec4');
    expect(inferUniformType(new Float32Array(16))).toBe('mat4');
    expect(inferUniformType([1, 2, 3, 4, 5])).toBe('array');
    expect(inferUniformType(null)).toBe('unknown');
  });

  it('renders the GLSL and WGSL spellings of a declaration', () => {
    expect(uniformTypeName('color', 'glsl')).toBe('vec3');
    expect(uniformTypeName('color', 'wgsl')).toBe('vec3<f32>');
    expect(uniformTypeName('texture', 'glsl')).toBe('sampler2D');
    expect(uniformTypeName('mat4', 'wgsl')).toBe('mat4x4<f32>');

    const uniforms = new Uniforms();
    uniforms.set('uModelViewMatrix', new Mat4());
    uniforms.set('uColor', new Color(1, 0, 0));
    uniforms.set('uOpacity', 0.5);
    uniforms.set('uMap', { isTexture: true });

    const glsl = uniforms.getDeclaration('glsl');
    expect(glsl).toBe(
      [
        'uniform mat4 uModelViewMatrix;',
        'uniform vec3 uColor;',
        'uniform float uOpacity;',
        'uniform sampler2D uMap;',
      ].join('\n'),
    );

    const wgsl = uniforms.getDeclaration('wgsl');
    expect(wgsl).toContain('@group(0) @binding(0) var<uniform> uModelViewMatrix: mat4x4<f32>;');
    expect(wgsl).toContain('@group(0) @binding(1) var<uniform> uColor: vec3<f32>;');
    expect(wgsl).toContain('@group(0) @binding(2) var<uniform> uOpacity: f32;');
    expect(wgsl).toContain('@group(0) @binding(3) var uMap: texture_2d<f32>;');
    expect(wgsl.split('\n')).toHaveLength(4);
  });

  it('renders array declarations per language', () => {
    const uniforms = new Uniforms();
    uniforms.set('uLights', [1, 2, 3, 4], { type: 'array', elementType: 'vec3', count: 4 });
    expect(uniforms.getDeclaration('glsl')).toBe('uniform vec3 uLights[4];');
    expect(uniforms.getDeclaration('wgsl')).toBe(
      '@group(0) @binding(0) var<uniform> uLights: array<vec3<f32>, 4>;',
    );
  });

  it('tracks changes and compares by value', () => {
    const a = new Uniforms({ uOpacity: 1 });
    const b = new Uniforms({ uOpacity: 1 });
    expect(a.equals(b)).toBe(true);

    b.set('uOpacity', 0.5);
    expect(a.equals(b)).toBe(false);

    const clone = a.clone();
    expect(clone.equals(a)).toBe(true);
    clone.set('uTime', 3);
    expect(a.has('uTime')).toBe(false);
    expect(a.version).toBeLessThan(clone.version);

    a.markDirty('uOpacity');
    expect(a.isDirty).toBe(true);
    expect(a.consumeDirty()).toEqual(['uOpacity']);
    expect(a.isDirty).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* MaterialFactory                                                            */
/* -------------------------------------------------------------------------- */

describe('MaterialFactory', () => {
  it('creates a registered material with overrides', () => {
    const material = createMaterial('MeshStandardMaterial', { roughness: 0.4 });
    expect(material).toBeInstanceOf(MeshStandardMaterial);
    expect((material as MeshStandardMaterial).roughness).toBe(0.4);
    expect(getMaterialConstructor('MeshStandardMaterial')).toBe(MeshStandardMaterial);
    expect(listMaterialTypes()).toContain('DepthMaterial');
  });

  it('accepts the descriptor form', () => {
    const material = createMaterial({ type: 'MeshPhongMaterial', shininess: 60, name: 'shiny' });
    expect(material).toBeInstanceOf(MeshPhongMaterial);
    expect((material as MeshPhongMaterial).shininess).toBe(60);
    expect(material.name).toBe('shiny');
  });

  it('registers and unregisters custom types', () => {
    class ToonMaterial extends Material {
      public override readonly type: string = 'ToonMaterial';
    }
    registerMaterialType('ToonMaterial', ToonMaterial);
    const toon = createMaterial('ToonMaterial');
    expect(toon).toBeInstanceOf(ToonMaterial);
    expect(toon.type).toBe('ToonMaterial');
    expect(unregisterMaterialType('ToonMaterial')).toBe(true);
    expect(() => createMaterial('ToonMaterial')).toThrow(MaterialFactoryError);
  });

  it('round-trips through JSON, decoding an infinite attenuation distance', () => {
    const source = new MeshStandardMaterial({ roughness: 0.7 });
    const json = source.toJSON();
    expect(json.type).toBe('MeshStandardMaterial');

    const restored = createMaterialFromJSON(JSON.parse(JSON.stringify(json)) as typeof json);
    expect(restored).toBeInstanceOf(MeshStandardMaterial);
    expect((restored as MeshStandardMaterial).roughness).toBe(0.7);
  });

  it('round-trips the physical material through JSON', () => {
    const source = new MeshPhysicalMaterial({ transmission: 1, thickness: 0.5, ior: 1.5 });
    const restored = createMaterialFromJSON(JSON.parse(JSON.stringify(source.toJSON())));
    expect(restored).toBeInstanceOf(MeshPhysicalMaterial);
    expect((restored as MeshPhysicalMaterial).transmission).toBe(1);
    expect((restored as MeshPhysicalMaterial).thickness).toBe(0.5);
    // `Infinity` cannot survive JSON, so the decoder restores it.
    expect((restored as MeshPhysicalMaterial).attenuationDistance).toBe(Infinity);
  });

  it('keeps the factory error type informative', () => {
    try {
      createMaterial('NotAMaterial');
      throw new Error('expected createMaterial() to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MaterialFactoryError);
      expect((error as MaterialFactoryError).materialType).toBe('NotAMaterial');
      expect((error as Error).message).toContain('Unknown material type');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Depth material sanity                                                      */
/* -------------------------------------------------------------------------- */

describe('DepthMaterial', () => {
  it('defaults to basic depth packing and owns its maps', () => {
    const alphaMap = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const material = new DepthMaterial({ alphaMap, displacementScale: 2 });
    expect(material.depthPacking).toBe('basic');
    expect(material.displacementScale).toBe(2);
    expect(material.alphaMap).toBe(alphaMap);

    const clone = material.clone();
    expect(clone.alphaMap).toBe(alphaMap);
    expect(clone.displacementScale).toBe(2);

    material.dispose();
    expect(alphaMap.isDisposed).toBe(true);
  });
});
