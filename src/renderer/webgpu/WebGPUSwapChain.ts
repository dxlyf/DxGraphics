/**
 * Canvas swap-chain configuration.
 *
 * A WebGPU canvas context has to be configured before it hands out textures, and the
 * configuration carries the one value that varies per platform: the preferred
 * texture format. Windows and most Android devices prefer `bgra8unorm`, while
 * macOS/iOS and some Linux drivers prefer `rgba8unorm`; configuring a format the
 * compositor cannot present yields a black canvas with no error.
 *
 * The probe order that avoids that is: ask the adapter for
 * `getPreferredCanvasFormat()` when it exists, then fall back to a fixed
 * `bgra8unorm` probe and finally `rgba8unorm`.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import {
  GPUTextureUsageFlags,
  getGPUProvider,
  type GPUCanvasContextLike,
  type GPUDeviceLike,
  type GPUTextureLike,
  type GPUTextureViewLike,
} from './WebGPUUtils';

/** Logger for swap-chain diagnostics. */
const log = createLogger('renderer:webgpu:swapchain');

/** Format every current implementation can present. */
export const FALLBACK_SWAP_CHAIN_FORMAT = 'rgba8unorm';

/** Format desktop compositors prefer when it is available. */
export const PREFERRED_SWAP_CHAIN_FORMAT = 'bgra8unorm';

/** Alpha behaviour of the canvas backing store. */
export type SwapChainAlphaMode = 'opaque' | 'premultiplied';

/** Options accepted by {@link WebGPUSwapChain}. */
export interface WebGPUSwapChainOptions {
  /** Explicit format override; the probe is skipped when set. */
  format?: string;
  /** Alpha mode. Defaults to `'opaque'`. */
  alphaMode?: SwapChainAlphaMode;
  /** Usage bits for the swap-chain textures. Defaults to `RENDER_ATTACHMENT`. */
  usage?: number;
  /** Initial width in device pixels. */
  width?: number;
  /** Initial height in device pixels. */
  height?: number;
  /** Label applied to the configuration. */
  label?: string;
}

/** A resolved format choice. */
export interface SwapChainFormatChoice {
  /** Format to configure. */
  readonly format: string;
  /** `true` when the preferred format was unavailable. */
  readonly isFallback: boolean;
  /** Formats that were considered, in probe order. */
  readonly considered: readonly string[];
}

/**
 * Chooses the swap-chain format.
 *
 * Order: the first preferred format the platform actually offers, else
 * {@link PREFERRED_SWAP_CHAIN_FORMAT} when the caller listed nothing, else
 * {@link FALLBACK_SWAP_CHAIN_FORMAT}. `bgra8unorm` is checked before `rgba8unorm` so
 * the common desktop case takes the zero-conversion path.
 *
 * @param preferredFormats Formats the platform reported, or `null` when unknown.
 * @returns The chosen format plus whether it was a fallback.
 */
export function resolveSwapChainFormat(
  preferredFormats: readonly string[] | null | undefined,
): SwapChainFormatChoice {
  const considered: string[] = [];
  const available = preferredFormats == null ? [] : preferredFormats.filter((name) => name.length > 0);

  if (available.length > 0) {
    considered.push(...available);
    // An explicit preference wins, but only when it is a presentable format.
    if (available.includes(PREFERRED_SWAP_CHAIN_FORMAT)) {
      return { format: PREFERRED_SWAP_CHAIN_FORMAT, isFallback: false, considered };
    }
    if (available.includes(FALLBACK_SWAP_CHAIN_FORMAT)) {
      return { format: FALLBACK_SWAP_CHAIN_FORMAT, isFallback: false, considered };
    }
    return { format: available[0], isFallback: true, considered };
  }

  considered.push(PREFERRED_SWAP_CHAIN_FORMAT, FALLBACK_SWAP_CHAIN_FORMAT);
  return { format: FALLBACK_SWAP_CHAIN_FORMAT, isFallback: true, considered };
}

/**
 * Reads the platform's preferred format, tolerating a provider without the probe.
 *
 * @param provider GPU entry point; defaults to `navigator.gpu`.
 * @returns The preferred format, or `null` when the probe is unavailable.
 */
export function probePreferredFormat(
  provider = getGPUProvider(),
): string | null {
  if (provider === null || typeof provider.getPreferredCanvasFormat !== 'function') return null;
  try {
    const format = provider.getPreferredCanvasFormat();
    return typeof format === 'string' && format.length > 0 ? format : null;
  } catch (error) {
    log.debug('getPreferredCanvasFormat() threw', error);
    return null;
  }
}

/**
 * Configures a canvas context and hands out its current texture.
 *
 * ```ts
 * const swapChain = new WebGPUSwapChain(context, device, { width, height });
 * swapChain.configure();
 * const view = swapChain.getCurrentTexture().createView();
 * ```
 */
export class WebGPUSwapChain {
  /** Canvas context being configured. */
  public readonly context: GPUCanvasContextLike;

  /** Device whose queue owns the presented textures. */
  private readonly device: GPUDeviceLike;

