/**
 * The SVG backend — a live, inspectable SVG document instead of a pixel buffer.
 *
 * What it shows
 * -------------
 * `SVGRenderer` produces real DOM: a wrapper `<div>`, an `<svg>` root carrying the
 * `viewBox`, a `<defs>` container, a full-viewport background `<rect>`, a world
 * `<g>` that receives the camera transform, and one `<g>` per renderable. Because
 * the output is retained-mode markup, the camera is a `transform` attribute rather
 * than a rasterised matrix, and the whole document serialises with `toSVGString()`.
 *
 * The painter here is `SVGPainter`, and it is **not** immediate-mode: it has no
 * `beginPath`/`moveTo`/`fill`. Renderables branch on which painter they received, so
 * the same object can draw through Canvas2D or SVG:
 *
 * ```ts
 * const isSvg = typeof (painter as { create?: unknown }).create === 'function';
 * ```
 *
 * What to look for
 * ----------------
 * Concentric rotating arcs, a pulsing dot and a text label. Open the element
 * inspector: you will see `<path>`, `<circle>` and `<text>` nodes updating in place
 * as the animation runs. The overlay shows FPS, the backend, the node count and the
 * serialised document size. Copy a DOM snapshot out with `renderer.toSVGString()`
 * from the console to confirm it is a standalone SVG file.
 */

import {
  BackendNames,
  Color,
  detectBackendStrict,
  type BackendName,
  type Renderable2D,
} from '../../src/index';
import { SVGRenderer, type SVGPainter } from '../../src/renderer/svg/SVGRenderer';

/* -------------------------------------------------------------------------- */
/* Renderables: shared by the SVG and Canvas2D painters                       */
/* -------------------------------------------------------------------------- */

/** `true` when the painter is the SVG one (it exposes `create`). */
function isSvgPainter(painter: unknown): painter is SVGPainter {
  return typeof (painter as { create?: unknown }).create === 'function';
}

/**
 * One ring of `segments` arcs.
 *
 * On SVG each arc becomes a `<path>` with a `d` string built from `A` commands; on
 * Canvas2D the same arc is issued as a stroked path. That branch is the whole point
 * of the example.
 */
class ArcRing implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public constructor(
    private readonly radius: number,
    private readonly segments: number,
    private readonly tint: string,
    private readonly width: number,
    private speed: number,
  ) {}

  private angle = 0;

  public update(delta: number): void {
    this.angle += delta * this.speed;
  }

  public render(painter: unknown): void {
    const sweep = (Math.PI * 2) / this.segments;
    const gap = sweep * 0.28;

    for (let i = 0; i < this.segments; i++) {
      const start = this.angle + i * sweep;
      const end = start + sweep - gap;
      // SVG works in a Y-down coordinate system, so the arc sweep flag is 1 for a
      // clockwise sweep; Canvas2D uses false for the same visual direction.
      const startX = Math.cos(start) * this.radius;
      const startY = Math.sin(start) * this.radius;
      const endX = Math.cos(end) * this.radius;
      const endY = Math.sin(end) * this.radius;

      if (isSvgPainter(painter)) {
        painter.path(
          `M ${startX.toFixed(2)} ${startY.toFixed(2)} A ${this.radius} ${this.radius} 0 0 1 ` +
            `${endX.toFixed(2)} ${endY.toFixed(2)}`,
          { fill: 'none', stroke: this.tint, 'stroke-width': this.width, 'stroke-linecap': 'round' },
        );
        continue;
      }

      const p = painter as {
        beginPath(): void;
        arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
        lineWidth: number;
        strokeStyle: string;
        stroke(): void;
      };
      p.beginPath();
      p.arc(0, 0, this.radius, start, end, false);
      p.lineWidth = this.width;
      p.strokeStyle = this.tint;
      p.stroke();
    }
  }
}

