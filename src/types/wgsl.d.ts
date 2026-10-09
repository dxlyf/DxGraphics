/**
 * Module declarations for WGSL shader sources.
 *
 * Browsers natively support `import source from './shader.wgsl' with { type: 'text' }`
 * but bundlers still need a plugin. These declarations cover the bundler path
 * (Vite `?raw`, webpack `asset/source`) so WGSL chunks type-check like GLSL ones.
 */

declare module '*.wgsl' {
  const source: string;
  export default source;
}

declare module '*.wgsl?raw' {
  const source: string;
  export default source;
}

declare module '*.compute.wgsl' {
  const source: string;
  export default source;
}
