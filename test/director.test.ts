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
import { HAIKU_MAIN, OPUS_MAIN, haikuLines, readLines } from './helpers.js';

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
