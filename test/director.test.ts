import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runApp } from '../src/app.js';
import { describeEvent } from '../src/core/describe.js';
import type { SinapsisEvent } from '../src/core/events.js';
import { createParser } from '../src/core/parser.js';
import { reduce } from '../src/core/state.js';
import { Director } from '../src/engine/director.js';
import { createReplay, loadTranscript } from '../src/sources/replay.js';
import { RESTORE_SEQUENCE, TerminalSession } from '../src/tui/terminal.js';
import { FIXTURES, HAIKU_MAIN, OPUS_MAIN, haikuLines, readLines } from './helpers.js';

function directEvents(): SinapsisEvent[] {
  const parser = createParser();
  return [...haikuLines().values()].flat().flatMap((l) => parser.feed(l.raw, l.agentId ? { agentId: l.agentId } : {}));
}

/** Reproduce un transcript completo con reloj falso, hasta que la cola se vacíe. */
function playToEnd(path: string): { director: Director; total: number } {
  const director = new Director();
  const replay = createReplay(loadTranscript(path), { speed: 4 });
  let now = 0;
  for (let guard = 0; guard < 500_000; guard += 1) {
    for (const update of replay.tick(now)) director.ingest(update, now);
    director.update(now);
    if (replay.finished && director.settled) break;
    now += 16;
  }
  return { director, total: now };
}

describe('director', () => {
  it('al vaciarse la cola, lo visible coincide con el reductor: ninguna animación borra datos', () => {
    const { director } = playToEnd(HAIKU_MAIN);
    expect(director.settled).toBe(true);
    expect(director.shown).toEqual(reduce(directEvents()));
    expect(director.shown).toEqual(director.truth);
  });

  it('también sin subagentes y con errores reales', () => {
    const { director } = playToEnd(OPUS_MAIN);
    const parser = createParser();
    expect(director.shown).toEqual(reduce(readLines(OPUS_MAIN).flatMap((raw) => parser.feed(raw))));
    expect(director.shown.toolErrors).toBeGreaterThan(0);
  });

  it('lo visible va detrás de lo real mientras la cola tiene trabajo', () => {
    const director = new Director();
    const events: SinapsisEvent[] = [
      { type: 'advisor_consult', t: 1, id: 'c', reason: 'check-in' },
      { type: 'advisor_reply', t: 2, id: 'c', durationMs: 20_000, tokensRead: 100, tokensWritten: 10, isError: false },
    ];
    director.ingest({ kind: 'events', events, historical: false }, 0);
    expect(director.truth.advisor.tokensRead).toBe(100);
    expect(director.shown.advisor.calls).toBe(0);
    director.update(0);
    expect(director.shown.advisor.calls).toBe(1);
    expect(director.shown.advisor.consults[0]?.open).toBe(true);
    director.update(1000);
    expect(director.shown.advisor.tokensRead).toBe(0);
    director.update(6000);
    expect(director.shown.advisor.tokensRead).toBe(100);
    expect(director.shown.advisor.consults[0]?.open).toBe(false);
  });

  it('el historial se aplica de inmediato y sin cola', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: directEvents(), historical: true }, 0);
    expect(director.settled).toBe(true);
    expect(director.shown).toEqual(reduce(directEvents()));
    expect(director.view(0).log.every((entry) => entry.bornAt === undefined)).toBe(true);
  });

  it('un inicio repetido tras el historial no vuelve a animarse', () => {
    const director = new Director();
    const start: SinapsisEvent = { type: 'subagent_start', t: 5, subagentId: 's' };
    director.ingest({ kind: 'events', events: [start], historical: true }, 0);
    director.ingest({ kind: 'events', events: [start], historical: false }, 0);
    director.update(0);
    expect(director.settled).toBe(true);
  });

  it('reset limpia la sesión anterior', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [{ type: 'tool_call', t: 1, id: 'a', name: 'Read' }], historical: true }, 0);
    director.ingest({ kind: 'events', events: [{ type: 'tool_call', t: 1, id: 'b', name: 'Read' }], historical: false }, 0);
    director.ingest({ kind: 'reset', sessionId: 'otra' }, 0);
    expect(director.shown.toolCalls).toBe(0);
    expect(director.truth.toolCalls).toBe(0);
    expect(director.settled).toBe(true);
    expect(director.view(0).log).toEqual([]);
    expect(director.view(0).connected).toBe(true);
  });

  it('sin sesión aún, la vista queda desconectada', () => {
    expect(new Director().view(0).connected).toBe(false);
  });

  it('el log conserva todo evento que merece línea, sin repetir inicios', () => {
    const { director } = playToEnd(HAIKU_MAIN);
    const replay = createReplay(loadTranscript(HAIKU_MAIN), { speed: 64 });
    const events: SinapsisEvent[] = [];
    for (let now = 0; !replay.finished; now += 16) {
      for (const update of replay.tick(now)) if (update.kind === 'events') events.push(...update.events);
    }
    const seen = new Set<string>();
    const expected = events.filter((e) => {
      if (e.type === 'subagent_start') {
        if (seen.has(e.subagentId)) return false;
        seen.add(e.subagentId);
      }
      return describeEvent(e, director.shown) !== undefined;
    }).length;
    expect(director.view(0).log).toHaveLength(expected);
    expect(director.view(0).log.filter((entry) => entry.text === 'subagent started')).toHaveLength(3);
  });
});

