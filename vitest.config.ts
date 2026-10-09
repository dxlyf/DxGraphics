import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import glsl from 'vite-plugin-glsl';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [glsl({ minify: false })],
  resolve: {
    alias: {
      '@': resolvePath('./src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist', 'tests/e2e/**', 'tests/visual/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/types.ts', 'src/types/**', 'src/**/*.d.ts'],
    },
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
    },
  },
});
