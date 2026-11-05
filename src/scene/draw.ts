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

const THIN = { h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘' };
const DASHED = { h: '╌', v: '╎', tl: '┌', tr: '┐', bl: '└', br: '┘' };

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
  const glyphs = options.dashed ? DASHED : THIN;
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

/** Riel de una barra: trama tenue, como en la referencia. */
function track(buf: CellBuffer, x: number, y: number, color: Rgb): void {
  buf.clearCell(x, y, theme.bg);
  buf.put(x, y, '░', color);
}

/** Barra con precisión de un octavo de celda. Pinta su propio fondo. */
export function bar(buf: CellBuffer, x: number, y: number, width: number, fraction: number, color: Rgb, rail: Rgb = theme.barTrack): void {
  const total = Math.max(0, Math.min(1, fraction)) * width;
  const full = Math.floor(total);
  const eighths = Math.floor((total - full) * 8);
  for (let i = 0; i < width; i += 1) {
    if (i < full) {
      buf.clearCell(x + i, y, theme.bg);
      buf.put(x + i, y, '█', color);
    } else if (i === full && eighths > 0) {
      buf.clearCell(x + i, y, theme.bg);
      buf.put(x + i, y, PARTIAL[eighths] as string, color);
    } else {
      track(buf, x + i, y, rail);
    }
  }
}

/** Barra por conteo de herramientas: una celda llena por cada herramienta usada (`count`), sobre el riel `░`. */
export function countBar(buf: CellBuffer, x: number, y: number, width: number, count: number, color: Rgb, latestColor: Rgb = theme.subBright, rail: Rgb = theme.barTrack): void {
  const filled = Math.max(0, Math.min(width, Math.floor(count)));
  for (let i = 0; i < width; i += 1) {
    if (i < filled) {
      buf.clearCell(x + i, y, theme.bg);
      buf.put(x + i, y, '█', i === filled - 1 ? mix(color, latestColor, 0.35) : color);
    } else {
      track(buf, x + i, y, rail);
    }
  }
}

const SPINNER = ['|', '/', '-', '\\'];
const DISC = ['◐', '◓', '◑', '◒'];

/** Disco giratorio de las tarjetas activas, como en la referencia. */
export const discFrame = (now: number, offset = 0, period = 160): string => DISC[Math.floor(now / period + offset) % DISC.length] as string;

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
