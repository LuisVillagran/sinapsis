import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { describeEvent, displayModel, formatDuration, formatTokens, modelAlias, plainText } from '../src/core/describe.js';
import { BOOT_MS } from '../src/scene/boot.js';
import { renderScene } from '../src/scene/scene.js';
import { FULL_COLS, FULL_ROWS, layoutKind } from '../src/scene/layout.js';
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

/** Busca en el buffer dibujado una caja de trazo grueso cuya esquina superior izquierda esté cerca de lo pedido. */
function findBox(buf: CellBuffer, expected: { x0: number; x1: number; y0: number; y1: number }): { x0: number; x1: number; y0: number; y1: number } {
  const TOLERANCE = 1;
  for (let y = expected.y0 - TOLERANCE; y <= expected.y0 + TOLERANCE; y += 1) {
    for (let x = expected.x0 - TOLERANCE; x <= expected.x0 + TOLERANCE; x += 1) {
      if (x < 0 || y < 0 || buf.charAt(x, y) !== '┏') continue;
      let right = x + 1;
      while (right < buf.width && buf.charAt(right, y) !== '┓') right += 1;
      let bottom = y + 1;
      while (bottom < buf.height && buf.charAt(x, bottom) !== '┗') bottom += 1;
      if (right < buf.width && bottom < buf.height && buf.charAt(right, bottom) === '┛') return { x0: x, x1: right, y0: y, y1: bottom };
    }
  }
  throw new Error(`Sin caja cerca de columna ${expected.x0}, fila ${expected.y0}`);
}

const expectWithin = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected), `${actual} frente a ${expected}`).toBeLessThanOrEqual(1);
};

function textRow(buf: CellBuffer, text: string): number {
  for (let y = 0; y < buf.height; y += 1) if (buf.rowText(y).includes(text)) return y;
  return -1;
}

describe('geometría del layout completo, medida sobre el buffer', () => {
  const buf = render();
  const boxes: Array<[string, { x0: number; x1: number; y0: number; y1: number }]> = [
    ['advisor', { x0: 2, x1: 23, y0: 5, y1: 38 }],
    ['sesión principal', { x0: 39, x1: 76, y0: 5, y1: 11 }],
    ['estado del advisor', { x0: 78, x1: 94, y0: 5, y1: 11 }],
    ['métricas', { x0: 38, x1: 83, y0: 13, y1: 19 }],
    ['tarjeta 1', { x0: 28, x1: 48, y0: 24, y1: 30 }],
    ['tarjeta 2', { x0: 50, x1: 71, y0: 24, y1: 30 }],
    ['tarjeta 3', { x0: 73, x1: 94, y0: 24, y1: 30 }],
    ['back to lead', { x0: 43, x1: 78, y0: 35, y1: 38 }],
    ['session log', { x0: 2, x1: 94, y0: 39, y1: 44 }],
  ];

  for (const [name, expected] of boxes) {
    it(name, () => {
      const found = findBox(buf, expected);
      expectWithin(found.x0, expected.x0);
      expectWithin(found.x1, expected.x1);
      expectWithin(found.y0, expected.y0);
      expectWithin(found.y1, expected.y1);
    });
  }

  it('filas de texto', () => {
    expect(textRow(buf, '●')).toBe(0);
    expectWithin(textRow(buf, 'CLAUDE CODE ADVISOR'), 2);
    expectWithin(textRow(buf, '─────'), 3);
    expectWithin(textRow(buf, '· subagents'), 4);
    expectWithin(textRow(buf, 'delegate to subagents'), 21);
    expect([45, 46]).toContain(textRow(buf, '--advisor opus █'));
    const status = textRow(buf, 'queued');
    expect([46, 47]).toContain(status);
  });

  it('encabezado y texto de delegación centrados', () => {
    const header = buf.rowText(2);
    const start = header.indexOf('CLAUDE');
    const end = header.lastIndexOf('THINKS') + 6;
    expectWithin(start, FULL_COLS - end);
  });

  it('una terminal mayor centra el layout y sigue usando la misma geometría', () => {
    const big = render(120, 60);
    const found = findBox(big, { x0: 2 + 12, x1: 23 + 12, y0: 5 + 6, y1: 38 + 6 });
    expect(found).toEqual({ x0: 14, x1: 35, y0: 11, y1: 44 });
    expect(big.rowText(8)).toContain('CLAUDE CODE ADVISOR');
  });
});

