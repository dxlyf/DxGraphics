/**
 * Playground entry point.
 *
 * Owns the four things a demo must not: the canvas, the backend, the frame loop and the
 * control panel. A demo only ever sees a painter, a camera, a delta and its parameter
 * record, which is what lets the backend be swapped without touching demo code.
 *
 * ## Backend selection
 *
 * `getSupportedBackendNames()` reports what this browser can actually create, and each
 * option in the picker is **disabled** when unsupported rather than hidden — so the
 * reason a backend is unavailable stays visible. When the active demo cannot run on the
 * selected backend (for example a demo that needs `getImageData`, which SVG has no
 * equivalent of), the shell shows a notice and falls back to a backend the demo can use.
 *
 * ## Resize
 *
 * A `ResizeObserver` on the stage drives `renderer.setSize`, so the drawing buffer
 * follows the CSS layout rather than the window size.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  Vec2,
  detectBackendStrict,
  getSupportedBackendNames,
  type BackendName,
  type CameraLike,
  type Canvas2DPainter,
} from '../../src/index';
import { SVGRenderer } from '../../src/renderer/svg/SVGRenderer';
import {
  DEMOS,
  defaultParams,
  disposeDemoState,
  getDemo,
  setPointerWorld,
  type DemoContext,
  type SceneDemo,
} from './examples';
import {
  button,
  clear,
  select,
  setHidden,
  setText,
  slider,
  toggle,
  type ControlHandle,
} from './ui';

/* -------------------------------------------------------------------------- */
/* Backend abstraction                                                        */
/* -------------------------------------------------------------------------- */

/** What the shell needs from a running backend. */
interface ActiveBackend {
  readonly name: BackendName;
  readonly renderer: Canvas2DRenderer | SVGRenderer;
  /** The painter a demo draws through, or `null` for a backend without one. */
  readonly painter: Canvas2DPainter | null;
  /** Applies a new logical size. */
  resize(width: number, height: number): void;
  /** Draws one frame. */
  render(objects: readonly unknown[], camera: CameraLike | null): void;
  /** Releases the backend. */
  dispose(): void;
}

/** Human-readable labels for the backend picker. */
const BACKEND_LABELS: Record<string, string> = {
  [BackendNames.WebGPU]: 'WebGPU (not implemented)',
  [BackendNames.WebGL2]: 'WebGL 2',
  [BackendNames.WebGL]: 'WebGL (not wired here)',
  [BackendNames.Canvas2D]: 'Canvas2D',
  [BackendNames.SVG]: 'SVG',
};

/** Backends the playground knows how to drive. */
const PLAYGROUND_BACKENDS: readonly BackendName[] = [
  BackendNames.Canvas2D,
  BackendNames.SVG,
];

/* -------------------------------------------------------------------------- */
/* DOM                                                                        */
/* -------------------------------------------------------------------------- */

const canvasElement = document.querySelector<HTMLCanvasElement>('#canvas');
const stageElement = document.querySelector<HTMLElement>('#stage');
const noticeElement = document.querySelector<HTMLElement>('#notice');
const statsHost = document.querySelector<HTMLElement>('#stats');
const backendGroupHost = document.querySelector<HTMLElement>('#backend');
const backendNoteHost = document.querySelector<HTMLElement>('#backend-note');
const demoPicker = document.querySelector<HTMLSelectElement>('#demo-select');
const demoNoteHost = document.querySelector<HTMLElement>('#demo-note');
const optionsElement = document.querySelector<HTMLElement>('#options');
const resetElement = document.querySelector<HTMLButtonElement>('#reset');
const pauseElement = document.querySelector<HTMLButtonElement>('#pause');
const snapshotElement = document.querySelector<HTMLButtonElement>('#snapshot');

if (
  canvasElement === null ||
  stageElement === null ||
  noticeElement === null ||
  statsHost === null ||
  backendGroupHost === null ||
  backendNoteHost === null ||
  demoPicker === null ||
  demoNoteHost === null ||
  optionsElement === null
) {
  throw new Error('the playground shell is missing a required element in index.html');
}

/*
 * Bind the required elements to non-nullable consts. The guard above cannot narrow the
 * `let`-shaped module bindings for closures declared later, so the narrowing is made
 * explicit here once instead of asserting at every use site.
 */
