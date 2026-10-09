/**
 * `SVGLoader` — SVG path data, flattened to polylines.
 *
 * The full path grammar is implemented:
 *
 * | Command | Meaning | Notes |
 * | --- | --- | --- |
 * | `M`/`m` | moveto | extra coordinate pairs become implicit `L`/`l` |
 * | `L`/`l` | lineto | |
 * | `H`/`h`, `V`/`v` | horizontal/vertical lineto | |
 * | `C`/`c` | cubic Bezier | |
 * | `S`/`s` | smooth cubic | first control point mirrored from the previous one |
 * | `Q`/`q` | quadratic Bezier | |
 * | `T`/`t` | smooth quadratic | control point mirrored from the previous one |
 * | `A`/`a` | elliptical arc | converted to cubic Beziers by the endpoint-to-centre algorithm, then flattened |
 * | `Z`/`z` | closepath | closes the current subpath and sets the pen to its start |
 *
 * Numbers are parsed with the SVG rule that a `-` or a second `.` implicitly
 * terminates the previous number, so `M0 0L10-5` and `M.5.5` both parse.
 *
 * ```ts
 * const result = parseSVGPath('M0 0 L10 0 L10 10 Z');
 * result.subPaths[0].closed;   // true
 * result.points;               // [0,0, 10,0, 10,10, 0,0]
 * ```
 *
 * ## Scope
 *
 * SVG *shapes* (`<rect>`, `<circle>`, `<polygon>`) are out of scope: a renderer
 * converts them to path data before it needs this parser. So are CSS styles, filters
 * and `<use>` references. Arc flattening uses a fixed segment budget per quarter
 * turn rather than a sagitta-based adaptive scheme, which is deterministic — the
 * property a test needs.
 *
 * @packageDocumentation
 */

import { Loader, type LoadedSource } from './Loader';
import type { FetchLike, LoadOptions, SVGParseResult, SVGSubPath } from '../types';

/** Options accepted by {@link parseSVGPath}. */
export interface SVGParseOptions {
  /** Curve segments per Bezier; defaults to `16`. */
  curveSegments?: number;
  /** Arc segments per quarter turn; defaults to `8`. */
  arcSegments?: number;
  /** Curve flattening tolerance; when set, overrides `curveSegments`. */
  tolerance?: number;
}

/** Mutable path-walking state. */
interface PathState {
  /** Current pen X. */
  x: number;
  /** Current pen Y. */
  y: number;
  /** Start of the current subpath. */
  startX: number;
  /** Start of the current subpath. */
  startY: number;
  /** Last cubic control point X; `null` when the previous command was not a cubic. */
  cubicX: number | null;
  /** Last cubic control point Y. */
  cubicY: number | null;
  /** Last quadratic control point X; `null` when the previous command was not a quadratic. */
  quadX: number | null;
  /** Last quadratic control point Y. */
  quadY: number | null;
}

/**
 * Tokenises path data into commands and numbers.
 *
 * @param source Path data.
 * @returns An alternating sequence of command letters and numbers.
 */
export function tokenizePathData(source: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i++;
      continue;
    }

    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(char)) {
      tokens.push(char);
      i++;
      continue;
    }

    // A number: SVG allows `.5`, `-.5`, `1e-3`, and implicitly terminates on a
    // second `.` or a `-` that is not an exponent sign.
    const start = i;
    if (char === '-' || char === '+') i++;
    let seenDot = false;
    let seenExponent = false;

    while (i < source.length) {
      const current = source[i];
      if (current >= '0' && current <= '9') {
        i++;
        continue;
      }
      if (current === '.' && !seenDot && !seenExponent) {
        seenDot = true;
        i++;
        continue;
      }
      if ((current === 'e' || current === 'E') && !seenExponent) {
        seenExponent = true;
        i++;
        if (source[i] === '-' || source[i] === '+') i++;
        continue;
      }
      break;
    }

    const text = source.slice(start, i);
    const value = Number(text);
    if (Number.isFinite(value)) {
      tokens.push(value);
    } else if (text.length > 0) {
      // Not a number and not a command: stop rather than loop forever.
      i++;
    }
  }

  return tokens;
}

