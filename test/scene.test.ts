import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { describeEvent, displayModel, formatDuration, formatTokens, modelAlias, plainText } from '../src/core/describe.js';
import { BOOT_MS } from '../src/scene/boot.js';
import { renderScene } from '../src/scene/scene.js';
import { type Rect, countBar } from '../src/scene/draw.js';
import { FULL_COLS, FULL_ROWS, type SceneLayout, layoutFor } from '../src/scene/layout.js';
import { theme } from '../src/scene/theme.js';
import { encodeFrame } from '../src/tui/ansi.js';
import { CellBuffer, charWidth, fit, toCells } from '../src/tui/buffer.js';
import { detectColorMode, mix, rgb, to256 } from '../src/tui/color.js';
import { applyEvent, createState } from '../src/core/state.js';
import type { SceneView } from '../src/scene/view.js';
import { MID_SESSION_MS, fixtureView, idleView } from '../tools/lib/fixture-view.js';

function render(cols = FULL_COLS, rows = FULL_ROWS, view = fixtureView(MID_SESSION_MS)): CellBuffer {
  const buf = new CellBuffer(cols, rows);
  renderScene(buf, view);
  return buf;
}

const L = layoutFor(FULL_COLS, FULL_ROWS) as SceneLayout;
const screenText = (buf: CellBuffer): string => Array.from({ length: buf.height }, (_, y) => buf.rowText(y)).join('\n');
const rectText = (buf: CellBuffer, r: Rect): string => Array.from({ length: r.h }, (_, i) => buf.rowText(r.y + i, r.x, r.x + r.w)).join('\n');

function textRow(buf: CellBuffer, text: string): number {
  for (let y = 0; y < buf.height; y += 1) if (buf.rowText(y).includes(text)) return y;
  return -1;
}

/** El borde de una caja, dibujado de verdad en el buffer. */
function expectBox(buf: CellBuffer, r: Rect, ox = 0, oy = 0): void {
  const right = r.x + r.w - 1 + ox;
  const bottom = r.y + r.h - 1 + oy;
  const x = r.x + ox;
  const y = r.y + oy;
  expect(buf.charAt(x, y), 'esquina superior izquierda').toBe('┌');
  expect(buf.charAt(right, y), 'esquina superior derecha').toBe('┐');
  expect(buf.charAt(x, bottom), 'esquina inferior izquierda').toBe('└');
  expect(buf.charAt(right, bottom), 'esquina inferior derecha').toBe('┘');
}

describe('geometría medida sobre el buffer', () => {
  const buf = render();

  it('todos los paneles están dibujados donde dice el layout', () => {
    for (const r of [L.project, L.main, L.advisor, L.memory, ...L.cards, L.lead, L.log]) expectBox(buf, r);
  });

  it('filas de texto', () => {
    expect(textRow(buf, 'SINAPSIS')).toBe(L.rows.header);
    expect(textRow(buf, 'lead · haiku')).toBe(L.rows.legend);
    expect(textRow(buf, 'delegated')).toBe(L.rows.delegate);
    expect(textRow(buf, 'q quit')).toBe(L.rows.prompt);
    expect(textRow(buf, 'queued')).toBe(L.rows.status);
  });

  it('encabezado centrado', () => {
    const header = buf.rowText(L.rows.header);
    const start = header.indexOf('SINAPSIS');
    const end = header.lastIndexOf('LIVE') + 4;
    expect(Math.abs(start - (FULL_COLS - end))).toBeLessThanOrEqual(1);
  });

  it('conectores: tronco continuo hasta el bus, del bus a cada tarjeta y de vuelta al lead', () => {
    const { rows, spine, cardCenters, main } = L;
    for (let y = main.y + main.h; y < rows.bus; y += 1) expect(buf.charAt(spine, y), `fila ${y}`).toBe('│');
    expect(buf.charAt(cardCenters[0], rows.bus)).toBe('┌');
    expect(buf.charAt(spine, rows.bus)).toBe('┼');
    expect(buf.charAt(cardCenters[2], rows.bus)).toBe('┐');
    for (const center of cardCenters) expect(buf.charAt(center, L.cardArrowRow as number)).toBe('▼');
    expect(buf.charAt(cardCenters[0], rows.merge)).toBe('└');
    expect(buf.charAt(cardCenters[2], rows.merge)).toBe('┘');
    expect(buf.charAt(spine, L.leadArrowRow as number)).toBe('▼');
  });

  it('flechas punteadas desde la memoria de proyecto hasta sus tres destinos', () => {
    const edge = L.project.x + L.project.w;
    const targets = [L.main.x, L.cards[0].x, L.lead.x];
    L.milestones.forEach((row, i) => {
      expect(buf.charAt(edge, row)).toBe('┄');
      expect(buf.charAt((targets[i] as number) - 1, row)).toBe('▸');
    });
  });

  it('una terminal mayor centra el layout y sigue usando la misma geometría', () => {
    const big = render(120, 60);
    const layout = layoutFor(120, 60) as SceneLayout;
    expectBox(big, layout.project, layout.originX, layout.originY);
    expectBox(big, layout.log, layout.originX, layout.originY);
    expect(big.rowText(layout.rows.header + layout.originY)).toContain('SINAPSIS');
  });
});

