import { describe, expect, it } from 'vitest';
import type { SinapsisEvent } from '../src/core/events.js';
import { reduce } from '../src/core/state.js';
import { Director, breathLevel, examplePercent } from '../src/engine/director.js';
import { encodeFrame } from '../src/tui/ansi.js';
import { FULL_COLS, FULL_ROWS, type SceneLayout, layoutFor } from '../src/scene/layout.js';
import { TRAIL_CELLS } from '../src/scene/packets.js';
import { renderScene } from '../src/scene/scene.js';
import { theme } from '../src/scene/theme.js';
import type { SceneView } from '../src/scene/view.js';
import { CellBuffer } from '../src/tui/buffer.js';
import { mix } from '../src/tui/color.js';

const FULL = layoutFor(FULL_COLS, FULL_ROWS) as SceneLayout;
const ROUTES = FULL.routes;

const CONSULT_ID = 'c1';
const consult = (reason: 'before a plan' | 'after subagents' | 'before done' = 'before a plan'): SinapsisEvent => ({ type: 'advisor_consult', t: 1000, id: CONSULT_ID, reason });
const reply = (durationMs = 20_000): SinapsisEvent => ({ type: 'advisor_reply', t: 21_000, id: CONSULT_ID, durationMs, tokensRead: 64_700, tokensWritten: 4000, model: 'claude-opus-5-5', resultType: 'advisor_redacted_result', isError: false });
const models: SinapsisEvent = { type: 'session_info', t: 500, mainModel: 'claude-haiku-5-5', advisorModel: 'claude-opus-5-5', advisorEnabled: true, cwd: 'x', effort: 'high' };

function play(events: SinapsisEvent[], ms: number): { director: Director; view: SceneView; buf: CellBuffer } {
  const director = new Director();
  director.ingest({ kind: 'events', events, historical: false }, 0);
  for (let now = 0; now <= ms; now += 16) director.update(now);
  director.update(ms);
  const view = director.view(ms);
  const buf = new CellBuffer(FULL_COLS, FULL_ROWS);
  renderScene(buf, view);
  return { director, view, buf };
}

const bufferOf = (view: SceneView): CellBuffer => {
  const buf = new CellBuffer(FULL_COLS, FULL_ROWS);
  renderScene(buf, view);
  return buf;
};

describe('animación 2: paquetes', () => {
  const call: SinapsisEvent = { type: 'tool_call', t: 1, id: 't', name: 'Read' };

  it('avanza por su camino, sin saltos hacia atrás, y desaparece', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [call], historical: false }, 0);
    const seen: number[] = [];
    for (let now = 0; now <= 449; now += 16) {
      director.update(now);
      seen.push(director.view(now).anim?.packets?.[0]?.t ?? -1);
    }
    expect(seen[0]).toBe(0);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThan(seen[i - 1] as number);
    director.update(500);
    expect(director.view(500).anim?.packets).toEqual([]);
    expect(director.isBusy(2000)).toBe(false);
  });

  it('una herramienta del principal baja por el tronco, y la de un subagente por la rama de su tarjeta', () => {
    expect(play([call], 100).view.anim?.packets?.map((p) => p.route)).toEqual(['tool']);
    const director = new Director();
    const start: SinapsisEvent[] = ['a', 'b'].map((subagentId) => ({ type: 'subagent_start', t: 1, subagentId }));
    director.ingest({ kind: 'events', events: start, historical: true }, 0);
    director.ingest({ kind: 'events', events: [{ type: 'tool_call', t: 2, id: 't', name: 'Read', agentId: 'b' }], historical: false }, 0);
    director.update(0);
    expect(director.view(100).anim?.packets?.map((p) => p.route)).toEqual(['work-1']);
  });

  it('la cabeza brilla y la estela se apaga detrás de ella', () => {
    const route = ROUTES['memory-0'];
    const base = play([models], 10).view;
    const still = bufferOf({ ...base, anim: { packets: [] } });
    const buf = bufferOf({ ...base, anim: { packets: [{ route: 'memory-0', t: 0.6 }] } });
    const head = Math.round(0.6 * (route.length - 1 + TRAIL_CELLS));
    const at = (i: number): [number, number] => route[i] as [number, number];
    expect(buf.charAt(...at(head))).toBe('●');
    expect(buf.charAt(...at(head - 1))).toBe('•');
    expect(buf.charAt(...at(head - 2))).toBe('·');
    const shift = (i: number): number => Math.abs((buf.fgAt(...at(i)) & 255) - (still.fgAt(...at(i)) & 255));
    expect(shift(head - 1)).toBeGreaterThan(shift(head - 3));
    // Después de la estela, el conector queda como estaba.
    expect(buf.charAt(...at(head - 5))).toBe(still.charAt(...at(head - 5)));
  });

  it('el avance es más fino que una celda: la intensidad cambia dentro de una misma celda', () => {
    const route = ROUTES['memory-0'];
    const cell = route[6] as [number, number];
    const base = play([models], 10).view;
    const span = route.length - 1 + TRAIL_CELLS;
    const at = (head: number): number => bufferOf({ ...base, anim: { packets: [{ route: 'memory-0', t: head / span }] } }).bgAt(cell[0], cell[1]);
    expect(at(5.3)).not.toBe(at(5.7));
  });

