/**
 * WebGL + WebGPU backend tests.
 *
 * ## Why every GPU object here is hand-written
 *
 * These tests run in Vitest's **Node** environment: there is no `document`, no
 * `OffscreenCanvas`, no `navigator.gpu` and no GPU. Rather than mock a library, the
 * file defines the smallest object that satisfies each backend's needs:
 *
 * - `FakeGL2` records every `gl.*` call, which is exactly what the WebGL state-shadow
 *   test asserts against;
 * - `createFakeGPUDevice()` records compute dispatches and queue submissions, which is
 *   what the WebGPU dispatch-validation test needs.
 *
 * Both are *behavioural* doubles: they implement the methods the code under test calls
 * and nothing more. That is possible because neither backend reaches for state it did
 * not ask for — a property worth keeping.
 *
 * The GPU draw paths themselves are deliberately not exercised: without a real device
 * they could only prove that no call was issued, which the headless-renderer
 * assertions already cover.
 */

import { describe, expect, it } from 'vitest';

import {
  BlendEquation,
  BlendFactor,
  ClearFlags,
  CompareFunction,
  CullMode,
  PixelFormat,
  PrimitiveTopology,
  TextureFilter,
  TextureWrap,
} from '../../src/renderer/interfaces/types';
import { BufferType, BufferUsage } from '../../src/renderer/interfaces/IBuffer';
import { RenderState } from '../../src/renderer/core/RenderState';

import {
  SUPPORTED_PIXEL_FORMATS,
  convertColor,
  convertDepth,
  fromGLFormat,
  isCompressedFormat,
  toGLBlendFactor,
  toGLBufferTarget,
  toGLBufferUsage,
  toGLClearMask,
  toGLCompareFunction,
  toGLCullFace,
  toGLFormat,
  toGLTextureFilter,
  toGLTextureWrap,
  toGLTopology,
} from '../../src/renderer/webgl/WebGLUtils';
import { UNKNOWN, WebGLState } from '../../src/renderer/webgl/WebGLState';
import { formatWebGLInfoLog, parseWebGLInfoLog, prependDefines } from '../../src/renderer/webgl/WebGLShader';
import { buildProgramKey, hashString, ProgramLRUCache } from '../../src/renderer/webgl/WebGLProgram';
import { WebGLRenderer } from '../../src/renderer/webgl/WebGLRenderer';

import {
  alignTo,
  alignUniformOffset,
  buildVertexBufferLayout,
  buildVertexBufferLayouts,
  bytesPerRowAlignment,
  computeTextureCopyLayout,
  fromGPUTextureFormat,
  GPUColorWrite,
  GPUMapMode,
  toGPUBufferUsage,
  toGPUIndexFormat,
  toGPUTextureFormat,
  toGPUVertexFormat,
  type GPUCanvasContextLike,
  type GPUDeviceLike,
  type GPUTextureLike,
} from '../../src/renderer/webgpu/WebGPUUtils';
import { WebGPUSwapChain, resolveSwapChainFormat } from '../../src/renderer/webgpu/WebGPUSwapChain';
import { WebGPUCompute, validateWorkgroupCount, validateWorkgroups } from '../../src/renderer/webgpu/WebGPUCompute';
import { WebGPUState } from '../../src/renderer/webgpu/WebGPUState';
import { WebGPURenderer } from '../../src/renderer/webgpu/WebGPURenderer';
import { WebGPUCapabilities } from '../../src/renderer/webgpu/WebGPUAdapter';
import { buildDepthStencilState, hashPipelineDescriptor, stableSerialize } from '../../src/renderer/webgpu/WebGPUPipeline';
import { formatWGSLDiagnostics, parseWGSLDiagnostic } from '../../src/renderer/webgpu/WebGPUShader';

import * as webglBarrel from '../../src/renderer/webgl';
import * as webgpuBarrel from '../../src/renderer/webgpu';
import * as rendererBarrel from '../../src/renderer';

/* -------------------------------------------------------------------------- */
/* Hand-written WebGL2 double                                                 */
/* -------------------------------------------------------------------------- */

/** One recorded call on the GL double. */
interface RecordedGLCall {
  method: string;
  args: unknown[];
}

/**
 * A GL context double that records every call.
 *
 * Only the enumerations the assertions inspect are declared as fields; every other
 * name resolves through `glConst`'s numeric fallbacks, which use the real WebGL
 * values. That keeps the double honest: it proves the backend tolerates a context that
 * exposes fewer names than a browser's.
 */
class FakeGL2 {
  public readonly calls: RecordedGLCall[] = [];

  // Enumerations the assertions compare against.
  public readonly DEPTH_TEST: number = 0x0b71;
  public readonly BLEND: number = 0x0be2;
  public readonly CULL_FACE: number = 0x0b44;
  public readonly SCISSOR_TEST: number = 0x0c11;
  public readonly STENCIL_TEST: number = 0x0b90;
  public readonly POLYGON_OFFSET_FILL: number = 0x8037;
  public readonly ARRAY_BUFFER: number = 0x8892;
  public readonly ELEMENT_ARRAY_BUFFER: number = 0x8893;
  public readonly TEXTURE0: number = 0x84c0;
  public readonly TEXTURE_2D: number = 0x0de1;
  public readonly FRONT: number = 0x0404;
  public readonly BACK: number = 0x0405;
  public readonly SRC_ALPHA: number = 0x0302;
  public readonly ONE_MINUS_SRC_ALPHA: number = 0x0303;
  public readonly ONE: number = 1;
  public readonly ZERO: number = 0;
  public readonly CW: number = 0x0900;
  public readonly CCW: number = 0x0901;
  public readonly MAX_TEXTURE_SIZE: number = 0x0d33;

  /** @returns The recorded call method names, in order. */
  public callNames(): string[] {
    return this.calls.map((call) => call.method);
  }

  /** @returns The number of calls to `method`. */
  public countCalls(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  /** Forgets every recorded call. */
  public reset(): void {
    this.calls.length = 0;
  }

  /** Records one call. */
  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  /* --- capability / fixed-function state ---------------------------------- */

  enable(cap: number): void {
    this.record('enable', cap);
  }
  disable(cap: number): void {
    this.record('disable', cap);
  }
  isEnabled(cap: number): boolean {
    this.record('isEnabled', cap);
    return false;
  }
  depthFunc(func: number): void {
    this.record('depthFunc', func);
  }
  depthMask(flag: boolean): void {
    this.record('depthMask', flag);
  }
  depthRange(near: number, far: number): void {
    this.record('depthRange', near, far);
  }
  blendFunc(src: number, dst: number): void {
    this.record('blendFunc', src, dst);
  }
  blendFuncSeparate(srcRGB: number, dstRGB: number, srcA: number, dstA: number): void {
    this.record('blendFuncSeparate', srcRGB, dstRGB, srcA, dstA);
  }
  blendEquation(mode: number): void {
    this.record('blendEquation', mode);
  }
  blendEquationSeparate(rgb: number, alpha: number): void {
    this.record('blendEquationSeparate', rgb, alpha);
  }
  blendColor(r: number, g: number, b: number, a: number): void {
    this.record('blendColor', r, g, b, a);
  }
  cullFace(mode: number): void {
    this.record('cullFace', mode);
  }
  frontFace(mode: number): void {
    this.record('frontFace', mode);
  }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    this.record('colorMask', r, g, b, a);
  }
  scissor(x: number, y: number, w: number, h: number): void {
    this.record('scissor', x, y, w, h);
  }
  viewport(x: number, y: number, w: number, h: number): void {
    this.record('viewport', x, y, w, h);
  }
  lineWidth(width: number): void {
    this.record('lineWidth', width);
  }
  polygonOffset(factor: number, units: number): void {
    this.record('polygonOffset', factor, units);
  }
  stencilFunc(func: number, ref: number, mask: number): void {
    this.record('stencilFunc', func, ref, mask);
  }
  stencilMask(mask: number): void {
    this.record('stencilMask', mask);
  }
  stencilOp(fail: number, zfail: number, zpass: number): void {
    this.record('stencilOp', fail, zfail, zpass);
  }

  /* --- bindings ------------------------------------------------------------ */

