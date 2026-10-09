/**
 * Renderer hot-path benchmarks.
 *
 * These bench the CPU-side per-frame work: bucketing renderables into a `RenderList`,
 * sorting them in a `RenderQueue`, and the scene-graph traversal that feeds them. No GPU
 * context is created, so this runs anywhere.
 *
 * Run with `pnpm bench`. Inputs are constructed **outside** the `bench` callbacks.
 *
 * ## How to read the numbers
 *
 * `hz` is operations per second, `mean` is milliseconds per operation. One "operation"
 * here is a **whole frame's** queue work for the stated object count, which is the
 * useful unit: 1 000 objects is a heavy scene, and its sort should stay well under a
 * frame's 16.7 ms budget.
 *
 * The two benches to compare are **`RenderQueue.sort` and `RenderQueue.sort` with
 * material grouping disabled**: they differ only in one comparator branch, so the gap
 * between them is the cost of state-change minimisation.
 *
 * ## What would regress these
 *
 * - **`RenderList.push`** — allocating a fresh entry per submission instead of recycling
 *   from the pool; the `reset()` bench exists precisely to catch that.
 * - **`RenderQueue.sort`** — sorting the list's own buckets in place instead of a copy
 *   (which breaks the documented submission-order guarantee *and* is slower because it
 *   defeats the engine's sort fast paths on a stable array), or dropping the
 *   `sequence` tie-break (unstable output, not merely slower).
 * - **`Node.traverse`** — replacing the indexed `for` loop with `forEach` or
 *   `for…of`, both of which allocate an iterator per level.
 * - **`Node.updateMatrixWorld`** — recomputing a child's world matrix when the parent
 *   did not change.
 */

import { bench, describe } from 'vitest';

import { Node } from '../../src/core/Node';
import { RenderList, type Renderable2D } from '../../src/renderer/core/RenderList';
import { RenderQueue } from '../../src/renderer/core/RenderQueue';

/* -------------------------------------------------------------------------- */
/* Pre-built renderables                                                      */
/* -------------------------------------------------------------------------- */

/** The renderable shape a scene node exposes to the renderer. */
class FakeRenderable implements Renderable2D {
  public visible = true;
  public readonly render = (): void => undefined;
  public readonly material: { id: string; transparent?: boolean } | null;

  public constructor(
    public readonly id: number,
    public renderOrder: number,
    public depth: number,
    materialId: string,
    transparent: boolean,
  ) {
    this.material = { id: materialId, transparent };
  }
}

/**
 * Builds a mixed workload: roughly 80% opaque, 15% transparent, 5% explicitly ordered,
 * spread over a small number of materials. That mix is what keeps the queue's secondary
 * and tertiary sort keys exercised rather than degenerate.
 */
function makeRenderables(count: number): FakeRenderable[] {
  const materialCount = Math.max(1, Math.round(count / 40));
  const result: FakeRenderable[] = [];
  for (let i = 0; i < count; i++) {
    const roll = i % 20;
    const transparent = roll === 0 || roll === 1 || roll === 2;
    const renderOrder = roll === 3 ? 1 + (i % 3) : 0;
    result.push(
      new FakeRenderable(
        i,
        renderOrder,
        (i * 37) % 1000,
        `material-${i % materialCount}`,
        transparent,
      ),
    );
  }
  return result;
}

const small = makeRenderables(100);
const medium = makeRenderables(1_000);
const large = makeRenderables(10_000);

/** Pre-built lists, refilled per iteration by `pushAll`. */
const list100 = new RenderList<Renderable2D>();
const list1000 = new RenderList<Renderable2D>();
const list10000 = new RenderList<Renderable2D>();

const queue = new RenderQueue<Renderable2D>();
const queueNoMaterial = new RenderQueue<Renderable2D>({ sortByMaterial: false });

/* -------------------------------------------------------------------------- */
/* RenderList                                                                 */
/* -------------------------------------------------------------------------- */

describe('RenderList bucketing', () => {
  bench('pushAll 1 000 renderables (then reset)', () => {
    // The per-frame collection cost: one bucket decision and one pooled entry per
    // object. `reset()` is included because a frame always ends with one, and it is the
    // place a pooling bug shows up as allocation churn.
    list1000.pushAll(medium);
    list1000.reset();
  });

  bench('pushAll 10 000 renderables (then reset)', () => {
    // Ten times the work at ten times the size, so a super-linear regression (a linear
    // scan of the buckets per push, for example) becomes visible as a worse than 10×
    // ratio against the bench above.
    list10000.pushAll(large);
    list10000.reset();
  });
});

