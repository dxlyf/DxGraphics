/**
 * Text — measuring, aligning and laying out glyphs on the Canvas2D backend.
 *
 * Read this first
 * ---------------
 * **`src/text/` is an empty directory in this checkout**: there is no `Font`,
 * `GlyphAtlas`, `TextLayout` or SDF text. What does exist and is demonstrated here is
 * the text surface the renderer actually provides:
 *
 * - `Canvas2DPainter.fillText(text, x, y, maxWidth?)` and `strokeText(...)`;
 * - `Canvas2DPainter.measureText(text)` -> `{ width, actualBoundingBoxAscent?,
 *   actualBoundingBoxDescent?, native? }`, which is what layout needs;
 * - the style accessors `font`, `textAlign` and `textBaseline`;
 * - `Text2D`, the real scene node in `src/scene/2d/Text2D.ts`, whose `measure(painter)`
 *   and `getLines()` show how the 2D scene layer models the same problem.
 *
 * `main.ts` builds a small word-wrap engine from `measureText` alone, then shows the
 * three `textAlign` values and the five `textBaseline` values on a shared ruler so
 * their meanings are unambiguous.
 *
 * What to look for
 * ----------------
 * A wrapped paragraph inside a measured column, a heading using a different baseline,
 * a struck-through label (`strokeText` under `fillText`), and a live table of the
 * metrics `measureText` reported for each style. The wrap width in the overlay is the
 * measured line width, not an estimate.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  detectBackendStrict,
  type BackendName,
  type Canvas2DPainter,
  type Renderable2D,
} from '../../src/index';

/* -------------------------------------------------------------------------- */
/* A tiny layout engine built on measureText                                  */
/* -------------------------------------------------------------------------- */

/** One laid-out line: the text plus its measured width. */
interface LaidOutLine {
  readonly text: string;
  readonly width: number;
}

/**
 * Greedy word wrap driven entirely by the painter's own metrics.
 *
 * A word longer than `maxWidth` is emitted on its own line rather than split, which
 * is the conventional behaviour and keeps this short.
 */
function wrapText(painter: Canvas2DPainter, text: string, maxWidth: number): LaidOutLine[] {
  const lines: LaidOutLine[] = [];
  let current = '';

  for (const word of text.split(/\s+/)) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    const width = painter.measureText(candidate).width;
    if (width <= maxWidth || current.length === 0) {
      current = candidate;
      continue;
    }
    lines.push({ text: current, width: painter.measureText(current).width });
    current = word;
  }

  if (current.length > 0) lines.push({ text: current, width: painter.measureText(current).width });
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Renderables                                                                */
/* -------------------------------------------------------------------------- */

const PARAGRAPH =
  'The Canvas2D backend exposes the platform text stack directly: font, textAlign and ' +
  'textBaseline are the context properties, and measureText is the only source of ' +
  'layout truth. A text layer is not implemented in this checkout, so the wrap below ' +
  'is computed from those metrics — no character-count guesses.';