  activeTexture(unit: number): void {
    this.record('activeTexture', unit);
  }
  bindTexture(target: number, texture: unknown): void {
    this.record('bindTexture', target, texture);
  }
  bindBuffer(target: number, buffer: unknown): void {
    this.record('bindBuffer', target, buffer);
  }
  bindVertexArray(vao: unknown): void {
    this.record('bindVertexArray', vao);
  }
  useProgram(program: unknown): void {
    this.record('useProgram', program);
  }

  /* --- drawing ------------------------------------------------------------- */

  clear(mask: number): void {
    this.record('clear', mask);
  }
  clearColor(r: number, g: number, b: number, a: number): void {
    this.record('clearColor', r, g, b, a);
  }
  clearDepth(depth: number): void {
    this.record('clearDepth', depth);
  }
  clearStencil(value: number): void {
    this.record('clearStencil', value);
  }
  drawArrays(mode: number, first: number, count: number): void {
    this.record('drawArrays', mode, first, count);
  }
  drawElements(mode: number, count: number, type: number, offset: number): void {
    this.record('drawElements', mode, count, type, offset);
  }
  drawArraysInstanced(mode: number, first: number, count: number, instances: number): void {
    this.record('drawArraysInstanced', mode, first, count, instances);
  }
  drawElementsInstanced(mode: number, count: number, type: number, offset: number, instances: number): void {
    this.record('drawElementsInstanced', mode, count, type, offset, instances);
  }
  flush(): void {
    this.record('flush');
  }
  finish(): void {
    this.record('finish');
  }

  /* --- objects ------------------------------------------------------------- */

  createBuffer(): object {
    this.record('createBuffer');
    return { __buffer: true };
  }
  deleteBuffer(buffer: unknown): void {
    this.record('deleteBuffer', buffer);
  }
  bufferData(target: number, data: unknown, usage: number): void {
    this.record('bufferData', target, data, usage);
  }
  bufferSubData(target: number, offset: number, data: unknown): void {
    this.record('bufferSubData', target, offset, data);
  }
  createVertexArray(): object {
    this.record('createVertexArray');
    return { __vao: true };
  }
  deleteVertexArray(vao: unknown): void {
    this.record('deleteVertexArray', vao);
  }
  createTexture(): object {
    this.record('createTexture');
    return { __texture: true };
  }
  deleteTexture(texture: unknown): void {
    this.record('deleteTexture', texture);
  }
  texParameteri(target: number, pname: number, param: number): void {
    this.record('texParameteri', target, pname, param);
  }
  texImage2D(...args: unknown[]): void {
    this.record('texImage2D', ...args);
  }
  generateMipmap(target: number): void {
    this.record('generateMipmap', target);
  }
  pixelStorei(pname: number, param: number): void {
    this.record('pixelStorei', pname, param);
  }
  createFramebuffer(): object {
    this.record('createFramebuffer');
    return { __fbo: true };
  }
  deleteFramebuffer(framebuffer: unknown): void {
    this.record('deleteFramebuffer', framebuffer);
  }
  bindFramebuffer(target: number, framebuffer: unknown): void {
    this.record('bindFramebuffer', target, framebuffer);
  }
  checkFramebufferStatus(_target: number): number {
    this.record('checkFramebufferStatus');
    return 0x8cd5;
  }
  createRenderbuffer(): object {
    this.record('createRenderbuffer');
    return { __rbo: true };
  }
  deleteRenderbuffer(renderbuffer: unknown): void {
    this.record('deleteRenderbuffer', renderbuffer);
  }
  createShader(_type: number): object {
    this.record('createShader');
    return { __shader: true };
  }
  shaderSource(_shader: unknown, _source: string): void {
    this.record('shaderSource');
  }
  compileShader(_shader: unknown): void {
    this.record('compileShader');
  }
  getShaderParameter(_shader: unknown, _pname: number): boolean {
    this.record('getShaderParameter');
    return true;
  }
  getShaderInfoLog(_shader: unknown): string {
    this.record('getShaderInfoLog');
    return '';
  }
  deleteShader(shader: unknown): void {
    this.record('deleteShader', shader);
  }
  createProgram(): object {
    this.record('createProgram');
    return { __program: true };
  }
  attachShader(_program: unknown, _shader: unknown): void {
    this.record('attachShader');
  }
  detachShader(_program: unknown, _shader: unknown): void {
    this.record('detachShader');
  }
  bindAttribLocation(_program: unknown, _index: number, _name: string): void {
    this.record('bindAttribLocation');
  }
  linkProgram(_program: unknown): void {
    this.record('linkProgram');
  }
  getProgramParameter(_program: unknown, _pname: number): number | boolean {
    this.record('getProgramParameter');
    return 0;
  }
  getProgramInfoLog(_program: unknown): string {
    this.record('getProgramInfoLog');
    return '';
  }
  deleteProgram(program: unknown): void {
    this.record('deleteProgram', program);
  }
  getActiveUniform(_program: unknown, _index: number): unknown {
    this.record('getActiveUniform');
    return null;
  }
  getActiveAttrib(_program: unknown, _index: number): unknown {
    this.record('getActiveAttrib');
    return null;
  }
  getUniformLocation(_program: unknown, _name: string): unknown {
    this.record('getUniformLocation');
    return null;
  }
  getAttribLocation(_program: unknown, _name: string): number {
    this.record('getAttribLocation');
    return 0;
  }
  enableVertexAttribArray(_index: number): void {
    this.record('enableVertexAttribArray');
  }
  disableVertexAttribArray(_index: number): void {
    this.record('disableVertexAttribArray');
  }
  vertexAttribPointer(...args: unknown[]): void {
    this.record('vertexAttribPointer', ...args);
  }

  /* --- queries / extensions ------------------------------------------------ */

  getParameter(pname: number): unknown {
    this.record('getParameter', pname);
    if (pname === this.MAX_TEXTURE_SIZE) return 4096;
    return 8;
  }
  getExtension(name: string): unknown {
    this.record('getExtension', name);
    return null;
  }
  getContextAttributes(): Record<string, unknown> {
    this.record('getContextAttributes');
    return { alpha: true, depth: true, stencil: false, antialias: true };
  }
}

/** Builds a fresh GL double typed as a WebGL2 context. */
function createFakeGL(): { gl: FakeGL2; context: WebGL2RenderingContext } {
  const gl = new FakeGL2();
  return { gl, context: gl as unknown as WebGL2RenderingContext };
}

/**
 * Drives every `WebGLState` setter once, so every cached value becomes known.
 *
 * Called twice in the "replay is minimal" test: the second call proves the full state
 * is already established, which is what makes the subsequent `popState()` replay
 * exactly one call.
 */
function applyFullState(state: WebGLState, gl: FakeGL2): void {
  state.setDepthTest(true);
  state.setDepthWrite(true);
  state.setDepthFunc(CompareFunction.Less);
  state.setBlend(true);
  state.setBlendFunc(BlendFactor.One, BlendFactor.Zero);
  state.setBlendEquation(BlendEquation.Add);
  state.setBlendColor(0, 0, 0, 0);
  state.setCullFace(CullMode.Back);
  state.setFrontFace(true);
  state.setColorMask(true, true, true, true);
  state.setScissor(null);
  state.setViewport({ x: 0, y: 0, width: 100, height: 100 });
  state.setStencilTest(false);
  state.setPolygonOffset(0, 0);
  state.setLineWidth(1);
  state.setActiveTexture(0);
  state.bindTexture(0, gl.TEXTURE_2D, null);
  state.bindArrayBuffer(null);
  state.bindElementArrayBuffer(null);
  state.bindVertexArray(null);
  state.useProgram(null);
}

/* -------------------------------------------------------------------------- */
/* Hand-written WebGPU double                                                 */
/* -------------------------------------------------------------------------- */

/** A device double plus the observations a test needs. */
interface FakeGPUDevice {
  device: GPUDeviceLike;
  dispatches: number[][];
  submissions: () => number;
  limits: Record<string, number>;
}