it('no escribe sobre texto', () => {
    const base = play([models], 10).view;
    for (let t = 0; t <= 1; t += 0.05) {
      const buf = bufferOf({ ...base, anim: { packets: [{ route: 'delegate-0', t }] } });
      expect(buf.rowText(FULL.rows.delegate)).toContain('delegate to subagents');
    }
  });

  it('solo un paquete a la vez en un conector', () => {
    const calls = Array.from({ length: 5 }, (_, i): SinapsisEvent => ({ type: 'tool_call', t: 1, id: `t${i}`, name: 'Read' }));
    const director = new Director();
    director.ingest({ kind: 'events', events: calls, historical: false }, 0);
    for (let now = 0; now < 4000; now += 16) {
      director.update(now);
      expect(director.view(now).anim?.packets?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

describe('animación 4: subagentes', () => {
  const start = (id: string): SinapsisEvent => ({ type: 'subagent_start', t: 1, subagentId: id, model: 'claude-haiku-5-5' });
  const info = (id: string): SinapsisEvent => ({ type: 'subagent_info', t: 1, subagentId: id, description: `tarea ${id}`, agentType: 'Explore' });
  const end = (id: string): SinapsisEvent => ({ type: 'subagent_end', t: 2, subagentId: id, status: 'completed', summary: `resumen de ${id}` });

  it('la caja crece desde su centro y luego aparece el contenido', () => {
    const events = [models, start('a'), info('a')];
    const at = (ms: number): CellBuffer => play(events, ms).buf;
    const r = FULL.cards[0];
    // Al principio ni el borde completo ni el contenido.
    const early = at(400);
    expect(early.charAt(r.x, r.y)).not.toBe('┌');
    expect(early.rowText(r.y + 4, r.x, r.x + r.w)).not.toContain('tarea a');
    // Después la caja ya tiene su tamaño real.
    const full = at(800);
    expect(full.charAt(r.x, r.y)).toBe('┌');
    expect(full.charAt(r.x + r.w - 1, r.y + r.h - 1)).toBe('┘');
    expect(full.rowText(r.y + 4, r.x, r.x + r.w)).toContain('tarea a');
  });

  it('crece de forma monótona', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [models, start('a')], historical: false }, 0);
    const grows: number[] = [];
    for (let now = 0; now <= 900; now += 50) {
      director.update(now);
      grows.push(director.view(now).anim?.cards?.[0]?.grow ?? 0);
    }
    for (let i = 1; i < grows.length; i += 1) expect(grows[i]).toBeGreaterThanOrEqual(grows[i - 1] as number);
    expect(grows[grows.length - 1]).toBe(1);
  });

  it('el paquete de delegación va a la tarjeta que le corresponde', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [models, start('a'), start('b')], historical: false }, 0);
    director.update(0);
    expect(director.view(100).anim?.packets?.map((p) => p.route)).toEqual(['delegate-0']);
    director.update(850);
    expect(director.view(850).anim?.packets?.map((p) => p.route)).toEqual(['delegate-1']);
  });

  it('al terminar: la barra se llena, envía su resumen y se atenúa sin perder datos', () => {
    const director = new Director();
    const events = [models, start('a'), info('a')];
    director.ingest({ kind: 'events', events, historical: true }, 0);
    director.ingest({ kind: 'events', events: [end('a')], historical: false }, 0);
    director.update(0);
    expect(director.view(100).anim?.cards?.[0]?.fade).toBeLessThan(1);
    expect(director.view(300).anim?.packets?.map((p) => p.route)).toEqual(['back-0']);
    const mid = director.view(800);
    expect(mid.anim?.leadGlow).toBeDefined();
    director.update(1000);
    const after = director.view(3000);
    expect(after.anim?.cards?.[0]?.fade).toBe(1);
    const buf = bufferOf(after);
    const r = FULL.cards[0];
    expect(buf.rowText(r.y + 4, r.x, r.x + r.w)).toContain('tarea a');
    expect(buf.rowText(FULL.lead.y + 2, FULL.lead.x, FULL.lead.x + FULL.lead.w)).toContain('resumen de a');
    expect(after.anim?.leadGlow).toBeUndefined();
    expect(director.isBusy(3000)).toBe(false);
  });

  it('las tarjetas no cambian de lugar cuando otra termina', () => {
    const events = [models, start('a'), start('b'), start('c')];
    const director = new Director();
    director.ingest({ kind: 'events', events, historical: true }, 0);
    const before = director.view(0).anim?.cards?.map((c) => c?.id);
    expect(before).toEqual(['a', 'b', 'c']);
    director.ingest({ kind: 'events', events: [end('a')], historical: false }, 0);
    for (let now = 0; now <= 2000; now += 50) {
      director.update(now);
      expect(director.view(now).anim?.cards?.map((c) => c?.id)).toEqual(before);
    }
  });

  it('un cuarto subagente espera su tarjeta y entra cuando una queda libre', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [models, start('a'), start('b'), start('c'), start('d')], historical: true }, 0);
    expect(director.view(0).anim?.cards?.map((c) => c?.id)).toEqual(['a', 'b', 'c']);
    director.ingest({ kind: 'events', events: [end('b')], historical: false }, 0);
    director.update(0);
    expect(director.view(500).anim?.cards?.[1]?.id).toBe('b');
    director.update(1000);
    expect(director.view(1000).anim?.cards?.map((c) => c?.id)).toEqual(['a', 'd', 'c']);
  });

  it('un subagente nuevo reemplaza a uno terminado, nunca a uno activo', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [models, start('a'), start('b'), start('c'), end('a')], historical: true }, 0);
    director.ingest({ kind: 'events', events: [start('e')], historical: false }, 0);
    director.update(0);
    expect(director.view(100).anim?.cards?.map((c) => c?.id)).toEqual(['e', 'b', 'c']);
  });

  it('el estado final coincide con el reductor', () => {
    const events = [models, start('a'), info('a'), start('b'), end('a'), end('b')];
    const { view } = play(events, 8000);
    expect(view.state).toEqual(reduce(events));
    expect(view.anim?.cards?.map((c) => c?.fade)).toEqual([1, 1, undefined]);
  });
});