describe('contenido', () => {
  it('modelos reales en el encabezado, sin valores de ejemplo de la imagen', () => {
    const all = Array.from({ length: FULL_ROWS }, (_, y) => render().rowText(y)).join('\n');
    expect(all).toContain('HAIKU 5.5 BUILDS');
    expect(all).toContain('OPUS 5.5 THINKS');
    for (const banned of ['skunzu', 'jev', 'forks', '2,625', 'files: 156', 'call sites', '%']) expect(all).not.toContain(banned);
  });

  it('los datos del advisor son los del reductor', () => {
    const buf = render(FULL_COLS, FULL_ROWS, fixtureView());
    const panel = Array.from({ length: 34 }, (_, i) => buf.rowText(5 + i, 2, 24)).join('\n');
    expect(panel).toContain('sealed · 39 s');
    expect(panel).toContain('77.5k read');
    expect(panel).toContain('3.7k written');
    expect(panel).toContain('97.9k');
    expect(panel).toContain('after subagents');
    expect(panel).toContain('before a plan');
  });

  it('los patrones de herramientas se muestran literales', () => {
    const buf = render(FULL_COLS, FULL_ROWS, fixtureView());
    const log = Array.from({ length: 6 }, (_, i) => buf.rowText(39 + i)).join('\n');
    expect(log).toContain('fixtures/*.jsonl');
  });

  it('una tarjeta en curso no muestra porcentaje y sí su contador real', () => {
    const view = fixtureView(MID_SESSION_MS);
    expect(view.state.subagents.some((s) => s.running)).toBe(true);
    const cards = Array.from({ length: 7 }, (_, i) => render(FULL_COLS, FULL_ROWS, view).rowText(24 + i, 28, 95)).join('\n');
    expect(cards).toContain('tools:');
    expect(cards).not.toContain('%');
  });

  it('ningún texto se sale de un panel: los bordes quedan intactos', () => {
    for (const view of [fixtureView(MID_SESSION_MS), fixtureView(), idleView()]) {
      const buf = render(FULL_COLS, FULL_ROWS, view);
      const borders: Array<[number, number, number]> = [
        [2, 6, 37], [23, 6, 37], [39, 6, 10], [76, 6, 10], [38, 14, 18], [83, 14, 18],
        [28, 25, 29], [48, 25, 29], [50, 25, 29], [71, 25, 29], [73, 25, 29], [94, 25, 29],
      ];
      for (const [x, from, to] of borders) {
        for (let y = from; y <= to; y += 1) expect('┃╏').toContain(buf.charAt(x, y));
      }
    }
  });

  it('panel en reposo sin sesión', () => {
    const buf = render(FULL_COLS, FULL_ROWS, idleView());
    expect(buf.rowText(9)).toContain('waiting for a session');
    expect(buf.rowText(2)).toContain('CLAUDE CODE ADVISOR');
  });

  it('un texto ancho o con controles no desarma las filas', () => {
    const state = createState();
    state.title = '日本語のタイトル 🚀\tcon\ncontrol';
    state.mainModel = 'claude-haiku-5-5';
    const buf = render(FULL_COLS, FULL_ROWS, { state, log: [], now: 0, queue: { pending: [] }, connected: true });
    expect([...buf.rowText(7)].length).toBe(FULL_COLS);
    for (let x = 0; x < FULL_COLS; x += 1) expect(charWidth(buf.charAt(x, 7).codePointAt(0) as number)).toBe(1);
  });

  it('color: los paneles usan los tokens del tema', () => {
    const buf = render();
    expect(buf.fgAt(2, 5)).toBe(mix(theme.advisor, theme.panel, 0.2));
    expect(buf.fgAt(39, 5)).toBe(mix(theme.main, theme.panel, 0.2));
    expect(buf.fgAt(38, 13)).toBe(mix(theme.metrics, theme.panel, 0.2));
    expect(buf.bgAt(10, 20)).toBe(theme.panel);
    // Viñeta: el centro del fondo es más claro que una esquina.
    const luma = (c: number): number => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
    expect(luma(buf.bgAt(32, 33))).toBeGreaterThan(luma(buf.bgAt(0, 47)));
  });
});

