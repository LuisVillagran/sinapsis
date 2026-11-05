// Reproduce un transcript guardado con el mismo ritmo de lotes que tendría en vivo.
//
// Cada línea de un mensaje se escribió al terminar ese mensaje, no en su `timestamp`. El replay imita eso:
// todas las líneas de un `message.id` llegan juntas, a la hora de la última. Así consulta y respuesta del
// advisor llegan en el mismo lote, igual que en una sesión real.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SinapsisEvent } from '../core/events.js';
import { createParser } from '../core/parser.js';
import type { EventSource, SourceUpdate } from './types.js';

export interface TimedLine {
  at: number;
  raw: string;
  agentId?: string;
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
}

/** Calcula cuándo llegó cada línea de un archivo a disco. Las líneas sin hora heredan la de la anterior. */
export function arrivalTimes(lines: string[], agentId?: string): TimedLine[] {
  const parsed = lines.map((raw) => {
    try {
      const line = JSON.parse(raw) as { timestamp?: unknown; type?: unknown; message?: { id?: unknown } };
      const time = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
      const messageId = line.type === 'assistant' && typeof line.message?.id === 'string' ? line.message.id : undefined;
      return { raw, time: Number.isNaN(time) ? undefined : time, messageId };
    } catch {
      return { raw, time: undefined, messageId: undefined };
    }
  });

  const lastOfMessage = new Map<string, number>();
  for (const line of parsed) {
    if (line.messageId && line.time !== undefined) {
      lastOfMessage.set(line.messageId, Math.max(lastOfMessage.get(line.messageId) ?? 0, line.time));
    }
  }

  const firstKnown = parsed.find((l) => l.time !== undefined)?.time ?? 0;
  let previous = firstKnown;
  return parsed.map((line) => {
    const at = (line.messageId && lastOfMessage.get(line.messageId)) || line.time || previous;
    // Una línea posterior del mismo archivo no puede haber llegado antes que la anterior.
    previous = Math.max(previous, at);
    return { at: previous, raw: line.raw, ...(agentId ? { agentId } : {}) };
  });
}

/** Lee un transcript con sus subagentes, si existen, y mezcla sus líneas en orden de llegada. */
export function loadTranscript(path: string): TimedLine[] {
  const timed = arrivalTimes(readLines(path));
  const subagentsDir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[] = [];
  try {
    names = readdirSync(subagentsDir);
  } catch {
    // Sesión sin subagentes.
  }
  for (const name of names.sort()) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
    if (agentId) timed.push(...arrivalTimes(readLines(join(subagentsDir, name)), agentId));
  }
  // `sort` es estable: dentro de un archivo se conserva el orden.
  return timed.sort((a, b) => a.at - b.at);
}

export interface ReplayOptions {
  speed?: number;
  /** Tiempo muerto máximo entre dos líneas, medido en tiempo de la sesión. */
  maxGapMs?: number;
}

export interface ReplaySource extends EventSource {
  readonly speed: number;
  readonly paused: boolean;
  readonly finished: boolean;
  setSpeed(speed: number): void;
  togglePause(): void;
}

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 64;

interface Step {
  at: number;
  events: SinapsisEvent[];
}

export function createReplay(lines: TimedLine[], options: ReplayOptions = {}): ReplaySource {
  const maxGapMs = options.maxGapMs ?? 8000;
  const parser = createParser();
  const steps: Step[] = [];
  let virtual = 0;
  let previous: number | undefined;

  for (const line of lines) {
    if (previous !== undefined) virtual += Math.min(line.at - previous, maxGapMs);
    previous = line.at;
    const events = parser.feed(line.raw, line.agentId ? { agentId: line.agentId } : {});
    if (!events.length) continue;
    const last = steps[steps.length - 1];
    if (last && last.at === virtual) last.events.push(...events);
    else steps.push({ at: virtual, events });
  }

  let speed = options.speed ?? 1;
  let paused = false;
  let cursor = 0;
  let position = 0;
  let lastTick: number | undefined;

  return {
    get speed() {
      return speed;
    },
    get paused() {
      return paused;
    },
    get finished() {
      return cursor >= steps.length;
    },
    setSpeed(next) {
      speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, next));
    },
    togglePause() {
      paused = !paused;
    },
    tick(now) {
      if (lastTick !== undefined && !paused) position += (now - lastTick) * speed;
      lastTick = now;
      const updates: SourceUpdate[] = [];
      while (cursor < steps.length && (steps[cursor] as Step).at <= position) {
        updates.push({ kind: 'events', events: (steps[cursor] as Step).events, historical: false });
        cursor += 1;
      }
      return updates;
    },
    async stop() {
      cursor = steps.length;
    },
  };
}
