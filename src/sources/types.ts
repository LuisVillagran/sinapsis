import type { SinapsisEvent } from '../core/events.js';

export type SourceUpdate =
  /** `historical`: ya había ocurrido al empezar a seguir la sesión y no se anima. */
  | { kind: 'events'; events: SinapsisEvent[]; historical: boolean }
  /** Empieza otra sesión: el estado se reinicia. */
  | { kind: 'reset'; sessionId: string };

/** La interfaz pide las novedades una vez por frame, así que el tiempo siempre lo pone quien llama. */
export interface EventSource {
  tick(now: number): SourceUpdate[];
  stop(): Promise<void>;
}
