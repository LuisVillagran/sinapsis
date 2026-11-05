// Valores que se acercan a su objetivo con el tiempo, como contadores y barras.

import { type Easing, easeOutCubic, progress } from './easing.js';

interface Tween {
  from: number;
  to: number;
  start: number;
  duration: number;
  ease: Easing;
}

export class TweenSet {
  private readonly tweens = new Map<string, Tween>();

  /**
   * Valor actual de `key`, que persigue `target`. Si el objetivo cambia, sigue desde donde iba.
   * Un valor nuevo empieza en `initial`.
   */
  track(key: string, target: number, now: number, duration: number, initial = 0, ease: Easing = easeOutCubic): number {
    let tween = this.tweens.get(key);
    if (!tween) {
      tween = { from: initial, to: target, start: now, duration, ease };
      this.tweens.set(key, tween);
    } else if (tween.to !== target) {
      tween.from = this.valueOf(tween, now);
      tween.to = target;
      tween.start = now;
      tween.duration = duration;
    }
    return this.valueOf(tween, now);
  }

  private valueOf(tween: Tween, now: number): number {
    return tween.from + (tween.to - tween.from) * tween.ease(progress(now, tween.start, tween.duration));
  }

  /** Lleva un valor a su objetivo sin animarlo. */
  settle(key: string, target: number): void {
    this.tweens.set(key, { from: target, to: target, start: 0, duration: 0, ease: easeOutCubic });
  }

  /** Si algún valor sigue moviéndose. */
  isActive(now: number): boolean {
    for (const tween of this.tweens.values()) {
      if (tween.from !== tween.to && now < tween.start + tween.duration) return true;
    }
    return false;
  }

  clear(): void {
    this.tweens.clear();
  }
}