/** Builds a device double that records compute dispatches and submissions. */
function createFakeGPUDevice(): FakeGPUDevice {
  const dispatches: number[][] = [];
  const counters = { submissions: 0 };
  const limits: Record<string, number> = {
    maxComputeWorkgroupsPerDimension: 4096,
    maxComputeWorkgroupSizeX: 256,
    maxTextureDimension2D: 8192,
    maxBufferSize: 1 << 26,
  };

  const computePass = {
    setPipeline: (): void => undefined,
    setBindGroup: (): void => undefined,
    dispatchWorkgroups: (x: number, y: number, z: number): void => {
      dispatches.push([x, y, z]);
    },
    end: (): void => undefined,
  };

  const colorAttachment = {
    setPipeline: (): void => undefined,
    setBindGroup: (): void => undefined,
    setVertexBuffer: (): void => undefined,
    setIndexBuffer: (): void => undefined,
    draw: (): void => undefined,
    drawIndexed: (): void => undefined,
    setViewport: (): void => undefined,
    setScissorRect: (): void => undefined,
    end: (): void => undefined,
  };

  const device = {
    label: 'fake-device',
    limits,
    features: { has: (): boolean => false },
    queue: {
      writeBuffer: (): void => undefined,
      writeTexture: (): void => undefined,
      submit: (): void => {
        counters.submissions++;
      },
      onSubmittedWorkDone: async (): Promise<void> => undefined,
    },
    lost: new Promise<never>(() => undefined),
    createCommandEncoder: () => ({
      beginRenderPass: () => colorAttachment,
      beginComputePass: () => computePass,
      copyBufferToBuffer: (): void => undefined,
      copyBufferToTexture: (): void => undefined,
      copyTextureToBuffer: (): void => undefined,
      copyTextureToTexture: (): void => undefined,
      finish: () => ({ label: 'command-buffer' }),
    }),
    createBuffer: () => ({ label: 'buffer', size: 4, usage: 0, mapState: 'unmapped' }),
    createTexture: () => ({ label: 'texture', width: 1, height: 1 }),
    createSampler: () => ({ label: 'sampler' }),
    createShaderModule: () => ({ label: 'module' }),
    createBindGroupLayout: () => ({ label: 'bind-group-layout' }),
    createPipelineLayout: () => ({ label: 'pipeline-layout' }),
    createBindGroup: () => ({ label: 'bind-group' }),
    createRenderPipeline: () => ({ label: 'render-pipeline' }),
    createComputePipeline: () => ({ label: 'compute-pipeline' }),
    destroy: (): void => undefined,
  };

  return {
    device: device as unknown as GPUDeviceLike,
    dispatches,
    submissions: () => counters.submissions,
    limits,
  };
}

/* -------------------------------------------------------------------------- */
/* WebGLState                                                                 */
/* -------------------------------------------------------------------------- */

describe('WebGLState', () => {
  it('is a complete no-op when the requested value already matches', () => {
    const { gl, context } = createFakeGL();
    const state = new WebGLState(context, { isWebGL2: true });

    applyFullState(state, gl);
    const issued = state.callCount;
    expect(issued).toBeGreaterThan(0);

    gl.reset();
    const changesBefore = state.changeCount;

    applyFullState(state, gl);

    expect(gl.calls).toHaveLength(0);
    expect(state.changeCount).toBe(changesBefore);
    expect(state.callCount).toBe(issued);
  });

  it('issues exactly the calls a change requires', () => {
    const { gl, context } = createFakeGL();
    const state = new WebGLState(context, { isWebGL2: true });

    gl.reset();
    state.setDepthTest(true);
    expect(gl.callNames()).toEqual(['enable']);
    expect(gl.calls[0].args[0]).toBe(gl.DEPTH_TEST);

    gl.reset();
    state.setDepthTest(false);
    expect(gl.callNames()).toEqual(['disable']);
    expect(gl.calls[0].args[0]).toBe(gl.DEPTH_TEST);

    gl.reset();
    state.setDepthFunc(CompareFunction.Always);
    expect(gl.callNames()).toEqual(['depthFunc']);
    expect(gl.calls[0].args[0]).toBe(toGLCompareFunction(context, CompareFunction.Always));

    gl.reset();
    state.setDepthWrite(false);
    expect(gl.callNames()).toEqual(['depthMask']);
    expect(gl.calls[0].args[0]).toBe(false);

    gl.reset();
    state.setBlendFunc(BlendFactor.SrcAlpha, BlendFactor.OneMinusSrcAlpha);
    expect(gl.callNames()).toEqual(['blendFunc']);
    expect(gl.calls[0].args).toEqual([
      toGLBlendFactor(context, BlendFactor.SrcAlpha),
      toGLBlendFactor(context, BlendFactor.OneMinusSrcAlpha),
    ]);

    gl.reset();
    state.setBlendFunc(BlendFactor.SrcAlpha, BlendFactor.OneMinusSrcAlpha);
    expect(gl.calls).toHaveLength(0);

    gl.reset();
    state.setCullFace(CullMode.Front);
    expect(gl.callNames()).toEqual(['enable', 'cullFace']);
    expect(gl.calls[1].args[0]).toBe(gl.FRONT);

    gl.reset();
    state.setCullFace(CullMode.Front);
    expect(gl.calls).toHaveLength(0);

    gl.reset();
    state.setCullFace(CullMode.None);
    expect(gl.callNames()).toEqual(['disable']);
    expect(state.getSnapshot().cullFace).toBe(CullMode.None);

    gl.reset();
    state.setFrontFace(false);
    expect(gl.callNames()).toEqual(['frontFace']);
    expect(gl.calls[0].args[0]).toBe(gl.CW);

    gl.reset();
    state.setColorMask(true, true, true, false);
    expect(gl.callNames()).toEqual(['colorMask']);
    expect(gl.calls[0].args).toEqual([true, true, true, false]);

    gl.reset();
    state.setViewport({ x: 0, y: 0, width: 640, height: 480 });
    expect(gl.callNames()).toEqual(['viewport']);
    expect(gl.calls[0].args).toEqual([0, 0, 640, 480]);

    gl.reset();
    state.setViewport({ x: 0, y: 0, width: 640, height: 480 });
    expect(gl.calls).toHaveLength(0);

    gl.reset();
    state.setScissor({ x: 1, y: 2, width: 3, height: 4 });
    expect(gl.callNames()).toEqual(['enable', 'scissor']);
    expect(gl.calls[1].args).toEqual([1, 2, 3, 4]);

    gl.reset();
    state.setScissor(null);
    expect(gl.callNames()).toEqual(['disable']);
    expect(gl.calls[0].args[0]).toBe(gl.SCISSOR_TEST);

    gl.reset();
    state.setActiveTexture(3);
    expect(gl.callNames()).toEqual(['activeTexture']);
    expect(gl.calls[0].args[0]).toBe(gl.TEXTURE0 + 3);

    gl.reset();
    state.setActiveTexture(3);
    expect(gl.calls).toHaveLength(0);

    gl.reset();
    state.setPolygonOffset(2, 5);
    expect(gl.callNames()).toEqual(['enable', 'polygonOffset']);

    gl.reset();
    state.setPolygonOffset(2, 5);
    expect(gl.calls).toHaveLength(0);

    gl.reset();
    state.setStencilTest(true);
    state.setStencilFunc(CompareFunction.Equal, 7, 0xff);
    state.setStencilMask(0x3c);
    expect(gl.callNames()).toEqual(['enable', 'stencilFunc', 'stencilMask']);
    expect(gl.calls[1].args).toEqual([toGLCompareFunction(context, CompareFunction.Equal), 7, 0xff]);
    expect(gl.calls[2].args).toEqual([0x3c]);

    gl.reset();
    state.setLineWidth(2);
    expect(gl.callNames()).toEqual(['lineWidth']);
    state.setLineWidth(2);
    expect(gl.countCalls('lineWidth')).toBe(1);
  });

  it('deduplicates texture, buffer, VAO and program bindings per slot', () => {
    const { gl, context } = createFakeGL();
    const state = new WebGLState(context, { isWebGL2: true });

    const textureA = { __texture: 'a' } as unknown as WebGLTexture;
    const textureB = { __texture: 'b' } as unknown as WebGLTexture;
    const buffer = { __buffer: 'a' } as unknown as WebGLBuffer;
    const vao = { __vao: 'a' } as unknown as WebGLVertexArrayObject;
    const program = { __program: 'a' } as unknown as WebGLProgram;

    state.bindTexture(0, gl.TEXTURE_2D, textureA);
    expect(gl.callNames()).toEqual(['activeTexture', 'bindTexture']);

    gl.reset();
    state.bindTexture(0, gl.TEXTURE_2D, textureA);
    expect(gl.calls).toHaveLength(0);

    // The same texture on a different unit is a real change.
    gl.reset();
    state.bindTexture(1, gl.TEXTURE_2D, textureA);
    expect(gl.callNames()).toEqual(['activeTexture', 'bindTexture']);

    // A different texture on a locked unit is a real change too.
    gl.reset();
    state.bindTexture(0, gl.TEXTURE_2D, textureB);
    expect(gl.callNames()).toEqual(['activeTexture', 'bindTexture']);

    gl.reset();
    state.bindArrayBuffer(buffer);
    expect(gl.callNames()).toEqual(['bindBuffer']);
    expect(gl.calls[0].args[0]).toBe(gl.ARRAY_BUFFER);

    gl.reset();
    state.bindArrayBuffer(buffer);
    expect(gl.calls).toHaveLength(0);

    gl.reset();
    state.bindElementArrayBuffer(buffer);
    expect(gl.callNames()).toEqual(['bindBuffer']);
    expect(gl.calls[0].args[0]).toBe(gl.ELEMENT_ARRAY_BUFFER);

    gl.reset();
    state.bindVertexArray(vao);
    expect(gl.callNames()).toEqual(['bindVertexArray']);

    gl.reset();
    state.bindVertexArray(vao);
    expect(gl.calls).toHaveLength(0);

    gl.reset();
    state.useProgram(program);
    expect(gl.callNames()).toEqual(['useProgram']);

    gl.reset();
    state.useProgram(program);
    expect(gl.calls).toHaveLength(0);

    const snapshot = state.getSnapshot();
    expect(snapshot.boundTextures).toHaveLength(2);
    expect(snapshot.currentProgram).toBe(program);
    expect(snapshot.boundVertexArray).toBe(vao);
    expect(snapshot.boundArrayBuffer).toBe(buffer);
  });

  it('restores the full snapshot through pushState/popState', () => {
    const { gl, context } = createFakeGL();
    const state = new WebGLState(context, { isWebGL2: true });

    // Establish a thoroughly non-default state.
    state.setDepthTest(true);
    state.setDepthWrite(false);
    state.setDepthFunc(CompareFunction.Greater);
    state.setBlend(true);
    state.setBlendFuncSeparate(
      BlendFactor.SrcAlpha,
      BlendFactor.OneMinusSrcAlpha,
      BlendFactor.One,
      BlendFactor.OneMinusSrcAlpha,
    );
    state.setBlendEquationSeparate(BlendEquation.Add, BlendEquation.Max);
    state.setBlendColor(0.25, 0.5, 0.75, 1);
    state.setCullFace(CullMode.Front);
    state.setFrontFace(false);
    state.setColorMask(true, false, true, true);
    state.setScissor({ x: 5, y: 6, width: 70, height: 80 });
    state.setViewport({ x: 1, y: 2, width: 300, height: 200 });
    state.setStencilTest(true);
    state.setStencilFunc(CompareFunction.NotEqual, 9, 0x7f);
    state.setStencilMask(0x1f);
    state.setPolygonOffset(3, 7);
    state.setLineWidth(1);

    const pushed = state.getSnapshot();
    state.pushState();
    expect(state.depth).toBe(1);

    // A nested block that changes essentially everything.
    state.setDepthTest(false);
    state.setDepthWrite(true);
    state.setDepthFunc(CompareFunction.Always);
    state.setBlend(false);
    state.setBlendFunc(BlendFactor.One, BlendFactor.Zero);
    state.setCullFace(CullMode.FrontAndBack);
    state.setFrontFace(true);
    state.setColorMask(false, false, false, true);
    state.setScissor(null);
    state.setViewport({ x: 9, y: 9, width: 99, height: 99 });
    state.setStencilTest(false);
    state.setPolygonOffset(0, 0);

    expect(state.getSnapshot()).not.toEqual(pushed);

    gl.reset();
    state.popState();
    expect(state.depth).toBe(0);

    // The restored state must match the pushed snapshot exactly, and the replay must
    // have re-issued the calls the nested block changed.
    expect(state.getSnapshot()).toEqual(pushed);
    expect(gl.calls.length).toBeGreaterThan(0);

    // Popping again is a programming error and must say so.
    expect(() => state.popState()).toThrow(/state stack is empty/);
  });

  it('replays only the members a nested block changed', () => {
    const { gl, context } = createFakeGL();
    const state = new WebGLState(context, { isWebGL2: true });

    applyFullState(state, gl);
    gl.reset();
    // The second pass establishes that every cached value is already known, which is
    // what makes the replay below exact.
    applyFullState(state, gl);
    expect(gl.calls).toHaveLength(0);

    state.pushState();
    state.setDepthTest(false);
    expect(gl.callNames()).toEqual(['disable']);

    gl.reset();
    state.popState();
    expect(gl.callNames()).toEqual(['enable']);
  });

  it('marks every cached value unknown after invalidate()', () => {
    const { gl, context } = createFakeGL();
    const state = new WebGLState(context, { isWebGL2: true });
    state.setDepthTest(true);
    state.setBlend(true);

    state.invalidate();
    gl.reset();
    state.setDepthTest(true);
    state.setBlend(true);

    expect(gl.callNames()).toEqual(['enable', 'enable']);
    expect(state.getSnapshot().depthTest).toBe(true);
  });

  it('exposes UNKNOWN as the wildcard sentinel', () => {
    expect(typeof UNKNOWN).toBe('symbol');
  });
});