describe('animación 5: contadores y barras', () => {
  const calls = (n: number, name = 'Read'): SinapsisEvent[] => Array.from({ length: n }, (_, i): SinapsisEvent => ({ type: 'tool_call', t: 1, id: `${name}${i}`, name }));

  it('un contador sube número a número, sin bajar y sin pasarse', () => {
    const batch = [models, consult(), reply()];
    const director = new Director();
    director.ingest({ kind: 'events', events: batch, historical: false }, 0);
    const shown: number[] = [];
    for (let now = 0; now < 5000; now += 16) {
      director.update(now);
      shown.push(director.view(now).anim?.numbers?.tokensRead ?? 0);
    }
    for (let i = 1; i < shown.length; i += 1) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1] as number);
    const distinct = new Set(shown.map((v) => Math.round(v)));
    expect(distinct.size).toBeGreaterThan(10);
    expect(shown[shown.length - 1]).toBe(64_700);
  });

  it('el total de llamadas no se adelanta a lo que ya se aplicó', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: calls(4), historical: false }, 0);
    for (let now = 0; now < 3000; now += 16) {
      director.update(now);
      const view = director.view(now);
      expect(view.anim?.numbers?.toolCalls ?? 0).toBeLessThanOrEqual(view.state.toolCalls);
    }
  });

  it('una barra de memoria crece con easing: rápido al principio y suave al final', () => {
    const director = new Director();
    const start: SinapsisEvent = { type: 'subagent_start', t: 1, subagentId: 'a' };
    const read: SinapsisEvent = { type: 'tool_call', t: 2, id: 'r', name: 'Read', agentId: 'a', memory: { file: 'MEMORY.md', scope: 'agent', op: 'read' } };
    director.ingest({ kind: 'events', events: [start], historical: true }, 0);
    director.ingest({ kind: 'events', events: [read], historical: false }, 0);
    director.update(0);
    const at = (ms: number): number => director.view(ms).anim?.numbers?.memory.a ?? 0;
    expect(at(0)).toBe(0);
    const firstHalf = at(250) - at(0);
    const secondHalf = at(500) - at(250);
    expect(firstHalf).toBeGreaterThan(secondHalf);
    expect(at(500)).toBe(1);
  });

it('lo que ya había ocurrido no se vuelve a contar', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: calls(7), historical: true }, 100);
    const numbers = director.view(100).anim?.numbers;
    expect(numbers?.toolCalls).toBe(7);
        expect(director.isBusy(100)).toBe(false);
  });

  it('en reposo, la escena muestra los valores reales', () => {
    const events = [models, ...calls(3), ...calls(2, 'Grep'), consult(), reply()];
    const { buf, view } = play(events, 15_000);
    expect(view.anim?.numbers?.toolCalls).toBe(5);
    const panel = Array.from({ length: FULL.project.h }, (_, i) => buf.rowText(FULL.project.y + i, FULL.project.x, FULL.project.x + FULL.project.w)).join('\n');
    expect(panel).toMatch(/tools\s+5/);
    expect(buf.rowText(FULL.advisor.y + 4, FULL.advisor.x, FULL.advisor.x + FULL.advisor.w)).toContain('1 · 64.7k');
  });

it('el estado final coincide con el reductor', () => {
    const events = [models, ...calls(3)];
    expect(play(events, 8000).view.state).toEqual(reduce(events));
  });
});

