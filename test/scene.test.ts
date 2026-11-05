import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { describeEvent, displayModel, formatDuration, formatTokens, modelAlias, plainText } from '../src/core/describe.js';
import { BOOT_MS } from '../src/scene/boot.js';
import { renderScene } from '../src/scene/scene.js';
import type { Rect } from '../src/scene/draw.js';
import { FULL_COLS, FULL_ROWS, type SceneLayout, layoutFor } from '../src/scene/layout.js';
import { theme } from '../src/scene/theme.js';
import { encodeFrame } from '../src/tui/ansi.js';
import { CellBuffer, charWidth, fit, toCells } from '../src/tui/buffer.js';
import { detectColorMode, mix, rgb, to256 } from '../src/tui/color.js';
import { createState } from '../src/core/state.js';
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
    expect(textRow(buf, 'CLAUDE CODE ADVISOR')).toBe(L.rows.header);
    expect(buf.rowText(L.rows.separator as number)).toContain('━━━━');
    expect(textRow(buf, '· lead')).toBe(L.rows.legend);
    expect(textRow(buf, 'delegate to subagents')).toBe(L.rows.delegate);
    expect(textRow(buf, '--advisor opus')).toBe(L.rows.prompt);
    expect(textRow(buf, 'queued')).toBe(L.rows.status);
  });

  it('encabezado centrado', () => {
    const header = buf.rowText(L.rows.header);
    const start = header.indexOf('CLAUDE');
    const end = header.lastIndexOf('BUILDS') + 6;
    expect(Math.abs(start - (FULL_COLS - end))).toBeLessThanOrEqual(1);
  });

  it('conectores: del tronco al bus, del bus a cada tarjeta y de vuelta al lead', () => {
    const { rows, spine, cardCenters, main, memory } = L;
    expect(buf.charAt(spine, main.y + main.h)).toBe('│');
    expect(buf.charAt(spine, memory.y + memory.h)).toBe('│');
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
    expect(big.rowText(layout.rows.header + layout.originY)).toContain('CLAUDE CODE ADVISOR');
  });
});

describe('contenido', () => {
  it('modelos reales en el encabezado, sin valores de ejemplo de las imágenes', () => {
    const all = screenText(render(FULL_COLS, FULL_ROWS, fixtureView()));
    expect(all).toContain('HAIKU 5.5 LEADS');
    expect(all).toContain('HAIKU 5.5 BUILDS');
    for (const banned of ['skunzu', 'jev', 'forks', '2,625', 'files: 156', 'call sites', '%', 'SUBAGENT TIP', '~/app', 'builder', 'debugger', 'reviewer', 'Sonnet', 'illustrative']) expect(all).not.toContain(banned);
  });

  it('están todos los apartados de la referencia', () => {
    const all = screenText(render(FULL_COLS, FULL_ROWS, fixtureView()));
    for (const part of ['PROJECT MEMORY', 'before work', 'repeat failure', 'before sign-off', 'agent memories:', 'main session', 'AGENT MEMORY', 'roles', 'delegate to subagents', 'back to', '· lead', 'session log', 'claude --model', 'ADVISOR']) expect(all).toContain(part);
  });

  it('los datos del advisor y de las tarjetas son los del reductor', () => {
    const view = fixtureView();
    const buf = render(FULL_COLS, FULL_ROWS, view);
    const advisorBox = rectText(buf, L.advisor);
    expect(advisorBox).toContain('opus 5.5');
    expect(advisorBox).toContain('2 · 97.9k');
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
    expect(rectText(buf, L.memory)).toContain('recall');
    expect(rectText(buf, L.memory)).toContain('no memory');
    expect(rectText(buf, L.memory)).toContain('real tool calls');
    expect(rectText(buf, L.memory)).toContain('1 / 3');
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
    expect(buf.rowText(L.rows.header)).toContain('WAITING FOR A SESSION');
    expect(rectText(buf, L.project)).toContain('none yet');
  });

  it('los modelos que la cola aún no deja ver evitan el encabezado en espera', () => {
    const buf = render(FULL_COLS, FULL_ROWS, { ...idleView(), preview: { main: 'claude-haiku-5-5', advisor: 'claude-opus-5-5' } });
    expect(buf.rowText(L.rows.header)).toContain('HAIKU 5.5 LEADS');
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
      for (const part of ['PROJECT MEMORY', 'before work', 'repeat failure', 'before sign-off', 'main session', 'ADVISOR', 'AGENT MEMORY', 'delegate to subagents', 'explore', 'back to', 'session log', 'claude --model', 'queued']) {
        expect(all, `${cols}x${rows}: ${part}`).toContain(part);
      }
      for (const r of [layout.project, layout.main, layout.memory, ...layout.cards, layout.lead, layout.log]) expect(buf.charAt(r.x + layout.originX, r.y + layout.originY)).toBe('┌');
      expect(buf.charAt(layout.spine + layout.originX, layout.rows.bus + layout.originY)).toBe('┼');
      expect(buf.charAt(layout.spine + layout.originX, layout.rows.merge + layout.originY)).toBe('┼');
    }
  });

  it('el rótulo de la memoria se ve también sin fila propia', () => {
    const all = screenText(render(80, 30, fixtureView()));
    expect(all).toContain('memory · real tool calls');
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
    expect(buf.rowText(L.rows.header)).not.toContain('CLAUDE');
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