/* -------------------------------------------------------------------------- */
/* WebGLUtils                                                                 */
/* -------------------------------------------------------------------------- */

describe('WebGLUtils', () => {
  it('round-trips every supported pixel format', () => {
    const { context } = createFakeGL();

    for (const format of SUPPORTED_PIXEL_FORMATS) {
      const descriptor = toGLFormat(context, format);
      const reverse = fromGLFormat(context, descriptor.internalFormat, descriptor.format, descriptor.type);
      expect(reverse, `round trip for ${format}`).toBe(format);
      expect(descriptor.pixelFormat).toBe(format);
    }
  });

  it('round-trips formats without any context enumerations at all', () => {
    // `glConst` falls back to the real WebGL numeric values, so a bare object is
    // enough — which is what makes this module testable without a GPU.
    const bare = {} as unknown as WebGL2RenderingContext;

    for (const format of SUPPORTED_PIXEL_FORMATS) {
      const descriptor = toGLFormat(bare, format);
      expect(fromGLFormat(bare, descriptor.internalFormat, descriptor.format, descriptor.type)).toBe(format);
    }
  });

  it('distinguishes RGBA8 from BGRA8 through the format component', () => {
    const { context } = createFakeGL();
    const rgba = toGLFormat(context, PixelFormat.RGBA8);
    const bgra = toGLFormat(context, PixelFormat.BGRA8);

    expect(rgba.internalFormat).toBe(bgra.internalFormat);
    expect(rgba.format).not.toBe(bgra.format);
    expect(fromGLFormat(context, bgra.internalFormat, bgra.format, bgra.type)).toBe(PixelFormat.BGRA8);
  });

  it('returns null for a format triple that is not in the table', () => {
    const { context } = createFakeGL();
    expect(fromGLFormat(context, 0x1234, 0x5678, 0x9abc)).toBeNull();
  });

  it('maps the shared enumerations onto their GL constants', () => {
    const { context } = createFakeGL();

    expect(toGLTopology(context, PrimitiveTopology.Triangles)).toBe(4);
    expect(toGLTopology(context, PrimitiveTopology.Points)).toBe(0);
    expect(toGLTopology(context, PrimitiveTopology.LineStrip)).toBe(3);
    expect(toGLCullFace(context, CullMode.None)).toBeNull();
    expect(toGLCullFace(context, CullMode.Front)).toBe(0x0404);
    expect(toGLCullFace(context, CullMode.Back)).toBe(0x0405);
    expect(toGLBufferTarget(context, BufferType.Vertex)).toBe(0x8892);
    expect(toGLBufferTarget(context, BufferType.Index)).toBe(0x8893);
    expect(toGLBufferTarget(context, BufferType.Indirect)).toBeNull();
    expect(toGLBufferUsage(context, BufferUsage.Static)).toBe(0x88e4);
    expect(toGLBufferUsage(context, BufferUsage.Stream)).toBe(0x88e0);
    expect(toGLTextureWrap(context, TextureWrap.Repeat)).toBe(0x2901);
    expect(toGLTextureFilter(context, TextureFilter.LinearMipmapLinear, true).min).toBe(0x2703);
    expect(toGLTextureFilter(context, TextureFilter.LinearMipmapLinear, false).min).toBe(0x2601);
    expect(toGLTextureFilter(context, TextureFilter.Nearest, true).mag).toBe(0x2600);
    expect(toGLClearMask(context, ClearFlags.Color | ClearFlags.Depth)).toBe(0x4000 | 0x0100);
    expect(isCompressedFormat(PixelFormat.RGBA8)).toBe(false);
  });

  it('converts colours and depths into GL-ready values', () => {
    const { context } = createFakeGL();
    expect(convertColor('#ff8000')).toEqual([1, 128 / 255, 0, 1]);
    expect(convertColor({ r: 0.25, g: 0.5, b: 0.75, a: 0.5 })).toEqual([0.25, 0.5, 0.75, 0.5]);
    expect(convertDepth(2)).toBe(1);
    expect(convertDepth(-1)).toBe(0);
    expect(convertDepth(Number.NaN)).toBe(1);
    expect(toGLCompareFunction(context, CompareFunction.LessEqual)).toBe(0x0203);
  });
});

