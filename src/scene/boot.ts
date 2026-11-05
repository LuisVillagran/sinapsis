// Animación 1, el arranque: los bordes se dibujan solos, el encabezado se escribe y los paneles entran en cascada.
//
// Se aplica sobre el frame ya dibujado: oculta lo que aún no debe verse, así que no puede cambiar ningún dato.

import { easeInOutCubic, easeOutCubic, segment } from '../engine/easing.js';
import type { CellBuffer } from '../tui/buffer.js';
import type { Rect } from './draw.js';
import type { SceneLayout } from './layout.js';
import { theme } from './theme.js';

export const BOOT_MS = 2200;

interface PanelTiming {
  rect: Rect;
  from: number;
  to: number;
}

const timingCache = new WeakMap<SceneLayout, PanelTiming[]>();

/** Cuándo empieza y termina cada panel, en ms. */
function panelsOf(layout: SceneLayout): PanelTiming[] {
  let panels = timingCache.get(layout);
  if (!panels) {
    panels = [
      { rect: layout.project, from: 150, to: 1150 },
      { rect: layout.main, from: 350, to: 1250 },
      { rect: layout.advisor, from: 500, to: 1300 },
      { rect: layout.memory, from: 650, to: 1450 },
      { rect: layout.cards[0], from: 850, to: 1550 },
      { rect: layout.cards[1], from: 950, to: 1650 },
      { rect: layout.cards[2], from: 1050, to: 1750 },
      { rect: layout.lead, from: 1200, to: 1850 },
      { rect: layout.log, from: 1300, to: 2000 },
    ];
    timingCache.set(layout, panels);
  }
  return panels;
}

/** Hasta aquí llega el borde; el resto del tramo es para que entre el contenido. */
const BORDER_SHARE = 0.6;

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

function revealPanel(buf: CellBuffer, r: Rect, t: number, base: BaseColor): void {
  if (t >= 1) return;
  const borderT = easeInOutCubic(segment(t, 0, BORDER_SHARE));
  const contentT = easeOutCubic(segment(t, BORDER_SHARE, 1));

  // Interior: oculto hasta que el borde termina, y luego se funde desde el fondo.
  for (let y = r.y + 1; y < r.y + r.h - 1; y += 1) {
    for (let x = r.x + 1; x < r.x + r.w - 1; x += 1) {
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
function hideRow(buf: CellBuffer, y: number, fromCol: number, width: number, base: BaseColor): void {
  for (let x = fromCol; x < width; x += 1) hide(buf, x, y, base);
}

function fadeRow(buf: CellBuffer, y: number, width: number, amount: number, base: BaseColor): void {
  for (let x = 0; x < width; x += 1) {
    buf.tintFg(x, y, base(x, y), amount);
    buf.blendBg(x, y, base(x, y), amount);
  }
}

/** Celdas entre paneles, donde van los conectores: entran al final. */
function fadeConnectors(buf: CellBuffer, layout: SceneLayout, amount: number, base: BaseColor): void {
  const panels = panelsOf(layout);
  const inPanel = (x: number, y: number): boolean => panels.some(({ rect: r }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  for (let y = layout.rows.legend + 1; y < layout.log.y; y += 1) {
    for (let x = 0; x < layout.width; x += 1) {
      if (inPanel(x, y)) continue;
      if (amount >= 1) {
        hide(buf, x, y, base);
      } else {
        buf.tintFg(x, y, base(x, y), amount);
        buf.blendBg(x, y, base(x, y), amount);
      }
    }
  }
}

/** Aplica la animación a la escena. `headerStart` y `headerLength` delimitan el texto del encabezado. */
export function applyBootFull(buf: CellBuffer, ms: number, layout: SceneLayout, headerStart: number, headerLength: number, base: BaseColor): void {
  const { rows, width } = layout;
  // Encabezado: máquina de escribir.
  const typed = Math.floor(easeInOutCubic(segment(ms, 0, 800)) * headerLength);
  hideRow(buf, rows.header, headerStart + typed, width, base);
  if (typed > 0 && typed < headerLength) buf.put(headerStart + typed, rows.header, '▌', theme.main);
  if (rows.separator !== undefined) fadeRow(buf, rows.separator, width, 1 - easeOutCubic(segment(ms, 300, 800)), base);
  fadeRow(buf, rows.legend, width, 1 - easeOutCubic(segment(ms, 450, 950)), base);

  fadeConnectors(buf, layout, 1 - easeOutCubic(segment(ms, 1500, 2100)), base);
  for (const panel of panelsOf(layout)) revealPanel(buf, panel.rect, segment(ms, panel.from, panel.to), base);

  const bottom = 1 - easeOutCubic(segment(ms, 1700, BOOT_MS));
  fadeRow(buf, rows.prompt, width, bottom, base);
  fadeRow(buf, rows.status, width, bottom, base);
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
