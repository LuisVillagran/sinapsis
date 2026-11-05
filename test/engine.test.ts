import { describe, expect, it } from 'vitest';
import type { SinapsisEvent } from '../src/core/events.js';
import { clamp01, easeInCubic, easeInOutCubic, easeOutCubic, linear, progress, segment } from '../src/engine/easing.js';
import { ADVISOR_MAX_MS, ADVISOR_MIN_MS, AnimationQueue, advisorDuration, loadScale } from '../src/engine/queue.js';
import { TweenSet } from '../src/engine/tweens.js';

const tool = (id: string): SinapsisEvent => ({ type: 'tool_call', t: 1, id, name: 'Read' });
const toolOk = (id: string): SinapsisEvent => ({ type: 'tool_result', t: 1, id, isError: false });
const toolBad = (id: string): SinapsisEvent => ({ type: 'tool_result', t: 1, id, isError: true });
const consult = (id: string): SinapsisEvent => ({ type: 'advisor_consult', t: 1, id, reason: 'check-in' });
const reply = (id: string, durationMs?: number): SinapsisEvent => ({ type: 'advisor_reply', t: 2, id, durationMs, tokensRead: 1, tokensWritten: 1, isError: false });
const usage = (): SinapsisEvent => ({ type: 'message_usage', t: 1, messageId: 'm', input: 0, output: 0, cacheRead: 0, cacheCreation: 0, hasAdvisor: false });

/** Corre la cola hasta vaciarla y devuelve los eventos aplicados, en orden, y los elementos que se vieron. */
function drain(queue: AnimationQueue, stepMs = 16): { events: SinapsisEvent[]; started: Array<{ kind: string; start: number; duration: number; events: number }>; total: number } {
  const events: SinapsisEvent[] = [];
  const started: Array<{ kind: string; start: number; duration: number; events: number }> = [];
  let now = 0;
  for (let guard = 0; guard < 1_000_000 && !queue.isEmpty; guard += 1) {
    for (const step of queue.update(now)) {
      if (step.phase === 'start') {
        events.push(...step.active.item.events);
        started.push({ kind: step.active.item.kind, start: step.active.start, duration: step.active.duration, events: step.active.item.events.length });
      } else {
        events.push(...step.active.item.endEvents);
      }
    }
    now += stepMs;
  }
  return { events, started, total: now };
}

describe('easing', () => {
  it('extremos y recorte', () => {
    for (const ease of [linear, easeOutCubic, easeInCubic, easeInOutCubic]) {
      expect(ease(0)).toBeCloseTo(0);
      expect(ease(1)).toBeCloseTo(1);
      expect(ease(-1)).toBeCloseTo(0);
      expect(ease(2)).toBeCloseTo(1);
    }
    expect(clamp01(0.3)).toBe(0.3);
  });

  it('monótonas y con la forma esperada', () => {
    for (const ease of [linear, easeOutCubic, easeInCubic, easeInOutCubic]) {
      let previous = -1;
      for (let t = 0; t <= 1; t += 0.05) {
        expect(ease(t)).toBeGreaterThanOrEqual(previous);
        previous = ease(t);
      }
    }
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeInCubic(0.5)).toBeLessThan(0.5);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
  });

  it('progress y segment', () => {
    expect(progress(150, 100, 100)).toBe(0.5);
    expect(progress(50, 100, 100)).toBe(0);
    expect(progress(500, 100, 100)).toBe(1);
    expect(progress(100, 100, 0)).toBe(1);
    expect(segment(0.5, 0.25, 0.75)).toBe(0.5);
    expect(segment(0.1, 0.25, 0.75)).toBe(0);
    expect(segment(0.9, 0.25, 0.75)).toBe(1);
    expect(segment(0.5, 0.5, 0.5)).toBe(1);
  });
});

describe('tweens', () => {
  it('llega al objetivo sin pasarse', () => {
    const tweens = new TweenSet();
    expect(tweens.track('a', 10, 0, 100)).toBe(0);
    expect(tweens.track('a', 10, 50, 100)).toBeGreaterThan(0);
    expect(tweens.track('a', 10, 50, 100)).toBeLessThan(10);
    expect(tweens.track('a', 10, 100, 100)).toBe(10);
    expect(tweens.track('a', 10, 500, 100)).toBe(10);
  });

  it('al cambiar de objetivo sigue desde donde iba, sin saltar', () => {
    const tweens = new TweenSet();
    tweens.track('a', 100, 0, 100);
    const mid = tweens.track('a', 100, 50, 100);
    expect(tweens.track('a', 200, 50, 100)).toBeCloseTo(mid);
    expect(tweens.track('a', 200, 150, 100)).toBe(200);
  });

  it('informa si sigue activo, y settle lo detiene', () => {
    const tweens = new TweenSet();
    tweens.track('a', 10, 0, 100);
    expect(tweens.isActive(50)).toBe(true);
    expect(tweens.isActive(100)).toBe(false);
    tweens.track('b', 10, 200, 100);
    tweens.settle('b', 10);
    expect(tweens.isActive(250)).toBe(false);
    expect(tweens.track('b', 10, 250, 100)).toBe(10);
  });
});

