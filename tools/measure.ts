// Mide el bucle real: tiempo por frame, bytes por segundo y CPU en reposo. Solo para desarrollo.
//
// Uso: npx tsx tools/measure.ts [--idle-seconds N]

import { Writable } from 'node:stream';
import { join } from 'node:path';
import { runApp } from '../src/app.js';
import { createLiveSource } from '../src/sources/live.js';
import { createReplay, loadTranscript } from '../src/sources/replay.js';
import type { EventSource } from '../src/sources/types.js';
import type { ReplaySource } from '../src/sources/replay.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'sesion-haiku-advisor-opus.jsonl');

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] as string) : fallback;
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

const sink = (): Writable =>
  new Writable({
    highWaterMark: 1 << 24,
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

async function measureReplay(cols: number, rows: number): Promise<void> {
  const replay: ReplaySource = createReplay(loadTranscript(FIXTURE), { speed: 2 });
  const times: number[] = [];
  let bytes = 0;
  const started = performance.now();
  const app = runApp({
    source: replay,
    replay,
    output: sink(),
    size: () => ({ cols, rows }),
    colorMode: 'truecolor',
    exitWhenDone: true,
    onFrame: (stats) => {
      times.push(stats.computeMs);
      bytes += stats.bytes;
    },
  });
  await app.done;
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(
    `replay ${cols}x${rows}: ${times.length} frames en ${seconds.toFixed(1)} s (${(times.length / seconds).toFixed(0)} fps), ` +
      `frame p50 ${percentile(times, 0.5).toFixed(2)} ms, p95 ${percentile(times, 0.95).toFixed(2)} ms, máx ${Math.max(...times).toFixed(2)} ms, ` +
      `${(bytes / seconds / 1024).toFixed(1)} KB/s\n`,
  );
}

async function measureIdle(label: string, source: EventSource, seconds: number): Promise<void> {
  let bytes = 0;
  let frames = 0;
  const app = runApp({
    source,
    output: sink(),
    size: () => ({ cols: 96, rows: 48 }),
    colorMode: 'truecolor',
    onFrame: (stats) => {
      bytes += stats.bytes;
      frames += 1;
    },
  });
  // El arranque no cuenta como reposo.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  bytes = 0;
  frames = 0;
  const cpu = process.cpuUsage();
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const used = process.cpuUsage(cpu);
  const elapsed = performance.now() - start;
  app.stop();
  await app.done;
  process.stdout.write(
    `reposo ${label}: CPU ${(((used.user + used.system) / 1000 / elapsed) * 100).toFixed(1)} % de un núcleo, ` +
      `${(frames / (elapsed / 1000)).toFixed(1)} frames/s, ${(bytes / (elapsed / 1000) / 1024).toFixed(2)} KB/s\n`,
  );
}

const idleSeconds = Number(option('idle-seconds', '20'));
await measureReplay(96, 48);
await measureReplay(140, 50);
await measureReplay(80, 24);
// Sin sesión: descubre sesiones sobre la carpeta real de transcripts, el peor caso del sondeo.
await measureIdle('sin sesión, buscando en los transcripts reales', createLiveSource({ sessionId: 'no-existe-esta-sesion' }), idleSeconds);
await measureIdle('siguiendo la sesión activa más reciente', createLiveSource({}), idleSeconds);
