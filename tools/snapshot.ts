// Renderiza un frame a PNG a través de xterm con JetBrains Mono.
//
// Uso: npx tsx tools/snapshot.ts <salida.png> [--scene mid|end|idle] [--cols N] [--rows N]
//                                [--mode truecolor|256] [--line-height N]

import { renderScene } from '../src/scene/scene.js';
import { encodeFrame } from '../src/tui/ansi.js';
import { CellBuffer } from '../src/tui/buffer.js';
import type { ColorMode } from '../src/tui/color.js';
import { MID_SESSION_MS, fixtureView, idleView } from './lib/fixture-view.js';
import { XtermCapture } from './lib/xterm-capture.js';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] as string) : fallback;
}

const output = process.argv[2];
if (!output || output.startsWith('--')) {
  process.stderr.write('Falta el archivo de salida\n');
  process.exit(1);
}

const cols = Number(option('cols', '90'));
const rows = Number(option('rows', '47'));
const mode = option('mode', 'truecolor') as ColorMode;
const scene = option('scene', 'mid');
const lineHeight = Number(option('line-height', '1.15'));

const view = scene === 'idle' ? idleView() : scene === 'end' ? fixtureView() : fixtureView(MID_SESSION_MS);
const buffer = new CellBuffer(cols, rows);
renderScene(buffer, { ...view, flatBackground: mode === '256' });

const capture = await XtermCapture.open({ cols, rows, lineHeight });
await capture.write(`\x1b[?7l${encodeFrame(null, buffer, mode)}`);
const size = await capture.screenshot(output);
await capture.close();
process.stdout.write(`${output}: ${size.width}x${size.height} (${scene}, ${cols}x${rows}, ${mode})\n`);
