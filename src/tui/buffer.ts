// Buffer de celdas: lo que la escena dibuja y el diff compara. Arreglos tipados para no asignar por celda.

import { type Rgb, mix } from './color.js';

export const BOLD = 1;

const SPACE = 0x20;

/** Ancho en celdas. Solo cubre lo necesario para que un texto ajeno no desarme el layout. */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Ajusta un texto ajeno a celdas de ancho 1: quita controles y reemplaza lo ancho. */
export function toCells(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const width = charWidth(char.codePointAt(0) as number);
    if (width === 1) out += char;
    else if (width === 2) out += '□';
  }
  return out;
}

export const cellLength = (text: string): number => [...text].length;

/** Recorta por celdas. Espera un texto ya pasado por `toCells`. */
export function fit(text: string, max: number): string {
  if (max <= 0) return '';
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

export class CellBuffer {
  readonly chars: Uint32Array;
  readonly fg: Int32Array;
  readonly bg: Int32Array;
  readonly attrs: Uint8Array;
  /** En 256 colores un tinte pequeño salta a otro gris: los halos se apagan. */
  tintsEnabled = true;
  /** Desplazamiento de las coordenadas de dibujo: centra el layout en una terminal mayor. */
  originX = 0;
  originY = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const size = width * height;
    this.chars = new Uint32Array(size).fill(SPACE);
    this.fg = new Int32Array(size);
    this.bg = new Int32Array(size);
    this.attrs = new Uint8Array(size);
  }

  /** Índice de una celda en coordenadas de dibujo, o -1 si está fuera. */
  private index(x: number, y: number): number {
    const col = x + this.originX;
    const row = y + this.originY;
    return col >= 0 && row >= 0 && col < this.width && row < this.height ? row * this.width + col : -1;
  }

  /** Escribe un carácter sin tocar el fondo. */
  put(x: number, y: number, char: string, fg: Rgb, attrs = 0): void {
    const i = this.index(x, y);
    if (i < 0) return;
    this.chars[i] = char.codePointAt(0) as number;
    this.fg[i] = fg;
    this.attrs[i] = attrs;
  }

  /** Cambia solo el fondo de una celda. */
  setBg(x: number, y: number, color: Rgb): void {
    const i = this.index(x, y);
    if (i >= 0) this.bg[i] = color;
  }

  /** Acerca el fondo de una celda a un color, para halos y destellos. */
  tintBg(x: number, y: number, color: Rgb, amount: number): void {
    if (!this.tintsEnabled) return;
    const i = this.index(x, y);
    if (i >= 0) this.bg[i] = mix(this.bg[i] as number, color, amount);
  }

  /** Como `tintBg`, pero también en 256 colores: es para animaciones breves, no para halos permanentes. */
  blendBg(x: number, y: number, color: Rgb, amount: number): void {
    const i = this.index(x, y);
    if (i >= 0) this.bg[i] = mix(this.bg[i] as number, color, amount);
  }

  /** Acerca el texto de una celda a un color, para fundidos y paquetes. */
  tintFg(x: number, y: number, color: Rgb, amount: number): void {
    const i = this.index(x, y);
    if (i >= 0) this.fg[i] = mix(this.fg[i] as number, color, amount);
  }

  /** Celda vacía con ese fondo. */
  clearCell(x: number, y: number, bg: Rgb): void {
    const i = this.index(x, y);
    if (i < 0) return;
    this.chars[i] = SPACE;
    this.fg[i] = bg;
    this.attrs[i] = 0;
    this.bg[i] = bg;
  }

  /** Carácter de una celda en coordenadas de dibujo, o un espacio si está fuera. */
  charAtDraw(x: number, y: number): string {
    const i = this.index(x, y);
    return i < 0 ? ' ' : String.fromCodePoint(this.chars[i] as number);
  }

  fill(x: number, y: number, w: number, h: number, bg: Rgb): void {
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) this.clearCell(col, row, bg);
    }
  }

  /** Escribe texto ya ajustado a celdas y devuelve la columna siguiente. */
  text(x: number, y: number, text: string, fg: Rgb, attrs = 0): number {
    let col = x;
    for (const char of text) {
      this.put(col, y, char, fg, attrs);
      col += 1;
    }
    return col;
  }

  /** Texto de una fila, para pruebas y mediciones. */
  rowText(y: number, from = 0, to = this.width): string {
    let out = '';
    for (let x = from; x < to; x += 1) out += String.fromCodePoint(this.chars[y * this.width + x] as number);
    return out;
  }

  charAt(x: number, y: number): string {
    return String.fromCodePoint(this.chars[y * this.width + x] as number);
  }

  fgAt(x: number, y: number): Rgb {
    return this.fg[y * this.width + x] as number;
  }

  bgAt(x: number, y: number): Rgb {
    return this.bg[y * this.width + x] as number;
  }

  copyFrom(other: CellBuffer): void {
    this.chars.set(other.chars);
    this.fg.set(other.fg);
    this.bg.set(other.bg);
    this.attrs.set(other.attrs);
  }
}