describe('animación 6: log', () => {
  const prompt: SinapsisEvent = { type: 'user_prompt', t: 1000, text: 'una línea bastante larga para que se note cómo se escribe' };
  const row = FULL.log.y + 1;
  const textAt = (ms: number): string => play([prompt], ms).buf.rowText(row, FULL.log.x + 1, FULL.log.x + FULL.log.w - 1);

  it('el texto se escribe de izquierda a derecha', () => {
    expect(textAt(10)).not.toContain('bastante');
    expect(textAt(300)).toContain('una línea');
    expect(textAt(300)).not.toContain('se escribe');
    expect(textAt(700)).toContain('se escribe');
  });

  it('la línea desliza desde la derecha y queda en su columna', () => {
    const columnOf = (ms: number): number => textAt(ms).indexOf('you');
    expect(columnOf(0)).toBeGreaterThan(columnOf(100));
    expect(columnOf(100)).toBeGreaterThan(columnOf(800));
    expect(columnOf(800)).toBe(10);
    expect(columnOf(5000)).toBe(10);
  });

  it('terminada, es igual a una línea sin animar', () => {
    const { view } = play([prompt], 5000);
    const animated = bufferOf(view);
    const plain = bufferOf({ ...view, log: view.log.map(({ bornAt: _bornAt, ...entry }) => entry) });
    expect(animated.rowText(row)).toBe(plain.rowText(row));
    expect(animated.fgAt(FULL.log.x + 3, row)).toBe(plain.fgAt(FULL.log.x + 3, row));
  });

  it('el historial entra completo, sin animar', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [prompt], historical: true }, 100);
    expect(bufferOf(director.view(100)).rowText(row)).toContain('se escribe');
  });

  it('el texto no se sale del panel mientras desliza', () => {
    const long: SinapsisEvent = { type: 'user_prompt', t: 1, text: 'x'.repeat(200) };
    for (const ms of [0, 50, 100, 200]) {
      const buf = play([long], ms).buf;
      expect(buf.charAt(FULL.log.x + FULL.log.w - 1, row)).toBe('│');
    }
  });

  it('mientras entra pide la frecuencia alta, y después no', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [prompt], historical: false }, 0);
    director.update(0);
    expect(director.isBusy(100)).toBe(true);
    director.update(500);
    expect(director.isBusy(5000)).toBe(false);
  });
});

describe('animación 7: spinners y cursor', () => {
  const FRAMES = /[|/\\-]/;
  const running: SinapsisEvent[] = [
    models,
    { type: 'request_start', t: 1 },
    { type: 'tool_call', t: 1, id: 't', name: 'Read', summary: 'a.ts' },
    { type: 'subagent_start', t: 1, subagentId: 's', model: 'claude-haiku-5-5' },
    { type: 'tool_call', t: 1, id: 'u', name: 'Grep', agentId: 's' },
  ];
  const historicalView = (events: SinapsisEvent[], now: number): SceneView => {
    const director = new Director();
    director.ingest({ kind: 'events', events, historical: true }, 0);
    return director.view(now);
  };
  const spinnerCell = (buf: CellBuffer, y: number, from: number, to: number): string => {
    const match = /\[ ([|/\\-]) \]/.exec(buf.rowText(y, from, to));
    return match?.[1] ?? '';
  };

  it('cada elemento activo tiene su spinner, y todos giran', () => {
    const at = (now: number): CellBuffer => bufferOf(historicalView(running, now));
    const main = FULL.main;
    const card = FULL.cards[0];
    const places: Array<(buf: CellBuffer) => string> = [
      (buf) => /([|/\\-])\s*│?$/.exec(buf.rowText(main.y + 4, main.x, main.x + main.w - 1).trimEnd())?.[1] ?? '',
      (buf) => /([◐◓◑◒])/.exec(buf.rowText(card.y + 5, card.x, card.x + card.w))?.[1] ?? '',
      (buf) => /([|/\\-])\s*$/.exec(buf.rowText(FULL.rows.delegate, FULL.spine, FULL_COLS).trimEnd())?.[1] ?? '',
      (buf) => /· ([|/\\-]) /.exec(buf.rowText(FULL.log.y, FULL.log.x, FULL.log.x + FULL.log.w))?.[1] ?? '',
    ];
    for (const place of places) {
      const seen = new Set([0, 130, 260, 390, 520].map((now) => place(at(now))));
      for (const frame of seen) expect(frame).toMatch(/[|/\\◐◓◑◒-]/);
      expect(seen.size).toBeGreaterThan(1);
    }
  });

  it('sin actividad no hay spinners salvo el del log', () => {
    const finished: SinapsisEvent[] = [...running, { type: 'tool_result', t: 2, id: 't', isError: false }, { type: 'tool_result', t: 2, id: 'u', isError: false, agentId: 's' }, { type: 'subagent_end', t: 3, subagentId: 's', status: 'completed' }, { type: 'turn_end', t: 4 }];
    const buf = bufferOf(historicalView(finished, 300));
    expect(buf.rowText(FULL.main.y + 4, FULL.main.x, FULL.main.x + FULL.main.w)).toContain('--model haiku');
    expect(buf.rowText(FULL.cards[0].y + 5, FULL.cards[0].x, FULL.cards[0].x + FULL.cards[0].w)).not.toMatch(/[◐◓◑◒]/);
    expect(buf.rowText(FULL.rows.delegate, 0, FULL_COLS).trimEnd()).toMatch(/subagents$/);
  });

it('el cursor parpadea', () => {
    const cursorIn = (now: number): boolean => bufferOf(historicalView(running, now)).rowText(FULL.rows.prompt).includes('█');
    expect(cursorIn(0)).toBe(true);
    expect(cursorIn(600)).toBe(false);
    expect(cursorIn(1100)).toBe(true);
  });

  it('los discos de las tarjetas no giran sincronizados', () => {
    const events: SinapsisEvent[] = [models, ...['a', 'b', 'c'].map((id): SinapsisEvent => ({ type: 'subagent_start', t: 1, subagentId: id, model: 'claude-haiku-5-5' }))];
    const buf = bufferOf(historicalView(events, 100));
    const frames = FULL.cards.map((c) => /([◐◓◑◒])/.exec(buf.rowText(c.y + 5, c.x, c.x + c.w))?.[1]);
    expect(new Set(frames).size).toBeGreaterThan(1);
  });
});

