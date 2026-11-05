// Muestrea colores de las imágenes de referencia, que no se publican. Solo para desarrollo.
//
// Uso: npx tsx tools/sample-colors.ts
//
// Son fotos JPEG de una pantalla: el borde de un panel ocupa un píxel y se mezcla con el fondo. Por eso los colores
// sólidos salen de un promedio y los trazos finos, del píxel más saturado de una ventana pequeña.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const IMAGE = join(import.meta.dirname, '..', 'referencia', 'Referencia (1).jpeg');

const SAMPLES: Record<string, [number, number]> = {
  fondo: [120, 1075],
  'fondo, otro lado': [710, 620],
  'barra de ventana': [200, 363],
  'barra de tarjeta': [270, 876],
  'barra de memoria': [460, 637],
  'borde de sesión principal': [450, 546],
  'borde de memoria de agentes': [450, 601],
  'borde de memoria de proyecto': [100, 455],
  'borde de tarjeta': [290, 822],
  'borde del log': [400, 1097],
  'leyenda, principal': [48, 435],
  'leyenda, subagentes': [222, 435],
  'leyenda, memoria': [398, 435],
  'leyenda, notas': [527, 435],
};

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.setContent(`<img id="i" src="data:image/jpeg;base64,${readFileSync(IMAGE).toString('base64')}">`);
await page.waitForFunction(() => document.images[0]?.complete);

const result = await page.evaluate((samples) => {
  const image = document.getElementById('i') as HTMLImageElement;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.drawImage(image, 0, 0);
  const hex = (values: number[]): string => `#${values.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const out: Record<string, { promedio: string; vivo: string }> = {};
  for (const [name, [x, y]] of Object.entries(samples)) {
    const flat = context.getImageData(x - 2, y - 2, 5, 5).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < flat.length; i += 4) for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] as number) + (flat[i + c] as number);
    const area = context.getImageData(x - 4, y - 4, 9, 9).data;
    let vivid = [0, 0, 0];
    let score = -1;
    for (let i = 0; i < area.length; i += 4) {
      const pixel = [area[i] as number, area[i + 1] as number, area[i + 2] as number];
      const value = Math.max(...pixel) - Math.min(...pixel) + Math.max(...pixel) * 0.2;
      if (value > score) {
        score = value;
        vivid = pixel;
      }
    }
    out[name] = { promedio: hex(sum.map((v) => v / (flat.length / 4))), vivo: hex(vivid) };
  }
  return out;
}, SAMPLES);
await browser.close();

for (const [name, { promedio, vivo }] of Object.entries(result)) process.stdout.write(`${name.padEnd(30)} promedio ${promedio}   vivo ${vivo}\n`);
