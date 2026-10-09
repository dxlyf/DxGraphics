/**
 * Module declarations for asset imports (images, fonts, models, binary blobs).
 *
 * Asset loaders in `src/assets` are the runtime path; these declarations exist so
 * that example and playground code can `import logo from './logo.png'` and get a
 * URL string with full type-safety.
 */

declare module '*.png' {
  const url: string;
  export default url;
}

declare module '*.jpg' {
  const url: string;
  export default url;
}

declare module '*.jpeg' {
  const url: string;
  export default url;
}

declare module '*.gif' {
  const url: string;
  export default url;
}

declare module '*.webp' {
  const url: string;
  export default url;
}

declare module '*.avif' {
  const url: string;
  export default url;
}

declare module '*.bmp' {
  const url: string;
  export default url;
}

declare module '*.svg' {
  const url: string;
  export default url;
}

declare module '*.ico' {
  const url: string;
  export default url;
}

declare module '*.woff' {
  const url: string;
  export default url;
}

declare module '*.woff2' {
  const url: string;
  export default url;
}

declare module '*.ttf' {
  const url: string;
  export default url;
}

declare module '*.otf' {
  const url: string;
  export default url;
}

declare module '*.json' {
  const value: any;
  export default value;
}

declare module '*.glb' {
  const url: string;
  export default url;
}

declare module '*.gltf' {
  const url: string;
  export default url;
}

declare module '*.obj' {
  const url: string;
  export default url;
}

declare module '*.fbx' {
  const url: string;
  export default url;
}

declare module '*.stl' {
  const url: string;
  export default url;
}

declare module '*.ply' {
  const url: string;
  export default url;
}

declare module '*.wasm' {
  const url: string;
  export default url;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.wasm?init' {
  const init: (imports?: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
  export default init;
}
