import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * Verifies that the package's brand is consistent everywhere it is observable.
 *
 * A rename like `@lyf/graphics` -> `@dxyl/graphics` is mostly a string replacement,
 * but the brand appears in several *independent* forms, each with its own failure
 * mode:
 *
 * | Form | Where it is observed | What a stale copy breaks |
 * | --- | --- | --- |
 * | `@dxyl/graphics` | imports, install snippets, docs | a copy-pasted import fails to resolve |
 * | `DXYL` | the namespace export | `import { DXYL }` is `undefined` |
 * | `data-dxyl-*` | the SVG renderer's DOM | user CSS selectors stop matching |
 * | `__dxylWillReadFrequently` | a canvas property read across two modules | the hint is silently ignored |
 * | `__DXYL_GRAPHICS__` | `window` augmentations | an embedder's opt-in flag is never seen |
 *
 * Checking only the package name would leave all of the others free to drift, so this
 * script derives the expected scope from `package.json` and then asserts that every
 * brand token agrees with it. It deliberately does **not** police `LYF_TEST_LOG` or
 * the playground's download filename, which the rename left alone on purpose.
 */

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
process.chdir(root);

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const scope = manifest.name.startsWith('@') ? manifest.name.split('/')[0] : null;
if (scope === null) {
  console.error(`package.json name "${manifest.name}" is not scoped`);
  process.exit(1);
}

/** `@dxyl` -> `dxyl`. */
const slug = scope.slice(1);
/** `dxyl` -> `DXYL`. */
const upper = slug.toUpperCase();

console.log(`package: ${manifest.name}`);
console.log(`scope:   ${scope}`);
console.log(`slug:    ${slug}`);
console.log(`upper:   ${upper}\n`);

const extensions = ['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.yml', '.yaml', '.css'];
const skippedDirectories = new Set(['node_modules', 'dist', 'coverage', '.git']);
const selfExcluded = new Set([relative(root, new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).replace(/\\/g, '/')]);

/*
 * `CHANGELOG.md` is exempt, and that is not a loophole: a changelog's job is to name
 * the *previous* identifiers so a reader knows what to update. Requiring it to contain
 * only current names would make it useless for precisely the entries that matter.
 * Every other file must agree with `package.json`.
 */
const changelogExempt = new Set(['CHANGELOG.md']);

/** Collects candidate files as POSIX-ish relative paths. */
function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(relative(root, path).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * Brand patterns whose canonical form must match the scope.
 *
 * Each entry maps a regex with the brand captured to a function producing the
 * expected text from `slug`/`upper`.
 */
const checks = [
  {
    label: 'package scope in a specifier or install snippet',
    regex: /@([a-z0-9][a-z0-9-]*)\/graphics/g,
    expected: () => slug,
    note: 'every `@scope/graphics` occurrence must use the current scope',
  },
  {
    label: 'SVG DOM attribute',
    regex: /data-([a-z0-9][a-z0-9-]*)-(?:renderer|background|world|node)/g,
    expected: () => slug,
    note: 'these are a public DOM contract',
  },
  {
    label: 'canvas hint property',
    regex: /__([a-z0-9][a-z0-9]*)(?=WillReadFrequently)/g,
    expected: () => slug,
    note: 'written by createCanvas, read by getContext',
  },
];

const violations = [];
let scanned = 0;
let observations = 0;

for (const file of walk('.')) {
  if (selfExcluded.has(file) || changelogExempt.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned++;

  for (const { label, regex, expected, note } of checks) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      observations++;
      const found = match[1];
      const want = expected();
      if (found !== want) {
        const line = text.slice(0, match.index).split('\n').length;
        violations.push({ file, line, label, found: match[0], want, note });
      }
    }
  }

  // The namespace export and the global flag use the upper-cased slug.
  const upperPatterns = [
    { regex: /export \* as ([A-Z][A-Z0-9_]*) from '\.\/namespace'/g, what: 'namespace export' },
    { regex: /__([A-Z][A-Z0-9_]*)_GRAPHICS__/g, what: 'global flag' },
  ];
  for (const { regex, what } of upperPatterns) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      observations++;
      if (match[1] !== upper) {
        const line = text.slice(0, match.index).split('\n').length;
        violations.push({ file, line, label: what, found: match[0], want: upper, note: `expected ${upper}` });
      }
    }
  }
}

console.log(`scanned ${scanned} files, ${observations} brand observations`);
if (violations.length === 0) {
  console.log(`brand: consistent (every token agrees with ${manifest.name})`);
} else {
  console.log(`brand: ${violations.length} inconsistent token(s)\n`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  ${v.label}`);
    console.log(`      found "${v.found}", expected "${v.want}"  (${v.note})`);
  }
  process.exitCode = 1;
}
