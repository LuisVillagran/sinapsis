import { describe, expect, it } from 'vitest';
import { COMPACT_ROWS, FULL_COLS, FULL_ROWS, type RouteName, type SceneLayout, layoutFor, layoutKind } from '../src/scene/layout.js';
import type { Rect } from '../src/scene/draw.js';

const FULL = layoutFor(FULL_COLS, FULL_ROWS) as SceneLayout;

const edges = (r: Rect): [number, number, number, number] => [r.x, r.x + r.w - 1, r.y, r.y + r.h - 1];
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const panels = (L: SceneLayout): Array<[string, Rect]> => [
  ['project', L.project],
  ['main', L.main],
  ['advisor', L.advisor],
  ['memory', L.memory],
  ['card 0', L.cards[0]],
  ['card 1', L.cards[1]],
  ['card 2', L.cards[2]],
  ['lead', L.lead],
  ['log', L.log],
];

describe('layout completo: geometría funcional', () => {
  it('cada panel está en su posición', () => {
    expect(edges(FULL.project)).toEqual([3, 23, 2, 35]);
    expect(edges(FULL.main)).toEqual([44, 70, 2, 7]);
    expect(edges(FULL.memory)).toEqual([26, 55, 10, 16]);
    expect(edges(FULL.cards[0])).toEqual([26, 45, 22, 28]);
    expect(edges(FULL.cards[1])).toEqual([47, 66, 22, 28]);
    expect(edges(FULL.cards[2])).toEqual([68, 87, 22, 28]);
    expect(edges(FULL.lead)).toEqual([41, 73, 32, 35]);
    expect(edges(FULL.log)).toEqual([3, 87, 37, 43]);
  });

  it('las filas sueltas también', () => {
    expect(FULL.rows).toEqual({ header: 0, legend: 1, delegate: 18, bus: 20, merge: 30, prompt: 44, status: 45 });
    expect(FULL.height).toBe(FULL_ROWS);
    expect(FULL.cardArrowRow).toBe(21);
    expect(FULL.leadArrowRow).toBe(31);
    expect(FULL.spine).toBe(57);
    expect(FULL.cardCenters).toEqual([36, 57, 78]);
  });

  it('los hitos quedan alineados con el panel al que apuntan', () => {
    expect(FULL.milestones).toEqual([5, 25, 33]);
  });

  it('la caja del advisor ocupa el espacio vacío a la derecha de la sesión principal', () => {
    expect(edges(FULL.advisor)).toEqual([74, 87, 2, 7]);
  });

  it('sin barra de ventana: las filas extra solo centran verticalmente', () => {
    expect('windowBar' in FULL).toBe(false);
    const taller = layoutFor(90, 47) as SceneLayout;
    expect(taller.originY).toBe(0);
    const muchTaller = layoutFor(90, 48) as SceneLayout;
    expect(muchTaller.originY).toBe(1);
  });

  it('una terminal mayor centra la misma geometría', () => {
    const big = layoutFor(120, 60) as SceneLayout;
    expect(big.kind).toBe('full');
    expect(big.originX).toBe(15);
    expect(big.originY).toBe(7);
    expect(edges(big.main)).toEqual(edges(FULL.main));
  });
});

describe('elección de layout', () => {
  it('por tamaño', () => {
    expect(layoutKind(90, 46)).toBe('full');
    expect(layoutKind(200, 100)).toBe('full');
    expect(layoutKind(89, 46)).toBe('compact');
    expect(layoutKind(90, 45)).toBe('compact');
    expect(layoutKind(120, 30)).toBe('compact');
    expect(layoutKind(80, 30)).toBe('compact');
    expect(layoutKind(80, 29)).toBe('reduced');
    expect(layoutKind(120, 29)).toBe('reduced');
    expect(layoutKind(80, 24)).toBe('reduced');
    expect(layoutKind(79, 30)).toBe('too-small');
    expect(layoutKind(80, 23)).toBe('too-small');
  });

  it('sin lugar para la escena no hay layout', () => {
    expect(layoutFor(80, COMPACT_ROWS - 1)).toBeUndefined();
    expect(layoutFor(60, 20)).toBeUndefined();
  });
});