describe('animación 8: respiración en reposo', () => {
  const idle = (now: number): SceneView => new Director().view(now);

  it('el borde cambia con el tiempo, sin dejar de verse', () => {
    const colors = new Set<number>();
    for (let now = 0; now < 4200; now += 100) colors.add(bufferOf(idle(now)).fgAt(FULL.main.x, FULL.main.y));
    expect(colors.size).toBeGreaterThan(2);
    const luma = (c: number): number => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
    const panelLuma = luma(theme.panel);
    for (const color of colors) expect(luma(color)).toBeGreaterThan(panelLuma + 100);
  });

  it('es periódica y usa pocos niveles', () => {
    const levels = new Set<number>();
    for (let now = 0; now < 8400; now += 16) levels.add(breathLevel(now));
    expect(levels.size).toBeLessThanOrEqual(7);
    expect(levels.size).toBeGreaterThan(3);
    expect(breathLevel(1000)).toBe(breathLevel(1000 + 4200));
  });

  it('la mayoría de los frames en reposo no cambia ningún borde', () => {
    const frames = 4200 / 16;
    let changes = 0;
    for (let now = 16; now < 4200; now += 16) if (breathLevel(now) !== breathLevel(now - 16)) changes += 1;
    expect(changes / frames).toBeLessThan(0.1);
  });

  it('entre dos frames de reposo, sin cambio de nivel, el diff es pequeño', () => {
    const a = bufferOf(idle(1000));
    const b = bufferOf(idle(1010));
    expect(encodeFrame(a, b, 'truecolor').length).toBeLessThan(200);
  });

  it('no es una animación que oculte nada: sin sesión, el panel sigue completo', () => {
    const buf = bufferOf(idle(2000));
    expect(buf.rowText(FULL.rows.header)).toContain('CLAUDE CODE ADVISOR');
    expect(buf.charAt(FULL.main.x, FULL.main.y)).toBe('┌');
  });

  it('no mantiene la frecuencia alta', () => {
    expect(new Director().isBusy(5000)).toBe(false);
  });
});

