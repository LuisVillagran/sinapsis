// Geometría de la escena, en celdas. El layout completo sale de medir las imágenes de referencia (90x46), y el
// compacto usa la misma topología con menos filas: un solo dibujo y los mismos caminos en ambos tamaños.

import type { Rect } from './draw.js';

export const FULL_COLS = 90;
export const FULL_ROWS = 46;
/** Desde aquí se ve toda la escena, con sus conectores y paquetes. */
export const COMPACT_COLS = 80;
export const COMPACT_ROWS = 30;
export const MIN_COLS = 80;
export const MIN_ROWS = 24;
/** Más ancho no aporta: las tarjetas dejarían de leerse como un conjunto. */
const COMPACT_MAX_CARD = 26;

export type LayoutKind = 'full' | 'compact' | 'reduced' | 'too-small';

export function layoutKind(cols: number, rows: number): LayoutKind {
  if (cols >= FULL_COLS && rows >= FULL_ROWS) return 'full';
  if (cols >= COMPACT_COLS && rows >= COMPACT_ROWS) return 'compact';
  if (cols >= MIN_COLS && rows >= MIN_ROWS) return 'reduced';
  return 'too-small';
}

export type Point = [number, number];

export type RouteName =
  | 'tool'
  | 'advisor-out'
  | 'advisor-back'
  | `delegate-${0 | 1 | 2}`
  | `work-${0 | 1 | 2}`
  | `back-${0 | 1 | 2}`
  | `memory-${0 | 1 | 2}`;

export interface SceneLayout {
  kind: 'full' | 'compact';
  /** Tamaño de la grilla dibujada, sin la barra de ventana. */
  width: number;
  height: number;
  originX: number;
  originY: number;
  /** La barra falsa de ventana va en la fila -1, si cabe. */
  windowBar: boolean;
  rows: { header: number; separator?: number; legend: number; delegate: number; bus: number; merge: number; prompt: number; status: number };
  project: Rect;
  main: Rect;
  advisor: Rect;
  memory: Rect;
  cards: [Rect, Rect, Rect];
  lead: Rect;
  log: Rect;
  spine: number;
  cardCenters: [number, number, number];
  /** Fila de cada hito de la memoria de proyecto, alineada con el panel al que apunta. */
  milestones: [number, number, number];
  /** Fila de la flecha entre la sesión principal y el advisor. */
  advisorLink: number;
  /** Las flechas de las tarjetas y del lead tienen fila propia. Si no, van sobre el borde superior. */
  cardArrowRow?: number;
  leadArrowRow?: number;
  routes: Record<RouteName, Point[]>;
}

/** Alturas de cada tramo vertical. */
interface Heights {
  separator: number;
  main: number;
  stem: number;
  memory: number;
  afterMemory: number;
  afterDelegate: number;
  cardArrow: number;
  card: number;
  cardStem: number;
  leadArrow: number;
  lead: number;
  beforeLog: number;
  log: number;
}

/** El mínimo que conserva todos los apartados: suma 30 filas. */
const COMPACT_HEIGHTS: Heights = { separator: 0, main: 4, stem: 1, memory: 5, afterMemory: 0, afterDelegate: 0, cardArrow: 0, card: 5, cardStem: 0, leadArrow: 0, lead: 3, beforeLog: 0, log: 5 };

/** Medidas de la referencia: suma 46 filas. */
const FULL_HEIGHTS: Heights = { separator: 1, main: 6, stem: 2, memory: 7, afterMemory: 1, afterDelegate: 1, cardArrow: 1, card: 7, cardStem: 1, leadArrow: 1, lead: 4, beforeLog: 1, log: 6 };

/** Orden en que el compacto gasta las filas que sobran. Lo primero es lo que más información agrega. */
const SPARE_ORDER: Array<keyof Heights> = ['log', 'memory', 'card', 'memory', 'card', 'main', 'main', 'separator', 'stem', 'afterMemory', 'afterDelegate', 'cardArrow', 'cardStem', 'leadArrow', 'lead', 'beforeLog'];