/** A dot whose radius pulses, drawn as `<circle>` on SVG. */
class PulseDot implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  private phase = 0;
  private readonly tint = new Color('#e8b23a');

  public update(delta: number): void {
    this.phase = (this.phase + delta * 0.9) % (Math.PI * 2);
  }

  public render(painter: unknown): void {
    const radius = 4 + (Math.sin(this.phase) * 0.5 + 0.5) * 7;
    const opacity = (0.45 + (Math.sin(this.phase) * 0.5 + 0.5) * 0.55).toFixed(3);
    const color = this.tint.toCssString();

    if (isSvgPainter(painter)) {
      painter.circle(120, 0, radius, { fill: color, opacity });
      return;
    }

    const p = painter as {
      beginPath(): void;
      arc(x: number, y: number, r: number, a0: number, a1: number): void;
      globalAlpha: number;
      fillStyle: string;
      fill(): void;
    };
    p.beginPath();
    p.arc(120, 0, radius, 0, Math.PI * 2);
    p.globalAlpha = Number(opacity);
    p.fillStyle = color;
    p.fill();
    p.globalAlpha = 1;
  }
}

/** A label, drawn as `<text>` on SVG. */
class Label implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public constructor(private readonly text: string) {}

  public render(painter: unknown): void {
    if (isSvgPainter(painter)) {
      painter.text(this.text, {
        x: -150,
        y: 128,
        fill: '#93a1b1',
        'font-family': 'ui-monospace, Menlo, Consolas, monospace',
        'font-size': 12,
      });
      return;
    }

    const p = painter as {
      fillStyle: string;
      font: string;
      textBaseline: string;
      fillText(text: string, x: number, y: number): void;
    };
    p.fillStyle = '#93a1b1';
    p.font = '12px ui-monospace, Menlo, Consolas, monospace';
    p.textBaseline = 'alphabetic';
    p.fillText(this.text, -150, 128);
  }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const host = document.querySelector<HTMLElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');

function showNotice(message: string): void {
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  if (overlay) overlay.textContent = 'backend unavailable';
}

let dispose = (): void => undefined;

if (!host || !overlay) {
  showNotice('This example needs the #stage container and the #overlay element to exist.');
} else {
  const preferred: BackendName[] = [BackendNames.SVG];
  const backend = detectBackendStrict(preferred, null);

  // `SVGRenderer.render()` throws when there is no DOM, so this is checked before
  // construction rather than caught afterwards.
  if (backend !== BackendNames.SVG) {
    showNotice(
      'The SVG backend needs `document.createElementNS`, which is unavailable here. ' +
        'Run this example in a browser.',
    );
  } else {
    const renderer = new SVGRenderer({
      container: host,
      clearColor: '#11151d',
      clearAlpha: 1,
      autoResize: true,
    });

    if (!renderer.isLive) {
      showNotice('The renderer constructed but could not create an <svg> root, so nothing can be painted.');
      renderer.dispose();
    } else {
      const rings: ArcRing[] = [
        new ArcRing(28, 3, '#3fbf8f', 4, 0.55),
        new ArcRing(52, 5, '#2f6fdf', 3, -0.38),
        new ArcRing(78, 8, '#8a6cf0', 2, 0.24),
        new ArcRing(104, 12, 'rgba(232, 178, 58, 0.65)', 1.5, -0.15),
      ];
      const dot = new PulseDot();
      const label = new Label('SVGRenderer — live DOM, no pixel buffer');

      const objects: Renderable2D[] = [...rings, dot, label];
      const scene = { children: objects };
      const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 1.6 };

      let fps = 0;
      let frames = 0;
      let elapsed = 0;

      renderer.setAnimationLoop((_time, delta) => {
        for (const ring of rings) ring.update(delta);
        dot.update(delta);

        frames++;
        elapsed += delta;
        if (elapsed >= 0.25) {
          fps = frames / elapsed;
          frames = 0;
          elapsed = 0;
        }

        renderer.render(scene, camera);

        const svg = renderer.svg;
        const nodes = svg ? svg.querySelectorAll('*').length : 0;
        const serialised = renderer.toSVGString();

        overlay.textContent =
          `FPS           ${fps.toFixed(0)}\n` +
          `backend       ${renderer.backend}\n` +
          `draw calls    ${renderer.stats.drawCalls}\n` +
          `svg nodes     ${nodes}\n` +
          `markup        ${serialised ? `${(serialised.length / 1024).toFixed(1)} kB` : 'n/a'}\n` +
          `viewBox       ${svg ? svg.getAttribute('viewBox') : 'n/a'}`;
      }, { autoStart: true });

      dispose = (): void => {
        renderer.setAnimationLoop(null);
        // Removes the wrapper <div> and drops the world/defs references.
        renderer.dispose();
      };
    }
  }
}

window.addEventListener('beforeunload', dispose);
