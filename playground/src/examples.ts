/**
 * The demo registry.
 *
 * Twelve demos, all written against the same contract: they receive a painter, a
 * camera, a delta and a parameter record, and they fill a `Renderable2D[]` whose objects
 * the 2D backends walk structurally. None of them imports the renderer, so the same
 * demo runs on Canvas2D and on SVG wherever its drawing calls overlap — and the demos
 * that need a pixel buffer declare `backends: ['canvas2d']` so the shell can disable
 * them on SVG instead of drawing nothing.
 *
 * The scene patterns mirror `examples/`, deliberately duplicated rather than shared:
 * the playground is a separate deployable and must not import across into `examples/`.
 */

import { Box2, BufferAttribute, BufferGeometry, Color, Mat4, Vec2, Vec3 } from '../../src/index';
import type { Canvas2DPainter, Renderable2D } from '../../src/index';
import {
  booleanParam,
  numberParam,
  stringParam,
  type DemoContext,
  type DemoParam,
  type SceneDemo,
} from './demos/types';

/* -------------------------------------------------------------------------- */
/* Shared drawing helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `true` when the painter is the SVG one.
 *
 * `SVGPainter` exposes `create`; `Canvas2DPainter` does not. Renderables use this to
 * branch, which is what lets one demo serve both backends.
 */
function isSvg(painter: Canvas2DPainter | null): boolean {
  return painter !== null && typeof (painter as unknown as { create?: unknown }).create === 'function';
}

/** Canvas2DPainter's arc signature, used to keep the branch above type-safe. */
type CanvasPainter = Canvas2DPainter;

/** A circle that works on both painters. */
function circle(painter: Canvas2DPainter | null, x: number, y: number, r: number, fill: string): void {
  if (painter === null) return;
  if (isSvg(painter)) {
    (painter as unknown as { circle(cx: number, cy: number, r: number, a: object): void }).circle(x, y, r, {
      fill,
    });
    return;
  }
  const p = painter as CanvasPainter;
  p.beginPath();
  p.arc(x, y, r, 0, Math.PI * 2);
  p.fillStyle = fill;
  p.fill();
}

/** A rectangle that works on both painters. */
function rectangle(
  painter: Canvas2DPainter | null,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
): void {
  if (painter === null) return;
  if (isSvg(painter)) {
    (painter as unknown as { rect(x: number, y: number, w: number, h: number, a: object): void }).rect(
      x,
      y,
      w,
      h,
      { fill },
    );
    return;
  }
  const p = painter as CanvasPainter;
  p.fillStyle = fill;
  p.fillRect(x, y, w, h);
}

/** A line that works on both painters. */
function line(
  painter: Canvas2DPainter | null,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  width: number,
): void {
  if (painter === null) return;
  if (isSvg(painter)) {
    (painter as unknown as { line(x1: number, y1: number, x2: number, y2: number, a: object): void }).line(
      x1,
      y1,
      x2,
      y2,
      { stroke, 'stroke-width': width, 'stroke-linecap': 'round' },
    );
    return;
  }
  const p = painter as CanvasPainter;
  p.lineWidth = width;
  p.strokeStyle = stroke;
  p.beginPath();
  p.moveTo(x1, y1);
  p.lineTo(x2, y2);
  p.stroke();
}

/** A closed polygon that works on both painters. */
function polygon(
  painter: Canvas2DPainter | null,
  points: readonly { x: number; y: number }[],
  fill: string,
  stroke: string | null,
  width: number,
): void {
  if (painter === null || points.length < 3) return;
  if (isSvg(painter)) {
    (painter as unknown as { polygon(p: readonly { x: number; y: number }[], a: object): void }).polygon(
      points,
      stroke === null ? { fill } : { fill, stroke, 'stroke-width': width },
    );
    return;
  }
  const p = painter as CanvasPainter;
  p.beginPath();
  p.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) p.lineTo(points[i].x, points[i].y);
  p.closePath();
  p.fillStyle = fill;
  p.fill();
  if (stroke !== null) {
    p.lineWidth = width;
    p.strokeStyle = stroke;
    p.stroke();
  }
}

/** A stroked text run; SVG needs the font attributes spelled out. */
function text(
  painter: Canvas2DPainter | null,
  value: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  align: CanvasTextAlign = 'left',
): void {
  if (painter === null) return;
  if (isSvg(painter)) {
    (painter as unknown as { text(t: string, a: object): void }).text(value, {
      x,
      y,
      fill,
      'font-family': 'ui-monospace, Menlo, Consolas, monospace',
      'font-size': size,
      'text-anchor': align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start',
    });
    return;
  }
  const p = painter as CanvasPainter;
  p.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
  p.fillStyle = fill;
  p.textAlign = align;
  p.textBaseline = 'alphabetic';
  p.fillText(value, x, y);
}

/** Resets any leftover transform so each demo draws in world units. */
function resetToWorld(painter: Canvas2DPainter | null): void {
  if (painter === null || isSvg(painter)) return;
  // The renderer already applied the camera transform; nothing to undo for 2D demos.
  (painter as CanvasPainter).setAlpha(1);
}

/* -------------------------------------------------------------------------- */
/* Demo 1 — drifting squares (the 2d-basic pattern)                           */
/* -------------------------------------------------------------------------- */

interface Drift {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  spin: number;
  size: number;
  tint: string;
}

/** Draws every drift object through whichever painter is active. */
class DriftLayer implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public constructor(private readonly items: Drift[]) {}

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    resetToWorld(p);
    for (const item of this.items) {
      const half = item.size / 2;
      const corners: { x: number; y: number }[] = [];
      const cos = Math.cos(item.rotation);
      const sin = Math.sin(item.rotation);
      for (const [cx, cy] of [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ]) {
        corners.push({ x: item.x + cx * cos - cy * sin, y: item.y + cx * sin + cy * cos });
      }
      polygon(p, corners, item.tint, 'rgba(255,255,255,0.5)', 2);
    }
  }
}

