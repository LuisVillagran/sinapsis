// Modo sin interfaz: imprime cada evento en una línea.

import type { SinapsisEvent } from '../core/events.js';
import type { EventSource } from './types.js';

function clock(t: number): string {
  return t > 0 ? new Date(t).toISOString().slice(11, 23) : '--:--:--.---';
}

export function formatEvent(event: SinapsisEvent): string {
  const { type, t, agentId, ...rest } = event;
  const who = agentId ? `[${agentId.slice(0, 8)}] ` : '';
  // Los textos largos no aportan a esta vista, y pueden traer varias líneas.
  const details = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value.replace(/\s+/g, ' ') : String(value);
      return `${key}=${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
    })
    .join(' ');
  return `${clock(t)} ${who}${type}${details ? ` ${details}` : ''}`;
}

export interface PrintOptions {
  write: (text: string) => void;
  intervalMs?: number;
  /** Termina cuando esto devuelve verdadero. Sin esto, sigue hasta que se detenga. */
  isDone?: () => boolean;
}

export function printEvents(source: EventSource, options: PrintOptions): { done: Promise<void>; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    void source.stop().finally(finish);
  };
  const pump = (): void => {
    for (const update of source.tick(Date.now())) {
      if (update.kind === 'reset') options.write(`-- sesión ${update.sessionId}\n`);
      else for (const event of update.events) options.write(`${formatEvent(event)}${update.historical ? ' (historial)' : ''}\n`);
    }
    if (options.isDone?.()) stop();
  };
  timer = setInterval(pump, options.intervalMs ?? 50);
  pump();
  return { done, stop };
}
