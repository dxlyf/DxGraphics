import { readFileSync, readdirSync } from 'node:fs';

/**
 * Sweeps the repository for mojibake: UTF-8 bytes that were decoded as CP1252 and
 * re-encoded, turning `—` (E2 80 94) into `â€"` and so on.
 *
 * A round trip through PowerShell's `Get-Content`/`Set-Content` with the default
 * encoding does this to every 3-byte character, and the damage is invisible in a
 * terminal that renders both forms as something plausible. The detector looks for the
 * characteristic leading bytes (`Ã`, `â€`, `Â`, `ï»¿`) rather than for specific
 * words, so it also catches characters nobody thought to check.
 */

const suspicious = [
  { marker: 'â€', meaning: 'em dash / en dash / curly quotes (E2 80 xx)' },
  { marker: 'Ã', meaning: 'any 2-byte UTF-8 lead byte (C3 xx)' },
  { marker: 'Â', meaning: 'non-breaking space or Latin-1 supplement (C2 xx)' },
  { marker: 'ï»¿', meaning: 'UTF-8 BOM read as CP1252' },
  { marker: 'å', meaning: '3-byte sequence (E5 xx xx)' },
  { marker: 'æ', meaning: '3-byte sequence (E6 xx xx)' },
  { marker: 'ç', meaning: '3-byte sequence (E7 xx xx)' },
  { marker: '\uFFFD', meaning: 'replacement character — a byte was already lost' },
];

/** Extensions worth scanning. */
const extensions = ['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.yml', '.yaml'];

/** Directories to skip. */
const skipped = new Set(['node_modules', 'dist', 'coverage', '.git', 'assets']);

/**
 * Files that must be skipped because they *contain* the markers by design.
 *
 * This detector has to spell out each mojibake sequence to look for it, so scanning
 * itself always reports a hit. Excluding it here is the difference between a check
 * that is useful in CI and one that always fails.
 */
const selfExcluded = new Set(['scripts/verify-encoding.mjs']);

/** Collects every candidate file. */
function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = `${directory}/${entry.name}`.replace(/^\.\//, '');
    if (entry.isDirectory()) walk(path, out);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(path);
  }
  return out;
}

const files = walk('.').filter((file) => !selfExcluded.has(file));
const hits = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { marker, meaning } of suspicious) {
      const column = lines[i].indexOf(marker);
      if (column === -1) continue;
      hits.push({ file, line: i + 1, column: column + 1, marker, meaning, text: lines[i].trim().slice(0, 110) });
      break; // one report per line is enough
    }
  }
}

console.log(`scanned ${files.length} files`);
if (hits.length === 0) {
  console.log('encoding: clean (no mojibake markers found)');
} else {
  console.log(`encoding: ${hits.length} suspicious line(s)\n`);
  const byFile = new Map();
  for (const hit of hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, []);
    byFile.get(hit.file).push(hit);
  }
  for (const [file, fileHits] of byFile) {
    console.log(`${file}  (${fileHits.length})`);
    for (const hit of fileHits.slice(0, 6)) {
      console.log(`  ${hit.line}:${hit.column} [${hit.marker}] ${hit.text}`);
    }
    if (fileHits.length > 6) console.log(`  ... and ${fileHits.length - 6} more`);
  }
  process.exitCode = 1;
}
