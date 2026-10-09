/**
 * `LineSegments` - disconnected pairs of vertices.
 *
 * Identical to `Line` except for the pairing rule: vertices are read as
 * `(0,1)`, `(2,3)`, `(4,5)`, ... so every segment is independent.
 *
 * @packageDocumentation
 */

import { Line } from './Line';
import { indexItemCount, indexValueAt, lineThreshold } from '../internal/raycast';
import type { Intersects } from './types';
import type { RaycasterLike } from './types';

/** A line whose segments are not connected to one another. */
export class LineSegments extends Line {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isLineSegments: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'LineSegments';

  /** Returns a clone of this line; geometry and material are shared. */
  public override clone(recursive = true): LineSegments {
    const clone = new LineSegments().copy(this, recursive) as LineSegments;
    clone.linewidth = this.linewidth;
    return clone;
  }

  /**
   * Intersects `raycaster` with every `(2i, 2i + 1)` vertex pair.
   *
   * Indexed geometry is read the same way, so the index buffer describes pairs
   * rather than a strip.
   */
  public override raycast(raycaster: RaycasterLike, intersects: Intersects): void {
    const position = this.positionAttribute();
    if (!position || !this.prepareRaycast(raycaster)) return;

    const thresholdSquared = Math.pow(lineThreshold(raycaster), 2);
    const index = this.geometryData?.index;
    const vertexCount = position.count ?? Math.floor(position.array.length / position.itemSize);

    if (index) {
      const pairCount = Math.floor(indexItemCount(index) / 2);
      for (let pair = 0; pair < pairCount; pair++) {
        this.testSegment(
          raycaster,
          position,
          indexValueAt(index, pair * 2),
          indexValueAt(index, pair * 2 + 1),
          thresholdSquared,
          intersects,
        );
      }
      return;
    }

    const pairCount = Math.floor(vertexCount / 2);
    for (let pair = 0; pair < pairCount; pair++) {
      this.testSegment(raycaster, position, pair * 2, pair * 2 + 1, thresholdSquared, intersects);
    }
  }
}