describe('animación 9: errores', () => {
  const failing: SinapsisEvent[] = [models, { type: 'tool_call', t: 1, id: 't', name: 'Bash' }, { type: 'tool_result', t: 2, id: 't', isError: true }];
  const TOOL_MS = 450;

  it('el destello aparece con el error, se apaga y termina', () => {
    expect(play(failing, TOOL_MS - 50).view.anim?.errorFlash).toBeUndefined();
    const early = play(failing, TOOL_MS + 20).view.anim?.errorFlash ?? 0;
    const later = play(failing, TOOL_MS + 400).view.anim?.errorFlash ?? 0;
    expect(early).toBeGreaterThan(later);
    expect(later).toBeGreaterThan(0);
    expect(play(failing, TOOL_MS + 1000).view.anim?.errorFlash).toBeUndefined();
  });

  it('tiñe la sesión, la memoria de agentes y el log, y no el advisor', () => {
    const base = play(failing, 3000).view;
    const lit = bufferOf({ ...base, anim: { ...base.anim, errorFlash: 1 } });
    const off = bufferOf({ ...base, anim: { ...base.anim, errorFlash: undefined } });
    for (const r of [FULL.main, FULL.memory, FULL.log]) {
      expect(lit.bgAt(r.x + 5, r.y + 2)).not.toBe(off.bgAt(r.x + 5, r.y + 2));
      expect(lit.fgAt(r.x, r.y)).toBe(mix(off.fgAt(r.x, r.y), theme.alert, 1));
    }
    expect(lit.bgAt(FULL.advisor.x + 5, FULL.advisor.y + 2)).toBe(off.bgAt(FULL.advisor.x + 5, FULL.advisor.y + 2));
  });

  it('no cambia el texto: solo el color', () => {
    const base = play(failing, 3000).view;
    const lit = bufferOf({ ...base, anim: { ...base.anim, errorFlash: 1 } });
    const off = bufferOf({ ...base, anim: { ...base.anim, errorFlash: undefined } });
    for (let y = 0; y < FULL_ROWS; y += 1) expect(lit.rowText(y)).toBe(off.rowText(y));
  });

  it('el log y la memoria de proyecto quedan marcados después del destello', () => {
    const { buf, view } = play(failing, 3000);
    expect(view.state.tools.Bash).toEqual({ count: 1, errors: 1 });
    const panel = Array.from({ length: FULL.project.h }, (_, i) => buf.rowText(FULL.project.y + i, FULL.project.x, FULL.project.x + FULL.project.w)).join('\n');
    expect(panel).toMatch(/errors\s+1/);
    const logRows = Array.from({ length: 4 }, (_, i) => buf.rowText(FULL.log.y + 1 + i)).join('\n');
    expect(logRows).toContain('tool returned an error');
  });

it('un error de la API también destella', () => {
    const events: SinapsisEvent[] = [models, { type: 'api_error', t: 1, status: 529, message: 'Overloaded' }];
    expect(play(events, 50).view.anim?.errorFlash).toBeGreaterThan(0);
    expect(play(events, 2000).view.state.apiErrors).toBe(1);
  });

  it('un error en el historial no destella', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: failing, historical: true }, 0);
    director.update(0);
    expect(director.view(0).anim?.errorFlash).toBeUndefined();
    expect(director.shown.toolErrors).toBe(1);
  });

  it('el estado final coincide con el reductor', () => {
    expect(play(failing, 5000).view.state).toEqual(reduce(failing));
  });
});

describe('animación 3: consulta al advisor', () => {
  const batch = [models, consult(), reply()];
  const total = (): number => {
    const director = new Director();
    director.ingest({ kind: 'events', events: batch, historical: false }, 0);
    director.update(0);
    let now = 0;
    while (!director.settled && now < 10_000) {
      now += 16;
      director.update(now);
    }
    return now;
  };

  it('ida, espera con pulso y vuelta, en un tiempo comprimido', () => {
    const length = total();
    expect(length).toBeGreaterThanOrEqual(1500);
    expect(length).toBeLessThanOrEqual(5016);

    const going = play(batch, length * 0.15).view.anim?.packets;
    expect(going?.map((p) => p.route)).toEqual(['advisor-out']);
    expect(play(batch, length * 0.5).view.anim?.packets).toEqual([]);
    const returning = play(batch, length * 0.85).view.anim?.packets;
    expect(returning?.map((p) => p.route)).toEqual(['advisor-back']);
  });

  it('la caja late mientras dura y se apaga al terminar', () => {
    const length = total();
    const pulses = [0.1, 0.25, 0.4, 0.55, 0.7].map((f) => play(batch, length * f).view.anim?.advisorPulse ?? -1);
    expect(Math.max(...pulses)).toBeGreaterThan(Math.min(...pulses));
    for (const p of pulses) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    const after = play(batch, length + 100).view;
    expect(after.anim?.advisorPulse).toBeUndefined();
    const lit = bufferOf({ ...after, anim: { advisorPulse: 1 } });
    const off = bufferOf({ ...after, anim: {} });
    const inside: [number, number] = [FULL.advisor.x + 1, FULL.advisor.y + 1];
    expect(lit.fgAt(FULL.advisor.x, FULL.advisor.y)).not.toBe(off.fgAt(FULL.advisor.x, FULL.advisor.y));
    expect(off.bgAt(...inside)).toBe(theme.panel);
    expect(lit.bgAt(...inside)).not.toBe(theme.panel);
  });

  it('el estado dice replaying solo durante la animación, y los datos llegan al final', () => {
    const length = total();
    const mid = play(batch, length * 0.5);
    expect(mid.buf.rowText(FULL.advisor.y + 3, FULL.advisor.x, FULL.advisor.x + FULL.advisor.w)).toContain('replaying');
    expect(mid.view.state.advisor.tokensRead).toBe(0);
    const end = play(batch, length + 100);
    expect(end.buf.rowText(FULL.advisor.y + 3, FULL.advisor.x, FULL.advisor.x + FULL.advisor.w)).toContain('silent');
    expect(end.view.state.advisor.tokensRead).toBe(64_700);
  });

  it('el motivo inferido se escribe en el log mientras llega la consulta', () => {
    const logText = (ms: number): string => Array.from({ length: 4 }, (_, i) => play(batch, ms).buf.rowText(FULL.log.y + 1 + i)).join('\n');
    expect(logText(100)).not.toContain('before a plan (inferred)');
    expect(logText(1200)).toContain('before a plan (inferred)');
  });

it('con la respuesta en otro lote, la vuelta se anima al llegar', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [consult()], historical: false }, 0);
    director.update(0);
    expect(director.view(100).anim?.packets?.map((p) => p.route)).toEqual(['advisor-out']);
    director.update(1100);
    director.ingest({ kind: 'events', events: [reply()], historical: false }, 1100);
    director.update(1200);
    expect(director.view(1200).anim?.packets?.map((p) => p.route)).toEqual(['advisor-back']);
    expect(director.view(1200).anim?.advisorPulse).toBeDefined();
  });

  it('el estado final coincide con el reductor', () => {
    const { view } = play(batch, 6000);
    expect(view.state).toEqual(reduce(batch));
  });
});

