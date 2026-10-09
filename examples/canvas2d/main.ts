/**
 * The Canvas2D painter — immediate-mode drawing without a scene graph.
 *
 * What it shows
 * -------------
 * `Canvas2DPainter` is the raw surface the Canvas2D backend hands to every
 * renderable, but it is also usable on its own. This example drives it directly and
 * outside the render loop, which is the right shape for a chart, a HUD or a
 * one-shot export.
 *
 * Covered here: `save`/`restore` and `depth` (the state-stack balance),
 * `beginPath`/`moveTo`/`lineTo`/`bezierCurveTo`/`arc`/`closePath`, `rect`,
 * `roundRect`, `ellipse`, `polygon`, `fill`/`stroke`, `setLineDash`, `clip`,
 * `createLinearGradient`/`createRadialGradient`/`createConicGradient`,
 * `fillText`/`measureText`/`strokeText`, `shadowBlur`/`shadowColor`/`shadowOffsetX`,
 * and `fillStyle`/`strokeStyle` accepting gradients as well as strings.
 *
 * What to look for
 * ----------------
 * A layered composition that redraws only when it must: gradient sky, a dashed
 * orbit, a clipped inner disc, a shadowed rounded panel with measured text, and a
 * polygon. The overlay reports the painter's live state-stack depth, which must
 * return to `0` after every frame.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  Color,
  detectBackendStrict,
  type BackendName,
  type Canvas2DPainter,
} from '../../src/index';

/* -------------------------------------------------------------------------- */
/* Scene drawing                                                              */
/* -------------------------------------------------------------------------- */