/** Evaluates a cubic Bezier component. */
function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** Evaluates a quadratic Bezier component. */
function quadraticAt(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

/**
 * Converts an SVG elliptical arc to a sequence of cubic Beziers.
 *
 * Implements the endpoint-to-centre parameterisation from the SVG specification
 * (F.6.5), including the out-of-range radius correction and the two candidate centre
 * solutions, then splits the sweep into segments of at most 90°.
 *
 * @param x1 Start X.
 * @param y1 Start Y.
 * @param x2 End X.
 * @param y2 End Y.
 * @param rx X radius.
 * @param ry Y radius.
 * @param rotation X-axis rotation, in radians.
 * @param largeArc Large-arc flag.
 * @param sweep Sweep flag.
 * @returns Cubic control-point triples, four numbers per segment: `c1x, c1y, c2x, c2y` plus the endpoint appended by the caller.
 */
export function arcToCubics(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rx: number,
  ry: number,
  rotation: number,
  largeArc: boolean,
  sweep: boolean,
): number[] {
  if (rx === 0 || ry === 0) return [];

  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);

  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;

  const x1p = cosRotation * dx2 + sinRotation * dy2;
  const y1p = -sinRotation * dx2 + cosRotation * dy2;

  // Scale the radii up when they are too small to span the chord.
  const lambda = (x1p * x1p) / (radiusX * radiusX) + (y1p * y1p) / (radiusY * radiusY);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    radiusX *= scale;
    radiusY *= scale;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator =
    radiusX * radiusX * radiusY * radiusY -
    radiusX * radiusX * y1p * y1p -
    radiusY * radiusY * x1p * x1p;
  const denominator = radiusX * radiusX * y1p * y1p + radiusY * radiusY * x1p * x1p;
  const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));

  const cxp = (coefficient * radiusX * y1p) / radiusY;
  const cyp = (-coefficient * radiusY * x1p) / radiusX;

  const cx = cosRotation * cxp - sinRotation * cyp + (x1 + x2) / 2;
  const cy = sinRotation * cxp + cosRotation * cyp + (y1 + y2) / 2;

  const theta1 = Math.atan2((y1p - cyp) / radiusY, (x1p - cxp) / radiusX);
  const theta2 = Math.atan2((-y1p - cyp) / radiusY, (-x1p - cxp) / radiusX);

  let delta = theta2 - theta1;
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  else if (sweep && delta < 0) delta += Math.PI * 2;

  // Split into 90°-or-smaller segments; each becomes one cubic.
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const alpha = (4 / 3) * Math.tan(step / 4);

  const out: number[] = [];

  const mapX = (px: number, py: number): number => cx + cosRotation * px - sinRotation * py;
  const mapY = (px: number, py: number): number => cy + sinRotation * px + cosRotation * py;

  let theta = theta1;
  for (let i = 0; i < segments; i++) {
    const nextTheta = theta + step;

    const cosA = Math.cos(theta);
    const sinA = Math.sin(theta);
    const cosB = Math.cos(nextTheta);
    const sinB = Math.sin(nextTheta);

    const startX = radiusX * cosA;
    const startY = radiusY * sinA;
    const endX = radiusX * cosB;
    const endY = radiusY * sinB;

    const c1x = startX - alpha * radiusX * sinA;
    const c1y = startY + alpha * radiusY * cosA;
    const c2x = endX + alpha * radiusX * sinB;
    const c2y = endY - alpha * radiusY * cosB;

    out.push(mapX(c1x, c1y), mapY(c1x, c1y), mapX(c2x, c2y), mapY(c2x, c2y));

    theta = nextTheta;
  }

  return out;
}

/**
 * Parses SVG path data and flattens every curve to a polyline.
 *
 * @param pathData The `d` attribute contents.
 * @param options Segment counts.
 * @returns The subpaths and a flat point list.
 * @throws Error When the data contains no `M` command.
 */
