// Geometría del layout completo, en celdas. Sale de la tabla de la sección 6 de CLAUDE.md.

import type { Rect } from './draw.js';

export const FULL_COLS = 96;
export const FULL_ROWS = 48;
export const MIN_COLS = 80;
export const MIN_ROWS = 24;

const span = (x0: number, x1: number, y0: number, y1: number): Rect => ({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });

export const FULL = {
  advisor: span(2, 23, 5, 38),
  main: span(39, 76, 5, 11),
  advisorState: span(78, 94, 5, 11),
  metrics: span(38, 83, 13, 19),
  cards: [span(28, 48, 24, 30), span(50, 71, 24, 30), span(73, 94, 24, 30)] as const,
  lead: span(43, 78, 35, 38),
  log: span(2, 94, 39, 44),
  rows: { windowBar: 0, header: 2, separator: 3, legend: 4, delegate: 21, prompt: 45, status: 46 },
  /** Columna de la columna vertebral y centros de las tarjetas. */
  spine: 61,
  cardCenters: [38, 61, 84] as const,
  arrows: { main: 9, cards: 26, lead: 35 },
};

export type LayoutKind = 'full' | 'reduced' | 'too-small';

export function layoutKind(cols: number, rows: number): LayoutKind {
  if (cols >= FULL_COLS && rows >= FULL_ROWS) return 'full';
  if (cols >= MIN_COLS && rows >= MIN_ROWS) return 'reduced';
  return 'too-small';
}