describe('subagente en segundo plano que termina por dos archivos', () => {
  const events = (noticeFirst: boolean): SinapsisEvent[] => {
    const start: SinapsisEvent = { type: 'subagent_start', t: 1000, subagentId: 'bg' };
    const info: SinapsisEvent = { type: 'subagent_info', t: 1000, subagentId: 'bg', description: 'tarea', agentType: 'builder' };
    const noticeEnd: SinapsisEvent = { type: 'subagent_end', t: 9000, subagentId: 'bg', status: 'completed' };
    const result: SinapsisEvent = { type: 'subagent_result', t: 9000, subagentId: 'bg', status: 'completed', durationMs: 8000, totalTokens: 50, toolCount: 3 };
    const handback: SinapsisEvent = { type: 'subagent_end', t: 8000, subagentId: 'bg', status: 'completed', summary: 'informe real', handback: true };
    return noticeFirst ? [start, info, noticeEnd, result, handback] : [start, info, handback, result];
  };

  for (const noticeFirst of [true, false]) {
    it(`${noticeFirst ? 'aviso' : 'informe'} primero: un solo fin en el log y el mismo estado final`, () => {
      const director = new Director();
      let now = 0;
      director.ingest({ kind: 'events', events: events(noticeFirst), historical: false }, now);
      for (let guard = 0; guard < 10_000 && !director.settled; guard += 1) {
        director.update(now);
        now += 16;
      }
      expect(director.settled).toBe(true);
      expect(director.shown).toEqual(director.truth);
      expect(director.shown.subagents[0]).toMatchObject({ running: false, summary: 'informe real', durationMs: 8000, toolCount: 3, finalized: true });
      expect(director.view(now).log.filter((entry) => entry.text === 'summary sent back to lead')).toHaveLength(1);
    });
  }

  it('el estado visible no depende del orden', () => {
    const final = (noticeFirst: boolean): unknown => {
      const director = new Director();
      director.ingest({ kind: 'events', events: events(noticeFirst), historical: true }, 0);
      return director.shown.subagents;
    };
    expect(final(true)).toEqual(final(false));
  });
});

