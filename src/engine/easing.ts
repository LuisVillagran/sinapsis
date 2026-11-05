// Curvas de animación. Reciben y devuelven valores en [0, 1].

export type Easing = (t: number) => number;

export const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

export const linear: Easing = (t) => clamp01(t);
export const easeOutCubic: Easing = (t) => 1 - (1 - clamp01(t)) ** 3;
export const easeInCubic: Easing = (t) => clamp01(t) ** 3;
export const easeInOutCubic: Easing = (t) => {
  const k = clamp01(t);
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
};

/** Avance de una animación en `now`. Con duración 0, ya terminó. */
export function progress(now: number, start: number, duration: number): number {
  return duration <= 0 ? 1 : clamp01((now - start) / duration);
}

/** Tramo de un avance: 0 antes de `from`, 1 después de `to`. */
export function segment(t: number, from: number, to: number): number {
  return to <= from ? (t >= to ? 1 : 0) : clamp01((t - from) / (to - from));
}