  /** Options the chain was created with. */
  private readonly options: WebGPUSwapChainOptions;

  /** Format actually configured. */
  private configuredFormat: string = FALLBACK_SWAP_CHAIN_FORMAT;

  /** `true` when {@link WebGPUSwapChain.configure} has run. */
  private configured: boolean = false;

  /** Width in device pixels. */
  private currentWidth: number;

  /** Height in device pixels. */
  private currentHeight: number;

  /** Number of times the configuration was applied. */
  private configureCount: number = 0;

  /**
   * Creates a swap chain.
   *
   * @param context Canvas context to configure.
   * @param device Device that will render into it.
   * @param options Format, alpha mode, usage and size.
   */
  constructor(context: GPUCanvasContextLike, device: GPUDeviceLike, options: WebGPUSwapChainOptions = {}) {
    this.context = context;
    this.device = device;
    this.options = options;
    this.currentWidth = Math.max(1, Math.floor(options.width ?? 1));
    this.currentHeight = Math.max(1, Math.floor(options.height ?? 1));
  }

  /** Format currently configured. */
  public get format(): string {
    return this.configuredFormat;
  }

  /** `true` once the context has been configured. */
  public get isConfigured(): boolean {
    return this.configured;
  }

  /** Current width in device pixels. */
  public get width(): number {
    return this.currentWidth;
  }

  /** Current height in device pixels. */
  public get height(): number {
    return this.currentHeight;
  }

  /** Number of times {@link WebGPUSwapChain.configure} ran. */
  public get configurations(): number {
    return this.configureCount;
  }

  /**
   * Resolves the format without configuring anything.
   *
   * @param preferredFormats Platform-preferred formats, or `null`.
   * @returns The choice.
   */
  public static resolveFormat(preferredFormats: readonly string[] | null | undefined): SwapChainFormatChoice {
    return resolveSwapChainFormat(preferredFormats);
  }

  /**
   * Configures (or reconfigures) the canvas context.
   *
   * @param preferredFormats Platform-preferred formats; defaults to the adapter probe.
   * @returns This chain, for chaining.
   */
  public configure(preferredFormats?: readonly string[] | null): this {
    const choice =
      this.options.format !== undefined
        ? { format: this.options.format, isFallback: false, considered: [this.options.format] }
        : resolveSwapChainFormat(preferredFormats ?? this.preferredFormats());

    if (choice.isFallback && this.options.format === undefined) {
      log.debug(
        `no preferred canvas format was reported; configuring '${choice.format}'. Considered: ` +
          `${choice.considered.join(', ') || 'none'}.`,
      );
    }

    this.configuredFormat = choice.format;
    this.context.configure({
      device: this.device,
      format: choice.format,
      alphaMode: this.options.alphaMode ?? 'opaque',
      usage: this.options.usage ?? GPUTextureUsageFlags.RENDER_ATTACHMENT,
    });

    this.configured = true;
    this.configureCount++;
    return this;
  }

  /**
   * Reconfigures the chain for a new drawing-buffer size.
   *
   * WebGPU has no `size` field in the canvas configuration —the texture size follows
   * the canvas element —so this records the size and reconfigures, which is what
   * makes the next `getCurrentTexture()` the right dimensions.
   *
   * @param width Width in device pixels.
   * @param height Height in device pixels.
   * @returns `true` when the size changed.
   */
  public resize(width: number, height: number): boolean {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.currentWidth && nextHeight === this.currentHeight) return false;

    this.currentWidth = nextWidth;
    this.currentHeight = nextHeight;
    if (this.configured) this.configure();
    return true;
  }

  /**
   * Returns the texture the next submit will present.
   *
   * @returns The current swap-chain texture.
   * @throws Error When the context has not been configured.
   */
  public getCurrentTexture(): GPUTextureLike {
    if (!this.configured) {
      throw new Error(
        'WebGPUSwapChain.getCurrentTexture(): the canvas context has not been configured. Call ' +
          '`configure()` first —`context.getCurrentTexture()` returns a texture whose usage and ' +
          'format are undefined until then.',
      );
    }
    return this.context.getCurrentTexture();
  }

  /**
   * Returns the current texture's default view, ready for a render pass attachment.
   *
   * @returns The texture view.
   */
  public getCurrentTextureView(): GPUTextureViewLike {
    return this.getCurrentTexture().createView();
  }

  /**
   * Unconfigures the context, releasing its textures.
   *
   * @returns This chain, for chaining.
   */
  public unconfigure(): this {
    if (!this.configured) return this;
    try {
      this.context.unconfigure();
    } catch (error) {
      log.debug('unconfigure() threw', error);
    }
    this.configured = false;
    return this;
  }

  /** @returns The platform-preferred formats, when the probe is available. */
  private preferredFormats(): readonly string[] | null {
    const preferred = probePreferredFormat();
    return preferred === null ? null : [preferred];
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGPUSwapChain(${this.configuredFormat}, ${this.currentWidth}x${this.currentHeight})`;
  }
}