describe('contenido', () => {
  it('identidad de sesión en el encabezado y sin valores de ejemplo ni textos fijos de las imágenes', () => {
    const all = screenText(render(FULL_COLS, FULL_ROWS, fixtureView()));
    expect(all).toContain('SINAPSIS');
    expect(all).toContain('LIVE');
    for (const banned of [
      'CLAUDE CODE ADVISOR',
      'skunzu',
      'jev',
      'forks',
      '2,625',
      'files: 156',
      'call sites',
      '%',
      'SUBAGENT TIP',
      '~/app',
      'builder',
      'debugger',
      'reviewer',
      'Sonnet',
      'illustrative',
      'saved findings',
      'loaded next time',
      'per-agent notes',
      'build then debug',
      'review the diff',
      'read so far',
      'persistent',
      'integrate + verify',
      'delegate to subagents',
      'claude --model',
      'reconstructed, not literal',
    ]) {
      expect(all).not.toContain(banned);
    }
  });

  it('están todos los apartados funcionales', () => {
    const all = screenText(render(FULL_COLS, FULL_ROWS, fixtureView()));
    for (const part of ['PROJECT MEMORY', 'before work', 'repeat failure', 'before sign-off', 'totals', 'errors', 'main session', 'AGENT MEMORY', 'roles', 'delegated ·', 'back to', '· lead', 'session log', 'q quit', 'elapsed', 'ADVISOR']) expect(all).toContain(part);
  });

  it('los datos del advisor y de las tarjetas son los del reductor', () => {
    const view = fixtureView();
    const buf = render(FULL_COLS, FULL_ROWS, view);
    const advisorBox = rectText(buf, L.advisor);
    expect(advisorBox).toContain('Opus 5.5');
    expect(advisorBox).toContain('97.9k tok');
    const cards = L.cards.map((r) => rectText(buf, r)).join('\n');
    expect(cards).toContain('explore');
    expect(cards).toContain('Haiku 5.5');
    expect(cards).toContain('read-only');
    expect(cards).toContain('3 tools');
    expect(cards).toContain('done · 10 s');
    expect(rectText(buf, L.lead)).toContain('3 back');
  });

  it('la lectura real de un archivo de memoria aparece en ambos paneles', () => {
    const view = fixtureView();
    expect(view.state.memory.touches.map((t) => t.file)).toContain('CLAUDE.md');
    const buf = render(FULL_COLS, FULL_ROWS, view);
    expect(rectText(buf, L.project)).toContain('CLAUDE.md');
    // Las tres ejecuciones del fixture son del mismo rol (`explore`): una sola fila, con el rol que tocó memoria.
    expect(new Set(view.state.subagents.map((s) => s.agentType)).size).toBe(1);
    expect(rectText(buf, L.memory)).toContain('recall');
    expect(rectText(buf, L.memory)).not.toContain('no memory');
    expect(rectText(buf, L.memory)).toContain('real tool calls');
    expect(rectText(buf, L.memory)).toContain('1 / 1');
  });

  it('los patrones de herramientas se muestran literales', () => {
    expect(rectText(render(FULL_COLS, FULL_ROWS, fixtureView()), L.log)).toContain('fixtures/*.jsonl');
  });

  it('una tarjeta terminada tiene la barra llena, también sin animación', () => {
    const buf = render(FULL_COLS, FULL_ROWS, fixtureView());
    const card = L.cards[0];
    expect(buf.charAt(card.x + 2, card.y + 3)).toBe('█');
    expect(buf.rowText(card.y + 3, card.x, card.x + card.w)).not.toContain('░');
  });

  it('una tarjeta en curso no muestra porcentaje y sí su contador real', () => {
    const view = fixtureView(MID_SESSION_MS);
    expect(view.state.subagents.some((s) => s.running)).toBe(true);
    const buf = render(FULL_COLS, FULL_ROWS, view);
    const cards = L.cards.map((r) => rectText(buf, r)).join('\n');
    expect(cards).toMatch(/\d+ tools?/);
    expect(cards).toContain('running');
    expect(cards).not.toContain('%');
  });

  it('ningún texto se sale de un panel: los bordes quedan intactos', () => {
    for (const [cols, rows] of [[FULL_COLS, FULL_ROWS], [80, 30], [120, 30], [80, 38], [120, 45]] as const) {
      const layout = layoutFor(cols, rows) as SceneLayout;
      for (const view of [fixtureView(MID_SESSION_MS), fixtureView(), idleView()]) {
        const buf = render(cols, rows, view);
        for (const r of [layout.project, layout.main, layout.advisor, layout.memory, ...layout.cards, layout.lead, layout.log]) {
          const left = r.x + layout.originX;
          const right = left + r.w - 1;
          for (let y = r.y + 1 + layout.originY; y < r.y + r.h - 1 + layout.originY; y += 1) {
            expect('│╎', `${cols}x${rows} columna ${left}, fila ${y}`).toContain(buf.charAt(left, y));
            expect('│╎', `${cols}x${rows} columna ${right}, fila ${y}`).toContain(buf.charAt(right, y));
          }
        }
      }
    }
  });

  it('panel en reposo sin sesión', () => {
    const buf = render(FULL_COLS, FULL_ROWS, idleView());
    expect(rectText(buf, L.main)).toContain('waiting for a session');
    expect(buf.rowText(L.rows.header)).toContain('SINAPSIS');
    expect(buf.rowText(L.rows.header)).toContain('WAITING FOR A SESSION');
    expect(rectText(buf, L.project)).toContain('no memory files');
    expect(rectText(buf, L.memory)).toContain('no subagents yet');
    expect(buf.rowText(L.rows.delegate)).toContain('no subagents yet');
    expect(rectText(buf, L.lead)).toContain('no summaries yet');
  });

  it('los modelos que la cola aún no deja ver evitan el encabezado en espera', () => {
    const buf = render(FULL_COLS, FULL_ROWS, { ...idleView(), preview: { main: 'claude-haiku-5-5', advisor: 'claude-opus-5-5' } });
    expect(buf.rowText(L.rows.header)).not.toContain('WAITING FOR A SESSION');
    expect(buf.rowText(L.rows.legend)).toContain('lead · Haiku 5.5');
  });

  it('un texto ancho o con controles no desarma las filas', () => {
    const state = createState();
    state.title = '日本語のタイトル 🚀\tcon\ncontrol';
    state.mainModel = 'claude-haiku-5-5';
    const buf = render(FULL_COLS, FULL_ROWS, { state, log: [], now: 0, queue: { pending: [] }, connected: true });
    const y = L.main.y + 2;
    expect([...buf.rowText(y)].length).toBe(FULL_COLS);
    for (let x = 0; x < FULL_COLS; x += 1) expect(charWidth(buf.charAt(x, y).codePointAt(0) as number)).toBe(1);
  });

  it('color: los paneles usan los tokens del tema, sobre un fondo plano', () => {
    const buf = render();
    expect(buf.fgAt(L.project.x, L.project.y)).toBe(mix(theme.notes, theme.panel, 0.12));
    expect(buf.fgAt(L.main.x, L.main.y)).toBe(mix(theme.main, theme.panel, 0.12));
    expect(buf.fgAt(L.memory.x, L.memory.y)).toBe(mix(theme.metrics, theme.panel, 0.12));
    expect(buf.bgAt(0, 0)).toBe(theme.bg);
    expect(buf.bgAt(45, 20)).toBe(theme.bg);
    expect(buf.bgAt(FULL_COLS - 1, FULL_ROWS - 1)).toBe(theme.bg);
  });
});

