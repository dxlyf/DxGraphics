/**
 * `Material` — the base description of how a surface is shaded and drawn.
 *
 * A material is *data*: it states what the surface looks like (colour, maps,
 * scalar parameters) and how the fixed-function pipeline must be configured
 * (depth, blending, culling). A backend turns it into a program plus a
 * {@link RenderState}; nothing here touches a GPU.
 *
 * ```ts
 * const material = new MeshStandardMaterial({ color: '#ff8800', roughness: 0.4 });
 * material.setValues({ metalness: 0.1, side: Side.DoubleSide });
 * material.version;   // bumped twice
 * ```
 *
 * ## Reactivity without `Proxy`
 *
 * Two conventions are available, and this class deliberately uses the second:
 *
 * 1. **accessor per field** — a `set color(value)` that bumps `version`. Always
 *    correct, but every field becomes an accessor pair, which costs a call per
 *    read on the renderer's hot path and bloats the class.
 * 2. **plain fields + an explicit revision** — fields are ordinary data
 *    properties, and `version` is a monotonic counter bumped by
 *    {@link Material.markNeedsUpdate} (or by `needsUpdate = true`, or by
 *    {@link Material.setValues}). The renderer keeps the last version it saw and
 *    re-derives its state only when it moved.
 *
 * The trade-off is explicit: `material.opacity = 0.5` does **not** bump `version`
 * on its own, so mutating a field in place must be followed by
 * `material.markNeedsUpdate()` — or the field should be set through `setValues`,
 * which bumps once for the whole bag. In exchange, property access stays a plain
 * load (no call, no monomorphic de-optimisation) and the class carries no
 * per-field boilerplate. Texture slots are the exception: they *are* accessors,
 * because assigning one must also transfer ownership and release the previous
 * texture, which cannot be done by a data property.
 *
 * @packageDocumentation
 */

import { Disposable } from '../core/Disposable';
import { EventEmitter, type EventArgs, type EventName, type EventListener } from '../core/EventEmitter';
import { Color, type ColorRepresentation } from '../math/Color';
import { Mat3 } from '../math/Mat3';
import { Mat4 } from '../math/Mat4';
import { Plane } from '../math/Plane';
import { Quat } from '../math/Quat';
import { Vec2 } from '../math/Vec2';
import { Vec3 } from '../math/Vec3';
import { Vec4 } from '../math/Vec4';
import { Uniforms } from '../shaders/Uniforms';
import type { Shader } from '../shaders/Shader';
import type { Texture } from '../textures/Texture';
import type { QuaternionLike, Vec2Source, Vec3Source, Vector4Like } from '../types';
import { createId } from '../utils/Id';
import { log } from '../utils/Logger';
import type { MaterialJSON, MaterialParameters } from './types';
import { BlendEquation, Blending, DepthFunc, Side, StencilFunc, StencilOp } from './types';
import { BlendMode } from './BlendMode';

/** Events emitted by {@link Material}. */
export interface MaterialEvents<TMaterial = Material> {
  /** A property changed; `version` carries the new revision. */
  versionchange: [material: TMaterial, version: number];
  /** The material has been released. */
  dispose: [];
  /** The material finished disposing. */
  disposed: [];
}

/** Keys that `setValues` must never write. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'label',
  'version',
  'events',
  'materialEvents',
  'isDisposed',
  'isDisposing',
  'isUsable',
  'disposableCount',
]);

/**
 * The base material.
 *
 * @typeParam TLabel Literal label used in disposal errors; defaults to `string`
 *   so the bare `Material` type accepts every subclass.
 */
export class Material<TLabel extends string = string> extends Disposable<TLabel> {
  /** Human-readable label used in diagnostics. */
  public override readonly label: TLabel = 'Material' as TLabel;

  /** Stable identifier, prefixed `mat-`. */
  public override readonly id: string = createId('mat');

  /** Optional user name, surfaced in diagnostics and serialisation. */
  public name: string = '';

  /** Registered type name; the factory resolves it back to a constructor. */
  public readonly type: string = 'Material';

  /* ------------------------------------------------------------- raster */

  /** `false` skips every draw that uses this material. */
  public visible: boolean = true;