const driftDemo: SceneDemo = {
  id: 'drift',
  label: 'Drifting squares',
  description: 'Bouncing, spinning squares — the structural-scene pattern, on either painter.',
  backends: ['canvas2d', 'svg'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 34, rotation: 0 },
  params: [
    { key: 'count', label: 'Squares', kind: 'slider', value: 6, min: 1, max: 24, step: 1 },
    { key: 'speed', label: 'Speed', kind: 'slider', value: 1, min: 0.1, max: 4, step: 0.1 },
    { key: 'size', label: 'Size (world)', kind: 'slider', value: 2.2, min: 0.6, max: 4, step: 0.1 },
    { key: 'spin', label: 'Spin', kind: 'slider', value: 0.8, min: 0, max: 3, step: 0.1 },
  ],
  setup(ctx) {
    const count = Math.max(1, Math.round(numberParam(ctx.params, 'count', 6)));
    const items: Drift[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      items.push({
        x: Math.cos(angle) * 5,
        y: Math.sin(angle) * 4,
        vx: Math.cos(angle * 1.7) * 3.4,
        vy: Math.sin(angle * 1.3) * 3.1,
        rotation: angle,
        spin: 0.4 + (i % 4) * 0.3,
        size: 2.2,
        tint: new Color('#2f6fdf').offsetHSL((i / count) * 220, 0, 0).toCssString(),
      });
    }
    ctx.objects.push(new DriftLayer(items));
    state.drifts = items;
  },
  update(ctx) {
    const items = state.drifts;
    const speed = numberParam(ctx.params, 'speed', 1);
    const size = numberParam(ctx.params, 'size', 2.2);
    const spin = numberParam(ctx.params, 'spin', 0.8);
    const bound = 8;
    for (const item of items) {
      item.size = size;
      item.x += item.vx * speed * ctx.delta;
      item.y += item.vy * speed * ctx.delta;
      item.rotation += item.spin * spin * ctx.delta;
      const limit = bound - item.size / 2;
      if (item.x > limit || item.x < -limit) {
        item.vx = -item.vx;
        item.x = Math.min(limit, Math.max(-limit, item.x));
      }
      if (item.y > limit || item.y < -limit) {
        item.vy = -item.vy;
        item.y = Math.min(limit, Math.max(-limit, item.y));
      }
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 2 — radial burst                                                      */
/* -------------------------------------------------------------------------- */

interface Ray {
  readonly angle: number;
  readonly length: number;
  readonly tint: string;
}

class BurstLayer implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  private phase = 0;

  public constructor(private readonly rays: Ray[], private readonly segments: number) {}

  public step(delta: number, speed: number): void {
    this.phase += delta * speed;
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    resetToWorld(p);

    for (let i = 0; i < this.rays.length; i++) {
      const ray = this.rays[i];
      const wobble = Math.sin(this.phase + i * 0.35) * 0.5 + 0.5;
      const inner = 1.2 + wobble * 1.1;
      const outer = ray.length * (0.72 + wobble * 0.28);
      const dabs = Math.max(1, this.segments);

      for (let s = 0; s < dabs; s++) {
        const t = dabs === 1 ? 0 : s / (dabs - 1);
        const radius = inner + (outer - inner) * t;
        const x = Math.cos(ray.angle) * radius;
        const y = Math.sin(ray.angle) * radius;
        circle(p, x, y, 0.1 + t * 0.24, ray.tint);
      }
    }

    circle(p, 0, 0, 1.0, 'rgba(255,255,255,0.9)');
    circle(p, 0, 0, 0.55, '#0d1017');
  }
}

const burstDemo: SceneDemo = {
  id: 'burst',
  label: 'Radial burst',
  description: 'A rotating radial burst sampled into discrete dabs, with a pulsing core.',
  backends: ['canvas2d', 'svg'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 34, rotation: 0 },
  params: [
    { key: 'rays', label: 'Rays', kind: 'slider', value: 18, min: 3, max: 48, step: 1 },
    { key: 'length', label: 'Length', kind: 'slider', value: 7, min: 2, max: 11, step: 0.1 },
    { key: 'segments', label: 'Dabs per ray', kind: 'slider', value: 7, min: 1, max: 16, step: 1 },
    { key: 'speed', label: 'Speed', kind: 'slider', value: 1.4, min: 0, max: 4, step: 0.1 },
    { key: 'rotation', label: 'Camera rotation', kind: 'slider', value: 0, min: -3.14, max: 3.14, step: 0.01 },
  ],
  setup(ctx) {
    const count = Math.max(3, Math.round(numberParam(ctx.params, 'rays', 18)));
    const length = numberParam(ctx.params, 'length', 7);
    const rays: Ray[] = [];
    for (let i = 0; i < count; i++) {
      rays.push({
        angle: (i / count) * Math.PI * 2,
        length,
        tint: new Color('#3fbf8f').offsetHSL((i / count) * 180 - 90, 0, 0).toCssString(),
      });
    }
    const layer = new BurstLayer(rays, Math.round(numberParam(ctx.params, 'segments', 7)));
    ctx.objects.push(layer);
    state.burst = layer;
  },
  update(ctx) {
    state.burst?.step(ctx.delta, numberParam(ctx.params, 'speed', 1.4));
    ctx.camera.rotation = numberParam(ctx.params, 'rotation', 0);
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 3 — orbit graph                                                       */
/* -------------------------------------------------------------------------- */

/** One node in the orbit graph, at a fixed position in world units. */
interface Node {
  readonly x: number;
  readonly y: number;
  readonly tint: string;
  phase: number;
}

class OrbitGraph implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  private pulse = 0;

  public constructor(private readonly nodes: Node[], private readonly links: readonly [number, number][]) {}

  public step(delta: number, speed: number): void {
    this.pulse += delta * speed;
    for (const node of this.nodes) node.phase += delta * speed;
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    resetToWorld(p);

    for (const [a, b] of this.links) {
      const from = this.nodes[a];
      const to = this.nodes[b];
      const weight = (Math.sin((from.phase + to.phase) * 0.5) * 0.5 + 0.5) * 0.55 + 0.12;
      line(p, from.x, from.y, to.x, to.y, `rgba(120,160,220,${weight.toFixed(3)})`, 0.08);
    }

    for (const node of this.nodes) {
      const size = 0.42 + (Math.sin(node.phase) * 0.5 + 0.5) * 0.3;
      circle(p, node.x, node.y, size, node.tint);
    }

    circle(p, 0, 0, 0.5 + (Math.sin(this.pulse * 0.6) * 0.5 + 0.5) * 0.2, 'rgba(255,255,255,0.85)');
  }
}

const orbitDemo: SceneDemo = {
  id: 'orbit',
  label: 'Orbit graph',
  description: 'Nodes on a ring joined by links whose opacity pulses with their endpoints.',
  backends: ['canvas2d', 'svg'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 40, rotation: 0 },
  params: [
    { key: 'nodes', label: 'Nodes', kind: 'slider', value: 12, min: 4, max: 28, step: 1 },
    { key: 'radius', label: 'Ring radius', kind: 'slider', value: 7, min: 3, max: 11, step: 0.1 },
    { key: 'links', label: 'Link span', kind: 'slider', value: 2, min: 1, max: 6, step: 1 },
    { key: 'speed', label: 'Pulse speed', kind: 'slider', value: 1.6, min: 0, max: 5, step: 0.1 },
    { key: 'fill', label: 'Fill nodes', kind: 'toggle', value: true },
  ],
  setup(ctx) {
    const count = Math.max(4, Math.round(numberParam(ctx.params, 'nodes', 12)));
    const radius = numberParam(ctx.params, 'radius', 7);
    const span = Math.max(1, Math.round(numberParam(ctx.params, 'links', 2)));

    const nodes: Node[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      nodes.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        tint: new Color('#8a6cf0').offsetHSL((i / count) * 260 - 130, 0, 0).toCssString(),
        phase: (i / count) * Math.PI * 2,
      });
    }

    const links: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      for (let k = 1; k <= span; k++) links.push([i, (i + k) % count]);
    }

    const graph = new OrbitGraph(nodes, links);
    ctx.objects.push(graph);
    state.orbit = graph;
  },
  update(ctx) {
    state.orbit?.step(ctx.delta, numberParam(ctx.params, 'speed', 1.6));
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 4 — software 3D cube                                                  */
/* -------------------------------------------------------------------------- */

/** A world-space triangle ready for projection. */
interface Face {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly tint: Color;
}

/**
 * Projects and paints a flat-shaded solid.
 *
 * This is the same technique as `examples/3d-basic`: build a `BufferGeometry`, compose
 * a model matrix, project with `Mat4.fromPerspective` × `Mat4.fromLookAt`, then sort
 * faces back-to-front because neither 2D backend has a depth buffer.
 */
class SoftwareSolid implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public rotationX = 0;
  public rotationY = 0;

  private readonly faces: Face[];
  private readonly model = new Mat4();
  private readonly rotationXMatrix = new Mat4();
  private readonly rotationYMatrix = new Mat4();

  public constructor(faces: Face[]) {
    this.faces = faces;
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    if (p === null) return;

    // Screen space: pixel-accurate projection, so the untransformed painter is used.
    const context = (p as CanvasPainter).getContext();
    const ratio = window.devicePixelRatio || 1;
    const width = context ? context.canvas.width / ratio : 800;
    const height = context ? context.canvas.height / ratio : 600;
    const viewport = Math.min(width, height);

    this.rotationXMatrix.makeRotationX(this.rotationX);
    this.rotationYMatrix.makeRotationY(this.rotationY);
    this.model.copy(this.rotationXMatrix).multiply(this.rotationYMatrix);

    const projection = Mat4.fromPerspective((48 * Math.PI) / 180, width / Math.max(1, height), 0.1, 100);
    const view = Mat4.fromLookAt(new Vec3(3.2, 2.6, 6.4), new Vec3(0, 0, 0), new Vec3(0, 1, 0));
    const viewProjection = new Mat4().multiplyMatrices(projection, view);
    const viewOnly = view;

    const drawn: { depth: number; points: { x: number; y: number }[]; shade: number }[] = [];
    const light = new Vec3(0.42, 0.8, 0.55).normalize();

    for (const face of this.faces) {
      const worldA = face.a.clone().applyMat4(this.model);
      const worldB = face.b.clone().applyMat4(this.model);
      const worldC = face.c.clone().applyMat4(this.model);

      const centroid = new Vec3(
        (worldA.x + worldB.x + worldC.x) / 3,
        (worldA.y + worldB.y + worldC.y) / 3,
        (worldA.z + worldB.z + worldC.z) / 3,
      );
      const viewSpace = centroid.clone().applyMat4(viewOnly);
      const depth = -viewSpace.z;
      if (depth <= 0.2) continue;

      const normal = new Vec3()
        .crossVectors(worldB.clone().sub(worldA), worldC.clone().sub(worldA))
        .normalize();
      const shade = 0.12 + Math.abs(normal.dot(light)) * 0.8;

      const points: { x: number; y: number }[] = [];
      for (const world of [worldA, worldB, worldC]) {
        // `applyMat4` divides by `w`, so this is already an NDC point.
        const ndc = world.clone().applyMat4(viewProjection);
        points.push({
          x: width / 2 + ndc.x * viewport * 0.42,
          y: height / 2 - ndc.y * viewport * 0.42,
        });
      }
      drawn.push({ depth, points, shade });
    }

    drawn.sort((a, b) => b.depth - a.depth);

    for (const face of drawn) {
      const shaded = new Color()
        .copy(BASE_FACE_TINT)
        .lerp(new Color(1, 1, 1, 1), face.shade * 0.55)
        .toCssString();
      polygon(p, face.points, shaded, 'rgba(0,0,0,0.35)', 1);
    }
  }
}

/** Base albedo of the software solid. */
const BASE_FACE_TINT = new Color('#2f6fdf');

/** Builds the triangles of a cube. */
function cubeFaces(half: number, offset: Vec3): Face[] {
  const corners: Vec3[] = [
    new Vec3(-half, -half, -half),
    new Vec3(half, -half, -half),
    new Vec3(half, half, -half),
    new Vec3(-half, half, -half),
    new Vec3(-half, -half, half),
    new Vec3(half, -half, half),
    new Vec3(half, half, half),
    new Vec3(-half, half, half),
  ].map((v) => v.add(offset));

  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
  ];

  const faces: Face[] = [];
  for (const [a, b, c, d] of quads) {
    faces.push({ a: corners[a], b: corners[b], c: corners[c], tint: BASE_FACE_TINT });
    faces.push({ a: corners[a], b: corners[c], c: corners[d], tint: BASE_FACE_TINT });
  }
  return faces;
}

