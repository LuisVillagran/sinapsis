// Seguimiento en vivo de una sesión: su transcript y los archivos de sus subagentes.
//
// `chokidar` avisa al instante, pero no alcanza: en Windows, si el escritor deja el archivo abierto, los
// avisos no llegan hasta que lo cierra (ver docs/eventos.md). Por eso además se sondea con `stat`.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import { createParser, type Parser } from '../core/parser.js';
import { LineTail } from './lineTail.js';
import { type SessionFile, type SessionQuery, findSession } from './discovery.js';
import type { EventSource, SourceUpdate } from './types.js';

const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;

/** Una sesión reciente puede estar esperando al usuario. Más allá de esto, se considera inactiva. */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Otra sesión debe ser así de más reciente para cambiarse a ella: evita saltar entre dos sesiones simultáneas. */
export const SWITCH_MARGIN_MS = 5000;

/** Lee un transcript y sus subagentes, y entrega sus eventos sin duplicar ni perder líneas. */
export class SessionTail {
  private readonly parser: Parser = createParser();
  private readonly mainTail: LineTail;
  private readonly subagentTails = new Map<string, LineTail>();
  private readonly subagentsDir: string;

  constructor(readonly mainPath: string) {
    this.mainTail = new LineTail(mainPath);
    this.subagentsDir = join(mainPath.replace(/\.jsonl$/, ''), 'subagents');
  }

  get watchedDir(): string {
    return dirname(this.mainPath);
  }

  get invalidLines(): number {
    return this.parser.invalidLines;
  }

  private discoverSubagents(): void {
    let names: string[];
    try {
      names = readdirSync(this.subagentsDir);
    } catch {
      return;
    }
    for (const name of names) {
      const agentId = SUBAGENT_FILE.exec(name)?.[1];
      if (agentId && !this.subagentTails.has(agentId)) {
        this.subagentTails.set(agentId, new LineTail(join(this.subagentsDir, name)));
      }
    }
  }

  /** Eventos de las líneas nuevas de todos los archivos. */
  pump(): ReturnType<Parser['feed']> {
    this.discoverSubagents();
    const events = this.mainTail.readNewLines().flatMap((line) => this.parser.feed(line));
    for (const [agentId, tail] of this.subagentTails) {
      for (const line of tail.readNewLines()) events.push(...this.parser.feed(line, { agentId }));
    }
    return events;
  }
}

export interface LiveOptions extends SessionQuery {
  /** Cada cuánto se sondean los archivos abiertos. */
  pollMs?: number;
  /** Cada cuánto se busca una sesión más reciente. */
  discoverMs?: number;
  /** Sin esto no se abre `chokidar`; las pruebas deterministas solo usan el sondeo. */
  useWatcher?: boolean;
}

export function createLiveSource(options: LiveOptions): EventSource {
  const pollMs = options.pollMs ?? 100;
  const discoverMs = options.discoverMs ?? 1000;
  const useWatcher = options.useWatcher ?? true;

  let current: { file: SessionFile; tail: SessionTail } | undefined;
  let watcher: FSWatcher | undefined;
  let wake = true;
  let nextPollAt = 0;
  let nextDiscoverAt = 0;
  let stopped = false;

  const closeWatcher = (): Promise<void> => {
    const closing = watcher?.close() ?? Promise.resolve();
    watcher = undefined;
    return closing;
  };

  function attach(file: SessionFile, updates: SourceUpdate[]): void {
    void closeWatcher();
    const tail = new SessionTail(file.path);
    current = { file, tail };
    updates.push({ kind: 'reset', sessionId: file.id });
    const events = tail.pump();
    if (events.length) updates.push({ kind: 'events', events, historical: true });
    if (useWatcher && !stopped) {
      watcher = watch([file.path, file.path.replace(/\.jsonl$/, '')], { ignoreInitial: true, depth: 2 });
      const onChange = (): void => {
        wake = true;
      };
      watcher.on('add', onChange).on('change', onChange).on('error', () => undefined);
    }
  }

  function pickSession(updates: SourceUpdate[], now: number): void {
    const found = findSession(options);
    if (!found) return;
    if (!current) {
      // Una sesión pedida por id se sigue siempre; la automática, solo si sigue viva.
      const isExplicit = Boolean(options.sessionId);
      if (isExplicit || now - found.mtimeMs <= ACTIVE_WINDOW_MS) attach(found, updates);
      return;
    }
    if (options.sessionId || found.id === current.file.id) {
      current.file = found.id === current.file.id ? found : current.file;
      return;
    }
    if (found.mtimeMs > current.file.mtimeMs + SWITCH_MARGIN_MS) attach(found, updates);
  }

  return {
    tick(now) {
      if (stopped) return [];
      const updates: SourceUpdate[] = [];
      if (now >= nextDiscoverAt) {
        nextDiscoverAt = now + discoverMs;
        pickSession(updates, Date.now());
      }
      if (current && (wake || now >= nextPollAt)) {
        wake = false;
        nextPollAt = now + pollMs;
        const events = current.tail.pump();
        if (events.length) updates.push({ kind: 'events', events, historical: false });
      }
      return updates;
    },
    async stop() {
      stopped = true;
      await closeWatcher();
    },
  };
}