  /** `true` when the material blends against what is already in the target. */
  public transparent: boolean = false;

  /** Opacity multiplier applied to the shaded colour, in `0..1`. */
  public opacity: number = 1;

  /** Which faces are drawn. */
  public side: Side = Side.FrontSide;

  /** `true` when the drawn primitives are rendered as lines. */
  public wireframe: boolean = false;

  /* -------------------------------------------------------------- depth */

  /** `true` when fragments are depth-tested. */
  public depthTest: boolean = true;

  /** `true` when passing fragments write depth. */
  public depthWrite: boolean = true;

  /** Comparison function used by the depth test. */
  public depthFunc: DepthFunc = DepthFunc.LessEqual;

  /* ------------------------------------------------------------ stencil */

  /** `true` when the stencil test runs. */
  public stencilWrite: boolean = false;

  /** Comparison function applied by the stencil test. */
  public stencilFunc: StencilFunc = StencilFunc.Always;

  /** Reference value compared against the stencil buffer. */
  public stencilRef: number = 0;

  /** Bit mask applied to both values before comparing. */
  public stencilMask: number = 0xff;

  /** Action taken when the stencil test fails. */
  public stencilFail: StencilOp = StencilOp.Keep;

  /** Action taken when the stencil passes but depth fails. */
  public stencilZFail: StencilOp = StencilOp.Keep;

  /** Action taken when both the stencil and depth tests pass. */
  public stencilZPass: StencilOp = StencilOp.Keep;

  /* ----------------------------------------------------------- blending */

  /** Named blend preset. */
  public blending: BlendMode = BlendMode.NormalBlending;

  /** Source blend factor, used when {@link blending} is `CustomBlending`. */
  public blendSrc: Blending = Blending.SrcAlpha;

  /** Destination blend factor, used when {@link blending} is `CustomBlending`. */
  public blendDst: Blending = Blending.OneMinusSrcAlpha;

  /** Blend equation, used when {@link blending} is `CustomBlending`. */
  public blendEquation: BlendEquation = BlendEquation.Add;

  /** `true` when the source colour is already premultiplied by its alpha. */
  public premultipliedAlpha: boolean = false;

  /* ------------------------------------------------------ alpha / colour */

  /** Fragments below this alpha are discarded; `0` disables the test. */
  public alphaTest: number = 0;

  /** `true` when multisample coverage replaces the alpha test. */
  public alphaToCoverage: boolean = false;

  /** `false` disables every colour write (depth-only passes). */
  public colorWrite: boolean = true;

  /* ------------------------------------------------------ polygon offset */

  /** `true` when polygon offset is applied to the depth of filled polygons. */
  public polygonOffset: boolean = false;

  /** Depth offset scale factor. */
  public polygonOffsetFactor: number = 0;

  /** Depth offset constant, in units of the smallest resolvable depth step. */
  public polygonOffsetUnits: number = 0;

  /* ------------------------------------------------------------ shading */

  /** `true` when scene fog is applied. */
  public fog: boolean = true;

  /** `true` when the renderer's tone mapping is applied to the output. */
  public toneMapped: boolean = true;

  /** World-space clipping planes, or `null` for no clipping. */
  public clippingPlanes: Plane[] | null = null;

  /** `true` when this material casts clipped shadows. */
  public clipShadows: boolean = false;

  /** Side used while rendering shadow maps; `null` keeps {@link side}. */
  public shadowSide: Side | null = null;

  /** Free-form application data; never interpreted by the library. */
  public userData: Record<string, unknown> = {};

  /* ---------------------------------------------------------- shader data */

  /** Preprocessor defines injected ahead of the program's source. */
  public defines: Record<string, string | number | boolean> = {};

  /** Uniform values, shared by every shader-derived material. */
  public readonly uniforms: Uniforms = new Uniforms();

  /**
   * `true` when `dispose()` releases the textures assigned to this material's
   * slots.
   *
   * Enabled by default (a material owns what it is given); set it to `false` when
   * several materials share one atlas and the caller releases it itself.
   */
  public ownsTextures: boolean = true;