describe('layout compacto', () => {
  const sizes = [[80, 30], [120, 30], [100, 35], [120, 40], [89, 46]] as const;

  it('una ventana normal conserva todos los apartados y sus conexiones', () => {
    for (const [cols, rows] of sizes) {
      const layout = layoutFor(cols, rows) as SceneLayout;
      expect(layout.kind).toBe('compact');
      const buf = render(cols, rows, fixtureView());
      const all = screenText(buf);
      for (const part of ['PROJECT MEMORY', 'before work', 'repeat failure', 'before sign-off', 'main session', 'ADVISOR', 'AGENT MEMORY', 'delegated ·', 'explore', 'back to', 'session log', 'q quit', 'queued']) {
        expect(all, `${cols}x${rows}: ${part}`).toContain(part);
      }
      for (const r of [layout.project, layout.main, layout.memory, ...layout.cards, layout.lead, layout.log]) {
        expect(buf.charAt(r.x + layout.originX, r.y + layout.originY)).toBe('┌');
        expect(buf.charAt(r.x + r.w - 1 + layout.originX, r.y + layout.originY)).toBe('┐');
        expect(buf.charAt(r.x + layout.originX, r.y + r.h - 1 + layout.originY)).toBe('└');
        expect(buf.charAt(r.x + r.w - 1 + layout.originX, r.y + r.h - 1 + layout.originY)).toBe('┘');
      }
      expect(buf.charAt(layout.spine + layout.originX, layout.rows.bus + layout.originY)).toBe('┼');
      expect(buf.charAt(layout.spine + layout.originX, layout.rows.merge + layout.originY)).toBe('┼');
    }
  });

  it('el rótulo de la memoria se ve también sin fila propia', () => {
    const all = screenText(render(80, 30, fixtureView()));
    expect(all).toContain('bars · real tool calls');
  });

  it('el nombre del agente no se corta para mostrar el modelo', () => {
    const all = screenText(render(80, 30, fixtureView()));
    expect(all).toContain('explore · haiku');
  });

  it('la flecha va sobre el borde de la tarjeta cuando no tiene fila propia', () => {
    const layout = layoutFor(80, 30) as SceneLayout;
    const buf = render(80, 30, fixtureView());
    expect(layout.cardArrowRow).toBeUndefined();
    for (const center of layout.cardCenters) expect(buf.charAt(center, layout.cards[0].y)).toBe('▼');
    expect(buf.charAt(layout.spine, layout.lead.y)).toBe('▼');
  });
});

describe('layouts según el tamaño', () => {
  it('el reducido a 80x24 conserva advisor, principal, subagentes y log, y avisa cómo ver todo', () => {
    const buf = render(80, 24, fixtureView());
    const all = screenText(buf);
    expect(all).toContain('OPUS 5.5 · on call');
    expect(all).toContain('main');
    expect(all).toContain('Estructura');
    expect(all).toContain('session log');
    expect(all).toContain('after subagents');
    expect(all).toContain('calls');
    expect(all).toContain('30+ rows: full view');
  });

  it('el mensaje de ventana pequeña dice el tamaño real', () => {
    const buf = render(60, 20);
    const all = screenText(buf);
    expect(all).toContain('Agranda la ventana');
    expect(all).toContain('80x24');
    expect(all).toContain('60x20');
  });

  it('ningún tamaño intermedio falla', () => {
    for (const [cols, rows] of [[80, 24], [81, 25], [89, 45], [90, 24], [80, 45], [120, 30], [80, 29], [79, 23], [1, 1], [10, 2]] as const) {
      for (const view of [fixtureView(MID_SESSION_MS), fixtureView(), idleView()]) {
        expect(() => render(cols, rows, view)).not.toThrow();
      }
    }
  });
});

