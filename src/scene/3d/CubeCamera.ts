/**
 * `CubeCamera` - six cameras sharing one origin, used to render cube maps.
 *
 * The camera owns the six `PerspectiveCamera` faces and delegates the actual
 * six-face render to the renderer through the structural
 * {@link CubeRenderHost} contract. That keeps this module free of any
 * `src/renderer` import (the renderer was still being written when this class
 * landed) and lets a WebGL, WebGPU or test double drive it.
 *
 * ```ts
 * const cube = new CubeCamera({ near: 0.1, far: 1000 });
 * cube.update(renderer, scene);          // renderer implements renderToCube()
 * material.envMap = cube.renderTarget.texture;
 * ```
 *
 * @packageDocumentation
 */

import { Object3D } from './Object3D';
import { PerspectiveCamera } from './PerspectiveCamera';
import type { CubeCameraOptions, CubeRenderHost } from './types';

/** Face order, matching the `TEXTURE_CUBE_MAP_*` constants of WebGL. */
export const CubeFace = {
  /** `+X` */
  PositiveX: 0,
  /** `-X` */
  NegativeX: 1,
  /** `+Y` */
  PositiveY: 2,
  /** `-Y` */
  NegativeY: 3,
  /** `+Z` */
  PositiveZ: 4,
  /** `-Z` */
  NegativeZ: 5,
} as const;

/** Union of the six cube-face indices. */
export type CubeFaceIndex = (typeof CubeFace)[keyof typeof CubeFace];

/**
 * A camera rig that renders a scene into the six faces of a cube map.
 *
 * The six faces are children so their `matrixWorld` follows the rig; their
 * local rotations are fixed at construction to look along the six signed axes.
 */
export class CubeCamera extends Object3D {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isCubeCamera: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'CubeCamera';

  /** Render target supplied by the renderer, stored as an opaque handle. */
  public renderTarget: unknown = null;

  /** Shared near plane distance of every face. */
  public near: number;

  /** Shared far plane distance of every face. */
  public far: number;

  /** Creates the rig and its six `fov: 90` faces. */
  constructor(options: CubeCameraOptions = {}) {
    super(options);
    this.near = options.near ?? 0.1;
    this.far = options.far ?? 1000;
    if (options.renderTarget !== undefined) this.renderTarget = options.renderTarget;
    for (let face = 0; face < 6; face++) {
      this.addFace(face as CubeFaceIndex);
    }
  }

  /** Returns the face camera at `index` (`0`..`5`). */
  public getFace(index: CubeFaceIndex): PerspectiveCamera {
    return this.children[index] as PerspectiveCamera;
  }

  /** The six face cameras, in `CubeFace` order. */
  public get faces(): PerspectiveCamera[] {
    return this.children as PerspectiveCamera[];
  }

  /**
   * Orients the six faces and asks `renderer` to render them.
   *
   * @param renderer Anything implementing {@link CubeRenderHost}.
   * @param scene Scene to render into the cube map.
   * @param target Render target override; defaults to {@link CubeCamera.renderTarget}.
   */
  public update<TCamera, TScene, TTarget>(
    renderer: CubeRenderHost<TCamera, TScene, TTarget> | unknown,
    scene: TScene,
    target?: TTarget,
  ): void {
    this.updateMatrixWorld(true);
    const host = renderer as Partial<CubeRenderHost<TCamera, TScene, TTarget>>;
    if (typeof host.renderToCube !== 'function') return;

    const resolved = (target ?? this.renderTarget) as TTarget;
    for (let face = 0; face < 6; face++) {
      const camera = this.children[face] as PerspectiveCamera;
      camera.updateWorldMatrix(true, false);
      host.renderToCube(camera as unknown as TCamera, scene, resolved);
    }
  }

  /** Applies the given near/far planes to every face. */
  public setClipPlanes(near: number, far: number): this {
    this.near = near;
    this.far = far;
    for (const child of this.children) {
      const face = child as PerspectiveCamera;
      face.near = near;
      face.far = far;
      face.updateProjectionMatrix();
    }
    return this;
  }

  /** Copies the six face cameras from `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof CubeCamera) {
      this.near = source.near;
      this.far = source.far;
      this.renderTarget = source.renderTarget;
      for (let face = 0; face < 6; face++) {
        const target = this.children[face] as PerspectiveCamera | undefined;
        const origin = source.children[face] as PerspectiveCamera | undefined;
        if (target && origin) target.copy(origin, false);
      }
    }
    return this;
  }

  /** Returns a new rig with the same clip planes. */
  public override clone(recursive = true): CubeCamera {
    return new CubeCamera({ near: this.near, far: this.far, renderTarget: this.renderTarget });
  }

  /** Creates, positions and rotates one face camera. */
  private addFace(face: CubeFaceIndex): void {
    const camera = new PerspectiveCamera({
      fov: 90,
      aspect: 1,
      near: this.near,
      far: this.far,
      name: `cube-face-${face}`,
    });
    camera.up.set(0, 1, 0);
    switch (face) {
      case CubeFace.PositiveX:
        camera.rotateY(Math.PI / 2);
        break;
      case CubeFace.NegativeX:
        camera.rotateY(-Math.PI / 2);
        break;
      case CubeFace.PositiveY:
        camera.rotateX(-Math.PI / 2);
        break;
      case CubeFace.NegativeY:
        camera.rotateX(Math.PI / 2);
        break;
      case CubeFace.PositiveZ:
        // A camera already looks down -Z, so the +Z face is the identity.
        break;
      default:
        camera.rotateY(Math.PI);
        break;
    }
    this.add(camera);
  }
}
