#!/usr/bin/env -S node --experimental-strip-types
/**
 * Module scaffolder.
 *
 * Generates a new library module (or a single class file inside one) from the templates
 * in `templates/`, following the conventions the rest of `src/` uses: a JSDoc
 * `@packageDocumentation` header, a barrel `index.ts`, a `types.ts` for cross-layer
 * vocabulary, and a matching unit test.
 *
 * ## Usage
 *
 * ```bash
 * # A new module directory, src/widgets/, with index.ts + types.ts + Widget.ts + test
 * node --experimental-strip-types tools/generator/generate.ts module widgets
 *
 * # A single class inside an existing module
 * node --experimental-strip-types tools/generator/generate.ts class src/widgets Gauge
 *
 * # See what would be written without writing anything
 * node --experimental-strip-types tools/generator/generate.ts module widgets --dry-run
 *
 * # Overwrite existing files
 * node --experimental-strip-types tools/generator/generate.ts module widgets --force
 * ```
 *
 * There is no build step and no runtime dependency: the script is plain TypeScript that
 * Node 22 runs directly through type stripping. It refuses to overwrite an existing file
 * unless `--force` is passed, so a mis-typed name cannot clobber work.
 *
 * ## What it deliberately does not do
 *
 * It does not edit `src/index.ts`. Adding a new layer to the public barrel is a decision
 * with API-extractor and release consequences, so the script prints the exact line to add
 * instead of guessing where it belongs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/** Directory containing this script. */
const toolsDir = dirname(fileURLToPath(import.meta.url));

/** Repository root (`graphics-lib/`). */
const repoRoot = resolve(toolsDir, '..', '..');

/** Template directory. */
const templateDir = join(toolsDir, 'templates');

/** Where a `module` scaffold is created. */
const srcDir = join(repoRoot, 'src');

/** Where the generated unit test is created. */
const unitTestDir = join(repoRoot, 'tests', 'unit');

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

type Command = 'module' | 'class' | 'help';

interface Options {
  readonly command: Command;
  /** Module name (for `module`) or the module path (for `class`). */
  readonly target: string;
  /** Class name (for `class`). */
  readonly className: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly withTypes: boolean;
  readonly withTest: boolean;
}

/** Prints usage and exits. */
function printUsage(): void {
  process.stdout.write(
    [
      'generate — scaffold a library module or class from templates',
      '',
      'Usage:',
      '  generate module <name> [--no-types] [--no-test] [--dry-run] [--force]',
      '  generate class <module-path> <ClassName> [--dry-run] [--force]',
      '',
      'Options:',
      '  --dry-run    Print the files that would be written, write nothing.',
      '  --force      Overwrite files that already exist.',
      '  --no-types   Skip types.ts (module command).',
      '  --no-test    Skip the unit test (module command).',
      '  -h, --help   Show this message.',
      '',
      'Examples:',
      '  generate module widgets',
      '  generate class src/widgets Gauge',
      '',
    ].join('\n'),
  );
}

/** Parses `process.argv`, exiting on anything unrecognised. */
function parseArgs(argv: readonly string[]): Options {
  const positional: string[] = [];
  let dryRun = false;
  let force = false;
  let withTypes = true;
  let withTest = true;

  for (const arg of argv) {
    switch (arg) {
      case '--dry-run':
        dryRun = true;
        break;
      case '--force':
        force = true;
        break;
      case '--no-types':
        withTypes = false;
        break;
      case '--no-test':
        withTest = false;
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`generate: unknown option '${arg}'\n`);
          printUsage();
          process.exit(2);
        }
        positional.push(arg);
    }
  }

  const [command, ...rest] = positional;
  if (command === undefined) {
    printUsage();
    process.exit(2);
  }

  if (command === 'module') {
    const name = rest[0];
    if (name === undefined) {
      process.stderr.write('generate: `module` needs a name\n');
      process.exit(2);
    }
    return { command: 'module', target: name, className: '', dryRun, force, withTypes, withTest };
  }

  if (command === 'class') {
    const modulePath = rest[0];
    const className = rest[1];
    if (modulePath === undefined || className === undefined) {
      process.stderr.write('generate: `class` needs a module path and a class name\n');
      process.exit(2);
    }
    return { command: 'class', target: modulePath, className, dryRun, force, withTypes, withTest };
  }

  process.stderr.write(`generate: unknown command '${command}'\n`);
  printUsage();
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* Naming helpers                                                             */
/* -------------------------------------------------------------------------- */

/** `my-module` / `my_module` -> `myModule`. */
function toCamelCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join('');
}

/** `my-module` / `myModule` -> `MyModule`. */
function toPascalCase(value: string): string {
  const camel = toCamelCase(value);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** `MyWidget` -> `my-widget`. */
function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/** Validates a module or class name, exiting with a clear message when it is unusable. */
function assertIdentifier(value: string, what: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
    process.stderr.write(
      `generate: ${what} '${value}' is not a valid TypeScript identifier ` +
        '(letters and digits, starting with a letter)\n',
    );
    process.exit(2);
  }
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

/** Reads a template file, failing loudly when it is missing. */
function readTemplate(name: string): string {
  const path = join(templateDir, name);
  if (!existsSync(path)) {
    process.stderr.write(
      `generate: template '${name}' is missing from ${templateDir}. ` +
        'Reinstall the repository or restore tools/generator/templates/.\n',
    );
    process.exit(1);
  }
  return readFileSync(path, 'utf8');
}

/** Substitutes `{{token}}` placeholders. Unknown tokens are left visible on purpose. */
function render(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, token: string) => tokens[token] ?? match);
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