describe('diff ANSI', () => {
  async function feed(term: Terminal, bytes: string): Promise<void> {
    await new Promise<void>((resolve) => term.write(bytes, resolve));
  }

  function expectMatch(term: Terminal, buf: CellBuffer): void {
    const active = term.buffer.active;
    for (let y = 0; y < buf.height; y += 1) {
      const line = active.getLine(y);
      for (let x = 0; x < buf.width; x += 1) {
        const cell = line?.getCell(x);
        expect(cell?.getChars() || ' ', `celda ${x},${y}`).toBe(buf.charAt(x, y));
      }
    }
  }

  it('los bytes reales reproducen el buffer en un emulador', async () => {
    const buf = render();
    const term = new Terminal({ cols: FULL_COLS, rows: FULL_ROWS, allowProposedApi: true });
    await feed(term, `\x1b[?7l${encodeFrame(null, buf, 'truecolor')}`);
    expectMatch(term, buf);
    const cell = term.buffer.active.getLine(L.project.y)?.getCell(L.project.x);
    expect(cell?.isFgRGB()).toBe(true);
    expect(cell?.getFgColor()).toBe(mix(theme.notes, theme.panel, 0.12));
    term.dispose();
  });

  it('el diff aplicado sobre el frame anterior llega al mismo resultado', async () => {
    const first = render(FULL_COLS, FULL_ROWS, fixtureView(MID_SESSION_MS, 0));
    const second = render(FULL_COLS, FULL_ROWS, fixtureView(MID_SESSION_MS + 20_000, 777));
    const term = new Terminal({ cols: FULL_COLS, rows: FULL_ROWS, allowProposedApi: true });
    await feed(term, `\x1b[?7l${encodeFrame(null, first, 'truecolor')}`);
    await feed(term, encodeFrame(first, second, 'truecolor'));
    expectMatch(term, second);
    term.dispose();
  });

  it('sin cambios no escribe nada, y un cambio escribe poco', () => {
    const a = render();
    const b = new CellBuffer(a.width, a.height);
    b.copyFrom(a);
    expect(encodeFrame(a, b, 'truecolor')).toBe('');
    b.put(50, 20, 'x', theme.text);
    const bytes = encodeFrame(a, b, 'truecolor');
    expect(bytes.length).toBeLessThan(80);
    expect(bytes.startsWith('\x1b[?2026h')).toBe(true);
    expect(bytes.endsWith('\x1b[?2026l')).toBe(true);
  });

  it('un cambio de tamaño redibuja todo', () => {
    const a = render(80, 24);
    const b = render(90, 46);
    expect(encodeFrame(a, b, 'truecolor').length).toBeGreaterThan(encodeFrame(null, a, 'truecolor').length);
  });

  it('en 256 colores no emite truecolor', async () => {
    const bytes = encodeFrame(null, render(), '256');
    expect(bytes).not.toContain('38;2;');
    expect(bytes).not.toContain('48;2;');
    expect(bytes).toContain('38;5;');
    const term = new Terminal({ cols: FULL_COLS, rows: FULL_ROWS, allowProposedApi: true });
    await feed(term, `\x1b[?7l${bytes}`);
    expectMatch(term, render());
    term.dispose();
  });
});

describe('animación 1: arranque', () => {
  const frame = (bootMs: number | undefined): CellBuffer => {
    const buf = new CellBuffer(FULL_COLS, FULL_ROWS);
    renderScene(buf, { ...fixtureView(), now: 1100, anim: { bootMs } });
    return buf;
  };
  const sameCells = (a: CellBuffer, b: CellBuffer): boolean =>
    a.chars.every((c, i) => c === b.chars[i]) && a.fg.every((c, i) => c === b.fg[i]) && a.bg.every((c, i) => c === b.bg[i]);

  it('termina exactamente en el frame estático: solo oculta, no cambia datos', () => {
    const still = frame(undefined);
    expect(sameCells(frame(BOOT_MS), still)).toBe(true);
    expect(sameCells(frame(BOOT_MS + 5000), still)).toBe(true);
    expect(sameCells(frame(BOOT_MS / 2), still)).toBe(false);
  });

  it('al empezar no hay paneles ni encabezado completo', () => {
    const buf = frame(0);
    expect(buf.rowText(L.rows.header)).not.toContain('SINAPSIS');
    expect(buf.charAt(L.project.x, L.project.y)).toBe(' ');
    expect(buf.charAt(L.main.x, L.main.y)).toBe(' ');
  });

  it('el encabezado se escribe de izquierda a derecha', () => {
    const lengths = [100, 300, 500, 700, 900].map((ms) => frame(ms).rowText(L.rows.header).trim().length);
    for (let i = 1; i < lengths.length; i += 1) expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1] as number);
    expect(lengths[0]).toBeLessThan(lengths[4] as number);
  });

  it('un borde se dibuja recorriendo el panel: arriba antes que abajo', () => {
    const r = L.project;
    const early = frame(400);
    expect(early.charAt(r.x, r.y)).toBe('┌');
    expect(early.charAt(r.x, r.y + r.h - 1)).toBe(' ');
    const later = frame(800);
    expect(later.charAt(r.x + r.w - 1, r.y)).toBe('┐');
  });

  it('los paneles entran en cascada: la memoria de proyecto antes que el log', () => {
    const buf = frame(700);
    expect(buf.charAt(L.project.x, L.project.y)).toBe('┌');
    expect(buf.charAt(L.log.x, L.log.y)).toBe(' ');
    expect(frame(2000).charAt(L.log.x, L.log.y)).toBe('┌');
  });

  it('funciona en una terminal mayor, en el compacto y en el reducido', () => {
    const big = new CellBuffer(120, 60);
    renderScene(big, { ...fixtureView(), anim: { bootMs: 500 } });
    expect(big.originX).toBe(0);
    for (const [cols, rows] of [[120, 30], [80, 30], [80, 24]] as const) {
      const buf = new CellBuffer(cols, rows);
      expect(() => renderScene(buf, { ...fixtureView(), anim: { bootMs: 100 } })).not.toThrow();
    }
  });
});