describe('cola', () => {
  it('duración mínima visible: sin carga, una herramienta dura al menos 350 ms', () => {
    const queue = new AnimationQueue();
    queue.push([tool('a')]);
    const { started } = drain(queue);
    expect(started[0]?.duration).toBeGreaterThanOrEqual(350);
  });

  it('cada elemento visible empieza cuando termina el anterior, sin superponerse', () => {
    const queue = new AnimationQueue();
    queue.push([tool('a'), toolOk('a'), { type: 'turn_end', t: 2 }, tool('b')]);
    const { started } = drain(queue, 10);
    for (let i = 1; i < started.length; i += 1) {
      const previous = started[i - 1] as { start: number; duration: number };
      expect(started[i]?.start).toBeCloseTo(previous.start + previous.duration, 5);
    }
  });

  it('lo invisible no consume tiempo y conserva el orden', () => {
    const queue = new AnimationQueue();
    const events = [usage(), { type: 'session_info', t: 1, cwd: 'x' } as SinapsisEvent, tool('a'), toolOk('a'), usage()];
    queue.push(events);
    const out = drain(queue);
    expect(out.events).toEqual(events);
    expect(out.started.filter((s) => s.duration > 0)).toHaveLength(1);
  });

  it('acelera de forma gradual con la cola larga', () => {
    expect(loadScale(0)).toBe(1);
    expect(loadScale(3)).toBe(1);
    expect(loadScale(10)).toBeLessThan(loadScale(5));
    expect(loadScale(5)).toBeLessThan(1);

    const durationAt = (pending: number): number => {
      const queue = new AnimationQueue();
      queue.push(Array.from({ length: pending }, (_, i): SinapsisEvent => ({ type: 'turn_end', t: 1, messageId: `m${i}` })));
      return drain(queue).started[0]?.duration ?? 0;
    };
    expect(durationAt(30)).toBeLessThan(durationAt(6));
    expect(durationAt(6)).toBeLessThan(durationAt(1));
    expect(durationAt(500)).toBeGreaterThanOrEqual(120);
  });

  it('una cola muy larga termina mucho antes que sin aceleración', () => {
    const queue = new AnimationQueue();
    const events = Array.from({ length: 300 }, (_, i) => tool(`t${i}`));
    queue.push(events);
    const out = drain(queue);
    expect(out.total).toBeLessThan(300 * 450 * 0.2);
  });

  it('agrupa herramientas consecutivas con cola larga, sin perder ningún evento', () => {
    const queue = new AnimationQueue();
    const events = Array.from({ length: 60 }, (_, i) => [tool(`t${i}`), toolOk(`t${i}`)]).flat();
    queue.push(events);
    const out = drain(queue);
    expect(out.events).toEqual(events);
    expect(out.started.some((s) => s.kind === 'tool' && s.events > 1)).toBe(true);
    expect(out.started.length).toBeLessThan(60);
  });

  it('sin carga no agrupa', () => {
    const queue = new AnimationQueue();
    queue.push([tool('a'), toolOk('a'), tool('b'), toolOk('b')]);
    expect(drain(queue).started.filter((s) => s.kind === 'tool').every((s) => s.events === 1)).toBe(true);
  });

  it('nada importante se descarta ni se une, aunque la cola sea enorme', () => {
    const queue = new AnimationQueue();
    const important: SinapsisEvent[] = [
      consult('c1'),
      reply('c1', 20_000),
      { type: 'subagent_start', t: 1, subagentId: 's1' },
      toolBad('x'),
      { type: 'subagent_end', t: 1, subagentId: 's1', status: 'completed' },
      { type: 'api_error', t: 1, status: 529 },
    ];
    const noise = (prefix: string): SinapsisEvent[] => Array.from({ length: 80 }, (_, i) => tool(`${prefix}${i}`));
    const events: SinapsisEvent[] = [];
    important.forEach((event, i) => events.push(...noise(`n${i}`), event));
    queue.push(events);
    const out = drain(queue);
    expect(out.events).toHaveLength(events.length);
    for (const event of important) expect(out.events).toContainEqual(event);
    // Cada uno conserva su propio elemento.
    expect(out.started.filter((s) => s.kind === 'advisor')).toHaveLength(1);
    expect(out.started.filter((s) => s.kind === 'advisor-reply')).toHaveLength(1);
    expect(out.started.filter((s) => s.kind === 'subagent-start')).toHaveLength(1);
    expect(out.started.filter((s) => s.kind === 'subagent-end')).toHaveLength(1);
    expect(out.started.filter((s) => s.kind === 'error')).toHaveLength(2);
    // Con la cola llena, lo importante sigue siendo visible.
    for (const s of out.started) {
      if (s.kind === 'error') expect(s.duration).toBeGreaterThanOrEqual(350);
      if (s.kind === 'subagent-start' || s.kind === 'subagent-end') expect(s.duration).toBeGreaterThanOrEqual(350);
    }
    // Aquí hay herramientas entre consulta y respuesta, así que van separadas: juntas suman el mínimo.
    const roundTrip = out.started.filter((s) => s.kind === 'advisor' || s.kind === 'advisor-reply').reduce((sum, s) => sum + s.duration, 0);
    expect(roundTrip).toBeGreaterThanOrEqual(ADVISOR_MIN_MS);
  });

  it('un error no queda dentro de un grupo de herramientas', () => {
    const queue = new AnimationQueue();
    const events = [...Array.from({ length: 20 }, (_, i) => tool(`a${i}`)), toolBad('a0'), ...Array.from({ length: 20 }, (_, i) => tool(`b${i}`))];
    queue.push(events);
    const out = drain(queue);
    expect(out.events).toEqual(events);
    expect(out.started.filter((s) => s.kind === 'error')).toHaveLength(1);
  });

  describe('advisor', () => {
    it('comprime la duración real a entre 1,5 y 5 s', () => {
      expect(advisorDuration(0)).toBe(ADVISOR_MIN_MS);
      expect(advisorDuration(undefined)).toBe(ADVISOR_MIN_MS);
      expect(advisorDuration(171_600)).toBeLessThanOrEqual(ADVISOR_MAX_MS);
      expect(advisorDuration(171_600)).toBeGreaterThan(4000);
      expect(advisorDuration(3_600_000)).toBe(ADVISOR_MAX_MS);
      expect(advisorDuration(42_000)).toBeGreaterThan(advisorDuration(19_000));
      expect(advisorDuration(-5)).toBe(ADVISOR_MIN_MS);
    });

    it('consulta y respuesta del mismo lote son un solo elemento: la respuesta se aplica al terminar', () => {
      const queue = new AnimationQueue();
      queue.push([consult('c'), usage(), reply('c', 171_600), tool('t')]);
      const first = queue.update(0);
      const active = first.find((s) => s.phase === 'start' && s.active.item.kind === 'advisor');
      expect(active?.active.item.events.map((e) => e.type)).toEqual(['advisor_consult']);
      expect(active?.active.item.endEvents.map((e) => e.type)).toEqual(['advisor_reply']);
      expect(active?.active.duration).toBeGreaterThan(4000);
      expect(queue.update(1000)).toEqual([]);
      const end = queue.update(5000);
      expect(end[0]?.phase).toBe('end');
    });

    it('la respuesta que llega en otro lote, con la consulta ya en curso, es su propio elemento', () => {
      const queue = new AnimationQueue();
      queue.push([consult('c')]);
      queue.update(0);
      queue.push([reply('c', 1000)]);
      const out = drain(queue);
      expect(out.started.map((s) => s.kind)).toContain('advisor-reply');
      expect(out.events.map((e) => e.type)).toEqual(['advisor_reply']);
    });

    it('un texto entre consulta y respuesta no se reordena', () => {
      const queue = new AnimationQueue();
      const text: SinapsisEvent = { type: 'assistant_text', t: 1, text: 'hola' };
      const events = [consult('c'), text, reply('c', 1000)];
      queue.push(events);
      expect(drain(queue).events).toEqual(events);
    });

    it('la respuesta sigue a la consulta correcta', () => {
      const queue = new AnimationQueue();
      queue.push([consult('a'), reply('b', 1000)]);
      expect(drain(queue).started.map((s) => s.kind)).toEqual(['advisor', 'advisor-reply']);
    });
  });

  it('un inicio repetido del mismo subagente no se anima dos veces', () => {
    const queue = new AnimationQueue();
    queue.push([{ type: 'subagent_start', t: 1, subagentId: 's' }, { type: 'subagent_start', t: 1, subagentId: 's' }]);
    expect(drain(queue).started.map((s) => s.kind)).toEqual(['subagent-start', 'instant']);
  });

  it('pendientes y sus colores', () => {
    const queue = new AnimationQueue();
    queue.push([usage(), tool('a'), consult('c'), toolBad('a')]);
    expect(queue.pending).toBe(3);
    expect(queue.pendingKinds).toEqual(['tool', 'advisor', 'error']);
    queue.clear();
    expect(queue.isEmpty).toBe(true);
  });

  it('un frame muy tardío no pierde nada', () => {
    const queue = new AnimationQueue();
    queue.push([tool('a'), tool('b'), tool('c')]);
    const started: string[] = [];
    const collect = (now: number): void => {
      for (const step of queue.update(now)) if (step.phase === 'start') started.push(step.active.item.events[0]?.type ?? '');
    };
    collect(0);
    expect(started).toHaveLength(1);
    // Tras la pausa, el siguiente empieza ahora y se alcanza a ver: no se salta.
    collect(100_000);
    expect(started).toHaveLength(2);
    expect(queue.active?.start).toBe(100_000);
    collect(101_000);
    expect(started).toHaveLength(3);
    expect(queue.isEmpty).toBe(false);
    collect(102_000);
    expect(queue.isEmpty).toBe(true);
  });
});