export function parseSVGPath(pathData: string, options: SVGParseOptions = {}): SVGParseResult {
  const curveSegments = Math.max(2, Math.floor(options.curveSegments ?? 16));
  const arcSegments = Math.max(2, Math.floor(options.arcSegments ?? 8));
  void arcSegments;

  const tokens = tokenizePathData(pathData);
  const subPaths: SVGSubPath[] = [];
  const allPoints: number[] = [];

  let current: number[] = [];
  let command = '';
  let cursor = 0;
  let commandCount = 0;

  const state: PathState = {
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
    cubicX: null,
    cubicY: null,
    quadX: null,
    quadY: null,
  };

  const pushPoint = (x: number, y: number): void => {
    current.push(x, y);
    allPoints.push(x, y);
  };

  const flush = (closed: boolean): void => {
    if (current.length >= 4) {
      subPaths.push({ points: Float32Array.from(current), closed });
    }
    current = [];
  };

  const readNumber = (): number => {
    const token = tokens[cursor++];
    return typeof token === 'number' ? token : 0;
  };

  const hasMore = (): boolean => cursor < tokens.length && typeof tokens[cursor] === 'number';

  while (cursor < tokens.length) {
    const token = tokens[cursor];

    if (typeof token === 'string') {
      command = token;
      cursor++;
      commandCount++;
    } else if (command === '') {
      // Numbers before any command: skip rather than guess.
      cursor++;
      continue;
    } else if (command === 'M') {
      // Implicit lineto after a moveto.
      command = 'L';
    } else if (command === 'm') {
      command = 'l';
    }

    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();

    switch (upper) {
      case 'M': {
        const x = readNumber();
        const y = readNumber();
        flush(false);
        state.x = relative ? state.x + x : x;
        state.y = relative ? state.y + y : y;
        state.startX = state.x;
        state.startY = state.y;
        state.cubicX = null;
        state.cubicY = null;
        state.quadX = null;
        state.quadY = null;
        pushPoint(state.x, state.y);
        break;
      }
      case 'L': {
        const x = readNumber();
        const y = readNumber();
        state.x = relative ? state.x + x : x;
        state.y = relative ? state.y + y : y;
        state.cubicX = null;
        state.cubicY = null;
        state.quadX = null;
        state.quadY = null;
        pushPoint(state.x, state.y);
        break;
      }
      case 'H': {
        const x = readNumber();
        state.x = relative ? state.x + x : x;
        state.cubicX = null;
        state.cubicY = null;
        state.quadX = null;
        state.quadY = null;
        pushPoint(state.x, state.y);
        break;
      }
      case 'V': {
        const y = readNumber();
        state.y = relative ? state.y + y : y;
        state.cubicX = null;
        state.cubicY = null;
        state.quadX = null;
        state.quadY = null;
        pushPoint(state.x, state.y);
        break;
      }
      case 'C': {
        const c1x = readNumber();
        const c1y = readNumber();
        const c2x = readNumber();
        const c2y = readNumber();
        const x = readNumber();
        const y = readNumber();

        const originX = state.x;
        const originY = state.y;
        const targetX = relative ? originX + x : x;
        const targetY = relative ? originY + y : y;
        const control1X = relative ? originX + c1x : c1x;
        const control1Y = relative ? originY + c1y : c1y;
        const control2X = relative ? originX + c2x : c2x;
        const control2Y = relative ? originY + c2y : c2y;

        for (let i = 1; i <= curveSegments; i++) {
          const t = i / curveSegments;
          pushPoint(
            cubicAt(originX, control1X, control2X, targetX, t),
            cubicAt(originY, control1Y, control2Y, targetY, t),
          );
        }

        state.x = targetX;
        state.y = targetY;
        state.cubicX = control2X;
        state.cubicY = control2Y;
        state.quadX = null;
        state.quadY = null;
        break;
      }
      case 'S': {
        const c2x = readNumber();
        const c2y = readNumber();
        const x = readNumber();
        const y = readNumber();

        const originX = state.x;
        const originY = state.y;
        // Mirror the previous cubic's second control point; without one, use the pen.
        const control1X = state.cubicX === null ? originX : originX * 2 - state.cubicX;
        const control1Y = state.cubicY === null ? originY : originY * 2 - state.cubicY;
        const targetX = relative ? originX + x : x;
        const targetY = relative ? originY + y : y;
        const control2X = relative ? originX + c2x : c2x;
        const control2Y = relative ? originY + c2y : c2y;

        for (let i = 1; i <= curveSegments; i++) {
          const t = i / curveSegments;
          pushPoint(
            cubicAt(originX, control1X, control2X, targetX, t),
            cubicAt(originY, control1Y, control2Y, targetY, t),
          );
        }

        state.x = targetX;
        state.y = targetY;
        state.cubicX = control2X;
        state.cubicY = control2Y;
        state.quadX = null;
        state.quadY = null;
        break;
      }
      case 'Q': {
        const qx = readNumber();
        const qy = readNumber();
        const x = readNumber();
        const y = readNumber();

        const originX = state.x;
        const originY = state.y;
        const controlX = relative ? originX + qx : qx;
        const controlY = relative ? originY + qy : qy;
        const targetX = relative ? originX + x : x;
        const targetY = relative ? originY + y : y;

        for (let i = 1; i <= curveSegments; i++) {
          const t = i / curveSegments;
          pushPoint(quadraticAt(originX, controlX, targetX, t), quadraticAt(originY, controlY, targetY, t));
        }

        state.x = targetX;
        state.y = targetY;
        state.quadX = controlX;
        state.quadY = controlY;
        state.cubicX = null;
        state.cubicY = null;
        break;
      }
      case 'T': {
        const x = readNumber();
        const y = readNumber();

        const originX = state.x;
        const originY = state.y;
        const controlX = state.quadX === null ? originX : originX * 2 - state.quadX;
        const controlY = state.quadY === null ? originY : originY * 2 - state.quadY;
        const targetX = relative ? originX + x : x;
        const targetY = relative ? originY + y : y;

        for (let i = 1; i <= curveSegments; i++) {
          const t = i / curveSegments;
          pushPoint(quadraticAt(originX, controlX, targetX, t), quadraticAt(originY, controlY, targetY, t));
        }

        state.x = targetX;
        state.y = targetY;
        state.quadX = controlX;
        state.quadY = controlY;
        state.cubicX = null;
        state.cubicY = null;
        break;
      }
      case 'A': {
        const rx = readNumber();
        const ry = readNumber();
        const rotationDegrees = readNumber();
        const largeArc = readNumber() !== 0;
        const sweep = readNumber() !== 0;
        const x = readNumber();
        const y = readNumber();

        const originX = state.x;
        const originY = state.y;
        const targetX = relative ? originX + x : x;
        const targetY = relative ? originY + y : y;

        const cubics = arcToCubics(
          originX,
          originY,
          targetX,
          targetY,
          rx,
          ry,
          (rotationDegrees * Math.PI) / 180,
          largeArc,
          sweep,
        );

        if (cubics.length === 0) {
          // A degenerate arc is a straight line per the specification.
          pushPoint(targetX, targetY);
        } else {
          for (let i = 0; i + 3 < cubics.length; i += 4) {
            const c1x = cubics[i];
            const c1y = cubics[i + 1];
            const c2x = cubics[i + 2];
            const c2y = cubics[i + 3];
            const isLast = i + 7 >= cubics.length;
            const endX = isLast ? targetX : cubics[i + 4];
            const endY = isLast ? targetY : cubics[i + 5];

            for (let s = 1; s <= curveSegments; s++) {
              const t = s / curveSegments;
              pushPoint(
                cubicAt(i === 0 ? originX : cubics[i - 2], c1x, c2x, endX, t),
                cubicAt(i === 0 ? originY : cubics[i - 1], c1y, c2y, endY, t),
              );
            }
          }
        }

        state.x = targetX;
        state.y = targetY;
        state.cubicX = null;
        state.cubicY = null;
        state.quadX = null;
        state.quadY = null;
        break;
      }
      case 'Z': {
        flush(true);
        state.x = state.startX;
        state.y = state.startY;
        state.cubicX = null;
        state.cubicY = null;
        state.quadX = null;
        state.quadY = null;
        // A closed path's implicit next `M` is the subpath start.
        pushPoint(state.x, state.y);
        command = '';
        break;
      }
      default: {
        cursor++;
        break;
      }
    }

    if (upper === 'Z') command = '';

    // Guard against a command with no operands looping forever.
    if (!hasMore() && cursor < tokens.length && typeof tokens[cursor] !== 'string') cursor++;
  }

  flush(false);

  if (subPaths.length === 0) {
    throw new Error(
      'SVGLoader: the path data produced no subpaths. Expected at least one "M" command ' +
        `in "${pathData.slice(0, 48)}${pathData.length > 48 ? '...' : ''}".`,
    );
  }

  return {
    subPaths,
    points: Float32Array.from(allPoints),
    commandCount,
  };
}