/* -------------------------------------------------------------------------- */
/* GLSL info-log formatting                                                   */
/* -------------------------------------------------------------------------- */

describe('formatWebGLInfoLog', () => {
  /** Twelve-line source whose line 12 is the offending one. */
  const source = [
    '#version 300 es',
    'precision highp float;',
    '// 3',
    '// 4',
    '// 5',
    '// 6',
    '// 7',
    '// 8',
    '// 9',
    '// 10',
    '// 11',
    '  float y = x * 2.0;',
  ].join('\n');

  const infoLog = "ERROR: 0:12: 'x' : undeclared identifier";

  it('annotates the failing line with a caret under the offending token', () => {
    const report = formatWebGLInfoLog(source, infoLog, { label: 'main.frag', stage: 'fragment' });

    // The driver's own record survives verbatim.
    expect(report).toContain(infoLog);
    // The source excerpt is reproduced.
    expect(report).toContain('  float y = x * 2.0;');
    // The header names the shader and counts the error.
    expect(report).toContain('main.frag');
    expect(report).toContain('1 error');

    const rows = report.split('\n');
    const sourceRow = rows.find((row) => row.includes('float y = x * 2.0;'));
    const caretRow = rows.find((row) => row.trimEnd().endsWith('^'));
    expect(sourceRow).toBeDefined();
    expect(caretRow).toBeDefined();

    // The caret row's `|` must line up with the source row's `|`, and the caret must
    // sit under the character the driver complained about.
    const sourceRowText = sourceRow as string;
    const caretRowText = caretRow as string;
    expect(caretRowText.indexOf('|')).toBe(sourceRowText.indexOf('|'));

    const tokenColumn = '  float y = x * 2.0;'.indexOf('x');
    expect(caretRowText.indexOf('^')).toBe(sourceRowText.indexOf('|') + 2 + tokenColumn);
  });

  it('parses the driver logs it understands and preserves the rest', () => {
    const entries = parseWebGLInfoLog(
      ["ERROR: 0:12: 'x' : undeclared identifier", 'WARNING: 0:3: something odd', 'a bare note'].join('\n'),
    );

    expect(entries).toHaveLength(3);
    expect(entries[0].severity).toBe('error');
    expect(entries[0].line).toBe(12);
    expect(entries[1].severity).toBe('warning');
    expect(entries[1].line).toBe(3);
    expect(entries[2].line).toBeNull();
    expect(entries[2].message).toBe('a bare note');
  });

  it('returns an empty report for an empty log', () => {
    expect(formatWebGLInfoLog(source, '')).toBe('');
    expect(formatWebGLInfoLog(source, null)).toBe('');
  });

  it('injects preprocessor definitions after a #version directive', () => {
    const injected = prependDefines('#version 300 es\nvoid main() {}', { USE_MAP: 1, FLAG: null });
    const lines = injected.split('\n');
    expect(lines[0]).toBe('#version 300 es');
    expect(lines).toContain('#define USE_MAP 1');
    expect(lines).toContain('#define FLAG');
  });
});

/* -------------------------------------------------------------------------- */
/* Program cache                                                              */
/* -------------------------------------------------------------------------- */