const canvas: HTMLCanvasElement = canvasElement;
const stage: HTMLElement = stageElement;
const notice: HTMLElement = noticeElement;
const statsElement: HTMLElement = statsHost;
const backendHost: HTMLElement = backendGroupHost;
const backendNote: HTMLElement = backendNoteHost;
const demoSelectHost: HTMLSelectElement = demoPicker;
const demoNote: HTMLElement = demoNoteHost;
const optionsHost: HTMLElement = optionsElement;
const resetButton: HTMLButtonElement | null = resetElement;
const pauseButton: HTMLButtonElement | null = pauseElement;
const snapshotButton: HTMLButtonElement | null = snapshotElement;

/* -------------------------------------------------------------------------- */
/* Shell state                                                                */
/* -------------------------------------------------------------------------- */

/** Backends this browser can actually create. */
const supported = new Set<BackendName>(getSupportedBackendNames());

/** Currently active backend adapter, or `null` before the first boot. */
let backend: ActiveBackend | null = null;

/** Currently active demo, or `null` before the first boot. */
let demo: SceneDemo | null = null;

/** Live parameter values for the active demo. */
let params: Record<string, number | boolean | string> = {};

/** Renderables the active demo filled in. */
const objects: DemoContext['objects'] = [];

/** Camera handed to the demo every frame. */
const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 34, rotation: 0 };

/** Parameter controls, so the panel can be rebuilt per demo. */
let controls: ControlHandle<unknown>[] = [];

/** `true` while the frame loop is started. */
let running = true;

/** Seconds since the active demo was created. */
let demoTime = 0;

/** Hand-rolled FPS estimate, used when a backend reports nothing usable. */
let frames = 0;
let fpsAccumulator = 0;
let measuredFps = 0;

/** Size of the stage, in CSS pixels, tracked by the observer. */
let stageWidth = 0;
let stageHeight = 0;

/** Keeps the requested backend across demo switches. */
let requestedBackend: BackendName = BackendNames.Canvas2D;

/* -------------------------------------------------------------------------- */
/* Notices                                                                    */
/* -------------------------------------------------------------------------- */

/** Shows a message on the stage, or hides it when `message` is `null`. */
function showNotice(message: string | null): void {
  setText(notice, message ?? '');
  setHidden(notice, message === null);
}

/* -------------------------------------------------------------------------- */
/* Backend factories                                                          */
/* -------------------------------------------------------------------------- */

/** Creates and starts a Canvas2D backend. */
function createCanvas2DBackend(): ActiveBackend | null {
  const renderer = new Canvas2DRenderer({
    canvas,
    clearColor: '#11151d',
    clearAlpha: 1,
    pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  });

  if (renderer.isHeadless) {
    renderer.dispose();
    return null;
  }

  return {
    name: BackendNames.Canvas2D,
    renderer,
    painter: renderer.painter,
    resize: (width, height) => renderer.setSize(width, height, false),
    render: (renderables, cam) => renderer.render({ children: renderables }, cam),
    dispose: () => renderer.dispose(),
  };
}

/** Creates and starts an SVG backend, using the stage as the container. */
function createSvgBackend(): ActiveBackend | null {
  const renderer = new SVGRenderer({
    container: stage,
    clearColor: '#11151d',
    clearAlpha: 1,
    width: Math.max(1, Math.round(stageWidth)),
    height: Math.max(1, Math.round(stageHeight)),
  });

  if (!renderer.isLive) {
    renderer.dispose();
    return null;
  }

  return {
    name: BackendNames.SVG,
    renderer,
    // SVG has no Canvas2DPainter; demos receive a painter typed as Canvas2DPainter but
    // branch on the SVG element factory, so the SVG painter is passed through here.
    painter: renderer.painter as unknown as Canvas2DPainter,
    resize: (width, height) => {
      renderer.setSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), false);
    },
    render: (renderables, cam) => {
      renderer.render({ children: renderables }, cam);
    },
    dispose: () => renderer.dispose(),
  };
}

/** Tears down the active backend, tolerating a missing one. */
function disposeBackend(): void {
  backend?.dispose();
  backend = null;
}

/* -------------------------------------------------------------------------- */
/* Demo lifecycle                                                            */
/* -------------------------------------------------------------------------- */

