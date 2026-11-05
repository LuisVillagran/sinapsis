// Colores como enteros 0xRRGGBB: sin asignaciones por celda en el bucle de render.

export type Rgb = number;

export const rgb = (hex: string): Rgb => Number.parseInt(hex.replace('#', ''), 16);

const red = (c: Rgb): number => (c >> 16) & 0xff;
const green = (c: Rgb): number => (c >> 8) & 0xff;
const blue = (c: Rgb): number => c & 0xff;

/** Interpola de `a` hacia `b`. `t` fuera de [0, 1] se recorta. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const r = Math.round(red(a) + (red(b) - red(a)) * k);
  const g = Math.round(green(a) + (green(b) - green(a)) * k);
  const bl = Math.round(blue(a) + (blue(b) - blue(a)) * k);
  return (r << 16) | (g << 8) | bl;
}

export type ColorMode = 'truecolor' | '256';

/** `depth` es el resultado de `getColorDepth()` de la salida. Bajo 24 bits se usan 256 colores. */
export function detectColorMode(depth: number): ColorMode {
  return depth >= 24 ? 'truecolor' : '256';
}

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

function nearestStep(value: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_STEPS.length; i += 1) {
    if (Math.abs((CUBE_STEPS[i] as number) - value) < Math.abs((CUBE_STEPS[best] as number) - value)) best = i;
  }
  return best;
}

const cache256 = new Map<Rgb, number>();

/** Color más cercano de la paleta de 256: el cubo de 6x6x6 o la rampa de grises. */
export function to256(c: Rgb): number {
  const cached = cache256.get(c);
  if (cached !== undefined) return cached;
  const r = red(c);
  const g = green(c);
  const b = blue(c);
  const ri = nearestStep(r);
  const gi = nearestStep(g);
  const bi = nearestStep(b);
  const cubeR = CUBE_STEPS[ri] as number;
  const cubeG = CUBE_STEPS[gi] as number;
  const cubeB = CUBE_STEPS[bi] as number;
  const cubeDistance = (r - cubeR) ** 2 + (g - cubeG) ** 2 + (b - cubeB) ** 2;
  const grayIndex = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + grayIndex * 10;
  const grayDistance = (r - gray) ** 2 + (g - gray) ** 2 + (b - gray) ** 2;
  const result = grayDistance < cubeDistance ? 232 + grayIndex : 16 + 36 * ri + 6 * gi + bi;
  cache256.set(c, result);
  return result;
}