describe('sesión real con un error a propósito', () => {
  const MAIN = join(FIXTURES, 'sesion-haiku-con-error.jsonl');

  it('llega al mismo estado que el reductor y marca el error', () => {
    const { director } = playToEnd(MAIN);
    expect(director.shown).toEqual(director.truth);
    expect(director.shown.toolErrors).toBe(1);
    expect(director.shown.tools.Read?.errors).toBe(1);
    expect(director.shown.subagents).toHaveLength(2);
    expect(director.shown.advisor.calls).toBe(2);
  });

  it('en el log, el fin de turno va después de la respuesta del advisor, y con una hora coherente', () => {
    const { director } = playToEnd(MAIN);
    const log = director.view(0).log;
    const finished = log.findIndex((entry) => entry.text === 'turn finished');
    const lastReply = log.map((entry) => entry.text.startsWith('sealed reply')).lastIndexOf(true);
    expect(finished).toBeGreaterThan(lastReply);
    expect(log[finished]?.t).toBeGreaterThanOrEqual(log[lastReply]?.t ?? 0);
  });

  it('la consulta tras el error se rotula como tal', () => {
    const { director } = playToEnd(MAIN);
    expect(director.shown.advisor.consults.map((c) => c.reason)).toEqual(['before a plan', 'after errors']);
  });
});