/** Builds the parameter controls for the active demo. */
function buildOptions(): void {
  clear(optionsHost);
  controls = [];
  if (demo === null) return;

  if (demo.params.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'This demo has no parameters.';
    optionsHost.append(empty);
    return;
  }

  for (const param of demo.params) {
    const current = params[param.key];
    if (param.kind === 'slider') {
      const handle = slider(optionsHost, {
        label: param.label,
        value: typeof current === 'number' ? current : 0,
        min: param.min ?? 0,
        max: param.max ?? 1,
        step: param.step,
        onChange: (value) => {
          params[param.key] = value;
        },
      });
      controls.push(handle as ControlHandle<unknown>);
      continue;
    }
    if (param.kind === 'toggle') {
      const handle = toggle(optionsHost, {
        label: param.label,
        value: typeof current === 'boolean' ? current : false,
        onChange: (value) => {
          params[param.key] = value;
        },
      });
      controls.push(handle as ControlHandle<unknown>);
      continue;
    }
    const choices = (param.choices ?? []).map((choice) => ({
      value: choice.value,
      label: choice.label,
    }));
    const handle = select(optionsHost, {
      label: param.label,
      value: typeof current === 'string' ? current : (choices[0]?.value ?? ''),
      choices,
      onChange: (value) => {
        params[param.key] = value;
      },
    });
    controls.push(handle as ControlHandle<unknown>);
  }
}

