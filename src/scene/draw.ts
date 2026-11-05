// Primitivas de dibujo sobre el buffer.

import { BOLD, type CellBuffer, cellLength, fit, toCells } from '../tui/buffer.js';
import { type Rgb, mix } from '../tui/color.js';
import { theme } from './theme.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Segment {
  text: string;
  color: Rgb;
  bold?: boolean;
}

const HEAVY = { h: '━', v: '┃', tl: '┏', tr: '┓', bl: '┗', br: '┛' };
const DASHED = { h: '╍', v: '╏', tl: '┏', tr: '┓', bl: '┗', br: '┛' };

export interface BoxOptions {
  color: Rgb;
  dashed?: boolean;
  fill?: Rgb;
  /** Intensidad del halo: fondo tintado en las celdas vecinas. */
  halo?: number;
  bold?: boolean;
}

/** Halo: tinta las celdas que rodean un rectángulo, más fuerte junto al borde. */
export function halo(buf: CellBuffer, r: Rect, color: Rgb, strength: number): void {
  if (strength <= 0) return;
  const ring = (dx: number, dy: number, amount: number): void => {
    for (let x = r.x - dx; x < r.x + r.w + dx; x += 1) {
      buf.tintBg(x, r.y - dy, color, amount);
      buf.tintBg(x, r.y + r.h - 1 + dy, color, amount);
    }
    for (let y = r.y - dy + 1; y < r.y + r.h - 1 + dy; y += 1) {
      buf.tintBg(r.x - dx, y, color, amount);
      buf.tintBg(r.x + r.w - 1 + dx, y, color, amount);
    }
  };
  // Las celdas son más altas que anchas: el halo se extiende más en horizontal.
  ring(2, 1, strength * 0.07);
  ring(1, 0, strength * 0.13);
}

export function box(buf: CellBuffer, r: Rect, options: BoxOptions): void {
  const glyphs = options.dashed ? DASHED : HEAVY;
  const attrs = options.bold ? BOLD : 0;
  if (options.halo) halo(buf, r, options.color, options.halo);
  if (options.fill !== undefined) buf.fill(r.x + 1, r.y + 1, r.w - 2, r.h - 2, options.fill);
  const right = r.x + r.w - 1;
  const bottom = r.y + r.h - 1;
  for (let x = r.x + 1; x < right; x += 1) {
    buf.put(x, r.y, glyphs.h, options.color, attrs);
    buf.put(x, bottom, glyphs.h, options.color, attrs);
  }
  for (let y = r.y + 1; y < bottom; y += 1) {
    buf.put(r.x, y, glyphs.v, options.color, attrs);
    buf.put(right, y, glyphs.v, options.color, attrs);
  }
  buf.put(r.x, r.y, glyphs.tl, options.color, attrs);
  buf.put(right, r.y, glyphs.tr, options.color, attrs);
  buf.put(r.x, bottom, glyphs.bl, options.color, attrs);
  buf.put(right, bottom, glyphs.br, options.color, attrs);
}

export const segmentsWidth = (segments: Segment[]): number => segments.reduce((sum, s) => sum + cellLength(s.text), 0);

export function writeSegments(buf: CellBuffer, x: number, y: number, segments: Segment[]): number {
  let col = x;
  for (const segment of segments) col = buf.text(col, y, segment.text, segment.color, segment.bold ? BOLD : 0);
  return col;
}

/** Centra segmentos en un ancho dado. */
export function centerSegments(buf: CellBuffer, x: number, width: number, y: number, segments: Segment[]): void {
  writeSegments(buf, x + Math.floor((width - segmentsWidth(segments)) / 2), y, segments);
}

export function centerText(buf: CellBuffer, x: number, width: number, y: number, text: string, color: Rgb, bold = false): void {
  centerSegments(buf, x, width, y, [{ text: fit(toCells(text), width), color, bold }]);
}

export function rightText(buf: CellBuffer, rightEdge: number, y: number, text: string, color: Rgb, bold = false): void {
  buf.text(rightEdge - cellLength(text) + 1, y, text, color, bold ? BOLD : 0);
}

const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** Barra con precisión de un octavo de celda. Pinta su propio fondo. */
export function bar(buf: CellBuffer, x: number, y: number, width: number, fraction: number, color: Rgb, track: Rgb = theme.barTrack): void {
  const total = Math.max(0, Math.min(1, fraction)) * width;
  const full = Math.floor(total);
  const eighths = Math.floor((total - full) * 8);
  for (let i = 0; i < width; i += 1) {
    buf.clearCell(x + i, y, track);
    if (i < full) buf.put(x + i, y, '█', color);
    else if (i === full && eighths > 0) buf.put(x + i, y, PARTIAL[eighths] as string, color);
  }
}

/**
 * Barra de media altura, para filas consecutivas que deben verse separadas.
 * El tope de un carácter de media altura obliga a una precisión de media celda.
 */
export function thinBar(buf: CellBuffer, x: number, y: number, width: number, fraction: number, color: Rgb, track: Rgb = theme.barTrack): void {
  const halves = Math.round(Math.max(0, Math.min(1, fraction)) * width * 2);
  for (let i = 0; i < width; i += 1) {
    const filled = halves - i * 2;
    if (filled >= 2) buf.put(x + i, y, '▄', color);
    else if (filled === 1) {
      // Media celda llena: el resto del ancho se pinta con el riel como fondo inferior no es posible,
      // así que la parte vacía queda sin riel en esta celda.
      buf.put(x + i, y, '▖', color);
    } else buf.put(x + i, y, '▄', track);
  }
}

/**
 * Barra indeterminada: una franja que recorre el ancho sin decir cuánto falta, porque ese dato no existe.
 * `phase` avanza de 0 a 1 en cada pasada.
 */
export function indeterminateBar(buf: CellBuffer, x: number, y: number, width: number, phase: number, color: Rgb, track: Rgb = theme.barTrack): void {
  const band = Math.max(3, width * 0.32);
  const start = (phase - Math.floor(phase)) * (width + band) - band;
  const end = start + band;
  for (let i = 0; i < width; i += 1) {
    buf.clearCell(x + i, y, track);
    const covered = Math.min(i + 1, end) - Math.max(i, start);
    if (covered <= 0) continue;
    if (covered >= 1) {
      buf.put(x + i, y, '█', color);
    } else if (start > i) {
      // Borde izquierdo: se pinta la parte vacía con el color del riel sobre fondo de la franja.
      buf.setBg(x + i, y, color);
      buf.put(x + i, y, PARTIAL[Math.max(1, Math.round((1 - covered) * 8))] ?? '▏', track);
    } else {
      buf.put(x + i, y, PARTIAL[Math.max(1, Math.round(covered * 8))] ?? '▉', color);
    }
  }
}

const SPINNER = ['|', '/', '-', '\\'];

export const spinnerFrame = (now: number, period = 120): string => SPINNER[Math.floor(now / period) % SPINNER.length] as string;

export const dimmed = (color: Rgb, amount: number): Rgb => mix(color, theme.panel, amount);

/** Corta un texto en líneas de un ancho dado, sin partir palabras salvo que no quepan. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const raw of toCells(text).split(/\s+/)) {
    let word = raw;
    while (cellLength(word) > width) {
      if (line) {
        lines.push(line);
        line = '';
      }
      const chars = [...word];
      lines.push(chars.slice(0, width).join(''));
      word = chars.slice(width).join('');
    }
    const next = line ? `${line} ${word}` : word;
    if (cellLength(next) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1] as string;
    kept[maxLines - 1] = cellLength(last) >= width ? fit(last, width) : `${last}…`;
    return kept;
  }
  return lines;
}
