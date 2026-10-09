/**
 * Texture format taxonomy.
 *
 * Three orthogonal descriptions of the same texel data:
 *  - {@link TextureFormat} — channel layout;
 *  - {@link PixelFormat} — element type of each channel;
 *  - {@link CompressedFormat} — block-compressed layouts, which replace both.
 *
 * @packageDocumentation
 */

export * from './TextureFormat';
export * from './PixelFormat';
export * from './CompressedFormat';
