// Muestrea la paleta de la imagen de referencia, que es local y no se publica. Solo para desarrollo.
//
// Uso: npx tsx tools/sample-colors.ts
//
// Rellenos: mediana de una zona sin texto. Cuadros de la leyenda: su color sólido.
// Bordes y texto: el píxel más brillante o más saturado de la zona, porque el resto está suavizado.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const png = PNG.sync.read(readFileSync(join(import.meta.dirname, '..', 'referencia', 'diseño.png')));
const { width, data } = png;

type Color = [number, number, number];
const pixel = (x: number, y: number): Color => {
  const i = (y * width + x) * 4;
  return [data[i] as number, data[i + 1] as number, data[i + 2] as number];
};
const hex = (c: Color): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const luma = (c: Color): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const saturation = (c: Color): number => Math.max(...c) - Math.min(...c);

function region(x0: number, y0: number, x1: number, y1: number): Color[] {
  const out: Color[] = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) out.push(pixel(x, y));
  return out;
}

function median(pixels: Color[]): Color {
  const channel = (i: 0 | 1 | 2): number => [...pixels].map((p) => p[i]).sort((a, b) => a - b)[Math.floor(pixels.length / 2)] as number;
  return [channel(0), channel(1), channel(2)];
}
const pick = (pixels: Color[], score: (c: Color) => number): Color => pixels.reduce((best, c) => (score(c) > score(best) ? c : best));
const brightest = (pixels: Color[]): Color => pick(pixels, luma);
const vivid = (pixels: Color[]): Color => pick(pixels, (c) => saturation(c) + luma(c) * 0.3);

const samples: Array<[string, string, Color]> = [
  ['bgEdge', 'mediana, esquina superior izquierda', median(region(4, 80, 12, 110))],
  ['bgEdge (abajo)', 'mediana, esquina inferior derecha', median(region(838, 1000, 848, 1040))],
  ['bgCenter', 'mediana, entre tarjetas', median(region(436, 610, 444, 640))],
  ['panel', 'mediana, interior de la sesión principal', median(region(360, 225, 680, 240))],
  ['panel (tarjeta)', 'mediana, interior de una tarjeta', median(region(260, 612, 295, 628))],
  ['chip', 'mediana, fondo de la línea de estado de la sesión', median(region(365, 225, 380, 228))],
  ['main', 'cuadro sólido de la leyenda', median(region(26, 95, 32, 102))],
  ['advisor', 'cuadro sólido de la leyenda', median(region(426, 95, 432, 102))],
  ['metrics', 'cuadro sólido de la leyenda', median(region(634, 95, 640, 102))],
  ['sub', 'más brillante, borde de tarjeta', brightest(region(242, 590, 248, 610))],
  ['subBright', 'más brillante, borde de back to lead', brightest(region(378, 820, 384, 840))],
  ['barGood', 'más saturado, barra verde', vivid(region(508, 342, 590, 352))],
  ['barAlert', 'más saturado, barra naranja', vivid(region(508, 386, 555, 396))],
  ['barSub', 'más saturado, barra de tarjeta', vivid(region(258, 595, 350, 606))],
  ['barTrack', 'mediana, riel de barra de tarjeta', median(region(362, 596, 376, 604))],
  ['text', 'más brillante, título', brightest(region(150, 52, 330, 70))],
  ['faint', 'más brillante, hora del log', brightest(region(30, 905, 95, 918))],
];

for (const [name, method, color] of samples) process.stdout.write(`${name.padEnd(16)} ${hex(color)}  ${method}\n`);
