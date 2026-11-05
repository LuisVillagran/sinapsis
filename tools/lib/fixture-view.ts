// Vistas de la escena con datos reales de la sesión Haiku, en un punto de su llegada real.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LogEntry, describeEvent } from '../../src/core/describe.js';
import { createParser } from '../../src/core/parser.js';
import { applyEvent, createState } from '../../src/core/state.js';
import type { SceneView } from '../../src/scene/view.js';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE = join(ROOT, 'fixtures', 'sesion-haiku-advisor-opus');

const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

/** Vista tras reproducir la llegada real hasta `untilMs` desde el inicio. Sin límite, la sesión completa. */
export function fixtureView(untilMs = Number.POSITIVE_INFINITY, now = 1100): SceneView {
  const order: Array<[string, number, number]> = JSON.parse(readFileSync(join(FIXTURE, 'orden-llegada.json'), 'utf8'));
  const files = new Map<string, string[]>();
  const file = (key: string): string[] => {
    let cached = files.get(key);
    if (!cached) {
      cached = lines(key === 'main' ? `${FIXTURE}.jsonl` : join(FIXTURE, 'subagents', `agent-${key}.jsonl`));
      files.set(key, cached);
    }
    return cached;
  };

  const parser = createParser();
  const state = createState();
  const log: LogEntry[] = [];
  let last: string | undefined;
  for (const [key, index, at] of order) {
    if (at > untilMs) break;
    for (const event of parser.feed(file(key)[index] as string, key === 'main' ? {} : { agentId: key })) {
      applyEvent(state, event);
      const entry = describeEvent(event, state);
      if (entry) {
        log.push(entry);
        last = `${entry.who} · ${entry.text}`;
      }
    }
  }
  return { state, log, now, queue: { last, pending: [] }, connected: true };
}

/** A los 29 s de la llegada: una consulta ya llegó y hay subagentes trabajando. */
export const MID_SESSION_MS = 29_000;

export function idleView(now = 1100): SceneView {
  return { state: createState(), log: [], now, queue: { pending: [] }, connected: false };
}