describe('layouts según el tamaño', () => {
  it('elige por tamaño', () => {
    expect(layoutKind(96, 48)).toBe('full');
    expect(layoutKind(200, 100)).toBe('full');
    expect(layoutKind(95, 48)).toBe('reduced');
    expect(layoutKind(96, 47)).toBe('reduced');
    expect(layoutKind(80, 24)).toBe('reduced');
    expect(layoutKind(79, 24)).toBe('too-small');
    expect(layoutKind(80, 23)).toBe('too-small');
  });

  it('el reducido a 80x24 conserva advisor, principal, subagentes y log', () => {
    const buf = render(80, 24, fixtureView());
    const all = Array.from({ length: 24 }, (_, y) => buf.rowText(y)).join('\n');
    expect(all).toContain('OPUS 5.5 · on call');
    expect(all).toContain('main');
    expect(all).toContain('Estructura');
    expect(all).toContain('session log');
    expect(all).toContain('after subagents');
    expect(all).toContain('calls');
  });

  it('el mensaje de ventana pequeña dice el tamaño real', () => {
    const buf = render(60, 20);
    const all = Array.from({ length: 20 }, (_, y) => buf.rowText(y)).join('\n');
    expect(all).toContain('Agranda la ventana');
    expect(all).toContain('80x24');
    expect(all).toContain('60x20');
  });

  it('ningún tamaño intermedio falla', () => {
    for (const [cols, rows] of [[80, 24], [81, 25], [95, 47], [96, 24], [80, 47], [120, 30], [79, 23], [1, 1], [10, 2]] as const) {
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
    const cell = term.buffer.active.getLine(5)?.getCell(2);
    expect(cell?.isFgRGB()).toBe(true);
    expect(cell?.getFgColor()).toBe(mix(theme.advisor, theme.panel, 0.2));
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
    const b = render(96, 48);
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
    expect(buf.rowText(2)).not.toContain('CLAUDE');
    expect(buf.charAt(2, 5)).toBe(' ');
    expect(buf.charAt(39, 5)).toBe(' ');
    expect(buf.rowText(0)).toContain('sinapsis');
  });

  it('el encabezado se escribe de izquierda a derecha', () => {
    const lengths = [100, 300, 500, 700, 900].map((ms) => frame(ms).rowText(2).trim().length);
    for (let i = 1; i < lengths.length; i += 1) expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1] as number);
    expect(lengths[0]).toBeLessThan(lengths[4] as number);
  });

  it('un borde se dibuja recorriendo el panel: arriba antes que abajo', () => {
    const early = frame(400);
    expect(early.charAt(2, 5)).toBe('┏');
    expect(early.charAt(2, 38)).toBe(' ');
    const later = frame(800);
    expect(later.charAt(23, 5)).toBe('┓');
    expect(later.charAt(23, 30)).toBe('┃');
  });

  it('los paneles entran en cascada: el advisor antes que el log', () => {
    const buf = frame(700);
    expect(buf.charAt(2, 5)).toBe('┏');
    expect(buf.charAt(2, 39)).toBe(' ');
    expect(frame(2000).charAt(2, 39)).toBe('┏');
  });

  it('funciona en una terminal mayor y en el layout reducido', () => {
    const big = new CellBuffer(120, 60);
    renderScene(big, { ...fixtureView(), anim: { bootMs: 500 } });
    expect(big.originX).toBe(0);
    const small = new CellBuffer(80, 24);
    expect(() => renderScene(small, { ...fixtureView(), anim: { bootMs: 100 } })).not.toThrow();
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