describe('memoria: hitos, caminos y brillo', () => {
  const start: SinapsisEvent = { type: 'subagent_start', t: 1, subagentId: 'a', model: 'claude-haiku-5-5' };
  const info: SinapsisEvent = { type: 'subagent_info', t: 1, subagentId: 'a', agentType: 'builder', description: 'code + patterns' };
  const touch = (t: number, op: 'read' | 'write' = 'read', agentId?: string): SinapsisEvent => ({ type: 'tool_call', t, id: `m${t}`, name: op === 'read' ? 'Read' : 'Write', memory: { file: 'MEMORY.md', scope: 'agent', op }, ...(agentId ? { agentId } : {}) });
  const failing: SinapsisEvent[] = [
    { type: 'tool_call', t: 2, id: 'x', name: 'Bash' },
    { type: 'tool_result', t: 3, id: 'x', isError: true },
  ];

  const routeFor = (events: SinapsisEvent[], setup: SinapsisEvent[] = []): string | undefined => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [models, ...setup], historical: true }, 0);
    director.ingest({ kind: 'events', events, historical: false }, 0);
    director.update(0);
    return director.view(100).anim?.packets?.[0]?.route;
  };

  it('cada hito dispara el paquete por su propia flecha', () => {
    expect(routeFor([touch(5)])).toBe('memory-0');
    expect(routeFor([touch(5)], failing)).toBe('memory-1');
    const ended: SinapsisEvent[] = [start, { type: 'subagent_end', t: 3, subagentId: 'a', status: 'completed' }];
    expect(routeFor([touch(5)], ended)).toBe('memory-2');
  });

  it('un error de otro turno no cuenta como intento repetido', () => {
    const nextTurn: SinapsisEvent = { type: 'user_prompt', t: 4, text: 'otra cosa' };
    expect(routeFor([touch(5)], [...failing, nextTurn])).toBe('memory-0');
  });

  it('cargar los archivos de memoria al iniciar enciende el primer hito', () => {
    const load: SinapsisEvent = { type: 'memory_load', t: 1, files: [{ file: 'CLAUDE.md', scope: 'project' }] };
    const { view, buf } = play([models, load], 100);
    expect(view.anim?.packets?.[0]?.route).toBe('memory-0');
    expect(buf.charAt(FULL.project.x + 1, FULL.milestones[0])).toBe('◆');
    expect(buf.charAt(FULL.project.x + 1, FULL.milestones[1])).toBe('◇');
  });

  it('el hito se resalta, se apaga y no deja la frecuencia alta', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [touch(5)], historical: false }, 0);
    director.update(0);
    const early = director.view(50).anim?.memoryPulse?.amount ?? 0;
    const later = director.view(800).anim?.memoryPulse?.amount ?? 0;
    expect(early).toBeGreaterThan(later);
    expect(later).toBeGreaterThan(0);
    director.update(1000);
    expect(director.view(1500).anim?.memoryPulse).toBeUndefined();
    expect(director.isBusy(1500)).toBe(false);
  });

  it('el agente que tocó la memoria se enciende en púrpura, y solo él', () => {
    const director = new Director();
    const other: SinapsisEvent = { type: 'subagent_start', t: 1, subagentId: 'b' };
    director.ingest({ kind: 'events', events: [models, start, info, other], historical: true }, 0);
    director.ingest({ kind: 'events', events: [touch(5, 'read', 'b')], historical: false }, 0);
    director.update(0);
    const view = director.view(10);
    expect(view.anim?.memoryPulse?.card).toBe(1);
    const buf = bufferOf(view);
    const still = bufferOf({ ...view, anim: { ...view.anim, memoryPulse: undefined } });
    const [c0, c1] = FULL.cards;
    expect(buf.fgAt(c1.x, c1.y)).not.toBe(still.fgAt(c1.x, c1.y));
    expect(buf.fgAt(c0.x, c0.y)).toBe(still.fgAt(c0.x, c0.y));
  });

  it('la fila del agente muestra recall, check o save según lo que ocurrió', () => {
    const row = FULL.memory.y + 2;
    const text = (events: SinapsisEvent[]): string => play([models, start, info, ...events], 20_000).buf.rowText(row, FULL.memory.x, FULL.memory.x + FULL.memory.w);
    expect(text([])).toContain('no memory');
    expect(text([touch(5, 'read', 'a')])).toContain('recall');
    expect(text([touch(5, 'write', 'a')])).toContain('save');
    expect(text([...failing, touch(5, 'read', 'a')])).toContain('check');
    expect(text([])).toContain('builder');
  });

  it('el log cuenta quién tocó qué archivo, sin inventar el motivo', () => {
    const { view } = play([models, start, info, touch(5, 'write', 'a')], 5000);
    expect(view.log.some((entry) => entry.who === 'memory' && entry.text === 'builder · save MEMORY.md')).toBe(true);
  });

  it('el estado final coincide con el reductor', () => {
    const events = [models, start, info, ...failing, touch(5, 'read', 'a'), touch(6, 'write')];
    expect(play(events, 20_000).view.state).toEqual(reduce(events));
  });
});

