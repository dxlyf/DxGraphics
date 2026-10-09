/**
 * Global constants.
 *
 * Every numeric literal that is shared between modules lives here so that a
 * single change propagates across math, geometry and rendering code.
 */

/* -------------------------------------------------------------------------- */
/* Numerical limits                                                           */
/* -------------------------------------------------------------------------- */

/** Machine epsilon for 32-bit floats; the tolerance used by GPU-facing math. */
export const EPSILON = 0.000001;

/** Twice {@link EPSILON}; used where a single multiplication amplifies error. */
export const EPSILON2 = 0.000002;

/** Below this magnitude a value is treated as zero during type conversions. */
export const FLT_EPSILON = 1.1920928955078125e-7;

/** Largest strictly positive finite 32-bit float. */
export const FLT_MAX = 3.4028234663852886e38;

/** Smallest strictly positive normal 32-bit float. */
export const FLT_MIN = 1.1754943508222875e-38;

/** Largest finite 64-bit float. */
export const DBL_MAX = Number.MAX_VALUE;

/** `Math.PI * 2`. */
export const PI2 = Math.PI * 2;

/** `Math.PI / 2`. */
export const HALF_PI = Math.PI / 2;

/** `Math.PI / 4`. */
export const QUARTER_PI = Math.PI / 4;

/** Multiplier converting degrees to radians. */
export const DEG2RAD = Math.PI / 180;

/** Multiplier converting radians to degrees. */
export const RAD2DEG = 180 / Math.PI;

/* -------------------------------------------------------------------------- */
/* Precision                                                                  */
/* -------------------------------------------------------------------------- */

/** Significant digits kept when serialising floats (`toFixed`-style). */
export const DEFAULT_PRECISION = 6;

/** Decimal places used by `toString`/`toArray` when the caller does not specify. */
export const DECIMAL_PLACES = 4;

/* -------------------------------------------------------------------------- */
/* Geometry / rendering defaults                                              */
/* -------------------------------------------------------------------------- */

/** Default radial segment count for circles, cylinders, spheres and cones. */
export const DEFAULT_CURVE_SEGMENTS = 64;

/** Default tessellation segments for 2D curves (beziers, splines, ellipses). */
export const DEFAULT_CURVE_DIVISIONS = 12;

/** Max depth used by recursive subdivision (Catmull-Clark, Simplify). */
export const DEFAULT_SUBDIVISION_ITERATIONS = 1;

/** Default UV wrap behaviour index mapped to `TextureWrap.Repeat`. */
export const DEFAULT_MIPMAP_LEVELS = 1;

/** Aspect ratio assumed when a canvas reports a zero-height client rect. */
export const DEFAULT_ASPECT = 1;

/** Field of view (in degrees) applied by `PerspectiveCamera`. */
export const DEFAULT_FOV = 50;

/** Near plane distance applied by every camera. */
export const DEFAULT_NEAR = 0.1;

/** Far plane distance applied by every camera. */
export const DEFAULT_FAR = 2000;

/** Orthographic frustum half-height applied by `OrthographicCamera`. */
export const DEFAULT_ORTHO_SIZE = 1;

/** Placeholder colour used before a renderer clears the frame. */
export const DEFAULT_BACKGROUND_COLOR = '#000000';

/** Longest delta (seconds) the clock will report after a tab was suspended. */
export const MAX_DELTA = 0.1;

/* -------------------------------------------------------------------------- */
/* Buffers / cursors                                                          */
/* -------------------------------------------------------------------------- */

/** Bytes per element for each typed array constructor name. */
export const BYTES_PER_ELEMENT = {
  Int8Array: 1,
  Uint8Array: 1,
  Uint8ClampedArray: 1,
  Int16Array: 2,
  Uint16Array: 2,
  Int32Array: 4,
  Uint32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
} as const;

/** Default CPU-side copy of a GPU buffer, in bytes (16 MiB). */
export const DEFAULT_STAGING_BUFFER_SIZE = 16 * 1024 * 1024;

/** Default number of instances a growable instanced attribute reserves. */
export const DEFAULT_INSTANCE_CAPACITY = 128;

/** Maximum texture units assumed when a device reports nothing usable. */
export const DEFAULT_MAX_TEXTURE_UNITS = 16;

/** WebGL/WebGPU `POINTS` primitive default point size in device pixels. */
export const DEFAULT_POINT_SIZE = 1;

/** Default line width; WebGL core profile ignores values above 1. */
export const DEFAULT_LINE_WIDTH = 1;

/* -------------------------------------------------------------------------- */
/* Hit testing / picking                                                      */
/* -------------------------------------------------------------------------- */

/** Pixels of slack added around a point when hit-testing small 2D nodes. */
export const PICKING_TOLERANCE = 2;

/** Max hits returned by `Raycaster` when no explicit limit is supplied. */
export const DEFAULT_MAX_PICK_RESULTS = 100;

/* -------------------------------------------------------------------------- */
/* Animation                                                                  */
/* -------------------------------------------------------------------------- */

/** Frames per second assumed when no display refresh rate could be measured. */
export const DEFAULT_FPS = 60;

/** Duration (seconds) of the fade applied by `AnimationAction.crossFadeTo`. */
export const DEFAULT_FADE_DURATION = 0.3;

/* -------------------------------------------------------------------------- */
/* Assets / caching                                                           */
/* -------------------------------------------------------------------------- */

/** Concurrent network requests issued by `AssetManager` for a batch. */
export const DEFAULT_MAX_CONCURRENT_LOADS = 6;

/** Attempts made by loaders before a request is reported as failed. */
export const DEFAULT_LOAD_RETRIES = 2;

/** Delay (milliseconds) before the first retry; subsequent retries double it. */
export const DEFAULT_RETRY_DELAY = 250;

/** Cache entries kept by `Cache` before the oldest are evicted. */
export const DEFAULT_CACHE_LIMIT = 1000;

/* -------------------------------------------------------------------------- */
/* Text                                                                       */
/* -------------------------------------------------------------------------- */

/** Padding, in texels, written around every glyph in a `GlyphAtlas`. */
export const GLYPH_PADDING = 1;

/** Default font size used when none is supplied. */
export const DEFAULT_FONT_SIZE = 16;

/** Distance-range spread used when generating SDF glyphs. */
export const DEFAULT_SDF_RADIUS = 8;

/* -------------------------------------------------------------------------- */
/* Backend identifiers                                                        */
/* -------------------------------------------------------------------------- */

/** Canonical backend names accepted by `RendererFactory` and `detectBackend`. */
export const BackendNames = {
  Canvas2D: 'canvas2d',
  SVG: 'svg',
  WebGL: 'webgl',
  WebGL2: 'webgl2',
  WebGPU: 'webgpu',
} as const;

/** Union of the canonical backend names. */
export type BackendName = (typeof BackendNames)[keyof typeof BackendNames];

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** Rounds a value to 6 significant digits for stable snapshot comparisons. */
export const SNAPSHOT_PRECISION = 6;

/** Capacity of the pools created by `Pool` when the caller does not say. */
export const DEFAULT_POOL_SIZE = 32;
