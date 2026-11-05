// Graba la demo como GIF, con los bytes reales de la aplicación pasados por xterm. Solo para desarrollo.
//
// Uso: npx tsx tools/gif.ts <salida.gif> [--speed N] [--fps N]

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { Director } from '../src/engine/director.js';
import { renderScene } from '../src/scene/scene.js';
import { createReplay, loadTranscript } from '../src/sources/replay.js';
import { encodeFrame } from '../src/tui/ansi.js';
import { CellBuffer } from '../src/tui/buffer.js';
import { XtermCapture } from './lib/xterm-capture.js';

// `gifenc` es CommonJS y su salida no se puede importar por nombre desde un módulo ES.
const { GIFEncoder, applyPalette, quantize } = createRequire(import.meta.url)('gifenc') as typeof import('gifenc');

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] as string) : fallback;
}

const output = process.argv[2] as string;
const speed = Number(option('speed', '3'));
const fps = Number(option('fps', '12'));
const COLS = 96;
const ROWS = 48;
const TAIL_MS = 1500;
const MAX_MS = 60_000;

const director = new Director({ boot: true });
const replay = createReplay(loadTranscript(join(import.meta.dirname, '..', 'fixtures', 'sesion-haiku-advisor-opus.jsonl')), { speed });
const capture = await XtermCapture.open({ cols: COLS, rows: ROWS, fontSize: 13, lineHeight: 1 });
await capture.write('\x1b[?7l');

const shots: Buffer[] = [];
const buffer = new CellBuffer(COLS, ROWS);
let previous: CellBuffer | null = null;
let doneAt: number | undefined;
let now = 0;
const step = 1000 / 60;

for (let t = 0; t < MAX_MS; t += 1000 / fps) {
  for (; now <= t; now += step) {
    for (const update of replay.tick(now)) director.ingest(update, now);
    director.update(now);
  }
  renderScene(buffer, director.view(t, { speed: replay.speed, paused: replay.paused, finished: replay.finished }));
  await capture.write(encodeFrame(previous, buffer, 'truecolor'));
  previous = new CellBuffer(COLS, ROWS);
  previous.copyFrom(buffer);
  shots.push(await capture.frame());
  if (replay.finished && director.settled && !director.isBusy(t)) doneAt ??= t;
  if (doneAt !== undefined && t > doneAt + TAIL_MS) break;
}
await capture.close();

// Una sola paleta para toda la animación, sacada de frames repartidos. El último índice queda para la transparencia.
const first = PNG.sync.read(shots[0] as Buffer);
const { width, height } = first;
const samples = shots.filter((_, i) => i % Math.ceil(shots.length / 12) === 0).map((shot) => PNG.sync.read(shot).data);
const merged = new Uint8Array(samples.reduce((sum, s) => sum + s.length, 0));
let offset = 0;
for (const sample of samples) {
  merged.set(sample, offset);
  offset += sample.length;
}
const palette = quantize(merged, 255, { format: 'rgb565' });
const TRANSPARENT = palette.length;
palette.push([0, 0, 0]);

const gif = GIFEncoder();
const delay = Math.round(1000 / fps);
let last: Uint8Array | undefined;
for (const shot of shots) {
  const { data } = PNG.sync.read(shot);
  const indexed = applyPalette(data, palette.slice(0, TRANSPARENT), 'rgb565');
  // Los píxeles iguales al frame anterior quedan transparentes: es lo que mantiene chico el archivo.
  const frame = Uint8Array.from(indexed);
  if (last) for (let i = 0; i < frame.length; i += 1) if (frame[i] === last[i]) frame[i] = TRANSPARENT;
  gif.writeFrame(frame, width, height, { palette, delay, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
  last = indexed;
}
gif.finish();
writeFileSync(output, gif.bytes());
process.stdout.write(`${output}: ${width}x${height}, ${shots.length} frames, ${(gif.bytes().length / 1024 / 1024).toFixed(1)} MB\n`);