describe('restauración de la terminal', () => {
  const outputOf = (): { stream: PassThrough; text: () => string } => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
  };

  const silentSource = { tick: () => [], stop: async () => undefined };
  const baseOptions = (stream: PassThrough) => ({
    source: silentSource,
    output: stream,
    size: () => ({ cols: 96, rows: 48 }),
    colorMode: 'truecolor' as const,
  });

  it('entra a la pantalla alternativa y restaura solo una vez', () => {
    const { stream, text } = outputOf();
    const session = new TerminalSession(stream, undefined);
    session.enter(() => undefined);
    expect(text()).toContain('\x1b[?1049h');
    expect(text()).toContain('\x1b[?25l');
    session.restore();
    session.restore();
    expect(text().split(RESTORE_SEQUENCE)).toHaveLength(2);
    expect(RESTORE_SEQUENCE).toContain('\x1b[?2026l');
    expect(RESTORE_SEQUENCE).toContain('\x1b[?25h');
    expect(RESTORE_SEQUENCE).toContain('\x1b[?1049l');
    expect(RESTORE_SEQUENCE).toContain('\x1b[?7h');
  });

  it('una salida cerrada no impide terminar', () => {
    const session = new TerminalSession(new PassThrough(), undefined, () => {
      throw new Error('cerrada');
    });
    expect(() => session.restore()).not.toThrow();
    expect(session.isRestored).toBe(true);
  });

  it('un error en un frame restaura y rechaza', async () => {
    const { stream, text } = outputOf();
    const app = runApp({ ...baseOptions(stream), crashAtFrame: 2, fps: 200 });
    await expect(app.done).rejects.toThrow('Fallo forzado');
    expect(app.session.isRestored).toBe(true);
    expect(text().endsWith(RESTORE_SEQUENCE)).toBe(true);
  });

  it('las teclas q y Ctrl+C terminan; en replay, las demás controlan la reproducción', async () => {
    for (const key of ['q', '\x03']) {
      const { stream } = outputOf();
      const input = new PassThrough();
      const fake = Object.assign(input, { isTTY: false });
      const app = runApp({ ...baseOptions(stream), input: fake, fps: 200 });
      input.write(key);
      await app.done;
      expect(app.session.isRestored).toBe(true);
    }

    const { stream } = outputOf();
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const replay = createReplay(loadTranscript(HAIKU_MAIN), { speed: 2 });
    const app = runApp({ ...baseOptions(stream), source: replay, replay, input, fps: 200 });
    const waitForKey = async (key: string): Promise<void> => {
      input.write(key);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await waitForKey(' ');
    expect(replay.paused).toBe(true);
    await waitForKey(' ');
    expect(replay.paused).toBe(false);
    await waitForKey('+');
    expect(replay.speed).toBe(4);
    await waitForKey('-');
    await waitForKey('-');
    expect(replay.speed).toBe(1);
    app.stop();
    await app.done;
  });

  it('una frecuencia muy alta no agota la pila ni bloquea el proceso', async () => {
    const { stream } = outputOf();
    const app = runApp({ ...baseOptions(stream), fps: 100_000 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    app.stop();
    await app.done;
    expect(app.session.isRestored).toBe(true);
  });

  it('con contrapresión espera a drain y no se detiene', async () => {
    let drainListener: (() => void) | undefined;
    let writes = 0;
    const output = {
      write: () => {
        writes += 1;
        return false;
      },
      once: (_event: 'drain', listener: () => void) => {
        drainListener = listener;
      },
    };
    let t = 0;
    const app = runApp({ source: silentSource, output, size: () => ({ cols: 96, rows: 48 }), colorMode: 'truecolor', now: () => (t += 1000), fps: 500 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const blocked = writes;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes).toBe(blocked);
    expect(drainListener).toBeDefined();
    drainListener?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes).toBeGreaterThan(blocked);
    app.stop();
    await app.done;
  });

  it('un cambio de tamaño redibuja al nuevo tamaño', async () => {
    const { stream, text } = outputOf();
    let size = { cols: 96, rows: 48 };
    let resize: () => void = () => undefined;
    const app = runApp({
      ...baseOptions(stream),
      size: () => size,
      onResize: (listener) => {
        resize = listener;
        return () => undefined;
      },
      fps: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    size = { cols: 60, rows: 20 };
    resize();
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stop();
    await app.done;
    expect(text()).toContain('Agranda la ventana'[0]);
    expect(text()).toContain('60x20'[0]);
  });
});

describe('consulta abandonada en el director', () => {
  const consult: SinapsisEvent = { type: 'advisor_consult', t: 1, id: 'x', reason: 'check-in' };
  const abandoned: SinapsisEvent = { type: 'advisor_abandoned', t: 3, id: 'x' };
  const retry: SinapsisEvent = { type: 'advisor_consult', t: 4, id: 'y', reason: 'check-in' };
  const reply: SinapsisEvent = { type: 'advisor_reply', t: 5, id: 'y', durationMs: 20_000, tokensRead: 100, tokensWritten: 10, isError: false };
  const events = [consult, abandoned, retry, reply];

  function play(director: Director, until: number): void {
    for (let now = 0; now <= until; now += 16) director.update(now);
  }

  it('el evento no se pierde ni bloquea: al vaciarse la cola, lo visible coincide con lo real', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events, historical: false }, 0);
    play(director, 20_000);
    expect(director.settled).toBe(true);
    expect(director.shown).toEqual(director.truth);
    expect(director.shown).toEqual(reduce(events));
    expect(director.shown.advisor.calls).toBe(1);
    expect(director.shown.advisor.consults.map((c) => c.id)).toEqual(['y']);
    expect(director.shown.advisor.consults.some((c) => c.open)).toBe(false);
  });

  it('con la consulta aún en la cola, no se anima ni deja el advisor en replaying', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [consult, abandoned], historical: false }, 0);
    director.update(0);
    expect(director.settled).toBe(true);
    expect(director.shown.advisor.consults).toEqual([]);
    expect(director.shown.advisor.calls).toBe(0);
    expect(director.view(0).anim?.advisorPulse).toBeUndefined();
  });

  it('con la consulta ya en curso, termina de forma normal y queda cerrada', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events: [consult], historical: false }, 0);
    director.update(0);
    expect(director.shown.advisor.consults[0]?.open).toBe(true);
    director.ingest({ kind: 'events', events: [abandoned], historical: false }, 100);
    director.update(500);
    expect(director.shown.advisor.consults.length).toBe(1);
    director.update(1100);
    expect(director.shown.advisor.consults).toEqual([]);
    expect(director.settled).toBe(true);
    expect(director.shown).toEqual(director.truth);
  });

  it('en el historial se aplica de inmediato y el log conserva la consulta y avisa del reintento', () => {
    const director = new Director();
    director.ingest({ kind: 'events', events, historical: true }, 0);
    expect(director.settled).toBe(true);
    expect(director.shown).toEqual(director.truth);
    const texts = director.view(0).log.map((l) => l.text);
    expect(texts.filter((t) => t.startsWith('consulted'))).toHaveLength(2);
    expect(texts).toContain('consult dropped · no reply (inferred)');
  });
});
