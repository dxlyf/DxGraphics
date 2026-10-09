/**
 * The WebGL backend — real GPU draws from a hand-written material.
 *
 * What it shows
 * -------------
 * `WebGLRenderer` implements the same `AbstractRenderer` contract as the Canvas2D
 * and SVG backends (sizing, pixel ratio, the animation loop, statistics, disposal),
 * and adds context acquisition, a redundant-state-change eliminator, VAO/program
 * caches, and a **structural** draw path: a renderable is any object with a
 * `geometry` and an optional `material`.
 *
 * Two details matter and are both demonstrated here:
 *
 * 1. `WebGLRenderableLike.uploadAutomaticUniforms` reads the view matrix from
 *    `camera.viewMatrix`. The library's camera classes expose `matrixWorldInverse`,
 *    so this example passes a small **camera adapter** that presents the same
 *    matrices under the names the backend looks for. Without it, `projectionMatrix`
 *    would upload but `modelViewMatrix` would silently be the model matrix alone.
 * 2. A material is a plain object: `vertexShader`/`fragmentShader` GLSL sources plus
 *    a `uniforms` bag. There are no material classes in this checkout
 *    (the material layer defines its own richer classes), which is why the backend is written
 *    against a structural interface.
 *
 * What to look for
 * ----------------
 * A smooth-shaded, spinning cube drawn with a program compiled from GLSL sources in
 * this file, plus the live capability list, resource counts and the context
 * generation counter from `renderer.renderInfo` and `renderer.info`. Try resizing
 * the window: the viewport follows.
 */

import {
  BackendNames,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mat4,
  Vec3,
  detectBackendStrict,
  type BackendName,
} from '../../src/index';
// The root barrel deliberately does not re-export the GPU backends (they are owned
// by a separate layer), so the WebGL renderer is imported from its own entry point.
import { WebGLRenderer } from '../../src/renderer/webgl/WebGLRenderer';

/* -------------------------------------------------------------------------- */
/* Shaders: GLSL ES 1.00, so the same text links on WebGL1 and WebGL2          */
/* -------------------------------------------------------------------------- */

const VERTEX_SHADER = `
attribute vec3 position;
attribute vec3 normal;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

uniform vec3 baseColor;
uniform vec3 lightDirection;

varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vec3 normal = normalize(vNormal);
  // Two-sided: flip the normal when the fragment faces away from the viewer.
  if (!gl_FrontFacing) normal = -normal;

  float lambert = max(dot(normal, normalize(lightDirection)), 0.0);
  vec3 viewDir = normalize(-vViewPosition);
  vec3 halfDir = normalize(normalize(lightDirection) + viewDir);
  float specular = pow(max(dot(normal, halfDir), 0.0), 32.0) * 0.35;

  vec3 color = baseColor * (0.18 + lambert * 0.85) + vec3(specular);
  gl_FragColor = vec4(color, 1.0);
}
`;

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A cube with per-face normals.
 *
 * Non-indexed, so the six faces never share vertices and the smooth-shading normal
 * matrix is exercised on genuinely flat faces.
 */