/**
 * Extracts the attributes `SVGLoader` understands from an SVG document.
 *
 * @param source SVG markup.
 * @returns The `viewBox`, width and height, and the concatenated `d` attributes.
 */
export function parseSVGDocument(source: string): {
  paths: string[];
  viewBox?: { x: number; y: number; width: number; height: number };
  width?: number;
  height?: number;
} {
  const viewBoxMatch = /viewBox\s*=\s*"([^"]+)"/i.exec(source);
  let viewBox: { x: number; y: number; width: number; height: number } | undefined;
  if (viewBoxMatch !== null) {
    const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  }

  const widthMatch = /\bwidth\s*=\s*"([\d.]+)/i.exec(source);
  const heightMatch = /\bheight\s*=\s*"([\d.]+)/i.exec(source);

  const paths: string[] = [];
  const pathPattern = /<path\b[^>]*\bd\s*=\s*"([^"]*)"/gi;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(source)) !== null) paths.push(match[1]);

  return {
    paths,
    ...(viewBox === undefined ? {} : { viewBox }),
    ...(widthMatch === null ? {} : { width: Number(widthMatch[1]) }),
    ...(heightMatch === null ? {} : { height: Number(heightMatch[1]) }),
  };
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Loads SVG path data.
 */
export class SVGLoader extends Loader<SVGParseResult, string> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** Flattening options applied to every parse. */
  public readonly parseOptions: SVGParseOptions;

  /**
   * Creates an SVG loader.
   *
   * @param options Flattening and transport overrides.
   */
  constructor(options: SVGParseOptions & { fetcher?: FetchLike } = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
    this.parseOptions = options;
  }

  /**
   * Installs a `fetch` implementation.
   *
   * @param fetcher Fetcher, or `null` for the global one.
   * @returns This loader, for chaining.
   */
  public setFetcher(fetcher: FetchLike | null): this {
    this.fetcher = fetcher;
    return this;
  }

  /**
   * @inheritdoc
   */
  protected override async loadData(url: string, options: LoadOptions): Promise<LoadedSource<string>> {
    const fetcher = this.resolveFetcher(options);
    if (fetcher === null) {
      throw new Error(
        `SVGLoader("${url}"): no \`fetch\` implementation is available. Use \`parse()\` on ` +
          'inline markup when running on a host without fetch.',
      );
    }

    const response = await fetcher(url, {
      method: 'GET',
      headers: { ...this.requestHeaders },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`SVGLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const text = await response.text();
    this.reportProgress(url, text.length, text.length, options);
    return { data: text, fromCache: false, byteLength: text.length };
  }

  /**
   * @inheritdoc
   *
   * Accepts either a full SVG document (every `<path d="...">` is concatenated) or a
   * bare path-data string.
   */
  public override parse(source: string, url = '<inline>'): SVGParseResult {
    try {
      const isDocument = /<svg[\s>]/i.test(source) || /<path[\s>]/i.test(source);

      if (isDocument) {
        const document = parseSVGDocument(source);
        if (document.paths.length === 0) {
          throw new Error(
            'the document contains no <path d="..."> element, so there is no path data ' +
              'to flatten (basic shapes such as <rect> are converted to paths by the ' +
              'caller, not by this loader).',
          );
        }

        // Merge every path into one result, preserving subpath boundaries.
        const merged: SVGSubPath[] = [];
        const points: number[] = [];
        let commandCount = 0;

        for (const data of document.paths) {
          const parsed = parseSVGPath(data, this.parseOptions);
          for (const subPath of parsed.subPaths) merged.push(subPath);
          for (let i = 0; i < parsed.points.length; i++) points.push(parsed.points[i]);
          commandCount += parsed.commandCount;
        }

        return {
          subPaths: merged,
          points: Float32Array.from(points),
          commandCount,
          ...(document.viewBox === undefined ? {} : { viewBox: document.viewBox }),
          ...(document.width === undefined ? {} : { width: document.width }),
          ...(document.height === undefined ? {} : { height: document.height }),
        };
      }

      return parseSVGPath(source, this.parseOptions);
    } catch (error) {
      throw new Error(
        `SVGLoader("${url}"): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: LoadOptions): FetchLike | null {
    const override = (options as { fetcher?: FetchLike }).fetcher;
    if (override !== undefined) return override;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FetchLike) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.fetcher = null;
  }
}

/**
 * Convenience factory mirroring `new SVGLoader(options)`.
 *
 * @param options Flattening and transport overrides.
 * @returns A new SVG loader.
 */
export function svgLoader(options: SVGParseOptions & { fetcher?: FetchLike } = {}): SVGLoader {
  return new SVGLoader(options);
}