describe('en todos los tamaños con escena completa', () => {
  const sizes: Array<[number, number]> = [];
  for (let cols = 80; cols <= 150; cols += 7) for (let rows = COMPACT_ROWS; rows <= 62; rows += 1) sizes.push([cols, rows]);
  sizes.push([80, 30], [120, 30], [89, 46], [90, 45], [90, 46], [90, 47], [240, 70]);

  it('los paneles caben, no se pisan y dejan lugar a prompt y estado', () => {
    for (const [cols, rows] of sizes) {
      const L = layoutFor(cols, rows) as SceneLayout;
      const label = `${cols}x${rows}`;
      expect(L.height, label).toBeLessThanOrEqual(rows);
      expect(L.width, label).toBeLessThanOrEqual(cols);
      const list = panels(L);
      for (const [name, r] of list) {
        expect(r.x, `${label} ${name}`).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w, `${label} ${name}`).toBeLessThanOrEqual(L.width);
        expect(r.y + r.h, `${label} ${name}`).toBeLessThanOrEqual(L.rows.prompt);
      }
      list.forEach(([nameA, a], i) => {
        for (const [nameB, b] of list.slice(i + 1)) expect(overlap(a, b), `${label} ${nameA} y ${nameB}`).toBe(false);
      });
    }
  });

  it('cada apartado queda conectado: los caminos parten y llegan a su panel', () => {
    for (const [cols, rows] of sizes) {
      const L = layoutFor(cols, rows) as SceneLayout;
      const label = `${cols}x${rows}`;
      const onBorder = (r: Rect, [x, y]: [number, number]): boolean => (y === r.y || y === r.y + r.h - 1 || x === r.x || x === r.x + r.w - 1) && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      const ends = (name: RouteName): [[number, number], [number, number]] => {
        const cells = L.routes[name];
        return [cells[0] as [number, number], cells[cells.length - 1] as [number, number]];
      };
      expect(onBorder(L.main, ends('tool')[0]), label).toBe(true);
      expect(ends('tool')[1], label).toEqual([L.spine, L.rows.bus - 1]);
      expect(onBorder(L.main, ends('advisor-out')[0]), label).toBe(true);
      expect(onBorder(L.advisor, ends('advisor-out')[1]), label).toBe(true);
      expect(onBorder(L.project, ends('memory-0')[0]), label).toBe(true);
      expect(onBorder(L.main, ends('memory-0')[1]), label).toBe(true);
      expect(onBorder(L.cards[0], ends('memory-1')[1]), label).toBe(true);
      expect(onBorder(L.lead, ends('memory-2')[1]), label).toBe(true);
      L.cardCenters.forEach((_, i) => {
        const slot = i as 0 | 1 | 2;
        expect(onBorder(L.main, ends(`delegate-${slot}`)[0]), label).toBe(true);
        expect(onBorder(L.cards[slot], ends(`delegate-${slot}`)[1]), label).toBe(true);
        expect(onBorder(L.cards[slot], ends(`back-${slot}`)[0]), label).toBe(true);
        expect(onBorder(L.lead, ends(`back-${slot}`)[1]), label).toBe(true);
      });
    }
  });

  it('el tronco y todos los caminos son continuos (sin saltos) y no cruzan paneles ajenos', () => {
    const inside = (r: Rect, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    for (const [cols, rows] of sizes) {
      const L = layoutFor(cols, rows) as SceneLayout;
      expect(L.memory.x).toBe(L.cards[0].x);
      expect(L.memory.x + L.memory.w - 1).toBe(L.spine - 2);
      for (const [name, cells] of Object.entries(L.routes)) {
        for (let i = 1; i < cells.length; i += 1) {
          const [ax, ay] = cells[i - 1] as [number, number];
          const [bx, by] = cells[i] as [number, number];
          expect(Math.abs(ax - bx) + Math.abs(ay - by), `${cols}x${rows} ${name}`).toBe(1);
        }
        // Las celdas interiores de la ruta (sin los extremos en el borde) nunca caen dentro de un panel.
        for (const [x, y] of cells.slice(1, -1)) {
          for (const [panelName, r] of panels(L)) {
            expect(inside(r, x, y), `${cols}x${rows} ${name} cruza ${panelName}`).toBe(false);
          }
        }
      }
    }
  });

  it('con más filas nunca se pierde información: cada panel crece o se mantiene', () => {
    for (const cols of [80, 90, 120]) {
      let previous = layoutFor(cols, COMPACT_ROWS) as SceneLayout;
      for (let rows = COMPACT_ROWS + 1; rows <= 45; rows += 1) {
        const L = layoutFor(cols, rows) as SceneLayout;
        for (const key of ['main', 'memory', 'lead', 'log', 'project'] as const) expect(L[key].h).toBeGreaterThanOrEqual(previous[key].h);
        expect(L.cards[0].h).toBeGreaterThanOrEqual(previous.cards[0].h);
        previous = L;
      }
    }
  });
});