/** Draws one full frame with the painter, in logical pixels. */
function drawScene(
  painter: Canvas2DPainter,
  width: number,
  height: number,
  timeSeconds: number,
): void {
  const cx = width / 2;
  const cy = height / 2;
  const scale = Math.min(width, height);

  painter.resetTransform();

  // --- background: a linear gradient ---------------------------------------
  const sky = painter.createLinearGradient(0, 0, 0, height);
  if (sky) {
    sky.addColorStop(0, '#101827');
    sky.addColorStop(0.55, '#16202f');
    sky.addColorStop(1, '#0d1017');
    painter.fillStyle = sky;
  } else {
    painter.fillStyle = '#11151d';
  }
  painter.fillRect(0, 0, width, height);

  // --- dashed orbit ring ----------------------------------------------------
  painter.save();
  painter.setLineDash([6, 8]);
  painter.lineWidth = 1;
  painter.strokeStyle = 'rgba(120, 160, 220, 0.35)';
  painter.beginPath();
  painter.arc(cx, cy, scale * 0.36, 0, Math.PI * 2);
  painter.stroke();
  painter.restore();

  // --- clipped inner disc ---------------------------------------------------
  painter.save();
  painter.beginPath();
  painter.arc(cx, cy, scale * 0.19, 0, Math.PI * 2);
  painter.clip();
  const disc = painter.createRadialGradient(cx - scale * 0.05, cy - scale * 0.05, 2, cx, cy, scale * 0.22);
  painter.fillStyle = disc ?? '#2f6fdf';
  painter.fillRect(cx - scale * 0.22, cy - scale * 0.22, scale * 0.44, scale * 0.44);

  // A conic sweep inside the same clip, to show stacking.
  const sweep = painter.createConicGradient(cx, cy, timeSeconds * 0.6);
  if (sweep) {
    sweep.addColorStop(0, 'rgba(63, 191, 143, 0.9)');
    sweep.addColorStop(0.5, 'rgba(63, 191, 143, 0)');
    sweep.addColorStop(1, 'rgba(63, 191, 143, 0.9)');
    painter.fillStyle = sweep;
    painter.fillRect(cx - scale * 0.2, cy - scale * 0.2, scale * 0.4, scale * 0.4);
  }
  painter.restore();

  // --- orbiting satellites, one per ellipse --------------------------------
  for (let i = 0; i < 3; i++) {
    const angle = timeSeconds * (0.5 + i * 0.22) + i * 2.1;
    const radius = scale * (0.24 + i * 0.075);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius * 0.42;

    painter.save();
    painter.shadowBlur = 18;
    painter.shadowColor = 'rgba(232, 178, 58, 0.75)';
    painter.beginPath();
    painter.arc(x, y, scale * 0.017, 0, Math.PI * 2);
    painter.fillStyle = '#e8b23a';
    painter.fill();
    painter.restore();
  }

  // --- a polygon by hand ----------------------------------------------------
  painter.save();
  painter.translate(cx, cy - scale * 0.3);
  painter.rotate(timeSeconds * 0.25);
  const hexagon: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
    hexagon.push({ x: Math.cos(angle) * scale * 0.055, y: Math.sin(angle) * scale * 0.055 });
  }
  painter.polygon(hexagon, true);
  painter.fillStyle = 'rgba(63, 191, 143, 0.28)';
  painter.fill();
  painter.lineWidth = 2;
  painter.strokeStyle = '#3fbf8f';
  painter.stroke();
  painter.restore();

  // --- a shadowed panel with measured text ---------------------------------
  const label = 'Canvas2DPainter';
  painter.font = '600 15px ui-monospace, Menlo, Consolas, monospace';
  const metrics = painter.measureText(label);
  const paddingX = 14;
  const paddingY = 10;
  const panelWidth = metrics.width + paddingX * 2;
  const panelHeight = 34;
  const panelX = cx - panelWidth / 2;
  const panelY = height - panelHeight - 22;

  painter.save();
  painter.shadowBlur = 22;
  painter.shadowColor = 'rgba(0, 0, 0, 0.65)';
  painter.shadowOffsetY = 4;
  painter.beginPath();
  painter.roundRect(panelX, panelY, panelWidth, panelHeight, 9);
  painter.fillStyle = 'rgba(12, 16, 23, 0.92)';
  painter.fill();
  painter.restore();

  painter.save();
  painter.beginPath();
  painter.roundRect(panelX, panelY, panelWidth, panelHeight, 9);
  painter.lineWidth = 1;
  painter.strokeStyle = 'rgba(120, 160, 220, 0.45)';
  painter.stroke();
  painter.restore();

  painter.fillStyle = '#e6edf3';
  painter.textBaseline = 'middle';
  painter.textAlign = 'left';
  painter.fillText(label, panelX + paddingX, panelY + panelHeight / 2 + 1);

  // A measured underline, to prove `measureText` reported something real.
  painter.lineWidth = 1;
  painter.strokeStyle = 'rgba(63, 191, 143, 0.8)';
  painter.beginPath();
  painter.moveTo(panelX + paddingX, panelY + panelHeight - 7);
  painter.lineTo(panelX + paddingX + metrics.width, panelY + panelHeight - 7);
  painter.stroke();

  // Sanity: an unresolved colour string never reaches the painter.
  painter.fillStyle = new Color('#00000000').toCssString();
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
  const backend = detectBackendStrict(preferred, canvas);

  if (backend !== BackendNames.Canvas2D) {
    showNotice('This example needs a 2D canvas context, which this browser could not create.');
  } else {
    const renderer = new Canvas2DRenderer({ canvas, autoResize: true });
    const painter = renderer.painter;

    if (!painter.isReady) {
      showNotice('The renderer constructed but did not obtain a usable 2D context.');
    } else {
      let frames = 0;
      let elapsed = 0;
      let fps = 0;
      let peakDepth = 0;

      renderer.setAnimationLoop((timeMs, delta) => {
        const ratio = window.devicePixelRatio || 1;
        const context = painter.getContext();
        const width = context ? context.canvas.width / ratio : renderer.width;
        const height = context ? context.canvas.height / ratio : renderer.height;

        drawScene(painter, Math.max(1, width), Math.max(1, height), timeMs / 1000);

        // `depth` is the live save/restore balance; a leak here is a real bug, so
        // the overlay surfaces the high-water mark.
        peakDepth = Math.max(peakDepth, painter.depth);

        frames++;
        elapsed += delta;
        if (elapsed >= 0.25) {
          fps = frames / elapsed;
          frames = 0;
          elapsed = 0;
        }

        overlay.textContent =
          `FPS          ${fps.toFixed(0)}\n` +
          `backend      ${renderer.backend}\n` +
          `canvas       ${Math.round(width)}×${Math.round(height)}\n` +
          `state depth  ${painter.depth} (peak ${peakDepth})\n` +
          `draw calls   ${painter.commandCount}`;
      }, { autoStart: true });

      dispose = (): void => {
        renderer.setAnimationLoop(null);
        renderer.dispose();
      };
    }
  }
}

window.addEventListener('beforeunload', dispose);
