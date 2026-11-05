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