  /**
   * Hook invoked with the assembled shader just before it is compiled.
   *
   * Use it to inject source, set defines or override uniforms; the callback
   * receives the `Shader` the compiler is about to hand to the backend.
   */
  public onBeforeCompile: (shader: Shader, context?: unknown) => void = () => undefined;

  /**
   * Extra cache-key fragment.
   *
   * Two materials of the same type with the same defines share a program; return
   * a distinguishing string here when the pair also needs different source.
   */
  public customProgramCacheKey: () => string = () => this.type;

  /** Typed event bus; see `Texture` for why it is not `events`. */
  public readonly materialEvents: EventEmitter<MaterialEvents<Material<TLabel>>> =
    new EventEmitter<MaterialEvents<Material<TLabel>>>();

  /** Texture slots owned by this material, keyed by property name. */
  private readonly textureMap = new Map<string, Texture | null>();

  /** Monotonic revision; bumped by {@link markNeedsUpdate}. */
  private revision: number = 0;

  /**
   * @param parameters Optional parameter bag; equivalent to `setValues`.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    if (parameters) this.setValues(parameters);
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Registers a listener on the material bus.
   *
   * @param event Event name (`'versionchange'`, `'dispose'`, `'disposed'`).
   * @param listener Listener invoked with the event's argument tuple.
   * @returns An unsubscribe function.
   */
  public onMaterial<K extends EventName<MaterialEvents<Material<TLabel>>>>(
    event: K,
    listener: EventListener<EventArgs<MaterialEvents<Material<TLabel>>[K]>>,
  ): () => void {
    return this.materialEvents.on(event, listener);
  }

  /* --------------------------------------------------------------- version */

  /** Current revision; bumped by every change. */
  public get version(): number {
    return this.revision;
  }

  /**
   * One-shot "the material changed" signal.
   *
   * Always reads `false`; assigning `true` calls {@link markNeedsUpdate}, matching
   * the flag convention the texture layer uses.
   */
  public get needsUpdate(): boolean {
    return false;
  }

  public set needsUpdate(value: boolean) {
    if (value) this.markNeedsUpdate();
  }

  /**
   * Bumps {@link version} and emits `versionchange`.
   *
   * Call this after mutating a field in place; `setValues` calls it for you.
   *
   * @returns This material, for chaining.
   */
  public markNeedsUpdate(): this {
    this.onChange();
    return this;
  }

  /**
   * The single place a revision is produced.
   *
   * Subclasses that add reactive state (for example a texture slot) call this
   * instead of touching `version` directly.
   */
  protected onChange(): void {
    this.revision++;
    this.materialEvents.emit('versionchange', this, this.revision);
  }

  /* -------------------------------------------------------- texture slots */

  /**
   * Reads a texture slot.
   *
   * @param slot Slot name (the property the subclasses expose).
   */
  protected texture(slot: string): Texture | null {
    return this.textureMap.get(slot) ?? null;
  }

  /**
   * Writes a texture slot, transferring ownership.
   *
   * The previous texture is released (when {@link ownsTextures} is set) and the
   * new one becomes a disposable child of this material, so `dispose()` releases
   * it exactly once. Always bumps {@link version}.
   *
   * @param slot Slot name.
   * @param value New texture, or `null` to clear the slot.
   */
  protected setTexture(slot: string, value: Texture | null): void {
    const previous = this.textureMap.get(slot) ?? null;
    if (previous === value) return;

    if (previous !== null && this.ownsTextures) this.removeDisposable(previous);
    this.textureMap.set(slot, value);
    if (value !== null && this.ownsTextures) this.addDisposable(value);

    this.onChange();
  }

  /** Every texture slot that currently has a value. */
  public getTextures(): Texture[] {
    const textures: Texture[] = [];
    for (const texture of this.textureMap.values()) {
      if (texture !== null) textures.push(texture);
    }
    return textures;
  }

  /** `true` when at least one texture slot is bound. */
  public hasTextures(): boolean {
    for (const texture of this.textureMap.values()) {
      if (texture !== null) return true;
    }
    return false;
  }

