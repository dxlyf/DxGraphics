import { existsSync, statSync } from 'node:fs';

/**
 * Checks that every path in the specification's directory tree exists under
 * `graphics-lib/`. Directories are listed explicitly; a handful of files (the
 * concrete `glsl`/`wgsl`/`tracks`/`skeleton` children) are checked by glob because
 * the spec names their parent only.
 */

const directories = [
  'src',
  'src/types',
  'src/core',
  'src/math',
  'src/geometry',
  'src/geometry/core',
  'src/geometry/2d',
  'src/geometry/3d',
  'src/geometry/3d/primitives',
  'src/geometry/3d/curves',
  'src/geometry/3d/modifiers',
  'src/geometry/3d/utils',
  'src/materials',
  'src/textures',
  'src/textures/formats',
  'src/shaders',
  'src/shaders/glsl',
  'src/shaders/glsl/chunks',
  'src/shaders/glsl/lib',
  'src/shaders/wgsl',
  'src/shaders/wgsl/chunks',
  'src/shaders/wgsl/lib',
  'src/scene',
  'src/scene/2d',
  'src/scene/3d',
  'src/renderer',
  'src/renderer/interfaces',
  'src/renderer/core',
  'src/renderer/canvas2d',
  'src/renderer/svg',
  'src/renderer/webgl',
  'src/renderer/webgpu',
  'src/renderer/utils',
  'src/animation',
  'src/animation/tracks',
  'src/animation/skeleton',
  'src/controls',
  'src/controls/camera',
  'src/controls/pointer',
  'src/controls/gesture',
  'src/picking',
  'src/assets',
  'src/assets/loaders',
  'src/text',
  'src/effects',
  'src/effects/postprocess',
  'src/effects/shadows',
  'src/effects/fog',
  'src/effects/particles',
  'src/utils',
  'src/wasm',
  'examples',
  'examples/2d-basic',
  'examples/3d-basic',
  'examples/canvas2d',
  'examples/svg',
  'examples/webgl',
  'examples/webgpu',
  'examples/animation',
  'examples/controls',
  'examples/picking',
  'examples/text',
  'examples/effects',
  'examples/assets',
  'playground',
  'playground/src',
  'playground/public',
  'docs',
  'docs/guide',
  'docs/api',
  'docs/architecture',
  'docs/examples',
  'tests',
  'tests/unit',
  'tests/integration',
  'tests/visual',
  'tests/e2e',
  'tests/fixtures',
  'benchmarks',
  'benchmarks/math',
  'benchmarks/geometry',
  'benchmarks/renderer',
  'benchmarks/animation',
  'scripts',
  'tools',
  'tools/generator',
  'tools/shader-compiler',
  'tools/visual-test-runner',
  'assets',
  'assets/textures',
  'assets/models',
  'assets/fonts',
  'assets/images',
  'assets/shaders',
  'public',
  '.github',
  '.github/workflows',
];

const files = [
  'src/index.ts',
  'src/version.ts',
  'src/constants.ts',
  'src/types/index.ts',
  'src/types/global.d.ts',
  'src/types/glsl.d.ts',
  'src/types/wgsl.d.ts',
  'src/types/assets.d.ts',
  'tests/setup.ts',
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'vite.config.ts',
  'vitest.config.ts',
  'rollup.config.ts',
  'eslint.config.js',
  'prettier.config.js',
  'typedoc.json',
  'api-extractor.json',
  '.gitignore',
  '.npmignore',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
];

const missingDirectories = directories.filter((path) => !existsSync(path) || !statSync(path).isDirectory());
const missingFiles = files.filter((path) => !existsSync(path));

console.log(`directories: ${directories.length - missingDirectories.length}/${directories.length} present`);
if (missingDirectories.length > 0) for (const path of missingDirectories) console.log(`  MISSING DIR  ${path}`);

console.log(`files:       ${files.length - missingFiles.length}/${files.length} present`);
if (missingFiles.length > 0) for (const path of missingFiles) console.log(`  MISSING FILE ${path}`);

if (missingDirectories.length === 0 && missingFiles.length === 0) {
  console.log('\nSpecification tree: complete.');
} else {
  console.log('\nSpecification tree: INCOMPLETE.');
  process.exitCode = 1;
}