describe('demo ilustrada', () => {
  const start: SinapsisEvent = { type: 'subagent_start', t: 1, subagentId: 'a', model: 'claude-haiku-5-5' };
  const info: SinapsisEvent = { type: 'subagent_info', t: 1, subagentId: 'a', agentType: 'Explore', description: 'x' };
  const allText = (buf: CellBuffer): string => Array.from({ length: FULL_ROWS }, (_, y) => buf.rowText(y)).join('\n');

  function demo(ms: number, events: SinapsisEvent[] = [models, start, info]): { director: Director; buf: CellBuffer; view: SceneView } {
    const director = new Director({ illustrative: true });
    director.ingest({ kind: 'events', events, historical: false }, 0);
    for (let now = 0; now <= ms; now += 100) director.update(now);
    const view = director.view(ms);
    return { director, view, buf: bufferOf(view) };
  }

  it('muestra porcentaje y actividad de memoria, y siempre los rotula como ilustrativos', () => {
    const { buf } = demo(6000);
    const text = allText(buf);
    expect(text).toMatch(/\d+%/);
    expect(text).toContain('recall');
    expect(text).toContain('memory · illustrative activity');
    expect(text).toContain('demo: % and memory are illustrative');
  });

  it('el rótulo no se pierde en el tamaño mínimo', () => {
    const { view } = demo(6000);
    const buf = new CellBuffer(80, 30);
    renderScene(buf, view);
    expect(Array.from({ length: 30 }, (_, y) => buf.rowText(y)).join('\n')).toContain('memory · illustrative activity');
  });

  it('sin la demo no hay porcentajes ni actividad de ejemplo', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [models, start, info], historical: false }, 0);
    for (let now = 0; now <= 6000; now += 100) director.update(now);
    const view = director.view(6000);
    const text = allText(bufferOf(view));
    expect(view.anim?.illustrative).toBeUndefined();
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toContain('illustrative');
    expect(text).toContain('no memory');
  });

  it('la actividad de ejemplo nunca toca el estado de la sesión', () => {
    const events = [models, start, info, { type: 'subagent_end', t: 9, subagentId: 'a', status: 'completed' } as SinapsisEvent];
    const { view } = demo(30_000, events);
    expect(view.state).toEqual(reduce(events));
    expect(view.state.memory.touches).toEqual([]);
  });

  it('el porcentaje de ejemplo avanza sin llegar al 100 antes de terminar', () => {
    expect(examplePercent(0, 1)).toBe(0);
    expect(examplePercent(5000, 1)).toBeGreaterThan(examplePercent(1000, 1));
    expect(examplePercent(10_000_000, 1)).toBeLessThanOrEqual(97);
    const { buf, view } = demo(30_000, [models, start, info, { type: 'subagent_end', t: 9, subagentId: 'a', status: 'completed' } as SinapsisEvent]);
    expect(view.state.subagents[0]?.running).toBe(false);
    const r = FULL.cards[0];
    expect(buf.rowText(r.y + 3, r.x, r.x + r.w)).not.toContain('%');
  });

  it('hay paquetes circulando por todos los caminos mientras un agente trabaja', () => {
    const director = new Director({ illustrative: true });
    director.ingest({ kind: 'events', events: [models, start, info], historical: true }, 0);
    const seen = new Set<string>();
    for (let now = 0; now < 15_000; now += 50) for (const packet of director.view(now).anim?.packets ?? []) seen.add(packet.route);
    for (const route of ['tool', 'work-0', 'work-1', 'work-2', 'back-0', 'back-1', 'back-2', 'memory-0', 'memory-1', 'memory-2']) expect(seen, route).toContain(route);
    for (const packet of director.view(4000).anim?.packets ?? []) {
      expect(packet.t).toBeGreaterThanOrEqual(0);
      expect(packet.t).toBeLessThan(1);
    }
  });

  it('es reproducible: el mismo instante da el mismo frame', () => {
    const at = (ms: number): CellBuffer => demo(ms).buf;
    const a = at(5000);
    const b = at(5000);
    expect(a.chars.every((c, i) => c === b.chars[i])).toBe(true);
    expect(a.fg.every((c, i) => c === b.fg[i])).toBe(true);
  });
});