interface PendingFile {
  readonly path: string;
  readonly contents: string;
}

/** Writes every pending file, honouring `--dry-run` and `--force`. */
function writeAll(files: readonly PendingFile[], options: Options): void {
  let written = 0;
  let skipped = 0;

  for (const file of files) {
    const relative = file.path.slice(repoRoot.length + 1).replace(/\\/g, '/');
    const exists = existsSync(file.path);

    if (exists && !options.force) {
      process.stdout.write(`  skip    ${relative}  (exists; pass --force to overwrite)\n`);
      skipped++;
      continue;
    }
    if (options.dryRun) {
      process.stdout.write(`  would   ${relative}  (${file.contents.length} bytes)\n`);
      written++;
      continue;
    }

    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents, 'utf8');
    process.stdout.write(`  write   ${relative}\n`);
    written++;
  }

  process.stdout.write(
    `\n${options.dryRun ? 'Would write' : 'Wrote'} ${written} file(s)` +
      (skipped > 0 ? `, skipped ${skipped} existing file(s)` : '') +
      '.\n',
  );
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

/** Scaffolds `src/<name>/` plus a unit test. */
function generateModule(rawName: string, options: Options): void {
  const kebab = toKebabCase(rawName);
  const className = toPascalCase(rawName);
  const camel = toCamelCase(rawName);
  assertIdentifier(className, 'module name');

  const moduleDir = join(srcDir, kebab);
  if (existsSync(moduleDir) && !options.force) {
    process.stdout.write(
      `Module directory src/${kebab}/ already exists. Files inside it will be skipped ` +
        'unless --force is passed.\n\n',
    );
  }

  const tokens = {
    NAME_KEBAB: kebab,
    NAME_CAMEL: camel,
    NAME_PASCAL: className,
    VERSION: readPackageVersion(),
  };

  const files: PendingFile[] = [
    { path: join(moduleDir, 'index.ts'), contents: render(readTemplate('module-index.ts.tpl'), tokens) },
    {
      path: join(moduleDir, `${className}.ts`),
      contents: render(readTemplate('class.ts.tpl'), tokens),
    },
  ];

  if (options.withTypes) {
    files.push({
      path: join(moduleDir, 'types.ts'),
      contents: render(readTemplate('types.ts.tpl'), tokens),
    });
  }
  if (options.withTest) {
    files.push({
      path: join(unitTestDir, `${kebab}.test.ts`),
      contents: render(readTemplate('unit-test.ts.tpl'), tokens),
    });
  }

  process.stdout.write(`Scaffolding module src/${kebab}/ (class ${className})\n\n`);
  writeAll(files, options);

  process.stdout.write(
    [
      '',
      'Next steps:',
      `  1. Export the layer from src/index.ts by adding:`,
      `       export * from './${kebab}';`,
      `     (this script does not edit the public barrel; adding a layer affects the`,
      `      API-extractor report and the release, so that stays a deliberate edit)`,
      `  2. Implement ${className} in src/${kebab}/${className}.ts`,
      `  3. Run: pnpm exec vitest run tests/unit/${kebab}.test.ts`,
      `  4. Run: pnpm exec tsc -p tsconfig.json --noEmit`,
      '',
    ].join('\n'),
  );
}

/** Scaffolds a single class file inside an existing module. */
function generateClass(modulePath: string, rawClassName: string, options: Options): void {
  const className = toPascalCase(rawClassName);
  assertIdentifier(className, 'class name');

  const absoluteModule = resolve(repoRoot, modulePath);
  if (!existsSync(absoluteModule)) {
    process.stderr.write(
      `generate: module path '${modulePath}' does not exist (resolved to ${absoluteModule})\n`,
    );
    process.exit(1);
  }

  const tokens = {
    NAME_KEBAB: toKebabCase(className),
    NAME_CAMEL: toCamelCase(className),
    NAME_PASCAL: className,
    VERSION: readPackageVersion(),
  };

  const files: PendingFile[] = [
    {
      path: join(absoluteModule, `${className}.ts`),
      contents: render(readTemplate('class.ts.tpl'), tokens),
    },
    {
      path: join(unitTestDir, `${toKebabCase(className)}.test.ts`),
      contents: render(readTemplate('unit-test.ts.tpl'), tokens),
    },
  ];

  process.stdout.write(`Scaffolding class ${className} in ${modulePath}\n\n`);
  writeAll(files, options);

  const barrel = join(absoluteModule, 'index.ts');
  if (existsSync(barrel)) {
    process.stdout.write(
      [
        '',
        'Next step:',
        `  Add to ${barrel.slice(repoRoot.length + 1).replace(/\\/g, '/')}:`,
        `       export * from './${className}';`,
        '',
      ].join('\n'),
    );
  }
}

/** Reads `version` out of package.json without importing it as a module. */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === 'string'
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    /* fall through to the placeholder below */
  }
  return '0.0.0';
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'module') generateModule(options.target, options);
  else generateClass(options.target, options.className, options);
}

main();
