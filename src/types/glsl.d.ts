/**
 * Module declarations for GLSL shader sources.
 *
 * Vite (`vite-plugin-glsl`), webpack (`raw-loader`/`glslify-loader`) and Rollup
 * all resolve `*.glsl` to a string when the corresponding plugin is configured.
 * Declaring every common suffix keeps `import chunk from './chunk.glsl'`
 * type-safe without a plugin-specific type package.
 */

declare module '*.glsl' {
  const source: string;
  export default source;
}

declare module '*.vert' {
  const source: string;
  export default source;
}

declare module '*.frag' {
  const source: string;
  export default source;
}

declare module '*.vs' {
  const source: string;
  export default source;
}

declare module '*.fs' {
  const source: string;
  export default source;
}

declare module '*.glsl?raw' {
  const source: string;
  export default source;
}

declare module '*?raw' {
  const source: string;
  export default source;
}