function makeCube(half: number): BufferGeometry {
  const corners: [number, number, number][] = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ];
  const faces: { quad: [number, number, number, number]; normal: [number, number, number] }[] = [
    { quad: [0, 3, 2, 1], normal: [0, 0, -1] },
    { quad: [4, 5, 6, 7], normal: [0, 0, 1] },
    { quad: [0, 1, 5, 4], normal: [0, -1, 0] },
    { quad: [3, 7, 6, 2], normal: [0, 1, 0] },
    { quad: [0, 4, 7, 3], normal: [-1, 0, 0] },
    { quad: [1, 2, 6, 5], normal: [1, 0, 0] },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const face of faces) {
    const [a, b, c, d] = face.quad;
    for (const corner of [a, b, c, a, c, d]) {
      indices.push(positions.length / 3);
      const position = corners[corner];
      positions.push(position[0], position[1], position[2]);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Camera adapter                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The structural camera the WebGL backend reads.
 *
 * `WebGLRenderer.uploadAutomaticUniforms` looks for `camera.viewMatrix` and
 * `camera.projectionMatrix`. `PerspectiveCamera` provides the projection and (via
 * `Camera3D`) `matrixWorldInverse` — the view matrix under a different name. This
 * adapter exposes both names without copying either matrix, so it stays live.
 */
class BackendCamera {
  public readonly projectionMatrix: Mat4;
  public readonly position: Vec3;
  public readonly zoom = 1;
  public readonly rotation = 0;

  private readonly view: Mat4;

  public constructor(projection: Mat4, view: Mat4, position: Vec3) {
    this.projectionMatrix = projection;
    this.view = view;
    this.position = position;
  }

  /** The view matrix, under the name the WebGL backend queries. */
  public get viewMatrix(): Mat4 {
    return this.view;
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
  // Strict detection with an explicit preference order: WebGL2 first, then WebGL1.
  const preferred: BackendName[] = [BackendNames.WebGL2, BackendNames.WebGL];
  const backend = detectBackendStrict(preferred, canvas);

  if (backend === null) {
    showNotice(
      'No WebGL context could be created on this canvas, so the WebGL backend cannot be ' +
        'demonstrated here. This usually means the browser has WebGL disabled, the GPU is ' +
        'blocklisted, or the page is running without hardware acceleration. The Canvas2D and ' +
        'SVG examples do not need a GPU.',
    );
  } else {
    const geometry = makeCube(1);

    // A material is a plain structural object. There is no material class yet:
    // `src/materials/` is still empty, which is why `WebGLRenderer` accepts this shape.
    const material = {
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        baseColor: new Color('#2f6fdf').toArray().slice(0, 3),
        lightDirection: new Vec3(0.45, 0.8, 0.55).normalize().toArray(),
      },
      depthTest: true,
      depthWrite: true,
    };

    const renderer = new WebGLRenderer({
      canvas,
      clearColor: '#11151d',
      clearAlpha: 1,
      autoResize: true,
      preferWebGL2: true,
    });

    if (renderer.isHeadless) {
      showNotice(
        'The WebGL renderer constructed without a drawing surface. Construction, sizing, ' +
          'clear and dispose are safe in that state, but nothing can be drawn.',
      );
      renderer.dispose();
    } else {
      // The camera is built from verified library maths and then presented through
      // the adapter above. `Mat4.lookAt` produces a view matrix directly.
      const projection = Mat4.fromPerspective((50 * Math.PI) / 180, 16 / 9, 0.1, 100);
      const view = Mat4.fromLookAt(new Vec3(0, 1.4, 5.2), new Vec3(0, 0, 0), new Vec3(0, 1, 0));
      const camera = new BackendCamera(projection, view, new Vec3(0, 1.4, 5.2));

      // The renderable: a `matrixWorld` plus the geometry and material. This mirrors
      // what `Mesh` exposes, but is written out so the example does not depend on
      // the scene layer's disposal semantics.
      const modelMatrix = new Mat4();
      const identityQuaternion = { x: 0, y: 0, z: 0, w: 1 };
      const model = {
        geometry,
        material,
        matrixWorld: modelMatrix,
      };

      const scene = { children: [model] };
      const spin = { x: 0, y: 0 };

      let fps = 0;
      let frames = 0;
      let elapsed = 0;

      const renderInfoAtStart = renderer.renderInfo;

      renderer.setAnimationLoop((_time, delta) => {
        spin.x += delta * 0.35;
        spin.y += delta * 0.6;

        // `Mat4` is column-major with column vectors, so a spin about X then Y is
        // `Rx * Ry`: rotate about Y first, then about the (already rotated) X axis.
        const rotationX = new Mat4().makeRotationX(spin.x);
        const rotationY = new Mat4().makeRotationY(spin.y);
        modelMatrix.copy(rotationX).multiply(rotationY);

        frames++;
        elapsed += delta;
        if (elapsed >= 0.25) {
          fps = frames / elapsed;
          frames = 0;
          elapsed = 0;
        }

        renderer.render(scene, camera);

        const info = renderer.info;
        const capabilities = info.capabilities.join(', ') || 'none reported';
        const renderInfo = renderer.renderInfo;

        overlay.textContent =
          `FPS           ${fps.toFixed(0)}\n` +
          `backend       ${renderer.backend}\n` +
          `vendor        ${info.vendor ?? 'unknown'}\n` +
          `renderer      ${info.renderer ?? 'unknown'}\n` +
          `generation    ${renderer.contextGeneration}\n` +
          `context       ${renderer.isContextUsable ? 'usable' : 'LOST'}\n` +
          `draw calls    ${renderInfo.render.calls}\n` +
          `triangles     ${renderInfo.render.triangles}\n` +
          `programs      ${renderInfo.memory.programs}\n` +
          `geometries    ${renderInfo.memory.geometries}\n` +
          `max tex size  ${info.maxTextureSize ?? '-'}\n` +
          `capabilities  ${capabilities}`;
      }, { autoStart: true });

      // Touch the snapshot so the initial resource counts are observable in a
      // debugger without changing steady-state behaviour.
      void renderInfoAtStart;

      dispose = (): void => {
        renderer.setAnimationLoop(null);
        renderer.dispose();
        geometry.dispose();
      };
    }
  }
}

window.addEventListener('beforeunload', dispose);