describe('color y texto', () => {
  it('mix interpola y recorta', () => {
    expect(mix(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mix(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mix(0x000000, 0xffffff, 2)).toBe(0xffffff);
    expect(mix(0x000000, 0xffffff, -1)).toBe(0x000000);
    expect(mix(0x102030, 0x102030, 0.5)).toBe(0x102030);
    expect(rgb('#0b1026')).toBe(0x0b1026);
  });

  it('to256 elige del cubo o de los grises', () => {
    expect(to256(0xff0000)).toBe(196);
    expect(to256(0x000000)).toBe(16);
    expect(to256(0x808080)).toBeGreaterThanOrEqual(232);
    expect(detectColorMode(24)).toBe('truecolor');
    expect(detectColorMode(8)).toBe('256');
    expect(detectColorMode(4)).toBe('256');
  });

  it('toCells y fit', () => {
    expect(toCells('a\tb\nc')).toBe('abc');
    expect(toCells('日本')).toBe('□□');
    expect(toCells('ñandú')).toBe('ñandú');
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(fit('abc', 4)).toBe('abc');
    expect(fit('abc', 0)).toBe('');
  });

  it('formatos', () => {
    expect(displayModel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(displayModel('claude-opus-5-5-20270101')).toBe('Opus 5.5');
    expect(displayModel('otro')).toBe('otro');
    expect(displayModel(undefined)).toBe('—');
    expect(modelAlias('claude-opus-5-5')).toBe('opus');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(64726)).toBe('64.7k');
    expect(formatTokens(181651)).toBe('182k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatDuration(42_500)).toBe('43 s');
    expect(formatDuration(7686)).toBe('7.7 s');
    expect(formatDuration(undefined)).toBe('—');
    expect(plainText('**Hola** `x`\n\n# t …<recortado:12>')).toBe('Hola x t …');
  });

  it('el log rotula como inferido lo inferido', () => {
    const state = createState();
    state.advisorModel = 'claude-opus-5-5';
    expect(describeEvent({ type: 'advisor_consult', t: 1, id: 'a', reason: 'check-in' }, state)?.text).toContain('(inferred)');
    expect(describeEvent({ type: 'session_end', t: 1 }, state)?.text).toContain('(inferred)');
    expect(describeEvent({ type: 'message_usage', t: 1, messageId: 'm', input: 0, output: 0, cacheRead: 0, cacheCreation: 0, hasAdvisor: false }, state)).toBeUndefined();
    expect(describeEvent({ type: 'tool_result', t: 1, id: 'x', isError: true }, state)?.kind).toBe('error');
    expect(describeEvent({ type: 'tool_result', t: 1, id: 'x', isError: false }, state)).toBeUndefined();
  });
});

describe('AGENT MEMORY por rol y rótulos de rol', () => {
  /** Sesión sintética: cada ejecución es `[agentType, ¿toca memoria?, ¿sigue corriendo?]`. */
  function roleView(runs: Array<[string | undefined, boolean, boolean]>, extra: Partial<SceneView> = {}): SceneView {
    const state = createState();
    applyEvent(state, { type: 'session_info', t: 1, mainModel: 'claude-opus-5-5', advisorModel: 'claude-opus-5-5', cwd: '/p' });
    applyEvent(state, { type: 'user_prompt', t: 2, text: 'trabaja' });
    runs.forEach(([agentType, touches, running], i) => {
      const id = `ag${i}`;
      const t = 1000 * (i + 1);
      applyEvent(state, { type: 'subagent_start', t, subagentId: id, model: 'claude-sonnet-5-5' });
      applyEvent(state, { type: 'subagent_info', t, subagentId: id, description: `tarea ${i}`, ...(agentType ? { agentType } : {}) });
      if (touches) applyEvent(state, { type: 'tool_call', t: t + 10, id: `m${i}`, name: 'Read', agentId: id, memory: { file: 'CLAUDE.md', scope: 'project', op: 'read' } });
      if (!running) applyEvent(state, { type: 'subagent_end', t: t + 500, subagentId: id, status: 'completed' });
    });
    return { state, log: [], now: 1100, queue: { pending: [] }, connected: true, ...extra };
  }

  const memoryText = (view: SceneView, cols = FULL_COLS, rows = FULL_ROWS): string => {
    const layout = layoutFor(cols, rows) as SceneLayout;
    const buf = render(cols, rows, view);
    return Array.from({ length: layout.memory.h }, (_, i) => buf.rowText(layout.memory.y + layout.originY + i, layout.memory.x + layout.originX, layout.memory.x + layout.originX + layout.memory.w)).join('\n');
  };
  const rowsNamed = (text: string, name: string): number => text.split('\n').filter((line) => line.includes(`│ ${name} `)).length;

  it('siete ejecuciones de tres roles que tocaron memoria: roles 3 / 3 y una fila por rol', () => {
    const runs: Array<[string, boolean, boolean]> = [
      ['builder', true, false],
      ['builder', true, false],
      ['builder', false, false],
      ['reviewer', true, false],
      ['reviewer', true, false],
      ['debugger', true, false],
      ['debugger', true, false],
    ];
    const view = roleView(runs);
    expect(view.state.subagents).toHaveLength(7);
    const text = memoryText(view);
    expect(text).toContain('3 / 3');
    for (const role of ['builder', 'reviewer', 'debugger']) expect(rowsNamed(text, role), role).toBe(1);
    expect(text).not.toContain('no memory');
  });

  it('un rol sin memoria cuenta en el total pero no en el numerador', () => {
    const view = roleView([['builder', true, false], ['builder', true, false], ['reviewer', false, false]]);
    applyEvent(view.state, { type: 'subagent_info', t: 5000, subagentId: 'ag2', memoryIndexed: false });
    const text = memoryText(view);
    expect(text).toContain('1 / 2');
    expect(text).toContain('no memory');
  });

  it('un rol con no data se muestra, pero queda fuera de la cuenta', () => {
    const text = memoryText(roleView([['builder', true, false], ['reviewer', false, false]]));
    expect(text).toContain('1 / 1');
    expect(text).toContain('no data');
    expect(memoryText(roleView([['reviewer', false, false]]))).toContain('0 / 0');
  });

  it('sin operaciones, distingue índice con notas, sin notas y sin dato', () => {
    const view = roleView([['builder', false, false], ['debugger', false, false], ['reviewer', false, false]]);
    applyEvent(view.state, { type: 'subagent_info', t: 5000, subagentId: 'ag0', memoryIndexed: true });
    applyEvent(view.state, { type: 'subagent_info', t: 5000, subagentId: 'ag1', memoryIndexed: false });
    const lines = memoryText(view).split('\n');
    expect(lines.find((line) => line.includes('builder'))).toContain('indexed');
    expect(lines.find((line) => line.includes('debugger'))).toContain('no memory');
    expect(lines.find((line) => line.includes('reviewer'))).toContain('no data');
    // Tener notas cuenta como memoria, sin dibujar operaciones que no ocurrieron.
    expect(lines.join('\n')).toContain('1 / 2');
    expect(lines.find((line) => line.includes('builder'))).not.toContain('█');
    for (const [cols, rows] of [[80, 30], [120, 30]] as const) expect(memoryText(view, cols, rows)).toContain('indexed');
  });

  it('una operación real tiene prioridad sobre el índice', () => {
    const view = roleView([['builder', true, false]]);
    applyEvent(view.state, { type: 'subagent_info', t: 5000, subagentId: 'ag0', memoryIndexed: true });
    const text = memoryText(view);
    expect(text).toContain('recall');
    expect(text).not.toContain('indexed');
    expect(text).toContain('1 / 1');
  });

  it('la barra suma las operaciones de todas las ejecuciones del rol', () => {
    const view = roleView([['builder', true, false], ['builder', true, false], ['reviewer', true, false]]);
    const lines = memoryText(view).split('\n');
    const full = lines.find((line) => line.includes('builder')) as string;
    const half = lines.find((line) => line.includes('reviewer')) as string;
    expect(full).toContain('███████');
    expect(full).not.toContain('░');
    expect(half).toContain('███▌░░░');
  });

  it('un subagente sin tipo es su propio rol', () => {
    const text = memoryText(roleView([[undefined, true, false], [undefined, true, false]]));
    expect(text).toContain('2 / 2');
    expect(text.split('\n').filter((line) => line.includes('tarea')).length).toBe(2);
  });

  it('con más roles que filas, primero los que corren y luego la memoria más reciente, en orden estable', () => {
    const runs: Array<[string, boolean, boolean]> = [
      ['alfa', true, false],
      ['beta', true, false],
      ['gamma', true, false],
      ['delta', false, true],
      ['epsilon', false, false],
    ];
    const text = memoryText(roleView(runs));
    // Corre `delta`; entre los demás, las memorias más recientes son las de `gamma` y `beta`.
    expect(rowsNamed(text, 'delta')).toBe(1);
    expect(rowsNamed(text, 'gamma')).toBe(1);
    expect(rowsNamed(text, 'beta')).toBe(1);
    expect(rowsNamed(text, 'alfa')).toBe(0);
    expect(rowsNamed(text, 'epsilon')).toBe(0);
    expect(text).toContain('3 / 3');
    // Las filas salen en el orden en que aparecieron los roles.
    const order = ['beta', 'gamma', 'delta'].map((name) => text.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('la demo no cambia: una fila por tarjeta activa, aunque repitan rol, y sin filas — para slots vacíos', () => {
    const base = roleView([['builder', false, true], ['builder', false, true], ['builder', false, true]]);
    const illustrative = { percents: [10, 20, 30], memory: [{ fraction: 0.7, label: 'recall' as const }, { fraction: 0.8, label: 'check' as const }, { fraction: 0.9, label: 'recall' as const }] };
    const view: SceneView = {
      ...base,
      illustrativeDemo: true,
      anim: { cards: base.state.subagents.map((s) => ({ id: s.id, grow: 1, fade: 0 })), illustrative },
    };
    const text = memoryText(view);
    expect(rowsNamed(text, 'builder')).toBe(3);
    expect(text).toContain('3 / 3');
    expect(text).toContain('illustrative activity');
    expect(text).toContain('check');
    const oneSlot = roleView([['builder', false, true]]);
    const oneSlotDemo: SceneView = {
      ...oneSlot,
      illustrativeDemo: true,
      anim: { cards: [{ id: 'ag0', grow: 1, fade: 0 }, undefined, undefined], illustrative },
    };
    expect(memoryText(oneSlotDemo)).not.toContain('│ —');
  });

  it('leyenda con agent memory / project memory y línea de estado con elapsed, cost y cola', () => {
    const view = roleView([['builder', true, true]]);
    view.state.costUSD = 0.42;
    view.queue = { last: 'builder · Read · CLAUDE.md', pending: ['tool'] };
    const buf = render(FULL_COLS, FULL_ROWS, view);
    const legend = buf.rowText(L.rows.legend);
    // Todos en alias o todos con su nombre completo, sin mezclar.
    for (const part of ['lead · opus', 'build · sonnet', 'agent memory', 'project memory', 'advisor · opus']) expect(legend).toContain(part);
    const wideLegend = render(120, 30, view).rowText((layoutFor(120, 30) as SceneLayout).rows.legend);
    for (const part of ['lead · Opus 5.5', 'build · Sonnet 5.5', 'agent memory', 'project memory', 'advisor · Opus 5.5']) expect(wideLegend).toContain(part);
    const status = buf.rowText(L.rows.status);
    for (const part of ['elapsed 00:00:01', 'cost $0.42', 'builder · Read', '■', '1 queued']) expect(status).toContain(part);
    for (const old of ['lead [', 'subagents [', 'memories [', 'build [', 'advisor [']) expect(status).not.toContain(old);
    expect(buf.rowText(L.rows.header)).toContain('SINAPSIS · p · LIVE');
    expect(rectText(buf, L.lead)).toContain('back to Opus 5.5 · lead');
  });

  it('leyenda sin subagentes: no atribuye un modelo a build', () => {
    for (const [cols, rows] of [[FULL_COLS, FULL_ROWS], [84, 46], [80, 30], [120, 30]] as const) {
      const legend = render(cols, rows, roleView([])).rowText((layoutFor(cols, rows) as SceneLayout).rows.legend);
      expect(legend, `${cols}x${rows}`).toContain('lead · Opus 5.5');
      expect(legend, `${cols}x${rows}`).toContain('advisor · Opus 5.5');
      expect(legend, `${cols}x${rows}`).toMatch(/build\s+■/);
    }
  });

  it('caja del advisor: estado sobre el borde, y consultas y tokens completos en su fila', () => {
    const view = roleView([]);
    applyEvent(view.state, { type: 'advisor_consult', t: 5000, id: 'c1', reason: 'before a plan' });
    applyEvent(view.state, { type: 'advisor_reply', t: 6000, id: 'c1', durationMs: 1000, tokensRead: 87_460, tokensWritten: 10, isError: false });
    const row = (buf: CellBuffer, y: number): string => buf.rowText(L.advisor.y + y, L.advisor.x, L.advisor.x + L.advisor.w);
    const one = render(FULL_COLS, FULL_ROWS, view);
    expect(row(one, 0)).toContain(' silent ');
    expect(row(one, 3)).toContain('1 consult');
    expect(row(one, 3)).not.toContain('consults');
    expect(row(one, 4)).toContain('87.5k tok');
    expect(one.charAt(L.advisor.x, L.advisor.y)).toBe('┌');
    expect(one.charAt(L.advisor.x + L.advisor.w - 1, L.advisor.y)).toBe('┐');
    applyEvent(view.state, { type: 'advisor_consult', t: 7000, id: 'c2', reason: 'before a plan' });
    const open = render(FULL_COLS, FULL_ROWS, view);
    expect(row(open, 0)).toContain(' replaying ');
    expect(row(open, 3)).toContain('2 consults');
    expect(open.charAt(L.advisor.x, L.advisor.y)).toBe('┌');
    expect(open.charAt(L.advisor.x + L.advisor.w - 1, L.advisor.y)).toBe('┐');
  });

  it('back to lead: sin resumen no inventa texto, y sin subagentes cerrados muestra waiting for N summaries', () => {
    const row = L.lead.y + 2;
    const rowAndColor = (view: SceneView): { text: string; fg: unknown } => {
      const buf = render(FULL_COLS, FULL_ROWS, view);
      const text = buf.rowText(row, L.lead.x + 1, L.lead.x + L.lead.w - 1);
      const letter = text.search(/\S/);
      return { text, fg: buf.fgAt(L.lead.x + 1 + letter, row) };
    };
    const closed = rowAndColor(roleView([['builder', true, false]]));
    expect(closed.text).toContain('1 back');
    expect(closed.text).not.toContain('integrate');
    expect(closed.fg).toEqual(theme.text);
    const running = rowAndColor(roleView([['builder', true, true], ['reviewer', false, true]]));
    expect(running.text).toContain('waiting for 2 summaries');
    expect(running.fg).toEqual(theme.dim);
  });

  it('borde del advisor: punteado en silent y sólido en replaying', () => {
    const silent = render(FULL_COLS, FULL_ROWS, roleView([]));
    expect(silent.charAt(L.advisor.x + 1, L.advisor.y)).toBe('╌');
    const view = roleView([]);
    applyEvent(view.state, { type: 'advisor_consult', t: 5000, id: 'c1', reason: 'before a plan' });
    const replaying = render(FULL_COLS, FULL_ROWS, view);
    expect(replaying.charAt(L.advisor.x + 1, L.advisor.y + L.advisor.h - 1)).toBe('─');
  });

  it('barra de tarjeta en curso representa toolCount real (1 celda por herramienta) y nunca barra indeterminada', () => {
    const view = roleView([['builder', false, true]]);
    const sub = view.state.subagents[0]!;
    sub.toolCount = 3;
    const buf = render(FULL_COLS, FULL_ROWS, view);
    const card = L.cards[0];
    const barRow = buf.rowText(card.y + 3, card.x + 2, card.x + 10);
    expect(barRow.startsWith('███░')).toBe(true);
    // La celda más reciente brilla más que las anteriores.
    expect(buf.fgAt(card.x + 4, card.y + 3)).not.toBe(buf.fgAt(card.x + 2, card.y + 3));
  });

  it('barra de tarjeta en curso: nunca se ve llena, y sigue avanzando con más herramientas que celdas', () => {
    const buf = new CellBuffer(12, 1);
    const cells = (count: number): string => {
      countBar(buf, 0, 0, 7, count, theme.barSub);
      return buf.rowText(0, 0, 7);
    };
    expect(cells(0)).toBe('░░░░░░░');
    expect(cells(1)).toBe('█░░░░░░');
    expect(cells(6)).toBe('██████░');
    expect(cells(7)).toBe('█░░░░░░');
    expect(cells(12)).toBe('██████░');
    expect(cells(13)).toBe('█░░░░░░');
    for (let count = 0; count < 100; count += 1) expect(cells(count)).toContain('░');
  });

  it('barra de tarjeta: llena solo al terminar, también con muchas herramientas', () => {
    const running = roleView([['builder', false, true]]);
    running.state.subagents[0]!.toolCount = 12;
    const done = roleView([['builder', false, false]]);
    done.state.subagents[0]!.toolCount = 12;
    const card = L.cards[0];
    const barOf = (view: SceneView): string => render(FULL_COLS, FULL_ROWS, view).rowText(card.y + 3, card.x + 2, card.x + 9);
    expect(barOf(running)).toContain('░');
    expect(barOf(done)).toBe('███████');
  });

  it('hora de los hitos en compacto: nunca pisa un total ni se pierde, también con horas de sesión', () => {
    for (const rows of [30, 32, 34, 36, 38]) {
      const view = roleView([['builder', false, false]]);
      view.state.startedAt = 0;
      view.state.promptTimes = [0, 7_200_000];
      view.state.subagents[0]!.endedAt = 7_205_000;
      view.state.errorTimes = [7_211_000];
      // A las 2 h (`2h00`): tras cerrar el subagente es `before sign-off`, y tras el error, `repeat failure`.
      view.state.memory.touches.push({ t: 7_210_000, file: 'MEMORY.md', op: 'read', scope: 'project' });
      view.state.memory.touches.push({ t: 7_215_000, file: 'MEMORY.md', op: 'read', scope: 'project' });
      const layout = layoutFor(80, rows) as SceneLayout;
      const buf = render(80, rows, view);
      const panel = rectText(buf, { ...layout.project, x: layout.project.x + layout.originX, y: layout.project.y + layout.originY });
      expect(panel, `80x${rows}`).toMatch(/agents\s+1/);
      expect(panel, `80x${rows}`).toMatch(/tools\s+0/);
      expect(panel.match(/2h00|02:00:\d\d/g)?.length ?? 0, `80x${rows}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('lista de archivos de memoria: con horas de sesión, el nombre del archivo cabe', () => {
    const view = roleView([['builder', false, false]]);
    view.state.startedAt = 0;
    view.state.memory.touches.push({ t: 10_686_000, file: 'CLAUDE.md', op: 'read', scope: 'project' });
    const panel = rectText(render(FULL_COLS, FULL_ROWS, view), L.project);
    expect(panel).toContain('2h58 CLAUDE.md');
  });

  it('leyenda: si los alias tampoco caben, ningún modelo queda a medias', () => {
    const view = roleView([['builder', false, true]]);
    view.state.mainModel = 'modelo-muy-largo-del-lead';
    const legend = render(80, 30, view).rowText((layoutFor(80, 30) as SceneLayout).rows.legend);
    expect(legend).not.toContain('modelo-muy-largo');
    expect(legend).not.toContain(' · ');
    for (const part of ['lead', 'build', 'agent memory', 'project memory', 'advisor']) expect(legend).toContain(part);
  });

  it('caja del advisor en compacto: consultas y tokens con su unidad, y estado sobre el borde', () => {
    const view = roleView([]);
    applyEvent(view.state, { type: 'advisor_consult', t: 5000, id: 'c1', reason: 'before a plan' });
    applyEvent(view.state, { type: 'advisor_reply', t: 6000, id: 'c1', durationMs: 1000, tokensRead: 87_460, tokensWritten: 10, isError: false });
    for (const [cols, rows] of [[80, 30], [120, 30], [84, 34]] as const) {
      const layout = layoutFor(cols, rows) as SceneLayout;
      const text = rectText(render(cols, rows, view), { ...layout.advisor, x: layout.advisor.x + layout.originX, y: layout.advisor.y + layout.originY });
      for (const part of ['ADVISOR', 'silent', '1 consult', '87.5k tok']) expect(text, `${cols}x${rows}: ${part}`).toContain(part);
    }
  });

  it('hitos de memoria de proyecto muestran la hora del primer disparo (incluso en compact y en repeat failure / before sign-off) o — si no ocurrió', () => {
    const view = roleView([['builder', true, false]]);
    const buf = render(FULL_COLS, FULL_ROWS, view);
    const m0Row = buf.rowText(L.milestones[0], L.project.x + 1, L.project.x + L.project.w - 1);
    const m1Row = buf.rowText(L.milestones[1], L.project.x + 1, L.project.x + L.project.w - 1);
    expect(m0Row).toContain('before work');
    expect(m0Row).toMatch(/\d+:\d{2}/);
    expect(m1Row).toContain('repeat failure');
    expect(m1Row).toContain('—');

    // En compacto (80x30) before work también muestra su hora.
    const compactL = layoutFor(80, 30) as SceneLayout;
    const compactBuf = render(80, 30, view);
    const cm0Row = compactBuf.rowText(compactL.milestones[0] + compactL.originY, compactL.project.x + 1 + compactL.originX, compactL.project.x + compactL.project.w - 1 + compactL.originX);
    expect(cm0Row).toContain('before work');
    expect(cm0Row).toMatch(/\d+:\d{2}/);

    // Cuando se disparan repeat failure y before sign-off, su hora aparece en la fila inferior del hito.
    // after subagent_end (en t=1500), un toque antes de un error (en t=10_000) es before sign-off (slot 2).
    view.state.memory.touches.push({ t: 5_001, file: 'MEMORY.md', op: 'write', scope: 'project' });
    // Con un error registrado en t=10_000, un toque posterior (en t=15_001) es repeat failure (slot 1).
    view.state.errorTimes.push(10_000);
    view.state.memory.touches.push({ t: 15_001, file: 'MEMORY.md', op: 'read', scope: 'project', agentId: 'ag0' });
    const firedBuf = render(FULL_COLS, FULL_ROWS, view);
    const m1Next = firedBuf.rowText(L.milestones[1] + 1, L.project.x + 1, L.project.x + L.project.w - 1);
    const m2Next = firedBuf.rowText(L.milestones[2] + 1, L.project.x + 1, L.project.x + L.project.w - 1);
    expect(m1Next).toContain('00:14');
    expect(m2Next).toContain('00:04');
  });

  it('drawStatus reserva espacio para los cuadros de cola aunque last sea largo y no duplica el costo', () => {
    const view = roleView([['builder', true, false]]);
    view.state.costUSD = 0.59;
    view.queue = {
      last: 'session · ended (inferred) · texto muy largo de resumen que ocupa todo el espacio · $0.59',
      pending: ['tool', 'advisor', 'sub'],
    };
    const buf = render(FULL_COLS, FULL_ROWS, view);
    const status = buf.rowText(L.rows.status);
    expect(status).toContain('■■■');
    expect(status).toContain('3 queued');
    expect(status.match(/\$0\.59/g)?.length).toBe(1);
  });

  it('línea de teclas muestra q quit siempre y controles de replay/demo cuando corresponde', () => {
    const live = render(FULL_COLS, FULL_ROWS, roleView([]));
    expect(live.rowText(L.rows.prompt)).toContain('q quit');
    expect(live.rowText(L.rows.prompt)).not.toContain('space pause');
    const replay = render(FULL_COLS, FULL_ROWS, { ...roleView([]), replay: { speed: 2, paused: false, finished: false } });
    expect(replay.rowText(L.rows.prompt)).toContain('q quit · space pause · +/- speed');
    expect(replay.rowText(L.rows.header)).toContain('REPLAY x2');
  });

  it('la línea de estado cabe en todos los tamaños sin cortar grupos', () => {
    for (const [cols, rows] of [[FULL_COLS, FULL_ROWS], [80, 30], [120, 30], [100, 35], [120, 45]] as const) {
      const layout = layoutFor(cols, rows) as SceneLayout;
      const buf = render(cols, rows, roleView([['builder', true, true]]));
      const status = buf.rowText(layout.rows.status + layout.originY);
      expect(status, `${cols}x${rows}`).toContain('elapsed');
      expect(status, `${cols}x${rows}`).toContain('queued');
      expect([...status].length).toBe(cols);
    }
  });
});