describe('WebGL program cache', () => {
  it('builds keys that are stable, order-independent and source-sensitive', () => {
    const a = buildProgramKey('void main(){}', 'void main(){}');
    const b = buildProgramKey('void main(){}', 'void main(){}');
    expect(a).toBe(b);

    const withDefines = buildProgramKey('void main(){}', 'void main(){}', { B: 2, A: 1 });
    const reordered = buildProgramKey('void main(){}', 'void main(){}', { A: 1, B: 2 });
    expect(withDefines).toBe(reordered);
    expect(withDefines).not.toBe(a);

    // A one-character difference in the middle must change the key.
    const changed = buildProgramKey('void main(){ }', 'void main(){}');
    expect(changed).not.toBe(a);
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('evicts the least recently used entry when full', () => {
    const evicted: string[] = [];
    const cache = new ProgramLRUCache<number>(2, (_value, key) => evicted.push(key));

    cache.set('a', 1);
    cache.set('b', 2);
    // Touch 'a' so 'b' becomes the least recently used entry.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.size).toBe(2);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(evicted).toEqual(['b']);
    expect(cache.evictions).toBe(1);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* WebGPUUtils                                                                */
/* -------------------------------------------------------------------------- */

describe('WebGPUUtils', () => {
  it('rounds bytesPerRow up to the 256-byte copy alignment', () => {
    expect(bytesPerRowAlignment(100)).toBe(256);
    expect(bytesPerRowAlignment(512)).toBe(512);
    expect(bytesPerRowAlignment(1)).toBe(256);
    expect(bytesPerRowAlignment(257)).toBe(512);
    expect(bytesPerRowAlignment(0)).toBe(0);
    expect(alignTo(100, 256)).toBe(256);
    expect(alignTo(768, 256)).toBe(768);
  });

  it('aligns uniform offsets to 256 bytes', () => {
    expect(alignUniformOffset(0)).toBe(0);
    expect(alignUniformOffset(1)).toBe(256);
    expect(alignUniformOffset(256)).toBe(256);
    expect(alignUniformOffset(257)).toBe(512);
  });

  it('computes a texture copy layout with aligned rows', () => {
    const layout = computeTextureCopyLayout(100, 4, 4);
    expect(layout.bytesPerRow).toBe(512);
    expect(layout.rowsPerImage).toBe(4);
    expect(layout.byteLength).toBe(512 * 4);

    const tight = computeTextureCopyLayout(64, 8, 4);
    expect(tight.bytesPerRow).toBe(256);
    expect(tight.byteLength).toBe(256 * 8);
  });

  it('round-trips the texture formats it supports', () => {
    for (const format of [
      PixelFormat.R8,
      PixelFormat.RG8,
      PixelFormat.RGBA8,
      PixelFormat.SRGB8Alpha8,
      PixelFormat.BGRA8,
      PixelFormat.RGBA16F,
      PixelFormat.RGBA32F,
      PixelFormat.Depth16,
      PixelFormat.Depth24Stencil8,
      PixelFormat.Depth32F,
    ]) {
      expect(fromGPUTextureFormat(toGPUTextureFormat(format)), `round trip for ${format}`).toBe(format);
    }
    expect(fromGPUTextureFormat('rgb10a2unorm')).toBeNull();
  });

  it('maps usage, index format and vertex formats', () => {
    expect(toGPUBufferUsage(BufferType.Vertex)).toBe(0x0020 | 0x0008);
    expect(toGPUBufferUsage(BufferType.Index)).toBe(0x0010 | 0x0008);
    expect(toGPUBufferUsage(BufferType.Uniform)).toBe(0x0040 | 0x0008);
    expect(toGPUIndexFormat(new Uint32Array(3))).toBe('uint32');
    expect(toGPUIndexFormat(new Uint16Array(3))).toBe('uint16');
    expect(toGPUIndexFormat(4)).toBe('uint32');
    expect(toGPUVertexFormat(3, 'float')).toBe('float32x3');
    expect(toGPUVertexFormat(2, 'float', 16)).toBe('float16x2');
    expect(toGPUVertexFormat(4, 'unorm', 8)).toBe('unorm8x4');
    expect(toGPUVertexFormat(3, 'sint')).toBe('sint32x3');
    expect(GPUMapMode.READ).toBe(1);
    expect(GPUColorWrite.ALL).toBe(15);
  });

  it('builds vertex buffer layouts from structural descriptors', () => {
    const layout = buildVertexBufferLayout(
      [
        { name: 'position', shaderLocation: 0, itemSize: 3, arrayStride: 32, offset: 0 },
        { name: 'uv', shaderLocation: 1, itemSize: 2, arrayStride: 32, offset: 12 },
      ],
      'vertex',
    );

    expect(layout.arrayStride).toBe(32);
    expect(layout.stepMode).toBe('vertex');
    expect(layout.attributes).toEqual([
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x2' },
    ]);

    const instanced = buildVertexBufferLayouts([
      { name: 'position', shaderLocation: 0, itemSize: 3, arrayStride: 12, bufferSlot: 0 },
      { name: 'offset', shaderLocation: 1, itemSize: 3, arrayStride: 12, bufferSlot: 1, instanceDivisor: 1 },
    ]);
    expect(instanced).toHaveLength(2);
    expect(instanced[0].stepMode).toBe('vertex');
    expect(instanced[1].stepMode).toBe('instance');

    expect(() => buildVertexBufferLayout([])).toThrow(/at least one attribute/);
    expect(() =>
      buildVertexBufferLayout([{ name: 'bad', shaderLocation: -1, itemSize: 3, arrayStride: 12 }]),
    ).toThrow(/shaderLocation/);
  });
});

/* -------------------------------------------------------------------------- */
/* WebGPUSwapChain                                                            */
/* -------------------------------------------------------------------------- */

describe('WebGPUSwapChain', () => {
  /** A canvas context double that records its configuration. */
  function createContextDouble(): {
    context: GPUCanvasContextLike;
    configurations: Record<string, unknown>[];
    unconfigureCount: () => number;
  } {
    const configurations: Record<string, unknown>[] = [];
    const counters = { unconfigures: 0 };
    const texture = { label: 'swapchain-texture', width: 1, height: 1 } as unknown as GPUTextureLike;

    return {
      configurations,
      unconfigureCount: () => counters.unconfigures,
      context: {
        configure: (configuration: unknown): void => {
          configurations.push(configuration as Record<string, unknown>);
        },
        unconfigure: (): void => {
          counters.unconfigures++;
        },
        getCurrentTexture: () => texture,
      },
    };
  }

  it('resolves the preferred format and falls back to rgba8unorm', () => {
    expect(resolveSwapChainFormat(['bgra8unorm', 'rgba8unorm']).format).toBe('bgra8unorm');
    expect(resolveSwapChainFormat(['bgra8unorm', 'rgba8unorm']).isFallback).toBe(false);

    expect(resolveSwapChainFormat(['rgba8unorm']).format).toBe('rgba8unorm');
    expect(resolveSwapChainFormat(['rgba8unorm']).isFallback).toBe(false);

    const fallback = resolveSwapChainFormat(null);
    expect(fallback.format).toBe('rgba8unorm');
    expect(fallback.isFallback).toBe(true);
    expect(fallback.considered).toEqual(['bgra8unorm', 'rgba8unorm']);

    // An unknown platform preference is honoured, but flagged as a fallback.
    expect(resolveSwapChainFormat(['rgba16float']).format).toBe('rgba16float');
    expect(resolveSwapChainFormat(['rgba16float']).isFallback).toBe(true);
    expect(WebGPUSwapChain.resolveFormat(null).format).toBe('rgba8unorm');
  });

  it('configures the context with the preferred format', () => {
    const device = createFakeGPUDevice().device;
    const { context, configurations } = createContextDouble();
    const swapChain = new WebGPUSwapChain(context, device, { width: 320, height: 200 });

    swapChain.configure(['bgra8unorm', 'rgba8unorm']);

    expect(swapChain.format).toBe('bgra8unorm');
    expect(swapChain.isConfigured).toBe(true);
    expect(configurations).toHaveLength(1);
    expect(configurations[0]['format']).toBe('bgra8unorm');
    expect(configurations[0]['alphaMode']).toBe('opaque');
    expect(configurations[0]['usage']).toBe(0x10);
    expect(configurations[0]['device']).toBe(device);
  });

  it('falls back to rgba8unorm when the platform reports no preference', () => {
    const device = createFakeGPUDevice().device;
    const { context, configurations } = createContextDouble();
    const swapChain = new WebGPUSwapChain(context, device, { width: 16, height: 16 });

    // Node exposes no `navigator.gpu`, so the probe returns nothing and the
    // documented fallback is used.
    swapChain.configure(null);

    expect(swapChain.format).toBe('rgba8unorm');
    expect(configurations[0]['format']).toBe('rgba8unorm');
  });

  it('refuses to hand out a texture before it is configured', () => {
    const device = createFakeGPUDevice().device;
    const { context } = createContextDouble();
    const swapChain = new WebGPUSwapChain(context, device, {});

    expect(() => swapChain.getCurrentTexture()).toThrow(/has not been configured/);
    swapChain.configure(['bgra8unorm']);
    expect(() => swapChain.getCurrentTexture()).not.toThrow();
  });

  it('reconfigures on resize and unconfigures on demand', () => {
    const device = createFakeGPUDevice().device;
    const { context, configurations, unconfigureCount } = createContextDouble();
    const swapChain = new WebGPUSwapChain(context, device, { width: 10, height: 10 });
    swapChain.configure(['bgra8unorm']);

    expect(swapChain.resize(10, 10)).toBe(false);
    expect(configurations).toHaveLength(1);

    expect(swapChain.resize(20, 30)).toBe(true);
    expect(swapChain.width).toBe(20);
    expect(swapChain.height).toBe(30);
    expect(configurations).toHaveLength(2);

    swapChain.unconfigure();
    expect(unconfigureCount()).toBe(1);
    expect(swapChain.isConfigured).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* WebGPUCompute                                                              */
/* -------------------------------------------------------------------------- */

describe('WebGPUCompute dispatch validation', () => {
  it('rejects zero, NaN, negative and fractional workgroup counts', () => {
    expect(() => validateWorkgroupCount(0, 'X')).toThrow(/workgroupsX/);
    expect(() => validateWorkgroupCount(0, 'X')).toThrow(/positive integer/);
    expect(() => validateWorkgroupCount(-8, 'Y')).toThrow(/workgroupsY/);
    expect(() => validateWorkgroupCount(-8, 'Y')).toThrow(/positive integer/);
    expect(() => validateWorkgroupCount(Number.NaN, 'Z')).toThrow(/workgroupsZ/);
    expect(() => validateWorkgroupCount(Number.NaN, 'Z')).toThrow(/NaN/);
    expect(() => validateWorkgroupCount(2.5, 'X')).toThrow(/integer/);
    expect(() => validateWorkgroupCount(Number.POSITIVE_INFINITY, 'X')).toThrow(/finite/);
    expect(() => validateWorkgroupCount('4' as unknown as number, 'X')).toThrow(/must be a number/);
    expect(() => validateWorkgroupCount(undefined as unknown as number, 'X')).toThrow(/undefined/);
    expect(() => validateWorkgroupCount(70000, 'X', 65535)).toThrow(/maxComputeWorkgroupsPerDimension/);
    expect(validateWorkgroupCount(64, 'X')).toBe(64);
  });

  it('validates all three axes', () => {
    expect(validateWorkgroups(4, 8, 2)).toEqual({ x: 4, y: 8, z: 2 });
    expect(validateWorkgroups(4)).toEqual({ x: 4, y: 1, z: 1 });
    expect(() => validateWorkgroups(4, 0, 1)).toThrow(/workgroupsY/);
    expect(() => validateWorkgroups(4, 1, -1)).toThrow(/workgroupsZ/);
  });

  it('rejects bad counts from dispatch() before touching the GPU', () => {
    const fake = createFakeGPUDevice();
    const compute = new WebGPUCompute(fake.device);
    const pipeline = { label: 'compute' };

    expect(() => compute.dispatch({ pipeline, workgroupsX: 0 })).toThrow(/positive integer/);
    expect(() => compute.dispatch({ pipeline, workgroupsX: 8, workgroupsY: Number.NaN })).toThrow(/NaN/);
    expect(() => compute.dispatch({ pipeline, workgroupsX: 8, workgroupsZ: -2 })).toThrow(/positive integer/);
    expect(() => compute.dispatch({ pipeline, workgroupsX: 1.5 })).toThrow(/integer/);

    // Nothing reached the GPU, because validation runs first.
    expect(fake.dispatches).toHaveLength(0);
    expect(compute.dispatches).toBe(0);
  });

  it('dispatches the validated counts and submits the command buffer', () => {
    const fake = createFakeGPUDevice();
    const compute = new WebGPUCompute(fake.device);
    const pipeline = { label: 'compute' };

    const result = compute.dispatch({ pipeline, workgroupsX: 4, workgroupsY: 2 });

    expect(fake.dispatches).toEqual([[4, 2, 1]]);
    expect(result.workgroups).toEqual({ x: 4, y: 2, z: 1 });
    expect(result.totalWorkgroups).toBe(8);
    expect(result.commandBuffer).not.toBeNull();
    expect(compute.dispatches).toBe(1);
    expect(fake.submissions()).toBe(1);
  });

  it('clamps validation to the adapter limit it was given', () => {
    const fake = createFakeGPUDevice();
    const compute = new WebGPUCompute(fake.device);

    expect(compute.maxWorkgroups).toBe(4096);
    expect(() => compute.dispatch({ pipeline: { label: 'p' }, workgroupsX: 5000 })).toThrow(/4096/);
  });
});

/* -------------------------------------------------------------------------- */
/* WebGPUState                                                                */
/* -------------------------------------------------------------------------- */

describe('WebGPUState', () => {
  it('is a no-op when a value already matches', () => {
    const state = new WebGPUState();
    const pipeline = { label: 'pipeline' } as never;

    state.setPipeline(null, pipeline);
    const changes = state.changeCount;
    state.setPipeline(null, pipeline);
    expect(state.changeCount).toBe(changes);

    state.setViewport(null, { x: 0, y: 0, width: 100, height: 100 });
    const viewportChanges = state.changeCount;
    state.setViewport(null, { x: 0, y: 0, width: 100, height: 100 });
    expect(state.changeCount).toBe(viewportChanges);

    state.setViewport(null, { x: 0, y: 0, width: 101, height: 100 });
    expect(state.changeCount).toBe(viewportChanges + 1);
  });

  it('treats dynamic offsets as part of a bind group binding', () => {
    const state = new WebGPUState();
    const group = { label: 'group' } as never;

    state.setBindGroup(null, 0, group, [0]);
    const changes = state.changeCount;
    state.setBindGroup(null, 0, group, [0]);
    expect(state.changeCount).toBe(changes);

    state.setBindGroup(null, 0, group, [256]);
    expect(state.changeCount).toBe(changes + 1);
    expect(state.getSnapshot().dynamicOffsets[0]).toEqual([256]);
  });

  it('restores the snapshot through pushState/popState', () => {
    const state = new WebGPUState();
    const buffer = { label: 'buffer' } as never;
    const group = { label: 'group' } as never;

    state.setViewport(null, { x: 1, y: 2, width: 30, height: 40 });
    state.setScissor(null, { x: 3, y: 4, width: 5, height: 6 });
    state.setVertexBuffer(null, 0, buffer, 0);
    state.setBindGroup(null, 0, group, []);

    const pushed = state.getSnapshot();
    state.pushState();

    state.setViewport(null, { x: 9, y: 9, width: 9, height: 9 });
    state.setScissor(null, null);
    state.setVertexBuffer(null, 0, null, 0);
    state.setBindGroup(null, 0, { label: 'other' } as never, []);

    expect(state.getSnapshot()).not.toEqual(pushed);

    state.popState();
    expect(state.getSnapshot()).toEqual(pushed);
    expect(() => state.popState()).toThrow(/state stack is empty/);
  });

  it('clears the pass-scoped caches when a pass begins', () => {
    const state = new WebGPUState();
    const pipeline = { label: 'pipeline' } as never;

    state.setPipeline(null, pipeline);
    expect(state.getSnapshot().pipeline).toBe(pipeline);

    state.beginPass({} as never, 'render');
    expect(state.isPassActive).toBe(true);
    expect(state.currentPassKind).toBe('render');
    expect(state.getSnapshot().pipeline).toBeNull();

    state.endPass();
    expect(state.isPassActive).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* WebGPU pipeline hashing                                                    */
/* -------------------------------------------------------------------------- */

describe('WebGPU pipeline cache keys', () => {
  it('hashes descriptors order-independently but content-sensitively', () => {
    const a = hashPipelineDescriptor({ topology: 'triangle-list', cullMode: 'back' });
    const b = hashPipelineDescriptor({ cullMode: 'back', topology: 'triangle-list' });
    expect(a).toBe(b);

    const c = hashPipelineDescriptor({ topology: 'triangle-list', cullMode: 'front' });
    expect(c).not.toBe(a);
  });

  it('serialises typed arrays, functions and nested objects deterministically', () => {
    expect(stableSerialize({ a: 1, b: [2, 3] })).toBe(stableSerialize({ b: [2, 3], a: 1 }));
    expect(stableSerialize(new Float32Array([1, 2]))).toBe(stableSerialize([1, 2]));
    expect(stableSerialize(() => undefined)).toContain('fn:');
  });

  it('builds depth-stencil state from the renderer-agnostic RenderState', () => {
    const state = new RenderState();
    state.depth.test = true;
    state.depth.write = true;
    state.depth.compare = CompareFunction.Less;

    const built = buildDepthStencilState(state, 'depth32float');
    expect(built).toBeDefined();
    expect(built?.['format']).toBe('depth32float');
    expect(built?.['depthCompare']).toBe('less');
    expect(built?.['depthWriteEnabled']).toBe(true);
    expect(built?.['stencilFront']).toBeUndefined();

    const withStencil = buildDepthStencilState(state, 'depth24plus-stencil8');
    expect(withStencil?.['stencilFront']).toBeDefined();

    expect(buildDepthStencilState(state, null)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* WGSL diagnostics                                                           */
/* -------------------------------------------------------------------------- */

describe('WGSL diagnostics', () => {
  const source = ['@vertex', 'fn vs_main() -> @builtin(position) vec4<f32> {', '  let y = x * 2.0;', '}'].join('\n');

  it('parses a line:column pair out of a message', () => {
    expect(parseWGSLDiagnostic("main.wgsl:3:11 error: unresolved value 'x'")).toEqual({ line: 3, column: 11 });
    expect(parseWGSLDiagnostic('at line 3:11')).toEqual({ line: 3, column: 11 });
    expect(parseWGSLDiagnostic('line 3, column 11')).toEqual({ line: 3, column: 11 });
    expect(parseWGSLDiagnostic('no position here')).toBeNull();
  });

  it('annotates the source line with a caret', () => {
    const report = formatWGSLDiagnostics(
      source,
      [
        {
          severity: 'error',
          message: "unresolved value 'x'",
          line: 3,
          column: 11,
          offset: null,
          length: null,
        },
      ],
      { label: 'main.wgsl', stage: 'vertex' },
    );

    expect(report).toContain("unresolved value 'x'");
    expect(report).toContain('let y = x * 2.0;');
    expect(report).toContain('1 error');

    const rows = report.split('\n');
    const sourceRow = rows.find((row) => row.includes('let y = x * 2.0;')) as string;
    const caretRow = rows.find((row) => row.trimEnd().endsWith('^')) as string;
    expect(caretRow.indexOf('|')).toBe(sourceRow.indexOf('|'));
    expect(caretRow.indexOf('^')).toBe(sourceRow.indexOf('|') + 2 + '  let y = x * 2.0;'.indexOf('x'));
  });

  it('returns an empty report when there is nothing to say', () => {
    expect(formatWGSLDiagnostics(source, [])).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* WebGPU capabilities                                                        */
/* -------------------------------------------------------------------------- */

describe('WebGPUCapabilities', () => {
  it('clamps sample counts and texture sizes to the adapter limits', () => {
    const capabilities = new WebGPUCapabilities(null, {
      maxTextureDimension2D: 4096,
      maxSamples: 4,
    });

    expect(capabilities.clampSamples(8)).toBe(4);
    expect(capabilities.clampSamples(2)).toBe(2);
    expect(capabilities.clampSamples(0)).toBe(1);
    expect(capabilities.clampTextureSize(8192)).toBe(4096);
    expect(capabilities.clampTextureSize(64)).toBe(64);
    expect(capabilities.toList()).toContain('webgpu');
    expect(capabilities.minUniformBufferOffsetAlignment).toBe(256);
  });
});

/* -------------------------------------------------------------------------- */
/* Headless renderer contract                                                 */
/* -------------------------------------------------------------------------- */

describe('headless renderer contract', () => {
  it('constructs, sizes and disposes a WebGL renderer without a GPU', () => {
    const renderer = new WebGLRenderer({ width: 64, height: 48 });

    // Vitest's node environment has no DOM and no OffscreenCanvas, so the renderer
    // binds a null surface — the documented headless behaviour.
    expect(renderer.isHeadless).toBe(true);
    expect(renderer.isDisposed()).toBe(false);
    expect(renderer.width).toBe(64);
    expect(renderer.height).toBe(48);
    expect(renderer.backend).toBe('webgl');

    // Sizing and pixel-ratio changes are safe.
    expect(() => renderer.setSize(128, 96)).not.toThrow();
    expect(renderer.width).toBe(128);
    expect(() => renderer.setPixelRatio(2)).not.toThrow();
    expect(renderer.getPixelRatio()).toBe(2);

    // Only `render` throws, and it says exactly why.
    expect(() => renderer.render(null, null)).toThrow(/no drawing surface/);
    expect(() => renderer.render(null, null)).toThrow(/options\.canvas/);

    // The stats and info surfaces exist and are zeroed.
    expect(renderer.stats.drawCalls).toBe(0);
    expect(renderer.renderInfo.render.calls).toBe(0);
    expect(renderer.renderInfo.memory.programs).toBe(0);
    expect(renderer.info.capabilities).toEqual([]);
    expect(renderer.state).toBeNull();
    expect(renderer.programCache).toBeNull();

    expect(() => renderer.dispose()).not.toThrow();
    expect(renderer.isDisposed()).toBe(true);
    // A disposed renderer refuses further work with an explanatory error.
    expect(() => renderer.render(null, null)).toThrow(/already been disposed/);
  });

  it('constructs, sizes and disposes a WebGPU renderer without a GPU', async () => {
    const renderer = new WebGPURenderer({ width: 64, height: 48 });

    expect(renderer.isHeadless).toBe(true);
    expect(renderer.isDisposed()).toBe(false);
    expect(renderer.backend).toBe('webgpu');
    expect(renderer.device).toBeNull();

    // The acquisition promise settles with `false` rather than hanging.
    await expect(renderer.whenReady()).resolves.toBe(false);
    expect(renderer.readyStateName).toBe('failed');

    expect(() => renderer.setSize(200, 100)).not.toThrow();
    expect(renderer.width).toBe(200);

    expect(() => renderer.render(null, null)).toThrow(/no drawing surface/);
    expect(() => renderer.render(null, null)).toThrow(/options\.canvas/);

    expect(renderer.renderInfo.memory.textures).toBe(0);
    expect(renderer.renderInfo.memory.programs).toBe(0);
    expect(() => renderer.dispose()).not.toThrow();
    expect(renderer.isDisposed()).toBe(true);
  });

  it('formats renderers descriptively', () => {
    const webgl = new WebGLRenderer({ width: 10, height: 10 });
    expect(webgl.toString()).toContain('WebGLRenderer');
    webgl.dispose();

    const webgpu = new WebGPURenderer({ width: 10, height: 10 });
    expect(webgpu.toString()).toContain('WebGPURenderer');
    webgpu.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Barrel exports                                                             */
/* -------------------------------------------------------------------------- */

describe('backend barrels', () => {
  it('exports the documented WebGL names', () => {
    const expected = [
      'WebGLRenderer',
      'WebGLContext',
      'WebGLState',
      'WebGLProgram',
      'WebGLShader',
      'WebGLUniforms',
      'WebGLBuffer',
      'WebGLAttributes',
      'WebGLVertexArray',
      'WebGLVertexArrayCache',
      'WebGLTexture',
      'WebGLFramebuffer',
      'WebGLRenderTarget',
      'WebGLCapabilities',
      'WebGLExtensions',
      'WebGLProgramCache',
      'WEBGL_CONTEXT_PRESETS',
      'WEBGL_EXTENSION_NAMES',
      'SUPPORTED_PIXEL_FORMATS',
      'DEFAULT_WEBGL_LIMITS',
      'DEFAULT_VERTEX_SHADER',
      'DEFAULT_FRAGMENT_SHADER',
      'toGLFormat',
      'fromGLFormat',
      'formatWebGLInfoLog',
      'buildProgramKey',
      'getMaxTextureSizeFor',
      'convertColor',
      'convertDepth',
      'isCompressedFormat',
      'ProgramLRUCache',
    ];

    for (const name of expected) {
      expect(webglBarrel, `webgl barrel exports ${name}`).toHaveProperty(name);
    }
    expect(typeof webglBarrel.WebGLRenderer).toBe('function');
    expect(webglBarrel.SUPPORTED_PIXEL_FORMATS.length).toBeGreaterThan(0);
  });

  it('exports the documented WebGPU names', () => {
    const expected = [
      'WebGPURenderer',
      'WebGPUDevice',
      'WebGPUCapabilities',
      'WebGPUSwapChain',
      'WebGPUPipeline',
      'WebGPUPipelineCache',
      'WebGPUShader',
      'WebGPUBuffer',
      'WebGPUTexture',
      'WebGPURenderTarget',
      'WebGPUCompute',
      'WebGPUState',
      'DeferredDestroyQueue',
      'SamplerCache',
      'requestAdapterSafe',
      'requestDeviceSafe',
      'acquireDevice',
      'getCapabilities',
      'isWebGPUAvailable',
      'getGPUProvider',
      'resolveSwapChainFormat',
      'bytesPerRowAlignment',
      'alignTo',
      'alignUniformOffset',
      'computeTextureCopyLayout',
      'computeTextureCopyExtent',
      'toGPUTextureFormat',
      'fromGPUTextureFormat',
      'toGPUBufferUsage',
      'toGPUTextureUsage',
      'buildVertexBufferLayout',
      'buildVertexBufferLayouts',
      'hashPipelineDescriptor',
      'stableSerialize',
      'buildDepthStencilState',
      'validateWorkgroupCount',
      'validateWorkgroups',
      'formatWGSLDiagnostics',
      'parseWGSLDiagnostic',
      'GPUMapMode',
      'GPUColorWrite',
      'GPUBufferUsageFlags',
      'GPUTextureUsageFlags',
      'UNIFORM_BUFFER_ALIGNMENT',
      'TEXTURE_ROW_ALIGNMENT',
      'FALLBACK_SWAP_CHAIN_FORMAT',
      'PREFERRED_SWAP_CHAIN_FORMAT',
      'DEFAULT_WGSL_SHADER',
    ];

    for (const name of expected) {
      expect(webgpuBarrel, `webgpu barrel exports ${name}`).toHaveProperty(name);
    }
    expect(typeof webgpuBarrel.WebGPURenderer).toBe('function');
    expect(webgpuBarrel.FALLBACK_SWAP_CHAIN_FORMAT).toBe('rgba8unorm');
    expect(webgpuBarrel.UNIFORM_BUFFER_ALIGNMENT).toBe(256);
  });

  it('re-exports both backends from the renderer barrel', () => {
    expect(rendererBarrel.WebGLRenderer).toBe(webglBarrel.WebGLRenderer);
    expect(rendererBarrel.WebGPURenderer).toBe(webgpuBarrel.WebGPURenderer);
    expect(rendererBarrel.WebGLState).toBe(webglBarrel.WebGLState);
    expect(rendererBarrel.WebGPUCompute).toBe(webgpuBarrel.WebGPUCompute);
  });

  it('contributes no ambiguous names to the renderer barrel', () => {
    // Every runtime export of either GPU backend must be unique to it, or `export *`
    // in `renderer/index.ts` would silently drop the name.
    const shared = Object.keys(webglBarrel).filter((name) => name in webgpuBarrel);
    expect(shared).toEqual([]);

    // Each backend's own module namespace must be re-exportable in full.
    expect(Object.keys(webglBarrel).length).toBeGreaterThan(30);
    expect(Object.keys(webgpuBarrel).length).toBeGreaterThan(30);
  });
});
