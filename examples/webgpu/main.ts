/**
 * WebGPU — capability detection and a clear report of what is and is not available.
 *
 * Read this first
 * ---------------
 * **The WebGPU backend is implemented but unproven on real hardware.** `src/renderer/webgpu/` is a
 * empty directory; `detectBackend`'s preference list names `'webgpu'` and the
 * renderer contracts are written to accommodate a GPU backend, but there is no
 * `WebGPURenderer` to construct. This example therefore does *not* pretend to render
 * through WebGPU. What it does instead is exactly what a real application has to do
 * before choosing a backend:
 *
 * 1. probe the platform (`navigator.gpu`, `requestAdapter`, `requestDevice`);
 * 2. cross-check that probe against the library's own answer
 *    (`detectBackendStrict('webgpu')` and `getSupportedBackendNames()`);
 * 3. report the outcome on the page — including the adapter's own limits and
 *    features, which are the numbers that decide whether a scene will fit;
 * 4. fall back to a backend that does work, so the page is never blank.
 *
 * If you are looking for a GPU backend that renders today, see
 * `examples/webgl/`, which drives `WebGLRenderer` with real GLSL programs.
 *
 * What to look for
 * ----------------
 * Chromium-based browsers expose WebGPU: the report lists the adapter's vendor,
 * architecture and limits, and the library agrees `'webgpu'` is supported. Safari
 * and Firefox builds without the flag, and every browser over an insecure origin,
 * report that `navigator.gpu` is missing — the page then explains why and renders
 * the Canvas2D fallback in the same canvas.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  Color,
  detectBackendStrict,
  getSupportedBackendNames,
  type BackendName,
  type Canvas2DPainter,
  type Renderable2D,
} from '../../src/index';

/* -------------------------------------------------------------------------- */
/* Minimal structural view of the WebGPU probe                                */
/* -------------------------------------------------------------------------- */

/*
 * `src/types/global.d.ts` already augments `Navigator` with a loosely typed
 * `readonly gpu?: any`, so this example does not redeclare it. The interfaces below
 * describe only the members the probe actually reads.
 */

/** The subset of `GPUAdapterInfo` this example reports. */
interface GpuAdapterInfo {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

/** The subset of `GPUAdapter` this example reads. */
interface GpuAdapter {
  readonly features?: Iterable<string>;
  readonly limits?: Record<string, number>;
  readonly info?: GpuAdapterInfo;
}

/** The subset of `GPUDevice` this example reads. */
interface GpuDevice {
  readonly limits?: Record<string, number>;
  destroy?(): void;
}

/** The subset of `GPU` this example uses. */
interface GpuApi {
  requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapter | null>;
}

/** The result of probing the platform for WebGPU. */
interface GpuProbe {
  readonly navigatorGpu: boolean;
  readonly adapter: boolean;
  readonly device: boolean;
  readonly info: GpuAdapterInfo | null;
  readonly limits: Record<string, number> | null;
  readonly features: string[];
  readonly error: string | null;
}

/** Reads `navigator.gpu` without assuming the type exists. */
function readGpuApi(): GpuApi | null {
  const candidate = (navigator as { gpu?: unknown }).gpu;
  if (candidate == null) return null;
  const requestAdapter = (candidate as { requestAdapter?: unknown }).requestAdapter;
  if (typeof requestAdapter !== 'function') return null;
  return candidate as GpuApi;
}

/**
 * Probes WebGPU, converting every failure mode into data.
 *
 * Nothing here throws: `requestAdapter` returns `null` on an unsupported platform,
 * and `requestDevice` rejects when the adapter cannot serve the requested limits.
 */
async function probeWebGpu(): Promise<GpuProbe> {
  const gpu = readGpuApi();
  if (gpu === null) {
    return {
      navigatorGpu: false,
      adapter: false,
      device: false,
      info: null,
      limits: null,
      features: [],
      error: null,
    };
  }

  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter === null) {
      return {
        navigatorGpu: true,
        adapter: false,
        device: false,
        info: null,
        limits: null,
        features: [],
        error: 'requestAdapter() resolved to null: no suitable GPU adapter is available.',
      };
    }

    const device = await (adapter as unknown as { requestDevice(): Promise<GpuDevice> }).requestDevice();
    const features = adapter.features ? Array.from(adapter.features) : [];
    const limits = device.limits ?? adapter.limits ?? null;

    // The device is released immediately: this example only inspects it.
    device.destroy?.();