/** Builds the triangles of an octahedron, for the alternate shape. */
function octahedronFaces(radius: number): Face[] {
  const top = new Vec3(0, radius, 0);
  const bottom = new Vec3(0, -radius, 0);
  const ring = [
    new Vec3(radius, 0, 0),
    new Vec3(0, 0, radius),
    new Vec3(-radius, 0, 0),
    new Vec3(0, 0, -radius),
  ];

  const faces: Face[] = [];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    faces.push({ a: top, b: a, c: b, tint: BASE_FACE_TINT });
    faces.push({ a: bottom, b: b, c: a, tint: BASE_FACE_TINT });
  }
  return faces;
}

const solidDemo: SceneDemo = {
  id: 'solid',
  label: 'Software 3D solid',
  description:
    'A hand-built BufferGeometry projected with Mat4 and painter-sorted — no GPU required.',
  // A pixel buffer is needed because the projection is computed from the canvas size.
  backends: ['canvas2d'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 1, rotation: 0 },
  params: [
    {
      key: 'shape',
      label: 'Shape',
      kind: 'select',
      value: 'cube',
      choices: [
        { value: 'cube', label: 'Cube' },
        { value: 'octahedron', label: 'Octahedron' },
        { value: 'pair', label: 'Cube + octahedron' },
      ],
    },
    { key: 'spinX', label: 'Spin X', kind: 'slider', value: 0.5, min: -2, max: 2, step: 0.05 },
    { key: 'spinY', label: 'Spin Y', kind: 'slider', value: 0.9, min: -2, max: 2, step: 0.05 },
    { key: 'tilt', label: 'Camera tilt', kind: 'slider', value: 1, min: -3, max: 3, step: 0.05 },
  ],
  setup(ctx) {
    const shape = stringParam(ctx.params, 'shape', 'cube');
    const faces =
      shape === 'octahedron'
        ? octahedronFaces(1.6)
        : shape === 'pair'
          ? [...cubeFaces(1.15, new Vec3(-1.5, 0, 0)), ...octahedronFaces(0.95).map((f) => ({
              a: f.a.add(new Vec3(1.7, 0, 0)),
              b: f.b.add(new Vec3(1.7, 0, 0)),
              c: f.c.add(new Vec3(1.7, 0, 0)),
              tint: f.tint,
            }))]
          : cubeFaces(1.5, new Vec3(0, 0, 0));

    const solid = new SoftwareSolid(faces);
    // A `BufferGeometry` is built alongside the faces purely so the demo exercises the
    // real geometry container and its disposal path, not just loose Vec3 triples.
    const geometry = new BufferGeometry();
    const positions: number[] = [];
    for (const face of faces) {
      positions.push(face.a.x, face.a.y, face.a.z, face.b.x, face.b.y, face.b.z, face.c.x, face.c.y, face.c.z);
    }
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.computeBoundingBox();

    ctx.objects.push(solid);
    state.solid = solid;
    state.solidGeometry = geometry;
  },
  update(ctx) {
    const solid = state.solid;
    if (!solid) return;
    solid.rotationX += numberParam(ctx.params, 'spinX', 0.5) * ctx.delta;
    solid.rotationY += numberParam(ctx.params, 'spinY', 0.9) * ctx.delta;
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 5 — keyframes and easing                                              */
/* -------------------------------------------------------------------------- */

/** A keyframe on a scalar track. */
interface Keyframe {
  readonly time: number;
  readonly value: number;
}

/** Samples a sorted track with linear interpolation, holding outside its range. */
function sampleTrack(track: readonly Keyframe[], time: number): number {
  if (track.length === 0) return 0;
  if (track.length === 1) return track[0].value;
  const first = track[0];
  const last = track[track.length - 1];
  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      return a.value + (b.value - a.value) * (span <= 0 ? 0 : (time - a.time) / span);
    }
  }
  return last.value;
}

