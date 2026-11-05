// Animación 1, el arranque: los bordes se dibujan solos, el encabezado se escribe y los paneles entran en cascada.
//
// Se aplica sobre el frame ya dibujado: oculta lo que aún no debe verse, así que no puede cambiar ningún dato.

import { easeInOutCubic, easeOutCubic, segment } from '../engine/easing.js';
import type { CellBuffer } from '../tui/buffer.js';
import type { Rect } from './draw.js';
import { FULL, FULL_COLS } from './layout.js';
import { theme } from './theme.js';

export const BOOT_MS = 2200;

/** Cuándo empieza y termina cada panel, en ms. */
const PANELS: Array<{ rect: Rect; from: number; to: number }> = [
  { rect: FULL.advisor, from: 150, to: 1150 },
  { rect: FULL.main, from: 350, to: 1250 },
  { rect: FULL.advisorState, from: 500, to: 1300 },
  { rect: FULL.metrics, from: 650, to: 1450 },
  { rect: FULL.cards[0], from: 850, to: 1550 },
  { rect: FULL.cards[1], from: 950, to: 1650 },
  { rect: FULL.cards[2], from: 1050, to: 1750 },
  { rect: FULL.lead, from: 1200, to: 1850 },
  { rect: FULL.log, from: 1300, to: 2000 },
];

/** Hasta aquí llega el borde; el resto del tramo es para que entre el contenido. */
const BORDER_SHARE = 0.6;
/** Celdas que el halo ocupa alrededor de un panel. */
const MARGIN_X = 2;
const MARGIN_Y = 1;

type BaseColor = (x: number, y: number) => number;

function hide(buf: CellBuffer, x: number, y: number, base: BaseColor): void {
  buf.clearCell(x, y, base(x, y));
}

/** Recorrido del borde en el sentido del reloj, desde la esquina superior izquierda. */
function perimeter(r: Rect): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  const right = r.x + r.w - 1;
  const bottom = r.y + r.h - 1;
  for (let x = r.x; x <= right; x += 1) cells.push([x, r.y]);
  for (let y = r.y + 1; y <= bottom; y += 1) cells.push([right, y]);
  for (let x = right - 1; x >= r.x; x -= 1) cells.push([x, bottom]);
  for (let y = bottom - 1; y > r.y; y -= 1) cells.push([r.x, y]);
  return cells;
}

const perimeterCache = new Map<Rect, Array<[number, number]>>();

const insideRect = (r: Rect, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

function revealPanel(buf: CellBuffer, r: Rect, t: number, base: BaseColor): void {
  if (t >= 1) return;
  const borderT = easeInOutCubic(segment(t, 0, BORDER_SHARE));
  const contentT = easeOutCubic(segment(t, BORDER_SHARE, 1));

  // Interior y halo: ocultos hasta que el borde termina, y luego se funden desde el fondo.
  for (let y = r.y - MARGIN_Y; y < r.y + r.h + MARGIN_Y; y += 1) {
    for (let x = r.x - MARGIN_X; x < r.x + r.w + MARGIN_X; x += 1) {
      const inside = insideRect(r, x, y);
      const onBorder = inside && (x === r.x || x === r.x + r.w - 1 || y === r.y || y === r.y + r.h - 1);
      if (onBorder) continue;
      // El margen de un panel no debe borrar a un vecino.
      if (!inside && PANELS.some(({ rect }) => rect !== r && insideRect(rect, x, y))) continue;
      if (contentT <= 0) {
        hide(buf, x, y, base);
      } else {
        const fade = 1 - contentT;
        buf.tintFg(x, y, base(x, y), fade);
        buf.blendBg(x, y, base(x, y), fade);
      }
    }
  }

  let cells = perimeterCache.get(r);
  if (!cells) {
    cells = perimeter(r);
    perimeterCache.set(r, cells);
  }
  // Antes de que el panel empiece no se ve ni su esquina.
  const drawn = t <= 0 ? -1 : Math.floor(borderT * cells.length);
  cells.forEach(([x, y], i) => {
    if (i > drawn) hide(buf, x, y, base);
    else if (i >= drawn - 3 && borderT < 1) buf.tintFg(x, y, theme.subBright, 1 - (drawn - i) / 4);
  });
}

/** Oculta las columnas de una fila desde `fromCol`. */
function hideRow(buf: CellBuffer, y: number, fromCol: number, base: BaseColor): void {
  for (let x = fromCol; x < FULL_COLS; x += 1) hide(buf, x, y, base);
}

function fadeRow(buf: CellBuffer, y: number, amount: number, base: BaseColor): void {
  for (let x = 0; x < FULL_COLS; x += 1) {
    buf.tintFg(x, y, base(x, y), amount);
    buf.blendBg(x, y, base(x, y), amount);
  }
}

/** Filas entre paneles que llevan conectores: entran al final. */
function fadeConnectors(buf: CellBuffer, amount: number, base: BaseColor): void {
  const panelCells = (x: number, y: number): boolean => PANELS.some(({ rect: r }) => x >= r.x - MARGIN_X && x < r.x + r.w + MARGIN_X && y >= r.y - MARGIN_Y && y < r.y + r.h + MARGIN_Y);
  for (let y = FULL.rows.legend + 1; y < FULL.log.y; y += 1) {
    for (let x = 0; x < FULL_COLS; x += 1) {
      if (panelCells(x, y)) continue;
      if (amount >= 1) {
        hide(buf, x, y, base);
      } else {
        buf.tintFg(x, y, base(x, y), amount);
        buf.blendBg(x, y, base(x, y), amount);
      }
    }
  }
}

/** Aplica la animación al layout completo. `headerStart` y `headerLength` delimitan el texto del encabezado. */
export function applyBootFull(buf: CellBuffer, ms: number, headerStart: number, headerLength: number, base: BaseColor): void {
  // Encabezado: máquina de escribir.
  const typed = Math.floor(easeInOutCubic(segment(ms, 0, 800)) * headerLength);
  hideRow(buf, FULL.rows.header, headerStart + typed, base);
  if (typed > 0 && typed < headerLength) {
    buf.put(headerStart + typed, FULL.rows.header, '▌', theme.main);
  }
  fadeRow(buf, FULL.rows.separator, 1 - easeOutCubic(segment(ms, 300, 800)), base);
  fadeRow(buf, FULL.rows.legend, 1 - easeOutCubic(segment(ms, 450, 950)), base);

  fadeConnectors(buf, 1 - easeOutCubic(segment(ms, 1500, 2100)), base);
  for (const panel of PANELS) revealPanel(buf, panel.rect, segment(ms, panel.from, panel.to), base);

  const bottom = 1 - easeOutCubic(segment(ms, 1700, BOOT_MS));
  fadeRow(buf, FULL.rows.prompt, bottom, base);
  fadeRow(buf, FULL.rows.status, bottom, base);
}

/** El layout reducido entra con un fundido de toda la pantalla. */
export function applyBootFade(buf: CellBuffer, ms: number, base: BaseColor): void {
  const amount = 1 - easeOutCubic(segment(ms, 0, 700));
  if (amount <= 0) return;
  for (let y = 0; y < buf.height; y += 1) {
    for (let x = 0; x < buf.width; x += 1) {
      buf.tintFg(x, y, base(x, y), amount);
      buf.blendBg(x, y, base(x, y), amount);
    }
  }
}