/** A wrapped paragraph inside a measured column, with a baseline ruler. */
class Paragraph implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  /** Width of the widest laid-out line, in logical pixels. */
  public widest = 0;
  /** Number of laid-out lines. */
  public lineCount = 0;

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.resetTransform();
    const ratio = window.devicePixelRatio || 1;
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    const marginX = 26;
    const top = 76;
    const columnWidth = 380;

    p.font = '14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    p.textAlign = 'left';
    p.textBaseline = 'alphabetic';

    const lines = wrapText(p, PARAGRAPH, columnWidth);
    const lineHeight = 21;

    // Column panel + border, so the measured column is visible.
    p.beginPath();
    p.roundRect(marginX - 12, top - 26, columnWidth + 24, lines.length * lineHeight + 34, 9);
    p.fillStyle = 'rgba(255, 255, 255, 0.035)';
    p.fill();
    p.lineWidth = 1;
    p.strokeStyle = 'rgba(120, 160, 220, 0.28)';
    p.stroke();

    p.fillStyle = '#e6edf3';
    for (let i = 0; i < lines.length; i++) {
      const baseline = top + i * lineHeight;
      p.fillText(lines[i].text, marginX, baseline);

      // A faint baseline rule makes the line box legible.
      p.lineWidth = 1;
      p.strokeStyle = 'rgba(120, 160, 220, 0.16)';
      p.beginPath();
      p.moveTo(marginX, baseline + 0.5);
      p.lineTo(marginX + lines[i].width, baseline + 0.5);
      p.stroke();
    }

    this.widest = lines.reduce((max, line) => Math.max(max, line.width), 0);
    this.lineCount = lines.length;

    // Column width guide, drawn at the wrap limit.
    p.setLineDash([4, 5]);
    p.lineWidth = 1;
    p.strokeStyle = 'rgba(232, 178, 58, 0.7)';
    p.beginPath();
    p.moveTo(marginX + columnWidth, top - 26);
    p.lineTo(marginX + columnWidth, top + lines.length * lineHeight + 8);
    p.stroke();
    p.setLineDash([]);

    p.font = '11px ui-monospace, Menlo, Consolas, monospace';
    p.fillStyle = '#e8b23a';
    p.fillText(`wrap limit ${columnWidth}px`, marginX + columnWidth - 108, top - 32);
  }
}

/** Alignment and baseline samples drawn against a shared ruler. */
class AlignmentShowcase implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  /** Metrics gathered this frame, for the overlay. */
  public readonly metrics: { label: string; a: number; d: number; w: number }[] = [];

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.resetTransform();
    const ratio = window.devicePixelRatio || 1;
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    const originX = 560;
    const originY = 110;
    this.metrics.length = 0;

    p.font = '600 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    p.fillStyle = '#93a1b1';
    p.textAlign = 'left';
    p.textBaseline = 'alphabetic';
    p.fillText('textAlign', originX, originY - 46);

    // A shared vertical ruler at originX, so each alignment is readable.
    p.lineWidth = 1;
    p.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    p.beginPath();
    p.moveTo(originX, originY - 30);
    p.lineTo(originX, originY + 74);
    p.stroke();

    const alignments: CanvasTextAlign[] = ['left', 'center', 'right'];
    for (let i = 0; i < alignments.length; i++) {
      const baseline = originY + i * 30;
      p.textAlign = alignments[i];
      p.textBaseline = 'alphabetic';
      p.font = '14px ui-monospace, Menlo, Consolas, monospace';
      p.fillStyle = '#2f9fe0';
      p.fillText(`align: ${alignments[i]}`, originX, baseline);
    }

    p.textAlign = 'left';
    p.font = '600 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    p.fillStyle = '#93a1b1';
    p.fillText('textBaseline', originX, originY + 118);

    const baselines: CanvasTextBaseline[] = ['top', 'middle', 'bottom', 'alphabetic', 'hanging'];
    for (let i = 0; i < baselines.length; i++) {
      const baseline = originY + 150 + i * 28;
      p.textAlign = 'left';
      p.textBaseline = baselines[i];
      p.font = '14px ui-monospace, Menlo, Consolas, monospace';
      p.fillStyle = '#3fbf8f';
      p.fillText(`baseline: ${baselines[i]}`, originX + 12, baseline);

      if (baselines[i] === 'alphabetic') {
        // The anchor line itself, for reference.
        p.lineWidth = 1;
        p.strokeStyle = 'rgba(63, 191, 143, 0.5)';
        p.beginPath();
        p.moveTo(originX, baseline + 0.5);
        p.lineTo(originX + 220, baseline + 0.5);
        p.stroke();
      }
    }

    /* ------------------------------------------------------ measurements */
    const samples: { label: string; font: string; text: string }[] = [
      { label: '12px sans', font: '12px ui-sans-serif, system-ui, sans-serif', text: 'Hamburgefonstiv' },
      { label: '14px sans', font: '14px ui-sans-serif, system-ui, sans-serif', text: 'Hamburgefonstiv' },
      { label: 'bold 18px', font: '700 18px ui-sans-serif, system-ui, sans-serif', text: 'Hamburgefonstiv' },
      { label: '12px mono', font: '12px ui-monospace, Menlo, Consolas, monospace', text: 'Hamburgefonstiv' },
      { label: 'italic serif', font: 'italic 16px ui-serif, Georgia, serif', text: 'Hamburgefonstiv' },
    ];

    p.textAlign = 'left';
    p.textBaseline = 'alphabetic';
    p.fillStyle = '#93a1b1';
    p.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    p.fillText('measureText', originX, originY + 320);

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const baseline = originY + 348 + i * 24;
      p.font = sample.font;
      const measured = p.measureText(sample.text);

      const ascent = measured.actualBoundingBoxAscent ?? 0;
      const descent = measured.actualBoundingBoxDescent ?? 0;
      this.metrics.push({ label: sample.label, a: ascent, d: descent, w: measured.width });

      p.fillStyle = '#e6edf3';
      p.fillText(sample.text, originX, baseline);

      p.fillStyle = '#c9d4e0';
      p.font = '11px ui-monospace, Menlo, Consolas, monospace';
      p.fillText(
        `${sample.label.padEnd(11)} w=${measured.width.toFixed(1).padStart(6)} ` +
          `a=${ascent.toFixed(0).padStart(3)} d=${descent.toFixed(0).padStart(3)}`,
        originX + 140,
        baseline,
      );
    }

    /* ------------------------------------------- filled + stroked, one label */
    p.font = '600 22px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    p.textAlign = 'left';
    p.textBaseline = 'alphabetic';

    const labelText = 'fillText + strokeText';
    const labelX = 26;
    const labelY = 70;

    p.lineWidth = 4;
    p.strokeStyle = 'rgba(63, 191, 143, 0.85)';
    p.strokeText(labelText, labelX, labelY);

    p.fillStyle = '#0d1017';
    p.fillText(labelText, labelX, labelY);

    // A maxWidth-clamped draw, to show the optional fourth argument.
    p.font = '13px ui-monospace, Menlo, Consolas, monospace';
    p.fillStyle = '#93a1b1';
    p.fillText('fillText(..., maxWidth) condenses instead of clipping:', labelX, labelY + 24);
    p.fillStyle = '#2f6fdf';
    p.fillText('CONDENSED-BY-MAXWIDTH-ARGUMENT', labelX, labelY + 44, 220);
  }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');

