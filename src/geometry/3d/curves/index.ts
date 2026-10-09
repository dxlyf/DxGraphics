/**
 * 3D curves.
 *
 * `Curve3` extends the generic `Curve` base (which is already parameterised over
 * `Vec2 | Vec3`) with 3D-only conveniences; the concrete classes differ only in
 * how they map a parameter onto a position.
 *
 * | Class | Interpolates its control points? | Right for |
 * | --- | --- | --- |
 * | `LineCurve3` | yes (endpoints) | straight edges, tube segments |
 * | `QuadraticBezierCurve3` | no (approaches the handle) | simple arcs |
 * | `CubicBezierCurve3` | no | the usual smooth authoring curve |
 * | `CatmullRomCurve3` | **yes** | camera paths, tube spines |
 * | `SplineCurve3` | **yes** | evenly spaced control points |
 *
 * @packageDocumentation
 */

export * from './Curve3';
export * from './LineCurve3';
export * from './QuadraticBezierCurve3';
export * from './CubicBezierCurve3';
export * from './CatmullRomCurve3';
export * from './SplineCurve3';
