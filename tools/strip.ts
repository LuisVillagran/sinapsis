// Tira de frames de una animación: reproduce la sesión con reloj falso y captura varios instantes en un PNG.
//
// Uso: npx tsx tools/strip.ts <salida.png> --times 100,400,800 [--crop x,y,w,h] [--speed N] [--columns N]
//                             [--source haiku|opus|error] [--cols N] [--rows N] [--boot] [--illustrative]
//
// `--times` son ms de animación. `--crop` recorta cada frame, en celdas.

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { Director } from '../src/engine/director.js';
import { renderScene } from '../src/scene/scene.js';
import { createReplay, loadTranscript } from '../src/sources/replay.js';
import { encodeFrame } from '../src/tui/ansi.js';
import { CellBuffer } from '../src/tui/buffer.js';
import { XtermCapture } from './lib/xterm-capture.js';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] as string) : fallback;
}

const output = process.argv[2] as string;
const times = option('times', '0').split(',').map(Number);
const cols = Number(option('cols', '90'));
const rows = Number(option('rows', '47'));
const speed = Number(option('speed', '1'));
const columns = Number(option('columns', String(times.length)));
const [cx, cy, cw, ch] = option('crop', `0,0,${cols},${rows}`).split(',').map(Number) as [number, number, number, number];
const FIXTURE_FILES: Record<string, string> = { haiku: 'sesion-haiku-advisor-opus.jsonl', opus: 'sesion-opus-advisor-opus.jsonl', error: 'sesion-haiku-con-error.jsonl' };
const fixture = FIXTURE_FILES[option('source', 'haiku')] ?? (FIXTURE_FILES.haiku as string);

const director = new Director({ boot: process.argv.includes('--boot'), illustrative: process.argv.includes('--illustrative') });
const replay = createReplay(loadTranscript(join(import.meta.dirname, '..', 'fixtures', fixture)), { speed });
const capture = await XtermCapture.open({ cols, rows, lineHeight: 1.15 });
await capture.write('\x1b[?7l');

const temp = `${output}.frame.png`;
const shots: PNG[] = [];
const buffer = new CellBuffer(cols, rows);
let previous: CellBuffer | null = null;
let now = 0;

for (const target of times) {
  // Avanza a 60 fps, como el bucle real, para que el estado sea el mismo que se vería.
  for (; now <= target; now += 1000 / 60) {
    for (const update of replay.tick(now)) director.ingest(update, now);
    director.update(now);
  }
  renderScene(buffer, director.view(target, { speed: replay.speed, paused: replay.paused, finished: replay.finished }));
  await capture.write(encodeFrame(previous, buffer, 'truecolor'));
  previous = new CellBuffer(cols, rows);
  previous.copyFrom(buffer);
  await capture.screenshot(temp);
  const { readFileSync, rmSync } = await import('node:fs');
  shots.push(PNG.sync.read(readFileSync(temp)));
  rmSync(temp);
}
await capture.close();

const first = shots[0] as PNG;
const cellW = first.width / cols;
const cellH = first.height / rows;
const frameW = Math.round(cw * cellW);
const frameH = Math.round(ch * cellH);
const GAP = 8;
const lines = Math.ceil(shots.length / columns);
const sheet = new PNG({ width: columns * frameW + (columns - 1) * GAP, height: lines * frameH + (lines - 1) * GAP });
sheet.data.fill(0x30);
for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;
shots.forEach((shot, i) => {
  const x = (i % columns) * (frameW + GAP);
  const y = Math.floor(i / columns) * (frameH + GAP);
  PNG.bitblt(shot, sheet, Math.round(cx * cellW), Math.round(cy * cellH), frameW, frameH, x, y);
});
writeFileSync(output, PNG.sync.write(sheet));
process.stdout.write(`${output}: ${sheet.width}x${sheet.height}, ${shots.length} frames en ${times.join(', ')} ms\n`);