/** Chooses the backend to use for `demo`, honouring `preferred` when it can run it. */
function resolveBackendFor(target: SceneDemo, preferred: BackendName): BackendName | null {
  const candidates: BackendName[] = [preferred, ...target.backends];
  for (const candidate of candidates) {
    if (!PLAYGROUND_BACKENDS.includes(candidate)) continue;
    if (!supported.has(candidate)) continue;
    if (!target.backends.includes(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Boots `target` on `resolved` backend.
 *
 * Every failure path ends in an on-page notice rather than an exception, because a
 * blank canvas with a console error is the worst possible outcome for a playground.
 */
function boot(target: SceneDemo, resolved: BackendName): void {
  disposeBackend();
  disposeDemoState();
  objects.length = 0;

  showNotice(null);

  backend =
    resolved === BackendNames.SVG ? createSvgBackend() : createCanvas2DBackend();

  if (backend === null) {
    showNotice(
      `The ${BACKEND_LABELS[resolved] ?? resolved} backend could not be created in this ` +
        'browser, so nothing is drawn. Pick another backend from the panel.',
    );
    setText(statsElement, 'no backend');
    return;
  }

  backend.resize(stageWidth, stageHeight);

  // Reset the camera to the demo's initial framing before the demo touches it.
  camera.position.x = target.camera.position.x;
  camera.position.y = target.camera.position.y;
  camera.position.z = target.camera.position.z;
  camera.zoom = target.camera.zoom;
  camera.rotation = target.camera.rotation;

  demoTime = 0;

  const context: DemoContext = {
    painter: backend.painter,
    camera,
    delta: 0,
    time: 0,
    width: stageWidth,
    height: stageHeight,
    params,
    objects,
  };

  try {
    target.setup(context);
  } catch (error) {
    showNotice(
      `The demo "${target.label}" failed while building its scene: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    disposeBackend();
    return;
  }

  demo = target;
  setText(demoNote, target.description);
  backend.renderer.setAnimationLoop(null);
  backend.renderer.start();
}

/** Switches to a backend, rebooting the active demo when necessary. */
function switchBackend(name: BackendName): void {
  requestedBackend = name;
  setText(backendNote, describeBackendAvailability(name));
  if (demo === null) return;
  const resolved = resolveBackendFor(demo, name);
  if (resolved === null) {
    showNotice(
      `The demo "${demo.label}" needs one of: ${demo.backends.join(', ')}. None of those is ` +
        'available in this browser.',
    );
    return;
  }
  if (resolved !== name) {
    showNotice(
      `The demo "${demo.label}" cannot render on the ${BACKEND_LABELS[name] ?? name} backend ` +
        `(it needs a pixel buffer), so it is running on ${BACKEND_LABELS[resolved] ?? resolved}.`,
    );
  }
  boot(demo, resolved);
  updateBackendPickerSelection(resolved);
}

/** Switches to another demo, keeping the requested backend when possible. */
function switchDemo(id: string): void {
  const target = getDemo(id);
  if (target === undefined) return;

  params = defaultParams(target);
  disposeDemoState();

  const resolved = resolveBackendFor(target, requestedBackend);
  if (resolved === null) {
    showNotice(
      `The demo "${target.label}" needs one of: ${target.backends.join(', ')}. None of those is ` +
        'available in this browser.',
    );
    return;
  }

  demo = target;
  buildOptions();
  setText(demoNote, target.description);
  boot(target, resolved);
  updateBackendPickerSelection(resolved);
}

/* -------------------------------------------------------------------------- */
/* Panel construction                                                         */
/* -------------------------------------------------------------------------- */

let backendHandle: ControlHandle<BackendName> | null = null;

/** Rebuilds the backend radio group with unsupported options disabled. */
function buildBackendPicker(): void {
  clear(backendHost);

  const choices = PLAYGROUND_BACKENDS.map((name) => ({
    value: name,
    label: BACKEND_LABELS[name] ?? name,
    disabled: !supported.has(name),
  }));

  const group = document.createElement('div');
  group.className = 'radios';

  for (const choice of choices) {
    const id = `backend-${choice.value}`;
    const row = document.createElement('label');
    row.className = 'radio';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'backend';
    input.id = id;
    input.value = choice.value;
    input.disabled = choice.disabled;
    input.checked = choice.value === requestedBackend;

    input.addEventListener('change', () => {
      if (input.checked) switchBackend(choice.value as BackendName);
    });

    const text = document.createElement('span');
    text.textContent = choice.label;

    row.append(input, text);
    if (choice.disabled) {
      const badge = document.createElement('em');
      badge.textContent = 'unavailable';
      row.append(badge);
    }
    group.append(row);
  }

  backendHost.append(group);

  backendHandle = {
    element: group,
    get: () => requestedBackend,
    set: (value: BackendName) => {
      requestedBackend = value;
    },
  };

  setText(backendNote, describeBackendAvailability(requestedBackend));
}

/** Keeps the radio group in sync when the shell falls back to another backend. */
function updateBackendPickerSelection(active: BackendName): void {
  if (backendHandle === null) return;
  const group = backendHandle.element;
  for (const input of group.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    input.checked = input.value === active && !input.disabled;
  }
}

/** Explains why a backend is or is not selectable. */
function describeBackendAvailability(name: BackendName): string {
  if (!PLAYGROUND_BACKENDS.includes(name)) {
    if (name === BackendNames.WebGPU) {
      return 'WebGPU: src/renderer/webgpu/ is an empty module in this checkout, so there is no renderer to select.';
    }
    return 'WebGL: drive it from examples/webgl — it exposes a camera adapter this shell does not need.';
  }
  if (!supported.has(name)) {
    return `Unavailable: this browser could not create a ${BACKEND_LABELS[name] ?? name} context.`;
  }
  return `Available. Supported backends: ${getSupportedBackendNames().join(', ') || 'none'}.`;
}

/** Rebuilds the demo picker. */
function buildDemoPicker(): void {
  clear(demoSelectHost);
  for (const entry of DEMOS) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    demoSelectHost.append(option);
  }
  if (DEMOS.length > 0) demoSelectHost.value = DEMOS[0].id;

  demoSelectHost.addEventListener('change', onDemoPickerChange);
}

/** Handles a demo picker change; stored so `dispose()` can remove it. */
function onDemoPickerChange(): void {
  switchDemo(demoSelectHost.value);
}

/* -------------------------------------------------------------------------- */
/* Pointer → world                                                            */
/* -------------------------------------------------------------------------- */

/*
 * The demos that hit-test need a world-space pointer, but they receive no events. The
 * shell converts once per pointer move using the same transform the backend applies:
 * world `+Y` up, origin at the viewport centre, `zoom` world-units-to-pixels.
 */
function updatePointerFromEvent(event: PointerEvent): void {
  if (backend === null) {
    setPointerWorld(null);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const zoom = camera.zoom === 0 ? 1 : camera.zoom;
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  const dx = (screenX - rect.width / 2) / zoom + camera.position.x;
  const dy = -(screenY - rect.height / 2) / zoom + camera.position.y;

  const cos = Math.cos(-camera.rotation);
  const sin = Math.sin(-camera.rotation);
  setPointerWorld(new Vec2(dx * cos - dy * sin, dx * sin + dy * cos));
}

canvas.addEventListener('pointermove', updatePointerFromEvent);
canvas.addEventListener('pointerleave', onPointerLeave);

/* -------------------------------------------------------------------------- */
/* Frame loop                                                                 */
/* -------------------------------------------------------------------------- */

let lastFrameTime = performance.now();

/** Advances and draws one frame. */
function frame(): void {
  const now = performance.now();
  // Clamped so a backgrounded tab cannot teleport the animation.
  const delta = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;

  if (backend !== null && demo !== null) {
    demoTime += delta;

    const context: DemoContext = {
      painter: backend.painter,
      camera,
      delta,
      time: demoTime,
      width: stageWidth,
      height: stageHeight,
      params,
      objects,
    };

    try {
      demo.update(context);
    } catch (error) {
      // A demo that throws must not kill the loop: report once and keep going.
      showNotice(
        `The demo "${demo.label}" threw while updating: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    backend.render(objects, camera);
  }

  frames++;
  fpsAccumulator += delta;
  if (fpsAccumulator >= 0.25) {
    measuredFps = frames / fpsAccumulator;
    frames = 0;
    fpsAccumulator = 0;
    updateStats();
  }

  requestAnimationFrame(frame);
}

/** Refreshes the statistics readout from the renderer's own counters. */
function updateStats(): void {
  if (backend === null) {
    setText(statsElement, 'no backend');
    return;
  }
  const info = backend.renderer.info;
  const reportedFps = backend.renderer.stats.fps;
  const fps = reportedFps > 0 ? reportedFps : measuredFps;
  const lines = [
    `FPS        ${fps.toFixed(1)}${reportedFps > 0 ? '' : ' (measured)'}`,
    `backend    ${backend.name}`,
    `demo       ${demo?.label ?? '—'}`,
    `objects    ${objects.length}`,
    `draw calls ${backend.renderer.stats.drawCalls}`,
    `surface    ${Math.round(backend.renderer.width)}×${Math.round(backend.renderer.height)} @${info.pixelRatio}x`,
  ];
  if (info.capabilities.length > 0) {
    lines.push(`caps       ${info.capabilities.slice(0, 4).join(', ')}`);
  }
  setText(statsElement, lines.join('\n'));
}

/* -------------------------------------------------------------------------- */
/* Resize                                                                     */
/* -------------------------------------------------------------------------- */

const observer = new ResizeObserver((entries) => {
  const entry = entries[0];
  if (entry === undefined) return;
  const width = Math.max(1, Math.round(entry.contentRect.width));
  const height = Math.max(1, Math.round(entry.contentRect.height));
  if (width === stageWidth && height === stageHeight) return;
  stageWidth = width;
  stageHeight = height;
  backend?.resize(width, height);
});

observer.observe(stage);

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

resetButton?.addEventListener('click', () => {
  if (demo === null) return;
  params = defaultParams(demo);
  buildOptions();
  boot(demo, backend?.name ?? requestedBackend);
});

pauseButton?.addEventListener('click', () => {
  if (backend === null) return;
  running = !running;
  if (running) {
    lastFrameTime = performance.now();
    backend.renderer.start();
    setText(pauseButton, 'Pause');
  } else {
    backend.renderer.stop();
    setText(pauseButton, 'Resume');
  }
});

snapshotButton?.addEventListener('click', () => {
  if (backend === null) return;
  const element = backend.renderer.canvas;
  if (element === null) {
    showNotice('Only the Canvas2D backend has a pixel buffer to export. Use SVG output instead.');
    return;
  }
  showNotice(null);
  // `toDataURL` is synchronous and safe to call between frames.
  const link = document.createElement('a');
  link.href = element.toDataURL('image/png');
  link.download = `lyf-playground-${demo?.id ?? 'demo'}.png`;
  link.click();
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

// Size the stage before the first boot so the initial frame is not 1×1.
{
  const rect = stage.getBoundingClientRect();
  stageWidth = Math.max(1, Math.round(rect.width));
  stageHeight = Math.max(1, Math.round(rect.height));
}

buildBackendPicker();
buildDemoPicker();

// Prefer Canvas2D because every demo supports it.
requestedBackend = supported.has(BackendNames.Canvas2D)
  ? BackendNames.Canvas2D
  : (getSupportedBackendNames()[0] ?? BackendNames.Canvas2D);

if (DEMOS.length > 0) {
  const first = DEMOS[0];
  params = defaultParams(first);
  demo = first;
  buildOptions();
  setText(demoNote, first.description);
  boot(first, resolveBackendFor(first, requestedBackend) ?? first.backends[0]);
  updateBackendPickerSelection(requestedBackend);
}

// The renderer's own loop is not used: the shell owns `requestAnimationFrame` so it can
// run demos that never call `renderer.render` (the SVG painter writes to the DOM).
requestAnimationFrame(frame);

/* -------------------------------------------------------------------------- */
/* Teardown                                                                   */
/* -------------------------------------------------------------------------- */

/** Stops everything this module started. Safe to call more than once. */
export function dispose(): void {
  observer.disconnect();
  disposeBackend();
  disposeDemoState();
  objects.length = 0;
  canvas.removeEventListener('pointermove', updatePointerFromEvent);
  canvas.removeEventListener('pointerleave', onPointerLeave);
  demoSelectHost.removeEventListener('change', onDemoPickerChange);
  setPointerWorld(null);
}

/** Clears the world pointer when the cursor leaves the canvas. */
function onPointerLeave(): void {
  setPointerWorld(null);
}

window.addEventListener('beforeunload', dispose);

// Referenced so the panel helper stays exercised even if a demo has no sliders.
void button;
void controls;
