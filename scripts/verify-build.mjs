#!/usr/bin/env node
/**
 * Verifies the artefacts produced by `pnpm build`.
 *
 * A build that "succeeds" can still ship something unusable: an empty ES module,
 * a CJS file that cannot be `require`d, declarations that do not resolve, or a
 * bundle that accidentally inlined a dependency. This script checks the real
 * files on disk so a broken release fails in CI instead of in a consumer's app.
 *
 * Checks performed:
 *  1. `dist/types/index.d.ts` exists and declares at least one export.
 *  2. `dist/esm/index.js` exists, is non-trivial, and imports no bare specifier
 *     other than Node built-ins (proving there are no runtime dependencies).
 *  3. `dist/cjs/index.cjs` exists, is non-trivial, and `require`s the same way.
 *  4. The ESM entry can actually be imported by Node and exposes the same public
 *     names as the CJS entry (modulo interop wrappers).
 *  5. `package.json` `exports`/`main`/`module`/`types` all point at files that
 *     exist on disk.
 *  6. No source map points outside the package.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative as relativePath, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(import.meta.url);

/** Collected failures; the script exits non-zero when this is non-empty. */
const failures = [];
/** Collected informational lines. */
const notes = [];

/**
 * Records a failure with an actionable message.
 *
 * @param {string} message What is wrong.
 */
function fail(message) {
  failures.push(message);
}

/**
 * Records an informational observation.
 *
 * @param {string} message The observation.
 */
function note(message) {
  notes.push(message);
}

/**
 * Asserts that a path exists and is a file.
 *
 * @param {string} relative Path relative to the package root.
 * @param {string} purpose Human-readable reason, used in the error.
 * @returns {string | null} The absolute path, or `null` when missing.
 */
function requireFile(relative, purpose) {
  const absolute = join(root, relative);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`missing ${relative} (${purpose})`);
    return null;
  }
  return absolute;
}

/* -------------------------------------------------------------------------- */
/* 1. package.json entry points                                               */
/* -------------------------------------------------------------------------- */

const pkgPath = requireFile('package.json', 'package manifest');
const pkg = pkgPath ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};

/** Maps a package.json field name to its declared path. */
const declaredEntryPoints = {
  main: pkg.main,
  module: pkg.module,
  types: pkg.types,
  'exports["."].import': pkg.exports?.['.']?.import,
  'exports["."].require': pkg.exports?.['.']?.require,
  'exports["."].types': pkg.exports?.['.']?.types,
};