    return {
      navigatorGpu: true,
      adapter: true,
      device: true,
      info: adapter.info ?? null,
      limits,
      features,
      error: null,
    };
  } catch (error) {
    return {
      navigatorGpu: true,
      adapter: true,
      device: false,
      info: null,
      limits: null,
      features: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Fallback: an honest Canvas2D render, so the page is never blank            */
/* -------------------------------------------------------------------------- */

/** A slowly rotating dashed ring, drawn with whichever CPU backend is available. */
class FallbackRing implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  private angle = 0;

  public update(delta: number): void {
    this.angle += delta * 0.4;
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.save();
    p.translate(0, 0);
    p.rotate(this.angle);

    p.setLineDash([10, 14]);
    p.lineWidth = 3;
    p.strokeStyle = 'rgba(47, 111, 223, 0.75)';
    p.beginPath();
    p.arc(0, 0, 90, 0, Math.PI * 2);
    p.stroke();

    p.setLineDash([]);
    p.lineWidth = 2;
    p.strokeStyle = 'rgba(63, 191, 143, 0.85)';
    p.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      p.moveTo(Math.cos(a) * 30, Math.sin(a) * 30);
      p.lineTo(Math.cos(a) * 62, Math.sin(a) * 62);
    }
    p.stroke();
    p.restore();
  }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');
const report = document.querySelector<HTMLElement>('#report');
const reportTitle = document.querySelector<HTMLElement>('#report-title');
const reportBody = document.querySelector<HTMLElement>('#report-body');

let dispose = (): void => undefined;

/** Renders a headline plus an explanation in the middle of the stage. */
function showReport(title: string, body: string): void {
  if (!report || !reportTitle || !reportBody) return;
  reportTitle.textContent = title;
  reportBody.textContent = body;
  report.hidden = false;
}

if (!canvas || !overlay) {
  if (notice) {
    notice.textContent = 'This example needs the #stage canvas and the #overlay element to exist.';
    notice.hidden = false;
  }
} else {
  const supported = getSupportedBackendNames();
  const librarySaysWebGpu = detectBackendStrict(BackendNames.WebGPU) === BackendNames.WebGPU;

  void (async (): Promise<void> => {
    const probe = await probeWebGpu();

    // The CPU fallback runs regardless, so the page always shows something.
    const preferred: BackendName[] = [BackendNames.Canvas2D];
    const fallback = detectBackendStrict(preferred, canvas);

    if (fallback !== BackendNames.Canvas2D) {
      showReport(
        'No CPU fallback either',
        'Neither the WebGPU backend (not implemented in this checkout) nor a 2D canvas ' +
          'context is available, so nothing can be drawn here.',
      );
      overlay.textContent = 'no backend available';
      return;
    }

    const renderer = new Canvas2DRenderer({ canvas, clearColor: '#11151d', autoResize: true });
    const ring = new FallbackRing();
    const scene = { children: [ring] as Renderable2D[] };
    const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 1.7 };

    const webgpuLabel = probe.navigatorGpu && probe.adapter && probe.device ? 'available' : 'unavailable';
    const limits = probe.limits ?? {};
    const reported = [
      'maxTextureDimension2D',
      'maxBufferSize',
      'maxComputeWorkgroupSizeX',
      'maxBindGroups',
    ].filter((key) => typeof limits[key] === 'number');

    if (webgpuLabel === 'available') {
      const info = probe.info;
      showReport(
        'WebGPU is available on this platform',
        `The platform probe succeeded${info?.vendor ? ` (vendor: ${info.vendor})` : ''}. The library ` +
          `also reports 'webgpu' as supported. A WebGPURenderer is still not implemented in this ` +
          `checkout, so this page is showing the Canvas2D fallback.`,
      );
    } else {
      showReport(
        'WebGPU is unavailable — showing the Canvas2D fallback',
        probe.navigatorGpu
          ? `${probe.error ?? 'The adapter or device request failed.'} The WebGPU backend is also not ` +
            `implemented in this checkout yet, so the Canvas2D fallback is rendering instead.`
          : `navigator.gpu is undefined. WebGPU needs a Chromium-based browser (or a Safari/Firefox ` +
            `build with it enabled) served over a secure context. The WebGPU backend is also not ` +
            `implemented in this checkout yet, so the Canvas2D fallback is rendering instead.`,
      );
    }

    let fps = 0;
    let frames = 0;
    let fpsElapsed = 0;

    renderer.setAnimationLoop((_time, delta) => {
      ring.update(delta);

      frames++;
      fpsElapsed += delta;
      if (fpsElapsed >= 0.25) {
        fps = frames / fpsElapsed;
        frames = 0;
        fpsElapsed = 0;
      }

      renderer.render(scene, camera);

      overlay.textContent =
        `FPS              ${fps.toFixed(0)}\n` +
        `active backend   ${renderer.backend} (fallback)\n` +
        `navigator.gpu    ${probe.navigatorGpu ? 'present' : 'missing'}\n` +
        `adapter          ${probe.adapter ? 'granted' : 'none'}\n` +
        `device           ${probe.device ? 'created' : 'none'}\n` +
        `'webgpu' detect  ${librarySaysWebGpu ? 'supported' : 'unsupported'}\n` +
        `supported list   ${supported.length > 0 ? supported.join(', ') : 'none'}\n` +
        `adapter limits   ${reported.length > 0 ? reported.map((k) => `${k}=${limits[k]}`).join('  ') : 'not read'}`;
    }, { autoStart: true });

    dispose = (): void => {
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  })();
}

window.addEventListener('beforeunload', dispose);

/** Documents the palette source without affecting the render loop. */
export const accent = new Color('#2f6fdf').toCssString();
