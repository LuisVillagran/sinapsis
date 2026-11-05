// Geometría del layout completo, en celdas. Sale de la tabla de la sección 6 de CLAUDE.md.

import type { ConsultReason } from '../core/events.js';
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

type Point = [number, number];

/** Expande puntos de paso a la lista de celdas, sin repetir las esquinas. */
function route(...points: Point[]): Point[] {
  const cells: Point[] = [points[0] as Point];
  for (let i = 1; i < points.length; i += 1) {
    const [tx, ty] = points[i] as Point;
    let [x, y] = cells[cells.length - 1] as Point;
    while (x !== tx || y !== ty) {
      x += Math.sign(tx - x);
      y += Math.sign(ty - y);
      cells.push([x, y]);
    }
  }
  return cells;
}

const delegateRoute = (center: number): Point[] => route([FULL.spine, 20], [FULL.spine, 22], [center, 22], [center, 23]);
const backRoute = (center: number): Point[] => route([center, 31], [center, 32], [FULL.spine, 32], [FULL.spine, 34]);
const advisorRow = (from: number, y: number): Point[] => route([from, y], [24, y]);

/** Caminos de los paquetes. Cada consulta viaja por la flecha de su hito. */
export const ROUTES = {
  tool: route([FULL.spine, 11], [FULL.spine, 13]),
  'delegate-0': delegateRoute(FULL.cardCenters[0]),
  'delegate-1': delegateRoute(FULL.cardCenters[1]),
  'delegate-2': delegateRoute(FULL.cardCenters[2]),
  'back-0': backRoute(FULL.cardCenters[0]),
  'back-1': backRoute(FULL.cardCenters[1]),
  'back-2': backRoute(FULL.cardCenters[2]),
  'advisor-out-0': advisorRow(38, FULL.arrows.main),
  'advisor-out-1': advisorRow(27, FULL.arrows.cards),
  'advisor-out-2': advisorRow(42, FULL.arrows.lead + 1),
  'advisor-back-0': advisorRow(38, FULL.arrows.main).reverse(),
  'advisor-back-1': advisorRow(27, FULL.arrows.cards).reverse(),
  'advisor-back-2': advisorRow(42, FULL.arrows.lead + 1).reverse(),
};

export type RouteName = keyof typeof ROUTES;

/** Hito del panel del advisor al que pertenece una consulta. */
export function consultSlot(reason: ConsultReason): 0 | 1 | 2 {
  if (reason === 'after errors' || reason === 'after subagents') return 1;
  return reason === 'before done' ? 2 : 0;
}

export type LayoutKind = 'full' | 'reduced' | 'too-small';

export function layoutKind(cols: number, rows: number): LayoutKind {
  if (cols >= FULL_COLS && rows >= FULL_ROWS) return 'full';
  if (cols >= MIN_COLS && rows >= MIN_ROWS) return 'reduced';
  return 'too-small';
}
