// `gifenc` no trae tipos. Solo se declara lo que usa tools/gif.ts.
declare module 'gifenc' {
  export type Palette = number[][];
  export interface FrameOptions {
    palette?: Palette;
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
    repeat?: number;
  }
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, options?: FrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(rgba: Uint8Array | Buffer, maxColors: number, options?: { format?: string }): Palette;
  export function applyPalette(rgba: Uint8Array | Buffer, palette: Palette, format?: string): Uint8Array;
}