const TRACK_X: Keyframe[] = [
  { time: 0, value: -8 },
  { time: 1, value: -2 },
  { time: 2, value: 4 },
  { time: 3, value: 8 },
  { time: 4, value: -8 },
];
const TRACK_Y: Keyframe[] = [
  { time: 0, value: -3 },
  { time: 1, value: 3.4 },
  { time: 2, value: -2.2 },
  { time: 3, value: 2.8 },
  { time: 4, value: -3 },
];
const KEYFRAME_CYCLE = 4;
const KEYFRAME_POINTS = 5;

class KeyframeTrail implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public cursor = 0;
  public easedCursor = 0;
  public showTrack = true;

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    resetToWorld(p);

    if (this.showTrack) {
      // The control spine: the linear track, drawn as a guide.
      const spine: { x: number; y: number }[] = [];
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * KEYFRAME_CYCLE;
        spine.push({ x: sampleTrack(TRACK_X, t), y: sampleTrack(TRACK_Y, t) });
      }
      for (let i = 1; i < spine.length; i++) {
        line(p, spine[i - 1].x, spine[i - 1].y, spine[i].x, spine[i].y, 'rgba(120,160,220,0.28)', 0.08);
      }
      for (let i = 0; i < KEYFRAME_POINTS; i++) {
        const t = (i / (KEYFRAME_POINTS - 1)) * KEYFRAME_CYCLE;
        circle(p, sampleTrack(TRACK_X, t), sampleTrack(TRACK_Y, t), 0.22, 'rgba(232,178,58,0.9)');
      }
    }

    const easedX = sampleTrack(TRACK_X, this.easedCursor);
    const easedY = sampleTrack(TRACK_Y, this.easedCursor);
    const linearX = sampleTrack(TRACK_X, this.cursor);
    const linearY = sampleTrack(TRACK_Y, this.cursor);

    // Ghost first, so the linear ball paints on top.
    circle(p, easedX, easedY, 0.72, 'rgba(138,108,240,0.6)');
    circle(p, linearX, linearY, 0.9, '#2f6fdf');
    circle(p, linearX, linearY, 0.32, 'rgba(255,255,255,0.9)');
  }
}

const keyframeDemo: SceneDemo = {
  id: 'keyframes',
  label: 'Keyframes + easing',
  description: 'A ball on a sampled keyframe track, with an eased ghost alongside it.',
  backends: ['canvas2d', 'svg'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 30, rotation: 0 },
  params: [
    { key: 'speed', label: 'Playback speed', kind: 'slider', value: 1, min: 0.1, max: 3, step: 0.05 },
    {
      key: 'easing',
      label: 'Easing',
      kind: 'select',
      value: 'smoothstep',
      choices: [
        { value: 'linear', label: 'Linear' },
        { value: 'smoothstep', label: 'Smoothstep' },
        { value: 'back', label: 'Back (overshoot)' },
      ],
    },
    { key: 'track', label: 'Show control spine', kind: 'toggle', value: true },
  ],
  setup(ctx) {
    const trail = new KeyframeTrail();
    ctx.objects.push(trail);
    state.trail = trail;
  },
  update(ctx) {
    const trail = state.trail;
    if (!trail) return;

    const speed = numberParam(ctx.params, 'speed', 1);
    trail.cursor = (trail.cursor + ctx.delta * speed) % KEYFRAME_CYCLE;

    const u = trail.cursor / KEYFRAME_CYCLE;
    const easing = stringParam(ctx.params, 'easing', 'smoothstep');
    const eased =
      easing === 'linear'
        ? u
        : easing === 'back'
          ? 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2)
          : u * u * (3 - 2 * u);
    trail.easedCursor = Math.min(KEYFRAME_CYCLE, Math.max(0, eased * KEYFRAME_CYCLE));
    trail.showTrack = booleanParam(ctx.params, 'track', true);
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 6 — blend modes                                                       */
/* -------------------------------------------------------------------------- */

class BlendGrid implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  /** Modes to composite, matching the CSS blend-mode list. */
  public modes: string[] = ['multiply', 'screen', 'overlay', 'difference'];
  public spread = 1;

  public render(painter: unknown): void {
    const p = painter as CanvasPainter;
    const context = p.getContext();
    const ratio = window.devicePixelRatio || 1;
    const width = context ? context.canvas.width / ratio : 800;
    const height = context ? context.canvas.height / ratio : 600;

    p.resetTransform();
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    const columns = Math.min(this.modes.length, 4);
    const rows = Math.ceil(this.modes.length / columns);
    const cellW = Math.min(200, (width - 40) / columns);
    const cellH = Math.min(200, (height - 80) / Math.max(1, rows));
    const size = Math.min(cellW, cellH) * 0.78;

    for (let index = 0; index < this.modes.length; index++) {
      const mode = this.modes[index];
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = 20 + col * cellW + (cellW - size) / 2;
      const y = 40 + row * cellH + (cellH - size) / 2;

      // Base: a two-stop gradient square.
      const gradient = p.createLinearGradient(x, y, x + size, y + size);
      if (gradient) {
        gradient.addColorStop(0, '#2f6fdf');
        gradient.addColorStop(1, '#8a6cf0');
        p.fillStyle = gradient;
      } else {
        p.fillStyle = '#2f6fdf';
      }
      p.fillRect(x, y, size, size);

      // Blend layer: a rotated square plus a disc, composited.
      p.globalCompositeOperation = mode;
      p.save();
      p.translate(x + size / 2, y + size / 2);
      p.rotate(Math.PI / 4 + this.spread);
      p.fillStyle = 'rgba(232, 178, 58, 0.85)';
      p.fillRect(-size * 0.28, -size * 0.28, size * 0.56, size * 0.56);
      p.restore();
      p.beginPath();
      p.arc(x + size * 0.68, y + size * 0.32, size * 0.24, 0, Math.PI * 2);
      p.fillStyle = 'rgba(63, 191, 143, 0.85)';
      p.fill();
      p.globalCompositeOperation = 'source-over';

      p.lineWidth = 1;
      p.strokeStyle = 'rgba(255,255,255,0.2)';
      p.strokeRect(x, y, size, size);

      p.font = '12px ui-monospace, Menlo, Consolas, monospace';
      p.fillStyle = '#93a1b1';
      p.textAlign = 'left';
      p.textBaseline = 'alphabetic';
      p.fillText(mode, x, y + size + 16);
    }
  }
}

