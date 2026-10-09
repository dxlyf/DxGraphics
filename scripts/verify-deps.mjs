import { readFileSync, readdirSync } from 'node:fs';

/**
 * Confirms the library has no **runtime** dependency: nothing under `src/` may
 * import a bare specifier that is not a Node builtin.
 *
 * A bare specifier is anything that is not a relative path, an absolute path or a
 * URL. The spec requires the library to be dependency-free, and a stray
 * `import ... from 'lodash'` in one file would be easy to miss in review but fatal
 * for every consumer.
 *
 * ## Why the patterns look like that
 *
 * A naive `[^;\n]*?from\s*['"]` produces false positives on ordinary code:
 * `export type TweenStepKind = 'to' | 'from' | 'by' | 'fromTo';` contains the word
 * `from` inside a string literal, and that form matches across it to the `' | '`
 * which follows. The patterns below refuse to cross a quote between the `import`
 * keyword and the `from` clause, so a match can only be a real import clause.
 *
 * The authoritative check of the same property is `scripts/verify-build.mjs`, which
 * inspects the **emitted bundle** — the artefact a consumer actually loads. This
 * script checks the sources, where a dependency can be caught before it ever reaches
 * a bundle.
 */

/** Collects every `.ts` file under a directory, recursively. */
function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Extracts every import/export specifier from a source file.
 *
 * @param source TypeScript source.
 * @returns The specifiers, in source order.
 */
function extractSpecifiers(source) {
  const specifiers = [];

  // `import ... from 'x'` / `export ... from 'x'`, refusing to cross a quote before
  // the `from` keyword so a string literal containing the word "from" cannot match.
  const fromClause =
    /^[ \t]*(?:import|export)\b(?:(?!['"`])[^\n])*?\bfrom\s*(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/gm;
  let match;
  while ((match = fromClause.exec(source)) !== null) specifiers.push(match[2]);

  // `import 'x'` — side-effect only.
  const sideEffect = /^[ \t]*import\s*(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/gm;
  while ((match = sideEffect.exec(source)) !== null) specifiers.push(match[2]);

  // `import('x')`
  const dynamic = /\bimport\s*\(\s*(['"])((?:(?!\1)[^\\\n]|\\.)*)\1\s*\)/g;
  while ((match = dynamic.exec(source)) !== null) specifiers.push(match[2]);

  return specifiers;
}

const files = walk('src');
const violations = [];
let scanned = 0;
let total = 0;

for (const file of files) {
  if (!file.endsWith('.ts')) continue;
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned++;

  for (const specifier of extractSpecifiers(source)) {
    total++;
    const isBare =
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('node:') &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(specifier);
    if (isBare) violations.push({ file, specifier });
  }
}

console.log(`scanned ${scanned} TypeScript files, ${total} import/export specifiers`);
if (violations.length === 0) {
  console.log('runtime dependencies: none (every specifier is relative, node: or a URL)');
} else {
  console.log(`runtime dependencies: ${violations.length} bare specifier(s) found`);
  for (const { file, specifier } of violations) console.log(`  ${file}: '${specifier}'`);
  process.exitCode = 1;
}