  /**
   * Registers a texture as owned by this material.
   *
   * @param texture Texture to own.
   * @returns This material, for chaining.
   */
  public addTexture(texture: Texture): this {
    this.addDisposable(texture);
    return this;
  }

  /* ------------------------------------------------------------ setValues */

  /**
   * Applies a partial parameter bag.
   *
   * - unknown keys are logged at debug level and skipped, never thrown on;
   * - `Color`, vector, quaternion and matrix fields are *coerced* rather than
   *   replaced, so `{ color: '#ff0000' }` and `{ normalScale: [1, 1] }` both work;
   * - `uniforms` accepts a plain record and is merged into the container;
   * - `version` is bumped once for the whole bag, not once per key.
   *
   * @param values Parameters to apply.
   * @returns This material, for chaining.
   */
  public setValues(values: MaterialParameters): this {
    let changed = false;
    for (const key of Object.keys(values)) {
      const value = values[key];
      if (value === undefined) continue;
      if (!this.isSettableKey(key)) {
        log.debug(`${this.type}.setValues(): ignoring unknown parameter "${key}"`);
        continue;
      }
      this.assignValue(key, value);
      changed = true;
    }
    if (changed) this.onChange();
    return this;
  }

  /**
   * `true` when `setValues` may write `key`.
   *
   * A key is settable when it resolves to a writable data property (or an
   * accessor with a setter) somewhere on the instance's prototype chain and is
   * not reserved, not a method and not a read-only accessor.
   */
  public isSettableKey(key: string): boolean {
    if (RESERVED_KEYS.has(key)) return false;

    let target: object | null = this;
    while (target !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor !== undefined) {
        if (typeof descriptor.set === 'function') return true;
        return descriptor.writable === true && typeof descriptor.value !== 'function';
      }
      target = Object.getPrototypeOf(target);
    }
    return false;
  }

  /**
   * Writes one parameter, coercing structured values.
   *
   * @param key Property name.
   * @param value New value.
   */
  private assignValue(key: string, value: unknown): void {
    const current = (this as unknown as Record<string, unknown>)[key];

    if (current instanceof Color) {
      current.set(value as ColorRepresentation);
      return;
    }
    if (current instanceof Vec2) {
      current.copy(value as Vec2Source);
      return;
    }
    if (current instanceof Vec3) {
      current.copy(value as Vec3Source);
      return;
    }
    if (current instanceof Vec4) {
      current.copy(value as Vector4Like | readonly number[]);
      return;
    }
    if (current instanceof Quat) {
      current.copy(value as QuaternionLike | ArrayLike<number>);
      return;
    }
    if (current instanceof Mat3) {
      if (ArrayBuffer.isView(value) || Array.isArray(value)) current.fromArray(value as ArrayLike<number>);
      else if (value instanceof Mat3) current.copy(value);
      return;
    }
    if (current instanceof Mat4) {
      if (ArrayBuffer.isView(value) || Array.isArray(value)) current.fromArray(value as ArrayLike<number>);
      else if (value instanceof Mat4) current.copy(value);
      return;
    }
    if (current instanceof Uniforms) {
      if (value instanceof Uniforms) current.copy(value);
      else if (typeof value === 'object' && value !== null) {
        for (const [name, entry] of Object.entries(value as Record<string, never>)) {
          current.set(name, entry);
        }
      }
      return;
    }

    (this as unknown as Record<string, unknown>)[key] = value;
  }

  /* --------------------------------------------------------------- copying */

  /**
   * Copies every base parameter from another material.
   *
   * Subclasses override this, copy their own fields and call `super.copy(source)`.
   * The `id` and `type` are never copied: a clone is a distinct material of the
   * same class.
   *
   * @param source Material to read.
   * @returns This material, for chaining.
   */
  public copy(source: Material): this {
    this.name = source.name;

    this.visible = source.visible;
    this.transparent = source.transparent;
    this.opacity = source.opacity;
    this.side = source.side;
    this.wireframe = source.wireframe;

    this.depthTest = source.depthTest;
    this.depthWrite = source.depthWrite;
    this.depthFunc = source.depthFunc;

    this.stencilWrite = source.stencilWrite;
    this.stencilFunc = source.stencilFunc;
    this.stencilRef = source.stencilRef;
    this.stencilMask = source.stencilMask;
    this.stencilFail = source.stencilFail;
    this.stencilZFail = source.stencilZFail;
    this.stencilZPass = source.stencilZPass;

    this.blending = source.blending;
    this.blendSrc = source.blendSrc;
    this.blendDst = source.blendDst;
    this.blendEquation = source.blendEquation;
    this.premultipliedAlpha = source.premultipliedAlpha;

    this.alphaTest = source.alphaTest;
    this.alphaToCoverage = source.alphaToCoverage;
    this.colorWrite = source.colorWrite;

    this.polygonOffset = source.polygonOffset;
    this.polygonOffsetFactor = source.polygonOffsetFactor;
    this.polygonOffsetUnits = source.polygonOffsetUnits;

    this.fog = source.fog;
    this.toneMapped = source.toneMapped;
    this.clipShadows = source.clipShadows;
    this.shadowSide = source.shadowSide;
    this.clippingPlanes = source.clippingPlanes === null ? null : source.clippingPlanes.slice();
    this.userData = { ...source.userData };

    this.defines = { ...source.defines };
    this.uniforms.copy(source.uniforms);

    this.onBeforeCompile = source.onBeforeCompile;
    this.customProgramCacheKey = source.customProgramCacheKey;

    // Texture slots: `source.textureMap` is reachable because `private` is
    // class-scoped, which keeps the clone exhaustive without a hand-written list.
    for (const [slot, texture] of source.textureMap) this.setTexture(slot, texture);

    this.onChange();
    return this;
  }

  /**
   * Returns a copy of this material.
   *
   * The copy is independent: mutating it (or its colour/vector fields) never
   * touches the original. Textures are shared by reference, since they are
   * immutable descriptions that a user usually wants to reuse.
   */
  public clone(): this {
    const ctor = this.constructor as new () => this;
    return new ctor().copy(this);
  }

  /* --------------------------------------------------------- serialisation */

  /**
   * Serialises the material.
   *
   * Only own, non-reserved, non-function properties are written; structured values
   * (`Color`, vectors, matrices, `Uniforms`) are flattened and textures are
   * reduced to `{ ref: id }` because image data is not JSON-representable.
   *
   * @returns A plain, `JSON.stringify`-safe record.
   */
  public toJSON(): MaterialJSON {
    const parameters: Record<string, unknown> = {};
    for (const key of Object.keys(this)) {
      if (RESERVED_KEYS.has(key)) continue;
      const value = (this as unknown as Record<string, unknown>)[key];
      if (typeof value === 'function' || value === undefined) continue;
      parameters[key] = serialiseValue(value);
    }
    return { type: this.type, name: this.name, id: this.id, parameters };
  }

  /* -------------------------------------------------------------- disposal */

  /** @inheritdoc */
  protected override onDispose(): void {
    this.materialEvents.emit('dispose');
    // The textures themselves are disposed by `Disposable` (they were registered
    // as children); the slots are cleared so nothing points at a released object.
    this.textureMap.clear();
    this.clippingPlanes = null;
    this.userData = {};
    this.materialEvents.dispose();
  }
}

/** Flattens a value into something `JSON.stringify` can represent. */
function serialiseValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Color) return { r: value.r, g: value.g, b: value.b, a: value.a };
  if (value instanceof Vec2) return [value.x, value.y];
  if (value instanceof Vec4) return [value.x, value.y, value.z, value.w];
  if (value instanceof Vec3) return [value.x, value.y, value.z];
  if (value instanceof Quat) return [value.x, value.y, value.z, value.w];
  if (value instanceof Mat3) return Array.from(value.elements);
  if (value instanceof Mat4) return Array.from(value.elements);
  if (value instanceof Uniforms) return value.toJSON();
  if (Array.isArray(value)) return value.map((item) => serialiseValue(item));
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (value instanceof Plane) return { normal: [value.normal.x, value.normal.y, value.normal.z], constant: value.constant };
  if (typeof (value as { isTexture?: unknown }).isTexture === 'boolean') {
    return { ref: (value as { id?: string }).id ?? 'texture' };
  }
  return value;
}
