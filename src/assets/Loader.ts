/**
 * `Loader` — re-exported from `loaders/Loader`, where the class is declared.
 *
 * The base class lives with the concrete loaders because it is meaningless without
 * them, but `src/assets/Loader.ts` exists so that the documented import path works:
 *
 * ```ts
 * import { Loader } from '@/assets/Loader';   // resolves here
 * import { Loader } from '@/assets';          // also works, via the barrel
 * ```
 *
 * @packageDocumentation
 */

export {
  Loader,
  LoadAbortError,
  isAbortError,
  assetKey,
} from './loaders/Loader';

export type {
  LoaderEvents,
  LoadedSource,
  LoaderStats,
} from './loaders/Loader';
