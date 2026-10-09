/**
 * 2D geometry: curves, paths, shapes, polygons and the operations on them.
 *
 * The layer is built around {@link Curve}, an abstract parametric curve, and
 * {@link Path}, an ordered list of curve segments. `Shape` adds holes and
 * triangulation, `Polygon`/`Polyline` wrap raw vertex lists, `BooleanOps` does
 * set operations and `Tessellate`/`Triangulate` turn curves into the flat arrays
 * the renderer consumes.
 *
 * Everything here is pure CPU code with no rendering dependency.
 *
 * @packageDocumentation
 */

export * from './Curve';
export * from './LineCurve';
export * from './QuadraticBezierCurve';
export * from './CubicBezierCurve';
export * from './ArcCurve';
export * from './EllipseCurve';
export * from './SplineCurve';
export * from './Path';
export * from './Shape';
export * from './RectShape';
export * from './CircleShape';
export * from './EllipseShape';
export * from './RoundedRectShape';
export * from './Polygon';
export * from './Polyline';
export * from './BooleanOps';
export * from './Triangulate';
export * from './Tessellate';
export type * from './types';