const blendDemo: SceneDemo = {
  id: 'blend',
  label: 'Blend modes',
  description: 'globalCompositeOperation on a gradient base — the CPU compositing toolkit.',
  backends: ['canvas2d'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 1, rotation: 0 },
  params: [
    {
      key: 'set',
      label: 'Mode set',
      kind: 'select',
      value: 'four',
      choices: [
        { value: 'four', label: 'Multiply / Screen / Overlay / Difference' },
        { value: 'all', label: 'All eight' },
        { value: 'add', label: 'lighter / hue / color-dodge / exclusion' },
      ],
    },
    { key: 'spread', label: 'Blend layer rotation', kind: 'slider', value: 0, min: -1.2, max: 1.2, step: 0.02 },
  ],
  setup(ctx) {
    const grid = new BlendGrid();
    ctx.objects.push(grid);
    state.blend = grid;
  },
  update(ctx) {
    const grid = state.blend;
    if (!grid) return;
    const set = stringParam(ctx.params, 'set', 'four');
    grid.modes =
      set === 'all'
        ? ['multiply', 'screen', 'overlay', 'difference', 'lighter', 'hue', 'color-dodge', 'exclusion']
        : set === 'add'
          ? ['lighter', 'hue', 'color-dodge', 'exclusion']
          : ['multiply', 'screen', 'overlay', 'difference'];
    grid.spread = numberParam(ctx.params, 'spread', 0);
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 7 — measured text                                                     */
/* -------------------------------------------------------------------------- */

class TextProbe implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public value = 'Hamburgefonstiv';
  public size = 22;
  public align: CanvasTextAlign = 'left';
  public showGuides = true;

  /** Width measurement from the most recent frame. */
  public measured = 0;

  public render(painter: unknown): void {
    const p = painter as CanvasPainter;
    if (p === null) return;

    // SVG has no measureText, so the guide can only be drawn where metrics exist.
    const context = p.getContext();
    const ratio = window.devicePixelRatio || 1;
    const width = context ? context.canvas.width / ratio : 800;
    const height = context ? context.canvas.height / ratio : 600;

    p.resetTransform();
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    const originX = width / 2;
    const originY = height / 2;
    const font = `${Math.round(this.size)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;

    p.font = font;
    p.textBaseline = 'alphabetic';
    p.textAlign = this.align;

    const metrics = p.measureText(this.value);
    this.measured = metrics.width;

    if (this.showGuides) {
      // The alignment anchor, plus the measured box.
      p.lineWidth = 1;
      p.strokeStyle = 'rgba(232,178,58,0.8)';
      p.beginPath();
      p.moveTo(originX, originY - this.size * 1.6);
      p.lineTo(originX, originY + this.size * 1.2);
      p.stroke();

      const left =
        this.align === 'center'
          ? originX - metrics.width / 2
          : this.align === 'right'
            ? originX - metrics.width
            : originX;

      p.strokeStyle = 'rgba(63,191,143,0.7)';
      p.strokeRect(left, originY - this.size * 0.82, metrics.width, this.size * 1.08);

      // Ascender / descender lines when the context reports them.
      const ascent = metrics.actualBoundingBoxAscent;
      const descent = metrics.actualBoundingBoxDescent;
      if (typeof ascent === 'number' && typeof descent === 'number') {
        p.strokeStyle = 'rgba(120,160,220,0.55)';
        p.setLineDash([4, 4]);
        p.beginPath();
        p.moveTo(left, originY - ascent);
        p.lineTo(left + metrics.width, originY - ascent);
        p.moveTo(left, originY + descent);
        p.lineTo(left + metrics.width, originY + descent);
        p.stroke();
        p.setLineDash([]);
      }
    }

    p.fillStyle = '#e6edf3';
    p.fillText(this.value, originX, originY);

    // Baseline reference.
    p.strokeStyle = 'rgba(255,255,255,0.28)';
    p.beginPath();
    p.moveTo(originX - 260, originY + 0.5);
    p.lineTo(originX + 260, originY + 0.5);
    p.stroke();

    p.textAlign = 'left';
    p.font = '12px ui-monospace, Menlo, Consolas, monospace';
    p.fillStyle = '#93a1b1';
    p.fillText(`measureText("${this.value}") = ${metrics.width.toFixed(1)} px`, 20, height - 20);
  }
}

const textDemo: SceneDemo = {
  id: 'text',
  label: 'Measured text',
  description: 'measureText drives the guides; textAlign picks the anchor. Pixel buffer only.',
  backends: ['canvas2d'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 1, rotation: 0 },
  params: [
    { key: 'text', label: 'Sample', kind: 'select', value: 'Hamburgefonstiv', choices: [
      { value: 'Hamburgefonstiv', label: 'Hamburgefonstiv' },
      { value: 'Wgjy', label: 'Wgjy (wide + descender)' },
      { value: 'illilili', label: 'illilili (narrow)' },
      { value: 'MMM', label: 'MMM (wide capitals)' },
    ] },
    { key: 'size', label: 'Font size', kind: 'slider', value: 22, min: 10, max: 72, step: 1 },
    {
      key: 'align',
      label: 'textAlign',
      kind: 'select',
      value: 'left',
      choices: [
        { value: 'left', label: 'left' },
        { value: 'center', label: 'center' },
        { value: 'right', label: 'right' },
      ],
    },
    { key: 'guides', label: 'Show guides', kind: 'toggle', value: true },
  ],
  setup(ctx) {
    const probe = new TextProbe();
    ctx.objects.push(probe);
    state.text = probe;
  },
  update(ctx) {
    const probe = state.text;
    if (!probe) return;
    probe.value = stringParam(ctx.params, 'text', 'Hamburgefonstiv');
    probe.size = numberParam(ctx.params, 'size', 22);
    const align = stringParam(ctx.params, 'align', 'left');
    probe.align = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
    probe.showGuides = booleanParam(ctx.params, 'guides', true);
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 8 — picking probe                                                     */
/* -------------------------------------------------------------------------- */

/** One hit-testable target. */
interface Target {
  readonly center: Vec2;
  readonly size: number;
  readonly square: boolean;
  readonly bounds: Box2;
  readonly tint: Color;
}

class PickField implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  /** World-space pointer position, or `null` when outside. */
  public pointer: Vec2 | null = null;
  /** Name of the hit target, or `null`. */
  public hit: string | null = null;

  public constructor(private readonly targets: Target[]) {}

  /** Runs the hit tests. Called by the demo's update, not by the renderer. */
  public test(): void {
    const pointer = this.pointer;
    if (pointer === null) {
      this.hit = null;
      return;
    }
    // Topmost wins: iterate backwards, matching painter order.
    for (let i = this.targets.length - 1; i >= 0; i--) {
      if (this.targets[i].bounds.containsPoint(pointer)) {
        this.hit = `target ${i}`;
        return;
      }
    }
    this.hit = null;
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    resetToWorld(p);

    for (let i = 0; i < this.targets.length; i++) {
      const target = this.targets[i];
      const isHit = this.hit === `target ${i}`;
      const tint = isHit
        ? '#ffffff'
        : target.tint.lerpColors(new Color('#2f6fdf'), new Color('#3fbf8f'), i / Math.max(1, this.targets.length - 1)).toCssString();

      if (target.square) {
        const half = target.size / 2;
        rectangle(
          p,
          target.center.x - half,
          target.center.y - half,
          target.size,
          target.size,
          tint,
        );
      } else {
        circle(p, target.center.x, target.center.y, target.size / 2, tint);
      }
    }

    // The crosshair, drawn last so it is always visible.
    if (this.pointer !== null) {
      const size = 0.6;
      line(p, this.pointer.x - size, this.pointer.y, this.pointer.x + size, this.pointer.y, '#ffffff', 0.06);
      line(p, this.pointer.x, this.pointer.y - size, this.pointer.x, this.pointer.y + size, '#ffffff', 0.06);
    }
  }
}

const pickDemo: SceneDemo = {
  id: 'pick',
  label: 'Hit testing',
  description: 'Box2.containsPoint against a field of targets, with the crosshair drawn in world space.',
  backends: ['canvas2d', 'svg'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 42, rotation: 0 },
  params: [
    { key: 'targets', label: 'Targets', kind: 'slider', value: 9, min: 3, max: 25, step: 1 },
    { key: 'size', label: 'Target size', kind: 'slider', value: 2.4, min: 0.8, max: 5, step: 0.1 },
    { key: 'squares', label: 'Squares', kind: 'toggle', value: false },
  ],
  setup(ctx) {
    const count = Math.max(3, Math.round(numberParam(ctx.params, 'targets', 9)));
    const size = numberParam(ctx.params, 'size', 2.4);
    const squares = booleanParam(ctx.params, 'squares', false);

    const targets: Target[] = [];
    const columns = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const center = new Vec2((col - (columns - 1) / 2) * 4.4, (row - (columns - 1) / 2) * 4.4);
      targets.push({
        center,
        size,
        square: squares,
        bounds: Box2.fromCenterAndSize(center, new Vec2(size, size)),
        tint: new Color('#2f6fdf').offsetHSL(((i * 47) % 300) - 150, 0, 0),
      });
    }

    const field = new PickField(targets);
    ctx.objects.push(field);
    state.pick = field;
  },
  update(ctx) {
    // The demo receives no pointer events; the shell stores the world pointer in the
    // shared `state` record, which is the smallest possible wiring between the two.
    const field = state.pick;
    if (!field) return;
    field.pointer = state.pointerWorld;
    field.test();
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 9 — offscreen texture                                                 */
/* -------------------------------------------------------------------------- */

/** Owns an offscreen canvas used as a CPU render target. */
class OffscreenLayer implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public readonly surface: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  public spin = 0;
  public blits = 0;

  public constructor(size: number) {
    this.surface = document.createElement('canvas');
    this.surface.width = size;
    this.surface.height = size;
    this.context = this.surface.getContext('2d');
  }

  public get isUsable(): boolean {
    return this.context !== null;
  }

  /** Repaints the offscreen surface. Called a few times per second, not per frame. */
  public redraw(phase: number): void {
    const ctx = this.context;
    if (!ctx) return;
    const size = this.surface.width;
    const center = size / 2;
    ctx.clearRect(0, 0, size, size);

    const sweep = ctx.createConicGradient?.(phase, center, center);
    if (sweep) {
      sweep.addColorStop(0, '#2f6fdf');
      sweep.addColorStop(0.5, 'rgba(13,16,23,0.15)');
      sweep.addColorStop(1, '#3fbf8f');
      ctx.fillStyle = sweep;
    } else {
      ctx.fillStyle = '#2f6fdf';
    }
    ctx.beginPath();
    ctx.arc(center, center, center * 0.88, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 7; i++) {
      const angle = phase + (i / 7) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(
        center + Math.cos(angle) * center * 0.48,
        center + Math.sin(angle) * center * 0.48,
        center * 0.13,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(center, center, center * 0.88, 0, Math.PI * 2);
    ctx.stroke();
  }

  public render(painter: unknown): void {
    const p = painter as CanvasPainter;
    const context = p.getContext();
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = context.canvas.width / ratio;
    const height = context.canvas.height / ratio;

    p.resetTransform();
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    const count = 5;
    const size = Math.min(140, width / (count + 2));
    for (let i = 0; i < count; i++) {
      const x = (width / (count + 1)) * (i + 1) - size / 2;
      const y = height / 2 - size / 2;
      p.save();
      p.translate(x + size / 2, y + size / 2);
      p.rotate(this.spin * (i % 2 === 0 ? 1 : -1) + i * 0.3);
      p.drawImage(this.surface, {
        dx: -size / 2,
        dy: -size / 2,
        dw: size,
        dh: size,
      });
      p.restore();
      this.blits++;
    }

    p.font = '12px ui-monospace, Menlo, Consolas, monospace';
    p.fillStyle = '#93a1b1';
    p.textAlign = 'center';
    p.textBaseline = 'alphabetic';
    p.fillText(
      `one offscreen ${this.surface.width}×${this.surface.height} surface, blitted ${count}× per frame`,
      width / 2,
      height - 24,
    );
  }
}

const offscreenDemo: SceneDemo = {
  id: 'offscreen',
  label: 'Offscreen texture',
  description: 'A CPU render target redrawn occasionally and blitted many times — pixel buffer only.',
  backends: ['canvas2d'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 1, rotation: 0 },
  params: [
    { key: 'size', label: 'Surface size', kind: 'slider', value: 128, min: 32, max: 512, step: 32 },
    { key: 'spin', label: 'Blit spin', kind: 'slider', value: 0.6, min: -3, max: 3, step: 0.05 },
    { key: 'rebuild', label: 'Rebuild cadence (Hz)', kind: 'slider', value: 5, min: 0.5, max: 30, step: 0.5 },
  ],
  setup(ctx) {
    const layer = new OffscreenLayer(Math.round(numberParam(ctx.params, 'size', 128)));
    layer.redraw(0);
    ctx.objects.push(layer);
    state.offscreen = layer;
    state.offscreenPhase = 0;
    state.offscreenAccumulator = 0;
  },
  update(ctx) {
    const layer = state.offscreen;
    if (!layer) return;
    layer.spin += numberParam(ctx.params, 'spin', 0.6) * ctx.delta;
    state.offscreenPhase += ctx.delta * 0.8;

    const cadence = Math.max(0.5, numberParam(ctx.params, 'rebuild', 5));
    state.offscreenAccumulator += ctx.delta;
    if (state.offscreenAccumulator >= 1 / cadence) {
      state.offscreenAccumulator = 0;
      layer.redraw(state.offscreenPhase);
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 10 — material swatches                                                */
/* -------------------------------------------------------------------------- */

class SwatchFan implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public hue = 210;
  public spread = 240;
  public count = 12;
  public lightness = 0.55;

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    resetToWorld(p);

    const columns = Math.min(this.count, 6);
    const rows = Math.ceil(this.count / columns);
    const cell = 2.4;
    const gap = 0.4;
    const tint = new Color();

    for (let i = 0; i < this.count; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const t = this.count === 1 ? 0 : i / (this.count - 1);
      const hue = this.hue + (t - 0.5) * this.spread;

      tint.setHsl(((hue % 360) + 360) % 360, 0.62, this.lightness);
      const x = (col - (columns - 1) / 2) * (cell + gap);
      const y = (row - (rows - 1) / 2) * (cell + gap);

      circle(p, x, y, cell / 2, tint.toCssString());

      // A lighter inner disc, using `Color.lerp` towards white.
      const inner = new Color().copy(tint).lerp(new Color(1, 1, 1, 1), 0.45);
      circle(p, x, y, cell / 4.4, inner.toCssString());
    }

    // CSS hex readout of the first swatch, so `getHexString` is exercised too.
    tint.setHsl(((this.hue % 360) + 360) % 360, 0.62, this.lightness);
    text(p, tint.getHexString(), 0, (Math.ceil(this.count / columns) * (cell + gap)) / 2 + 0.9, 12, '#93a1b1', 'center');
  }
}

const swatchDemo: SceneDemo = {
  id: 'swatch',
  label: 'HSL swatches',
  description: 'Color.setHsl / lerp / getHexString driving a fan of swatches.',
  backends: ['canvas2d', 'svg'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 34, rotation: 0 },
  params: [
    { key: 'hue', label: 'Base hue', kind: 'slider', value: 210, min: 0, max: 360, step: 1 },
    { key: 'spread', label: 'Hue spread', kind: 'slider', value: 240, min: 0, max: 720, step: 1 },
    { key: 'lightness', label: 'Lightness', kind: 'slider', value: 0.55, min: 0.15, max: 0.9, step: 0.01 },
    { key: 'count', label: 'Swatches', kind: 'slider', value: 12, min: 1, max: 24, step: 1 },
    { key: 'spin', label: 'Spin', kind: 'slider', value: 0.2, min: -2, max: 2, step: 0.05 },
  ],
  setup(ctx) {
    const fan = new SwatchFan();
    ctx.objects.push(fan);
    state.swatch = fan;
  },
  update(ctx) {
    const fan = state.swatch;
    if (!fan) return;
    fan.hue = numberParam(ctx.params, 'hue', 210);
    fan.spread = numberParam(ctx.params, 'spread', 240);
    fan.lightness = numberParam(ctx.params, 'lightness', 0.55);
    fan.count = Math.max(1, Math.round(numberParam(ctx.params, 'count', 12)));
    ctx.camera.rotation += numberParam(ctx.params, 'spin', 0.2) * ctx.delta;
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 11 — mathematical curves                                              */
/* -------------------------------------------------------------------------- */

/** A parametric curve, sampled into a polyline. */
class CurvePlot implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public kind = 'lissajous';
  public a = 3;
  public b = 4;
  public samples = 400;
  public phase = 0;

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    resetToWorld(p);

    const points: { x: number; y: number }[] = [];
    const scale = 8;
    for (let i = 0; i <= this.samples; i++) {
      const t = (i / this.samples) * Math.PI * 2;
      let x: number;
      let y: number;
      switch (this.kind) {
        case 'rose': {
          const k = this.a / Math.max(1, this.b);
          const r = Math.cos(k * t) * scale;
          x = Math.cos(t) * r;
          y = Math.sin(t) * r;
          break;
        }
        case 'spiral': {
          const r = (i / this.samples) * scale;
          x = Math.cos(t * this.a + this.phase) * r;
          y = Math.sin(t * this.a + this.phase) * r;
          break;
        }
        default: {
          x = Math.sin(this.a * t + this.phase) * scale;
          y = Math.sin(this.b * t) * scale;
          break;
        }
      }
      points.push({ x, y });
    }

    // Colouring each segment separately gives a gradient along the curve.
    for (let i = 1; i < points.length; i++) {
      const t = i / points.length;
      const tint = new Color().lerpColors(new Color('#2f6fdf'), new Color('#3fbf8f'), t);
      line(p, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, tint.toCssString(), 0.14);
    }

    circle(p, points[0].x, points[0].y, 0.26, '#e8b23a');
  }
}

const curveDemo: SceneDemo = {
  id: 'curve',
  label: 'Parametric curves',
  description: 'Lissajous, rose and spiral curves sampled into a polyline with a per-segment gradient.',
  backends: ['canvas2d', 'svg'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 32, rotation: 0 },
  params: [
    {
      key: 'kind',
      label: 'Curve',
      kind: 'select',
      value: 'lissajous',
      choices: [
        { value: 'lissajous', label: 'Lissajous' },
        { value: 'rose', label: 'Rose' },
        { value: 'spiral', label: 'Spiral' },
      ],
    },
    { key: 'a', label: 'Frequency A', kind: 'slider', value: 3, min: 1, max: 12, step: 1 },
    { key: 'b', label: 'Frequency B', kind: 'slider', value: 4, min: 1, max: 12, step: 1 },
    { key: 'samples', label: 'Samples', kind: 'slider', value: 400, min: 40, max: 1200, step: 20 },
    { key: 'animate', label: 'Animate phase', kind: 'toggle', value: true },
  ],
  setup(ctx) {
    const plot = new CurvePlot();
    ctx.objects.push(plot);
    state.curve = plot;
  },
  update(ctx) {
    const plot = state.curve;
    if (!plot) return;
    plot.kind = stringParam(ctx.params, 'kind', 'lissajous');
    plot.a = numberParam(ctx.params, 'a', 3);
    plot.b = numberParam(ctx.params, 'b', 4);
    plot.samples = Math.max(40, Math.round(numberParam(ctx.params, 'samples', 400)));
    if (booleanParam(ctx.params, 'animate', true)) plot.phase += ctx.delta * 0.6;
  },
};

/* -------------------------------------------------------------------------- */
/* Demo 12 — layered parallax                                                 */
/* -------------------------------------------------------------------------- */

class ParallaxField implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public layers = 5;
  public depthSpread = 1;
  public scroll = 0;

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    resetToWorld(p);

    for (let layer = 0; layer < this.layers; layer++) {
      const t = this.layers === 1 ? 0 : layer / (this.layers - 1);
      const scale = 0.45 + t * 0.85;
      const alpha = (0.25 + t * 0.6).toFixed(3);
      const tint = new Color().lerpColors(new Color('#141a24'), new Color('#8a6cf0'), t);

      for (let i = 0; i < 7; i++) {
        const x = ((i - 3) * 3.2 + this.scroll * scale * this.depthSpread * 2) % 22;
        const wrapped = x < -11 ? x + 22 : x;
        const y = (layer - (this.layers - 1) / 2) * 1.8;
        circle(
          p,
          wrapped * scale,
          y,
          0.5 + t * 0.9,
          new Color().copy(tint).toCssString().replace('rgb(', 'rgba(').replace(')', `, ${alpha})`),
        );
      }
    }
  }
}

const parallaxDemo: SceneDemo = {
  id: 'parallax',
  label: 'Layered parallax',
  description: 'Five depth layers scrolling at different rates, tinted with Color.lerpColors.',
  backends: ['canvas2d', 'svg'],
  camera: { position: { x: 0, y: 0, z: 0 }, zoom: 28, rotation: 0 },
  params: [
    { key: 'layers', label: 'Layers', kind: 'slider', value: 5, min: 1, max: 10, step: 1 },
    { key: 'speed', label: 'Scroll speed', kind: 'slider', value: 1.5, min: 0, max: 6, step: 0.1 },
    { key: 'spread', label: 'Depth spread', kind: 'slider', value: 1, min: 0.2, max: 3, step: 0.05 },
  ],
  setup(ctx) {
    const field = new ParallaxField();
    ctx.objects.push(field);
    state.parallax = field;
  },
  update(ctx) {
    const field = state.parallax;
    if (!field) return;
    field.layers = Math.max(1, Math.round(numberParam(ctx.params, 'layers', 5)));
    field.depthSpread = numberParam(ctx.params, 'spread', 1);
    field.scroll += ctx.delta * numberParam(ctx.params, 'speed', 1.5);
  },
};

/* -------------------------------------------------------------------------- */
/* Shared mutable state                                                       */
/* -------------------------------------------------------------------------- */

/*
 * The demos hold their own renderables, but `update` needs to reach the instance the
 * `setup` created. A module-scoped record is the smallest wiring that avoids threading
 * a generic through the registry; each field is typed individually so no `any` appears.
 */
interface DemoState {
  drifts: Drift[];
  burst: BurstLayer | null;
  orbit: OrbitGraph | null;
  solid: SoftwareSolid | null;
  solidGeometry: BufferGeometry | null;
  trail: KeyframeTrail | null;
  blend: BlendGrid | null;
  text: TextProbe | null;
  pick: PickField | null;
  offscreen: OffscreenLayer | null;
  offscreenPhase: number;
  offscreenAccumulator: number;
  swatch: SwatchFan | null;
  curve: CurvePlot | null;
  parallax: ParallaxField | null;
  pointerWorld: Vec2 | null;
}

const state: DemoState = {
  drifts: [],
  burst: null,
  orbit: null,
  solid: null,
  solidGeometry: null,
  trail: null,
  blend: null,
  text: null,
  pick: null,
  offscreen: null,
  offscreenPhase: 0,
  offscreenAccumulator: 0,
  swatch: null,
  curve: null,
  parallax: null,
  pointerWorld: null,
};

/** Releases anything the active demo allocated outside the renderer. */
export function disposeDemoState(): void {
  state.solidGeometry?.dispose();
  state.solidGeometry = null;
  if (state.offscreen) {
    state.offscreen.surface.width = 1;
    state.offscreen.surface.height = 1;
  }
  state.drifts = [];
  state.burst = null;
  state.orbit = null;
  state.solid = null;
  state.trail = null;
  state.blend = null;
  state.text = null;
  state.pick = null;
  state.offscreen = null;
  state.swatch = null;
  state.curve = null;
  state.parallax = null;
  state.pointerWorld = null;
}

/** Records the pointer position in world units, for the demos that hit-test. */
export function setPointerWorld(point: Vec2 | null): void {
  state.pointerWorld = point;
}

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/** Every demo, in menu order. */
export const DEMOS: readonly SceneDemo[] = [
  driftDemo,
  burstDemo,
  orbitDemo,
  solidDemo,
  keyframeDemo,
  blendDemo,
  textDemo,
  pickDemo,
  offscreenDemo,
  swatchDemo,
  curveDemo,
  parallaxDemo,
];

/** Looks a demo up by id. */
export function getDemo(id: string): SceneDemo | undefined {
  return DEMOS.find((demo) => demo.id === id);
}

/** The params a demo starts with. */
export function defaultParams(demo: SceneDemo): Record<string, number | boolean | string> {
  const values: Record<string, number | boolean | string> = {};
  for (const param of demo.params) values[param.key] = param.value;
  return values;
}

/** Re-exported so the shell can type the demo list without a second import. */
export type { DemoContext, DemoParam, SceneDemo } from './demos/types';