const span = (x0: number, x1: number, y0: number, y1: number): Rect => ({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });

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

interface Columns {
  width: number;
  project: { x: number; w: number };
  main: { x0: number; x1: number };
  advisor: { x0: number; x1: number };
  memory: { x0: number; x1: number };
  cards: [[number, number], [number, number], [number, number]];
  centers: [number, number, number];
  lead: { x0: number; x1: number };
  log: { x0: number; x1: number };
  spine: number;
}

/** Columnas medidas en la referencia, a 8 px por celda. */
const FULL_COLUMNS: Columns = {
  width: FULL_COLS,
  project: { x: 3, w: 21 },
  main: { x0: 44, x1: 70 },
  advisor: { x0: 74, x1: 87 },
  memory: { x0: 36, x1: 78 },
  cards: [[26, 45], [47, 66], [68, 87]],
  centers: [36, 57, 78],
  lead: { x0: 41, x1: 73 },
  log: { x0: 3, x1: 87 },
  spine: 57,
};

function compactColumns(cols: number): Columns {
  const left = 21;
  const card = Math.min(COMPACT_MAX_CARD, Math.floor((cols - left - 2) / 3));
  const used = card * 3 + 2;
  const width = Math.min(cols, left + 3 + used);
  const start = width - used;
  const cards: Columns['cards'] = [
    [start, start + card - 1],
    [start + card + 1, start + 2 * card],
    [start + 2 * card + 2, start + 3 * card + 1],
  ];
  const centers: Columns['centers'] = [cards[0][0] + (card >> 1), cards[1][0] + (card >> 1), cards[2][0] + (card >> 1)];
  const spine = centers[1];
  const advisorWidth = 13;
  const half = Math.min(17, width - 1 - advisorWidth - 3 - spine);
  const mainEnd = spine + half;
  return {
    width,
    project: { x: 0, w: 20 },
    main: { x0: spine - half, x1: mainEnd },
    advisor: { x0: mainEnd + 4, x1: mainEnd + 3 + advisorWidth },
    memory: { x0: spine - 20, x1: spine + 20 },
    cards,
    centers,
    lead: { x0: spine - 16, x1: spine + 16 },
    log: { x0: 0, x1: width - 1 },
    spine,
  };
}

