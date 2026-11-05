import { describe, expect, it } from 'vitest';
import type { SinapsisEvent } from '../src/core/events.js';
import { reduce } from '../src/core/state.js';
import { Director } from '../src/engine/director.js';
import { FULL, ROUTES, consultSlot } from '../src/scene/layout.js';
import { renderScene } from '../src/scene/scene.js';
import { theme } from '../src/scene/theme.js';
import type { SceneView } from '../src/scene/view.js';
import { CellBuffer } from '../src/tui/buffer.js';

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
  const buf = new CellBuffer(96, 48);
  renderScene(buf, view);
  return { director, view, buf };
}

const bufferOf = (view: SceneView): CellBuffer => {
  const buf = new CellBuffer(96, 48);
  renderScene(buf, view);
  return buf;
};

describe('rutas', () => {
  it('son contiguas: cada celda toca a la anterior', () => {
    for (const [name, cells] of Object.entries(ROUTES)) {
      for (let i = 1; i < cells.length; i += 1) {
        const [ax, ay] = cells[i - 1] as [number, number];
        const [bx, by] = cells[i] as [number, number];
        expect(Math.abs(ax - bx) + Math.abs(ay - by), `${name} en ${i}`).toBe(1);
      }
    }
  });

  it('cada subagente llega a su tarjeta y regresa a back to lead', () => {
    FULL.cardCenters.forEach((center, i) => {
      const delegate = ROUTES[`delegate-${i}` as 'delegate-0'];
      expect(delegate[delegate.length - 1]).toEqual([center, FULL.cards[i as 0].y - 1]);
      const back = ROUTES[`back-${i}` as 'back-0'];
      expect(back[0]).toEqual([center, FULL.cards[i as 0].y + FULL.cards[i as 0].h]);
      expect(back[back.length - 1]).toEqual([FULL.spine, FULL.lead.y - 1]);
    });
  });

  it('una consulta viaja por la flecha de su hito', () => {
    expect(consultSlot('before a plan')).toBe(0);
    expect(consultSlot('check-in')).toBe(0);
    expect(consultSlot('after errors')).toBe(1);
    expect(consultSlot('after subagents')).toBe(1);
    expect(consultSlot('before done')).toBe(2);
  });
});

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
    expect(director.isBusy(500)).toBe(false);
  });

  it('solo las herramientas del proceso principal envían un paquete', () => {
    const inside: SinapsisEvent = { type: 'tool_call', t: 1, id: 't', name: 'Read', agentId: 'a' };
    expect(play([inside], 100).view.anim?.packets).toEqual([]);
    expect(play([call], 100).view.anim?.packets).toHaveLength(1);
  });

  it('la cabeza brilla y la estela se apaga detrás de ella', () => {
    const route = ROUTES['advisor-out-0'];
    const buf = bufferOf({ ...play([models], 10).view, anim: { packets: [{ route: 'advisor-out-0', t: 0.5 }] } });
    const still = bufferOf({ ...play([models], 10).view, anim: { packets: [] } });
    const changes = route.map(([x, y]) => (buf.bgAt(x, y) !== still.bgAt(x, y) ? 1 : 0));
    expect(changes.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(3);
    const headIndex = Math.round(0.5 * (route.length - 1 + 5));
    const head = route[headIndex] as [number, number];
    expect(buf.charAt(head[0], head[1])).toBe('●');
    const near = route[headIndex - 1] as [number, number];
    const far = route[headIndex - 4] as [number, number];
    const glow = (x: number, y: number): number => Math.abs((buf.bgAt(x, y) & 255) - (still.bgAt(x, y) & 255));
    expect(glow(near[0], near[1])).toBeGreaterThan(glow(far[0], far[1]));
  });

  it('el avance es más fino que una celda: la intensidad cambia dentro de una misma celda', () => {
    const route = ROUTES['advisor-out-0'];
    const cell = route[6] as [number, number];
    const base = play([models], 10).view;
    const span = route.length - 1 + 5;
    const at = (head: number): number => bufferOf({ ...base, anim: { packets: [{ route: 'advisor-out-0', t: head / span }] } }).bgAt(cell[0], cell[1]);
    expect(at(5.3)).not.toBe(at(5.7));
  });

  it('no escribe sobre texto', () => {
    const base = play([models], 10).view;
    const buf = bufferOf({ ...base, anim: { packets: [{ route: 'delegate-0', t: 2 / 12 }] } });
    expect(buf.rowText(21)).toContain('delegate to subagents');
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
    expect(early.charAt(r.x, r.y)).not.toBe('┏');
    expect(early.rowText(r.y + 1, r.x, r.x + r.w)).not.toContain('tarea a');
    // Después la caja ya tiene su tamaño real.
    const full = at(800);
    expect(full.charAt(r.x, r.y)).toBe('┏');
    expect(full.charAt(r.x + r.w - 1, r.y + r.h - 1)).toBe('┛');
    expect(full.rowText(r.y + 1, r.x, r.x + r.w)).toContain('tarea a');
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
    expect(buf.rowText(r.y + 1, r.x, r.x + r.w)).toContain('tarea a');
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

  it('una barra crece con easing: rápido al principio y suave al final', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: calls(1), historical: false }, 0);
    director.update(0);
    const at = (ms: number): number => director.view(ms).anim?.numbers?.tools.Read ?? 0;
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
    expect(numbers?.tools.Read).toBe(7);
    expect(director.isBusy(100)).toBe(false);
  });

  it('en reposo, la escena muestra los valores reales', () => {
    const events = [models, ...calls(3), ...calls(2, 'Grep'), consult(), reply()];
    const { buf, view } = play(events, 15_000);
    expect(view.anim?.numbers?.toolCalls).toBe(5);
    expect(buf.rowText(FULL.metrics.y + 1)).toContain('calls 5');
    expect(buf.rowText(FULL.metrics.y + 2)).toContain('3');
    const panel = Array.from({ length: 34 }, (_, i) => buf.rowText(5 + i, 2, 24)).join('\n');
    expect(panel).toContain('64.7k');
  });

  it('las barras no se salen del riel mientras crecen', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [...calls(3), ...calls(2, 'Grep')], historical: false }, 0);
    for (let now = 0; now < 4000; now += 100) {
      director.update(now);
      const buf = bufferOf(director.view(now));
      for (const y of [FULL.metrics.y + 2, FULL.metrics.y + 3]) expect('┃').toContain(buf.charAt(FULL.metrics.x + FULL.metrics.w - 1, y));
    }
  });

  it('el estado final coincide con el reductor', () => {
    const events = [models, ...calls(3)];
    expect(play(events, 8000).view.state).toEqual(reduce(events));
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
    expect(going?.map((p) => p.route)).toEqual(['advisor-out-0']);
    expect(play(batch, length * 0.5).view.anim?.packets).toEqual([]);
    const returning = play(batch, length * 0.85).view.anim?.packets;
    expect(returning?.map((p) => p.route)).toEqual(['advisor-back-0']);
  });

  it('el panel late mientras dura y se apaga al terminar', () => {
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
    expect(lit.fgAt(2, 5)).not.toBe(off.fgAt(2, 5));
    expect(off.bgAt(10, 25)).toBe(theme.panel);
    expect(lit.bgAt(10, 25)).not.toBe(theme.panel);
  });

  it('el estado dice replaying solo durante la animación, y los datos llegan al final', () => {
    const length = total();
    const mid = play(batch, length * 0.5);
    expect(mid.buf.rowText(9, 78, 95)).toContain('replaying');
    expect(mid.view.state.advisor.tokensRead).toBe(0);
    const end = play(batch, length + 100);
    expect(end.buf.rowText(9, 78, 95)).toContain('silent');
    expect(end.view.state.advisor.tokensRead).toBe(64_700);
  });

  it('el motivo se escribe en la línea de tiempo', () => {
    const typed = (ms: number): string => play(batch, ms).buf.rowText(FULL.arrows.main, 3, 23);
    expect(typed(60)).toContain('b▌');
    expect(typed(200)).toContain('befor');
    expect(typed(200)).not.toContain('before a plan');
    expect(typed(1400)).toContain('before a plan');
    expect(typed(1400)).not.toContain('▌');
  });

  it('cada hito viaja por su flecha', () => {
    const events = [models, consult('after subagents'), reply()];
    expect(play(events, 100).view.anim?.packets?.[0]?.route).toBe('advisor-out-1');
    const done = [models, consult('before done'), reply()];
    expect(play(done, 100).view.anim?.packets?.[0]?.route).toBe('advisor-out-2');
  });

  it('con la respuesta en otro lote, la vuelta se anima al llegar', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [consult()], historical: false }, 0);
    director.update(0);
    expect(director.view(100).anim?.packets?.map((p) => p.route)).toEqual(['advisor-out-0']);
    director.update(1100);
    director.ingest({ kind: 'events', events: [reply()], historical: false }, 1100);
    director.update(1200);
    expect(director.view(1200).anim?.packets?.map((p) => p.route)).toEqual(['advisor-back-0']);
    expect(director.view(1200).anim?.advisorPulse).toBeDefined();
  });

  it('el estado final coincide con el reductor', () => {
    const { view } = play(batch, 6000);
    expect(view.state).toEqual(reduce(batch));
  });
});