/* -------------------------------------------------------------------------- */
/* RenderQueue                                                                */
/* -------------------------------------------------------------------------- */

describe('RenderQueue sorting', () => {
  bench('sort 100 renderables', () => {
    // The light-scene frame: should be measured in microseconds.
    list100.reset();
    list100.pushAll(small);
    queue.sort(list100);
  });

  bench('sort 1 000 renderables', () => {
    // A realistic mid-size scene. This is the number to watch against the 16.7 ms
    // frame budget: the sort is one of several per-frame costs.
    list1000.reset();
    list1000.pushAll(medium);
    queue.sort(list1000);
  });

  bench('sort 1 000 renderables without material grouping', () => {
    // `sortByMaterial: false` removes one comparison per sort step. The gap between
    // this and the bench above is the price of grouping draws by material to reduce
    // state changes — which is what the option exists to trade away.
    list1000.reset();
    list1000.pushAll(medium);
    queueNoMaterial.sort(list1000);
  });

  bench('sort 10 000 renderables', () => {
    // The stress case. `Array#sort` is O(n log n), so expect roughly 13× the 1 000
    // figure (10× the elements, ~1.3× the log factor) plus the copy overhead.
    list10000.reset();
    list10000.pushAll(large);
    queue.sort(list10000);
  });

  bench('getDrawOrder after sorting 1 000 renderables', () => {
    // Flattening the produced order into indexed entries. Called once per frame by a
    // backend that wants per-bucket boundaries.
    list1000.reset();
    list1000.pushAll(medium);
    queue.sort(list1000);
    queue.getDrawOrder();
  });
});

/* -------------------------------------------------------------------------- */
/* Scene-graph traversal                                                      */
/* -------------------------------------------------------------------------- */

/** Builds a wide-and-deep tree: `breadth` children per node, `depth` levels. */
function makeTree(breadth: number, depth: number): { root: Node; count: number } {
  const root = new Node({ name: 'root' });
  let count = 0;
  let current: Node[] = [root];
  for (let level = 0; level < depth; level++) {
    const next: Node[] = [];
    for (const parent of current) {
      for (let i = 0; i < breadth; i++) {
        const child = new Node({ name: `n${level}-${i}` });
        child.position.set(i, level, 0);
        parent.add(child);
        next.push(child);
        count++;
      }
    }
    current = next;
  }
  return { root, count };
}

const shallow = makeTree(4, 4); // 340 nodes
const deep = makeTree(3, 7); // 3 279 nodes

describe('scene-graph traversal', () => {
  bench('traverse 340-node tree', () => {
    // A single depth-first walk. Regresses if the traversal stops being an indexed loop
    // over `children`.
    let visited = 0;
    shallow.root.traverse(() => {
      visited++;
    });
    void visited;
  });

  bench('traverse 3 279-node tree', () => {
    // Roughly ten times the nodes, so this should be roughly ten times the bench above.
    let visited = 0;
    deep.root.traverse(() => {
      visited++;
      visitAccumulator = visited;
    });
  });

  bench('updateMatrixWorld on 340-node tree', () => {
    // Composes a local matrix and a parent-multiplied world matrix per node. This is the
    // per-frame graph update, and it is where `Mat4.compose`/`multiplyMatrices` costs
    // are actually paid.
    shallow.root.updateMatrixWorld(true);
  });

  bench('updateMatrixWorld on 3 279-node tree', () => {
    // The scale case. Expect roughly ten times the bench above; anything worse points at
    // a per-node allocation.
    deep.root.updateMatrixWorld(true);
  });

  bench('findNodes over 3 279-node tree', () => {
    // Predicate-based search, which collects into a fresh array. Included because it is
    // the pattern applications reach for instead of indexing children themselves.
    deep.root.findNodes((node) => node.name.startsWith('n6'), []);
  });
});

/** Keeps the traversal callback's result observable without changing the hot path. */
let visitAccumulator = 0;
void visitAccumulator;