function showNotice(message: string): void {
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  if (overlay) overlay.textContent = 'backend unavailable';
}

let dispose = (): void => undefined;

if (!canvas || !overlay) {
  showNotice('This example needs the #stage canvas and the #overlay element to exist.');
} else {
  const preferred: BackendName[] = [BackendNames.Canvas2D];
  if (detectBackendStrict(preferred, canvas) !== BackendNames.Canvas2D) {
    showNotice('This example needs a 2D canvas context, which this browser could not create.');
  } else {
    const renderer = new Canvas2DRenderer({ canvas, clearColor: '#11151d', autoResize: true });

    const paragraph = new Paragraph();
    const showcase = new AlignmentShowcase();
    const scene = { children: [paragraph, showcase] as Renderable2D[] };
    // No camera: text is laid out in logical pixels, so the identity transform is
    // what a text layer wants. The renderables reset the transform anyway.
    const camera = null;

    let fps = 0;
    let frames = 0;
    let elapsed = 0;

    renderer.setAnimationLoop((_time, delta) => {
      frames++;
      elapsed += delta;
      if (elapsed >= 0.25) {
        fps = frames / elapsed;
        frames = 0;
        elapsed = 0;
      }

      renderer.render(scene, camera);

      const firstMetric = showcase.metrics[0];
      overlay.textContent =
        `FPS          ${fps.toFixed(0)}\n` +
        `backend      ${renderer.backend}\n` +
        `lines        ${paragraph.lineCount}\n` +
        `longest line ${paragraph.widest.toFixed(1)} px\n` +
        `samples      ${showcase.metrics.length}\n` +
        `first sample ${firstMetric ? `${firstMetric.w.toFixed(1)} px wide, ascent ${firstMetric.a.toFixed(0)}` : 'n/a'}`;
    }, { autoStart: true });

    dispose = (): void => {
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  }
}

window.addEventListener('beforeunload', dispose);