function build(c: Columns, h: Heights, kind: SceneLayout['kind'], cols: number, rows: number): SceneLayout {
  let y = 0;
  const next = (n = 1): number => {
    const at = y;
    y += n;
    return at;
  };
  const header = next();
  const separator = h.separator ? next() : undefined;
  const legend = next();
  const mainY = next(h.main);
  next(h.stem);
  const memoryY = next(h.memory);
  next(h.afterMemory);
  const delegate = next();
  next(h.afterDelegate);
  const bus = next();
  const cardArrowRow = h.cardArrow ? next() : undefined;
  const cardY = next(h.card);
  next(h.cardStem);
  const merge = next();
  const leadArrowRow = h.leadArrow ? next() : undefined;
  const leadY = next(h.lead);
  next(h.beforeLog);
  const logY = next(h.log);
  const prompt = next();
  const status = next();
  const height = y;

  const rect = (span_: { x0: number; x1: number }, top: number, rowCount: number): Rect => span(span_.x0, span_.x1, top, top + rowCount - 1);
  const main = rect(c.main, mainY, h.main);
  const advisor = rect(c.advisor, mainY, h.main);
  const memory = rect(c.memory, memoryY, h.memory);
  const cards = c.cards.map(([x0, x1]) => span(x0, x1, cardY, cardY + h.card - 1)) as [Rect, Rect, Rect];
  const lead = rect(c.lead, leadY, h.lead);
  const log = rect(c.log, logY, h.log);
  const project: Rect = { x: c.project.x, y: mainY, w: c.project.w, h: leadY + h.lead - mainY };

  // Cada hito apunta a la fila central de su panel: el medidor de effort, la barra de la tarjeta y el resumen.
  const milestones: SceneLayout['milestones'] = [mainY + (h.main >= 5 ? 3 : 2), cardY + (h.card >= 7 ? 3 : 2), leadY + 1];
  const advisorLink = mainY + 1;
  const projectEdge = project.x + project.w - 1;
  const { spine } = c;
  const mainBottom = mainY + h.main - 1;
  const memoryBottom = memoryY + h.memory - 1;

  // Las tarjetas se alcanzan por el bus, y el paquete cruza el panel de memoria y el texto sin dibujarse encima.
  const trunk: Point[] = [...route([spine, mainBottom], [spine, memoryY]), ...route([spine, memoryBottom], [spine, memoryBottom + h.afterMemory]), ...(h.afterDelegate ? route([spine, delegate + 1], [spine, bus]) : [[spine, bus] as Point])];
  const branch = (center: number): Point[] => route([spine, bus], [center, bus], [center, cardY]);
  const toCard = (center: number): Point[] => [...trunk, ...branch(center).slice(1)];
  const home = (center: number): Point[] => route([center, cardY + h.card - 1], [center, merge], [spine, merge], [spine, leadY]);

  const [c0, c1, c2] = c.centers;
  const advisorOut = route([main.x + main.w - 1, advisorLink], [advisor.x, advisorLink]);
  const routes: SceneLayout['routes'] = {
    tool: route([spine, mainBottom], [spine, memoryY]),
    'advisor-out': advisorOut,
    'advisor-back': [...advisorOut].reverse(),
    'delegate-0': toCard(c0),
    'delegate-1': toCard(c1),
    'delegate-2': toCard(c2),
    'work-0': branch(c0),
    'work-1': branch(c1),
    'work-2': branch(c2),
    'back-0': home(c0),
    'back-1': home(c1),
    'back-2': home(c2),
    'memory-0': route([projectEdge, milestones[0]], [main.x, milestones[0]]),
    'memory-1': route([projectEdge, milestones[1]], [(cards[0] as Rect).x, milestones[1]]),
    'memory-2': route([projectEdge, milestones[2]], [lead.x, milestones[2]]),
  };

  const windowBar = rows > height;
  return {
    kind,
    width: c.width,
    height,
    originX: Math.max(0, Math.floor((cols - c.width) / 2)),
    originY: Math.max(0, Math.floor((rows - height - (windowBar ? 1 : 0)) / 2)) + (windowBar ? 1 : 0),
    windowBar,
    rows: { header, separator, legend, delegate, bus, merge, prompt, status },
    project,
    main,
    advisor,
    memory,
    cards,
    lead,
    log,
    spine,
    cardCenters: c.centers,
    milestones,
    advisorLink,
    cardArrowRow,
    leadArrowRow,
    routes,
  };
}

const cache = new Map<string, SceneLayout>();

/** Layout para un tamaño de terminal, o `undefined` si no cabe la escena completa. */
export function layoutFor(cols: number, rows: number): SceneLayout | undefined {
  const kind = layoutKind(cols, rows);
  if (kind !== 'full' && kind !== 'compact') return undefined;
  const key = `${cols}x${rows}`;
  let layout = cache.get(key);
  if (!layout) {
    if (kind === 'full') {
      layout = build(FULL_COLUMNS, FULL_HEIGHTS, 'full', cols, rows);
    } else {
      const heights = { ...COMPACT_HEIGHTS };
      const spare = Math.max(0, rows - COMPACT_ROWS);
      for (const part of SPARE_ORDER.slice(0, spare)) heights[part] += 1;
      layout = build(compactColumns(cols), heights, 'compact', cols, rows);
    }
    cache.set(key, layout);
  }
  return layout;
}
