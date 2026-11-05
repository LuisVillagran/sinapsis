import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArgsError, parseArgs } from '../src/args.js';
import type { SinapsisEvent } from '../src/core/events.js';
import { createParser } from '../src/core/parser.js';
import { reduce } from '../src/core/state.js';
import { encodeProjectPath, findSession, projectsRoot, sessionsInProject } from '../src/sources/discovery.js';
import { LineTail } from '../src/sources/lineTail.js';
import { ACTIVE_WINDOW_MS, SessionTail, createLiveSource } from '../src/sources/live.js';
import { formatEvent } from '../src/sources/printEvents.js';
import { arrivalTimes, createReplay, loadTranscript } from '../src/sources/replay.js';
import type { EventSource, SourceUpdate } from '../src/sources/types.js';
import { HAIKU_MAIN, OPUS_MAIN, haikuLines, readLines } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sinapsis-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const eventsOf = (updates: SourceUpdate[]): SinapsisEvent[] => updates.flatMap((u) => (u.kind === 'events' ? u.events : []));

describe('LineTail', () => {
  it('no entrega una línea hasta que está completa', () => {
    const file = join(dir, 'a.jsonl');
    writeFileSync(file, '{"a":1}\n{"b"');
    const tail = new LineTail(file);
    expect(tail.readNewLines()).toEqual(['{"a":1}']);
    expect(tail.readNewLines()).toEqual([]);
    appendFileSync(file, ':2}');
    expect(tail.readNewLines()).toEqual([]);
    appendFileSync(file, '\n');
    expect(tail.readNewLines()).toEqual(['{"b":2}']);
  });

  it('un carácter UTF-8 cortado entre dos escrituras llega intacto', () => {
    const file = join(dir, 'a.jsonl');
    const bytes = Buffer.from('{"texto":"ñandú ✓"}\n', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1;
    writeFileSync(file, bytes.subarray(0, cut));
    const tail = new LineTail(file);
    expect(tail.readNewLines()).toEqual([]);
    appendFileSync(file, bytes.subarray(cut));
    expect(tail.readNewLines()).toEqual(['{"texto":"ñandú ✓"}']);
  });

  it('tolera CRLF, líneas vacías y un archivo que aún no existe', () => {
    const file = join(dir, 'a.jsonl');
    const tail = new LineTail(file);
    expect(tail.readNewLines()).toEqual([]);
    writeFileSync(file, '{"a":1}\r\n\r\n\n{"b":2}\r\n');
    expect(tail.readNewLines()).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('si el archivo se trunca vuelve a empezar', () => {
    const file = join(dir, 'a.jsonl');
    writeFileSync(file, '{"a":1}\n{"b":2}\n');
    const tail = new LineTail(file);
    tail.readNewLines();
    writeFileSync(file, '{"c":3}\n');
    expect(tail.readNewLines()).toEqual(['{"c":3}']);
  });

  it('lee líneas más largas que el bloque de lectura', () => {
    const file = join(dir, 'a.jsonl');
    const long = `{"x":"${'y'.repeat(700_000)}"}`;
    writeFileSync(file, `${long}\n{"z":1}\n`);
    expect(new LineTail(file).readNewLines()).toEqual([long, '{"z":1}']);
  });

  it('con un descriptor abierto por el escritor también ve las líneas', () => {
    const file = join(dir, 'a.jsonl');
    const fd = openSync(file, 'a');
    const tail = new LineTail(file);
    writeSync(fd, '{"a":1}\n');
    expect(tail.readNewLines()).toEqual(['{"a":1}']);
    writeSync(fd, '{"b":2}\n');
    expect(tail.readNewLines()).toEqual(['{"b":2}']);
    closeSync(fd);
  });
});

describe('SessionTail de extremo a extremo', () => {
  function copyHaiku(pieces: number): { main: string; written: () => boolean; writeNext: () => void } {
    const main = join(dir, 'sesion.jsonl');
    const subDir = join(dir, 'sesion', 'subagents');
    const files = new Map<string, Buffer>();
    for (const [key, lines] of haikuLines()) {
      const path = key === 'main' ? main : join(subDir, `agent-${key}.jsonl`);
      files.set(path, Buffer.from(`${lines.map((l) => l.raw).join('\n')}\n`, 'utf8'));
    }
    const cursors = new Map([...files.keys()].map((p) => [p, 0]));
    let round = 0;
    return {
      main,
      written: () => [...files].every(([p, b]) => cursors.get(p) === b.length),
      writeNext: () => {
        round += 1;
        for (const [path, bytes] of files) {
          if (path !== main) mkdirSync(subDir, { recursive: true });
          // Cortes en cualquier byte, distintos en cada archivo: parten líneas y caracteres.
          const size = Math.ceil(bytes.length / pieces) + (round % 7);
          const from = cursors.get(path) ?? 0;
          const to = Math.min(bytes.length, from + size);
          appendFileSync(path, bytes.subarray(from, to));
          cursors.set(path, to);
        }
      },
    };
  }

  const expectedEvents = (): SinapsisEvent[] => {
    const parser = createParser();
    return [...haikuLines().values()].flat().flatMap((l) => parser.feed(l.raw, l.agentId ? { agentId: l.agentId } : {}));
  };

  it('escrito de una vez: el mismo estado que el parser directo', () => {
    const copy = copyHaiku(1);
    copy.writeNext();
    expect(copy.written()).toBe(true);
    const tail = new SessionTail(copy.main);
    expect(reduce(tail.pump())).toEqual(reduce(expectedEvents()));
    expect(tail.pump()).toEqual([]);
    expect(tail.invalidLines).toBe(0);
  });

  it('escrito a trozos que parten líneas: sin duplicados ni pérdidas', () => {
    const copy = copyHaiku(37);
    const tail = new SessionTail(copy.main);
    const events: SinapsisEvent[] = [];
    while (!copy.written()) {
      copy.writeNext();
      events.push(...tail.pump());
    }
    events.push(...tail.pump());
    expect(tail.invalidLines).toBe(0);

    const expected = expectedEvents();
    const count = (list: SinapsisEvent[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const e of list) if (e.type !== 'subagent_info' && e.type !== 'session_info') out[e.type] = (out[e.type] ?? 0) + 1;
      return out;
    };
    expect(reduce(events)).toEqual(reduce(expected));
    // Los enlaces y metadatos pueden llegar en otro orden; lo observable no se duplica.
    const ids = events.flatMap((e) => (e.type === 'tool_call' || e.type === 'tool_result' ? [`${e.type}:${e.id}`] : []));
    expect(new Set(ids).size).toBe(ids.length);
    const counts = count(events);
    const want = count(expected);
    expect(counts.tool_call).toBe(want.tool_call);
    expect(counts.tool_result).toBe(want.tool_result);
    expect(counts.advisor_consult).toBe(2);
    expect(counts.advisor_reply).toBe(2);
    expect(counts.subagent_end).toBe(3);
    expect(counts.subagent_result).toBe(3);
  });

  it('encuentra un subagente cuya carpeta aparece después', () => {
    const main = join(dir, 's.jsonl');
    writeFileSync(main, '{"type":"mode","mode":"normal"}\n');
    const tail = new SessionTail(main);
    tail.pump();
    expect(tail.pump()).toEqual([]);
    mkdirSync(join(dir, 's', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 's', 'subagents', 'agent-abc.jsonl'), '{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"p"}}\n');
    writeFileSync(join(dir, 's', 'subagents', 'agent-abc.meta.json'), '{}');
    expect(tail.pump().map((e) => e.type)).toContain('subagent_start');
  });
});

describe('descubrimiento de sesiones', () => {
  const session = (project: string, id: string, ageMs = 0): string => {
    const folder = join(dir, project);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${id}.jsonl`);
    writeFileSync(path, '{"type":"mode","mode":"normal"}\n');
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
    return path;
  };

  it('codifica la carpeta como lo hace Claude Code', () => {
    const encoded = encodeProjectPath('C:\\Users\\alguien\\Mi Proyecto_1');
    expect(encoded.endsWith('-Users-alguien-Mi-Proyecto-1')).toBe(true);
    expect(encoded).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it('respeta CLAUDE_CONFIG_DIR', () => {
    expect(projectsRoot({ CLAUDE_CONFIG_DIR: join('x', 'y') })).toBe(join('x', 'y', 'projects'));
  });

  it('elige la más reciente, por carpeta y por id, sin confundir subagentes', () => {
    session('p1', 'vieja', 60_000);
    session('p2', 'nueva', 1000);
    mkdirSync(join(dir, 'p2', 'nueva', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'p2', 'nueva', 'subagents', 'agent-x.jsonl'), '{}\n');
    expect(findSession({ root: dir })?.id).toBe('nueva');
    expect(findSession({ root: dir, sessionId: 'vieja' })?.id).toBe('vieja');
    expect(findSession({ root: dir, sessionId: 'no-existe' })).toBeUndefined();
    expect(sessionsInProject(join(dir, 'p2')).map((s) => s.id)).toEqual(['nueva']);
    const folder = join(dir, 'proyecto real');
    mkdirSync(join(dir, encodeProjectPath(folder)), { recursive: true });
    session(encodeProjectPath(folder), 'de-carpeta', 500_000);
    expect(findSession({ root: dir, project: folder })?.id).toBe('de-carpeta');
  });

  it('sin carpeta de proyectos no falla', () => {
    expect(findSession({ root: join(dir, 'no-existe') })).toBeUndefined();
  });

  const liveOptions = { pollMs: 0, discoverMs: 0, useWatcher: false };
  const tickUntil = (source: EventSource): SourceUpdate[] => source.tick(Date.now());

  it('fuente en vivo: espera sin fallar hasta que aparece una sesión', async () => {
    const source = createLiveSource({ root: dir, ...liveOptions });
    expect(tickUntil(source)).toEqual([]);
    const path = session('p', 'a');
    const first = tickUntil(source);
    expect(first[0]).toEqual({ kind: 'reset', sessionId: 'a' });
    expect(first[1]).toMatchObject({ kind: 'events', historical: true });
    appendFileSync(path, '{"type":"user","turnOrigin":"human","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hola"}}\n');
    expect(tickUntil(source)).toMatchObject([{ kind: 'events', historical: false }]);
    expect(tickUntil(source)).toEqual([]);
    await source.stop();
    expect(tickUntil(source)).toEqual([]);
  });

  it('fuente en vivo: ignora una sesión demasiado antigua, salvo que se pida por id', async () => {
    session('p', 'antigua', ACTIVE_WINDOW_MS + 60_000);
    const auto = createLiveSource({ root: dir, ...liveOptions });
    expect(tickUntil(auto)).toEqual([]);
    await auto.stop();
    const explicit = createLiveSource({ root: dir, sessionId: 'antigua', ...liveOptions });
    expect(tickUntil(explicit)[0]).toEqual({ kind: 'reset', sessionId: 'antigua' });
    await explicit.stop();
  });

  it('fuente en vivo: cambia a una sesión claramente más reciente, no a una casi simultánea', async () => {
    session('p', 'a', 60_000);
    const source = createLiveSource({ root: dir, ...liveOptions });
    expect(tickUntil(source)[0]).toEqual({ kind: 'reset', sessionId: 'a' });
    session('p', 'casi', 57_000);
    expect(tickUntil(source)).toEqual([]);
    session('p', 'b', 1000);
    expect(tickUntil(source)[0]).toEqual({ kind: 'reset', sessionId: 'b' });
    await source.stop();
  });

  it('fuente en vivo: una sesión pedida por id no cambia a otra', async () => {
    session('p', 'fija', 60_000);
    const source = createLiveSource({ root: dir, sessionId: 'fija', ...liveOptions });
    tickUntil(source);
    session('p', 'otra', 0);
    expect(tickUntil(source)).toEqual([]);
    await source.stop();
  });

  it('fuente en vivo con chokidar: entrega líneas con el reloj real', async () => {
    const path = session('p', 'real');
    const source = createLiveSource({ root: dir, pollMs: 50, discoverMs: 50 });
    const received: SinapsisEvent[] = [];
    const pump = (): void => {
      received.push(...eventsOf(source.tick(Date.now())));
    };
    pump();
    for (let i = 0; i < 5; i += 1) {
      appendFileSync(path, `{"type":"user","turnOrigin":"human","timestamp":"2026-01-01T00:00:0${i}Z","message":{"content":"p${i}"}}\n`);
      await new Promise((r) => setTimeout(r, 70));
      pump();
    }
    await source.stop();
    expect(received.filter((e) => e.type === 'user_prompt').map((e) => (e as { text: string }).text)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });
});

describe('replay con reloj falso', () => {
  const line = (time: string, extra: object = {}): string => JSON.stringify({ type: 'user', turnOrigin: 'human', timestamp: `2026-01-01T00:00:${time}Z`, message: { content: `prompt ${time}` }, ...extra });
  const promptsOf = (updates: SourceUpdate[]): string[] => eventsOf(updates).flatMap((e) => (e.type === 'user_prompt' ? [e.text] : []));
  const timed = (lines: string[]) => arrivalTimes(lines);

  it('respeta el orden y la velocidad', () => {
    const replay = createReplay(timed([line('00'), line('01'), line('03')]), { speed: 2 });
    expect(promptsOf(replay.tick(1000))).toEqual(['prompt 00']);
    expect(promptsOf(replay.tick(1499))).toEqual([]);
    expect(promptsOf(replay.tick(1500))).toEqual(['prompt 01']);
    expect(promptsOf(replay.tick(2499))).toEqual([]);
    expect(replay.finished).toBe(false);
    expect(promptsOf(replay.tick(2500))).toEqual(['prompt 03']);
    expect(replay.finished).toBe(true);
  });

  it('con velocidad 1, en tiempo real', () => {
    const replay = createReplay(timed([line('00'), line('02')]));
    replay.tick(0);
    expect(promptsOf(replay.tick(1999))).toEqual([]);
    expect(promptsOf(replay.tick(2000))).toEqual(['prompt 02']);
  });

  it('pausa y cambio de velocidad a mitad de camino', () => {
    const replay = createReplay(timed([line('00'), line('10')]), { maxGapMs: 60_000 });
    replay.tick(0);
    replay.tick(4000);
    replay.togglePause();
    expect(replay.paused).toBe(true);
    expect(promptsOf(replay.tick(100_000))).toEqual([]);
    replay.togglePause();
    replay.setSpeed(4);
    expect(promptsOf(replay.tick(101_000))).toEqual([]);
    expect(promptsOf(replay.tick(101_500))).toEqual(['prompt 10']);
  });

  it('limita la velocidad', () => {
    const replay = createReplay([]);
    replay.setSpeed(1000);
    expect(replay.speed).toBe(64);
    replay.setSpeed(0.001);
    expect(replay.speed).toBe(0.25);
  });

  it('acorta los tiempos muertos', () => {
    const replay = createReplay(arrivalTimes([line('00'), line('59')]), { maxGapMs: 2000 });
    replay.tick(0);
    expect(promptsOf(replay.tick(1999))).toEqual([]);
    expect(promptsOf(replay.tick(2000))).toEqual(['prompt 59']);
  });

  it('las líneas de un mensaje llegan juntas, a la hora de la última', () => {
    const msg = (time: string, content: object): string => JSON.stringify({ type: 'assistant', timestamp: `2026-01-01T00:00:${time}Z`, message: { id: 'm', model: 'x', content: [content] } });
    const lines = arrivalTimes([line('00'), msg('01', { type: 'server_tool_use', id: 'c', name: 'advisor', input: {} }), msg('30', { type: 'advisor_tool_result', tool_use_id: 'c', content: {} })]);
    expect(lines.map((l) => l.at - (lines[0]?.at ?? 0))).toEqual([0, 30000, 30000]);
    const replay = createReplay(lines, { maxGapMs: 60_000 });
    replay.tick(0);
    expect(eventsOf(replay.tick(29_999)).filter((e) => e.type.startsWith('advisor'))).toEqual([]);
    expect(eventsOf(replay.tick(30_000)).filter((e) => e.type.startsWith('advisor')).map((e) => e.type)).toEqual(['advisor_consult', 'advisor_reply']);
  });

  it('la sesión Haiku reproducida llega al mismo estado que el parser directo', () => {
    const lines = loadTranscript(HAIKU_MAIN);
    const replay = createReplay(lines, { speed: 8 });
    const events: SinapsisEvent[] = [];
    let now = 0;
    while (!replay.finished) {
      events.push(...eventsOf(replay.tick(now)));
      now += 16;
    }
    const parser = createParser();
    const direct = [...haikuLines().values()].flat().flatMap((l) => parser.feed(l.raw, l.agentId ? { agentId: l.agentId } : {}));
    expect(reduce(events)).toEqual(reduce(direct));
    const types = events.map((e) => e.type);
    expect(types.indexOf('advisor_reply')).toBe(types.indexOf('advisor_consult') + 1);
    expect(types.indexOf('subagent_start')).toBeLessThan(types.indexOf('advisor_consult'));
    const times = lines.map((l) => l.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('una sesión sin carpeta de subagentes también carga', () => {
    expect(loadTranscript(OPUS_MAIN)).toHaveLength(readLines(OPUS_MAIN).length);
  });

  it('líneas inválidas no detienen el replay', () => {
    const replay = createReplay(arrivalTimes(['no es json', line('00')]));
    expect(promptsOf(replay.tick(0))).toEqual(['prompt 00']);
  });
});

describe('argumentos', () => {
  it('comandos', () => {
    expect(parseArgs([]).command).toEqual({ kind: 'follow', session: undefined, project: undefined });
    expect(parseArgs(['--session', 'abc']).command).toMatchObject({ kind: 'follow', session: 'abc' });
    expect(parseArgs(['--project', 'c:/x']).command).toMatchObject({ kind: 'follow', project: 'c:/x' });
    expect(parseArgs(['replay', 'a.jsonl', '--speed', '4'])).toMatchObject({ command: { kind: 'replay', file: 'a.jsonl' }, speed: 4 });
    expect(parseArgs(['demo']).command).toEqual({ kind: 'demo' });
    expect(parseArgs(['--help']).command).toEqual({ kind: 'help' });
    expect(parseArgs(['-v']).command).toEqual({ kind: 'version' });
    expect(parseArgs(['demo', '--print-events', '--fps', '30'])).toMatchObject({ printEvents: true, fps: 30 });
  });

  it('errores claros', () => {
    for (const argv of [['--nada'], ['replay'], ['otro'], ['--speed'], ['--speed', '0'], ['--fps', 'x'], ['--session', 'a', '--project', 'b'], ['demo', 'x'], ['replay', 'a', 'b']]) {
      expect(() => parseArgs(argv)).toThrow(ArgsError);
    }
  });
});

describe('formato de eventos', () => {
  it('hora, agente, tipo y detalles', () => {
    const text = formatEvent({ type: 'tool_call', t: Date.parse('2026-01-01T10:20:30.400Z'), agentId: 'abcdefghijkl', id: 'x', name: 'Read', summary: 'a\nb' });
    expect(text).toBe('10:20:30.400 [abcdefgh] tool_call id=x name=Read summary=a b');
    expect(formatEvent({ type: 'turn_end', t: 0 })).toBe('--:--:--.--- turn_end');
    expect(formatEvent({ type: 'user_prompt', t: 0, text: 'x'.repeat(100) }).length).toBeLessThanOrEqual(90);
  });
});