for (const [field, declared] of Object.entries(declaredEntryPoints)) {
  if (typeof declared !== 'string') {
    fail(`package.json "${field}" is not a string`);
    continue;
  }
  const relative = declared.replace(/^\.\//, '');
  if (!existsSync(join(root, relative))) {
    fail(`package.json "${field}" points at ${declared}, which does not exist`);
  } else {
    note(`entry point ${field} -> ${declared}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 1b. Layer subpath exports                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Every layer subpath in `exports` must have all three artifacts on disk. Without this
 * the map can advertise `@dxyl/graphics/materials` while the build emitted nothing for
 * it, which surfaces to a consumer as `ERR_PACKAGE_PATH_NOT_EXPORTED` or a missing
 * file rather than as a build failure.
 */
const layerSubpaths = Object.keys(pkg.exports ?? {})
  .filter((key) => key.startsWith('./') && key !== './package.json')
  .sort();

let absentSubpathArtifacts = 0;
for (const subpath of layerSubpaths) {
  const conditions = pkg.exports[subpath];
  for (const condition of ['types', 'import', 'require']) {
    const declared = conditions?.[condition];
    if (typeof declared !== 'string') {
      fail(`package.json exports["${subpath}"] has no "${condition}" condition`);
      continue;
    }
    const relative = declared.replace(/^\.\//, '');
    if (!existsSync(join(root, relative))) {
      fail(`package.json exports["${subpath}"].${condition} points at ${declared}, which does not exist`);
      absentSubpathArtifacts++;
    }
  }
}
if (absentSubpathArtifacts === 0) {
  note(`layer subpaths: ${layerSubpaths.length} declared, all artifacts present`);
}

// The build's entry list and the manifest must agree, or one drifts from the other.
const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
const layersBlock = /const LAYERS = \[([\s\S]*?)\]/.exec(viteConfig);
const builtLayers = layersBlock
  ? [...layersBlock[1].matchAll(/'([a-z0-9]+)'/g)].map((match) => match[1]).sort()
  : [];
const declaredLayers = layerSubpaths.map((subpath) => subpath.slice(2)).sort();
const builtOnly = builtLayers.filter((layer) => !declaredLayers.includes(layer));
const declaredOnly = declaredLayers.filter((layer) => !builtLayers.includes(layer));
if (builtOnly.length > 0) fail(`vite.config.ts builds layer entries absent from package.json exports: ${builtOnly.join(', ')}`);
if (declaredOnly.length > 0) fail(`package.json exports layers that vite.config.ts does not build: ${declaredOnly.join(', ')}`);
if (builtOnly.length === 0 && declaredOnly.length === 0) {
  note(`layer entries: vite.config.ts and package.json exports agree (${declaredLayers.length})`);
}

/* -------------------------------------------------------------------------- */
/* 2. Declaration file                                                        */
/* -------------------------------------------------------------------------- */

const typesPath = requireFile('dist/types/index.d.ts', 'type declarations');
if (typesPath) {
  const declaration = readFileSync(typesPath, 'utf8');
  const exportCount = (declaration.match(/\bexport\b/g) ?? []).length;
  if (exportCount === 0) {
    fail('dist/types/index.d.ts contains no `export` statements');
  } else {
    note(`declarations: ${exportCount} export statements, ${declaration.split('\n').length} lines`);
  }
  if (/from ['"][^./]/.test(declaration) && !/from ['"](node:|@types)/.test(declaration)) {
    note('declarations reference a bare specifier; confirm it is types-only');
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Bundles                                                                 */
/* -------------------------------------------------------------------------- */

/** Bare specifiers that are allowed in the emitted bundles. */
const allowedBareSpecifiers = new Set(['node:process', 'node:buffer', 'node:util']);

/**
 * Extracts every bare (non-relative, non-absolute) import specifier.
 *
 * @param {string} source Bundle source text.
 * @returns {string[]} Unique bare specifiers.
 */
function bareSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('data:')) {
        found.add(specifier);
      }
    }
  }
  return [...found];
}

for (const [relative, label] of [
  ['dist/esm/index.js', 'ESM'],
  ['dist/cjs/index.cjs', 'CJS'],
]) {
  const file = requireFile(relative, `${label} bundle`);
  if (!file) continue;

  const source = readFileSync(file, 'utf8');
  const size = statSync(file).size;
  if (size < 4096) {
    fail(`${relative} is only ${size} bytes; the bundle looks empty or truncated`);
  } else {
    note(`${label} bundle: ${(size / 1024).toFixed(1)} kB`);
  }

  const external = bareSpecifiers(source).filter((specifier) => !allowedBareSpecifiers.has(specifier));
  if (external.length > 0) {
    fail(
      `${relative} imports external packages (${external.join(', ')}); the library must have no runtime dependencies`,
    );
  }
  if (!source.includes('export') && !source.includes('exports.')) {
    fail(`${relative} does not export anything`);
  }
}

/* -------------------------------------------------------------------------- */
/* 4. The ESM bundle must actually load                                       */
/* -------------------------------------------------------------------------- */

const esmEntry = join(root, 'dist/esm/index.js');
if (existsSync(esmEntry)) {
  try {
    const imported = await import(pathToFileURL(esmEntry).href);
    const names = Object.keys(imported).filter((name) => name !== 'default');
    if (names.length < 50) {
      fail(`dist/esm/index.js exposes only ${names.length} named exports; expected the full public API`);
    } else {
      note(`ESM loads and exposes ${names.length} named exports`);
    }

    // A representative check that the layers really are wired up.
    const expected = ['Vec3', 'Mat4', 'BufferGeometry', 'Mesh', 'Scene', 'Color', 'Clock'];
    const missing = expected.filter((name) => !(name in imported));
    if (missing.length > 0) {
      fail(`dist/esm/index.js is missing expected exports: ${missing.join(', ')}`);
    }
  } catch (error) {
    fail(`dist/esm/index.js failed to import: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 5. The CJS bundle must actually require                                    */
/* -------------------------------------------------------------------------- */

const cjsEntry = join(root, 'dist/cjs/index.cjs');
if (existsSync(cjsEntry)) {
  try {
    const required = require(cjsEntry);
    const names = Object.keys(required);
    if (names.length < 50) {
      fail(`dist/cjs/index.cjs exposes only ${names.length} exports; expected the full public API`);
    } else {
      note(`CJS loads and exposes ${names.length} exports`);
    }
  } catch (error) {
    fail(`dist/cjs/index.cjs failed to require: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 6. Source maps must not escape the package                                 */
/* -------------------------------------------------------------------------- */

/*
 * Source-map `sources` are relative to the **map file**, not to the package root, so
 * a bundled map legitimately says `../../src/version.ts` to point at the source in
 * `src/`. Treating any `..` segment as an escape would reject every correct map. The
 * check therefore resolves each entry against the map's own directory and only
 * rejects what lands outside the package root (or is an absolute path outside it).
 */
const isInside = (parent, candidate) => {
  const relative = relativePath(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !isAbsolute(relative);
};

/**
 * Collects every `.map` file under a directory.
 *
 * The build emits one map per module (the umbrella entry is now a thin re-export, so
 * checking only `dist/esm/index.js.map` would inspect a single source and pass no
 * matter what the other several hundred maps contained).
 *
 * @param {string} directory Directory to walk.
 * @param {string[]} out Accumulator.
 * @returns {string[]} Absolute map paths.
 */
function collectSourceMaps(directory, out = []) {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectSourceMaps(path, out);
    else if (entry.name.endsWith('.map')) out.push(path);
  }
  return out;
}

const sourceMaps = [...collectSourceMaps(join(root, 'dist', 'esm')), ...collectSourceMaps(join(root, 'dist', 'cjs'))];

if (sourceMaps.length === 0) {
  note('no source maps present (source maps disabled?)');
} else {
  let escapedTotal = 0;
  let sourceTotal = 0;
  const escapedSamples = [];
  const mapsWithoutSources = [];

  for (const mapPath of sourceMaps) {
    let map;
    try {
      map = JSON.parse(readFileSync(mapPath, 'utf8'));
    } catch {
      fail(`${relativePath(root, mapPath)} is not valid JSON`);
      continue;
    }
    const sources = map.sources ?? [];
    sourceTotal += sources.length;
    // A map with no sources explains nothing; it usually means the transform dropped
    // the association rather than that the file is a re-export.
    if (sources.length === 0 && !readFileSync(mapPath.replace(/\.map$/, ''), 'utf8').includes('export')) {
      mapsWithoutSources.push(relativePath(root, mapPath));
    }
    for (const source of sources) {
      if (isInside(root, resolve(dirname(mapPath), source))) continue;
      escapedTotal++;
      if (escapedSamples.length < 3) escapedSamples.push(`${relativePath(root, mapPath)} -> ${source}`);
    }
  }

  if (escapedTotal > 0) {
    fail(`${escapedTotal} source-map entries reference files outside the package: ${escapedSamples.join(', ')}`);
  } else {
    note(`source maps: ${sourceMaps.length} maps, ${sourceTotal} sources, all inside the package`);
  }
  for (const map of mapsWithoutSources.slice(0, 3)) {
    note(`${map} has no sources (a thin re-export, presumably)`);
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

for (const line of notes) console.log(`  ok   ${line}`);

if (failures.length > 0) {
  console.error('');
  for (const line of failures) console.error(`  FAIL ${line}`);
  console.error(`\nBuild verification failed with ${failures.length} problem(s).`);
  process.exit(1);
}

console.log('\nBuild verification passed.');
