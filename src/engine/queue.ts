// Cola de animación: decide cuándo se muestra cada evento.
//
// Los eventos llegan en lotes, a veces con minutos de retraso. Aquí se reparten en el tiempo. Ningún evento se
// descarta: agrupar solo une la animación, y todos los eventos del grupo se aplican igual.

import type { LogKind } from '../core/describe.js';
import type { SinapsisEvent } from '../core/events.js';

export type ItemKind = 'instant' | 'tool' | 'memory' | 'advisor' | 'advisor-reply' | 'subagent-start' | 'subagent-end' | 'error' | 'note';

export interface QueueItem {
  kind: ItemKind;
  /** Se aplican al estado visible cuando el elemento empieza. */
  events: SinapsisEvent[];
  /** Se aplican cuando termina. Una consulta deja aquí su respuesta. */
  endEvents: SinapsisEvent[];
}

export interface ActiveItem {
  item: QueueItem;
  start: number;
  duration: number;
}

export type QueueStep = { phase: 'start'; active: ActiveItem } | { phase: 'end'; active: ActiveItem };

/** Duración sin carga, en ms. */
const BASE: Record<ItemKind, number> = {
  instant: 0,
  tool: 450,
  memory: 800,
  advisor: 1000,
  'advisor-reply': 900,
  'subagent-start': 800,
  'subagent-end': 900,
  error: 650,
  note: 350,
};

/** Mínimo con la cola llena. Lo importante nunca baja de una duración que se alcance a ver. */
const MINIMUM: Record<ItemKind, number> = {
  instant: 0,
  tool: 120,
  memory: 300,
  // Consulta y respuesta separadas suman el mínimo acordado de 1,5 s.
  advisor: 1000,
  'advisor-reply': 500,
  'subagent-start': 350,
  'subagent-end': 400,
  error: 350,
  note: 120,
};

export const ADVISOR_MIN_MS = 1500;
export const ADVISOR_MAX_MS = 5000;
/** Duración real desde la que una consulta usa la animación más larga. */
const ADVISOR_LONG_MS = 180_000;

/** Comprime la duración real de una consulta: 19 s duran poco más de 2 s y 3 minutos duran 5 s. */
export function advisorDuration(realMs: number | undefined): number {
  const ratio = Math.min(1, Math.max(0, realMs ?? 0) / ADVISOR_LONG_MS);
  return ADVISOR_MIN_MS + (ADVISOR_MAX_MS - ADVISOR_MIN_MS) * Math.sqrt(ratio);
}

/** Con pocos elementos no hay prisa. Después, cada uno en espera acorta al siguiente. */
export function loadScale(pending: number): number {
  return pending <= 3 ? 1 : 1 / (1 + (pending - 3) * 0.12);
}

const GROUP_FROM = 8;
const GROUP_MAX_EVENTS = 40;

function classify(event: SinapsisEvent, known: Set<string>, ended: Set<string>): ItemKind {
  switch (event.type) {
    case 'tool_call':
      return event.memory ? 'memory' : 'tool';
    case 'memory_load':
      return 'memory';
    case 'tool_result':
      return event.isError ? 'error' : 'instant';
    case 'advisor_consult':
      return 'advisor';
    case 'advisor_reply':
      return 'advisor-reply';
    case 'advisor_abandoned':
      // Retira la consulta sin animación: el estado se corrige, pero no hay viaje que mostrar.
      return 'instant';
    case 'subagent_start':
      if (known.has(event.subagentId)) return 'instant';
      known.add(event.subagentId);
      return 'subagent-start';
    case 'subagent_end':
      // Un segundo fin (el informe llega por otro archivo que el aviso) solo completa datos: no se anima otra vez.
      if (ended.has(event.subagentId)) return 'instant';
      ended.add(event.subagentId);
      return 'subagent-end';
    case 'api_error':
      return 'error';
    case 'user_prompt':
    case 'turn_end':
    case 'session_end':
    case 'compaction':
      return 'note';
    default:
      return 'instant';
  }
}

/**
 * Eventos que no dependen del orden frente a una respuesta del advisor. Incluye el fin de turno: `end_turn` viene
 * en todas las líneas del mensaje, así que aparece antes de la respuesta aunque el turno termine después de ella.
 */
const isNeutral = (item: QueueItem): boolean => item.events.every((e) => e.type === 'message_usage' || e.type === 'session_info' || e.type === 'request_start' || e.type === 'turn_end');

const KIND_COLOR: Record<ItemKind, LogKind> = {
  instant: 'tool',
  tool: 'tool',
  memory: 'memory',
  advisor: 'advisor',
  'advisor-reply': 'advisor',
  'subagent-start': 'sub',
  'subagent-end': 'sub',
  error: 'error',
  note: 'main',
};

export class AnimationQueue {
  private items: QueueItem[] = [];
  private current: ActiveItem | undefined;
  private clockEnd: number | undefined;
  private readonly knownSubagents = new Set<string>();
  private readonly endedSubagents = new Set<string>();

  get active(): ActiveItem | undefined {
    return this.current;
  }

  /** Elementos visibles que aún no empiezan. */
  get pending(): number {
    return this.items.reduce((sum, item) => sum + (item.kind === 'instant' ? 0 : 1), 0);
  }

  get pendingKinds(): LogKind[] {
    return this.items.filter((item) => item.kind !== 'instant').map((item) => KIND_COLOR[item.kind]);
  }

  get isEmpty(): boolean {
    return this.items.length === 0 && !this.current;
  }

  /** Registra un subagente ya visto, para que un inicio repetido no se anime. */
  markKnown(subagentId: string): void {
    this.knownSubagents.add(subagentId);
  }

  /** Registra un fin ya visto, para que un segundo fin del mismo subagente no se anime. */
  markEnded(subagentId: string): void {
    this.endedSubagents.add(subagentId);
  }

  push(events: SinapsisEvent[]): void {
    for (const event of events) {
      const kind = classify(event, this.knownSubagents, this.endedSubagents);
      if (event.type === 'advisor_abandoned') this.skipPendingConsult(event.id);
      if (kind === 'advisor-reply' && event.type === 'advisor_reply' && this.attachReply(event)) continue;
      this.items.push({ kind, events: [event], endEvents: [] });
    }
  }

  /**
   * Una consulta que nunca tuvo respuesta y aún no empieza no se anima: no hay viaje de vuelta que mostrar. Sus eventos
   * se aplican igual, en su lugar. Si ya está en curso, termina de forma normal.
   */
  private skipPendingConsult(id: string): void {
    const item = this.items.find((i) => i.kind === 'advisor' && i.endEvents.length === 0 && i.events[0]?.type === 'advisor_consult' && i.events[0].id === id);
    if (item) item.kind = 'instant';
  }

  /** Une la respuesta a su consulta si sigue en espera y no hay nada relevante entre ambas. */
  private attachReply(reply: Extract<SinapsisEvent, { type: 'advisor_reply' }>): boolean {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i] as QueueItem;
      if (isNeutral(item)) continue;
      const consult = item.events[0];
      if (item.kind === 'advisor' && consult?.type === 'advisor_consult' && consult.id === reply.id && item.endEvents.length === 0) {
        item.endEvents.push(reply);
        return true;
      }
      return false;
    }
    return false;
  }

  private durationOf(item: QueueItem): number {
    if (item.kind === 'advisor') {
      const reply = item.endEvents[0];
      // Solo con su respuesta se conoce la duración real, y siempre dura al menos el mínimo acordado.
      if (reply?.type === 'advisor_reply') return advisorDuration(reply.durationMs);
    }
    return Math.max(MINIMUM[item.kind], BASE[item.kind] * loadScale(this.pending));
  }

  /** Une herramientas consecutivas cuando la cola está larga. Sus eventos se aplican todos. */
  private absorbTools(item: QueueItem): void {
    if (item.kind !== 'tool' || this.pending < GROUP_FROM) return;
    while (item.events.length < GROUP_MAX_EVENTS) {
      const next = this.items[0];
      if (!next || (next.kind !== 'tool' && next.kind !== 'instant')) break;
      item.events.push(...next.events);
      this.items.shift();
    }
  }

  /** Avanza la cola hasta `now` y devuelve lo que empezó y terminó, en orden. */
  update(now: number): QueueStep[] {
    const steps: QueueStep[] = [];
    for (;;) {
      if (this.current) {
        const end = this.current.start + this.current.duration;
        if (now < end) break;
        steps.push({ phase: 'end', active: this.current });
        this.current = undefined;
        this.clockEnd = end;
      }
      const item = this.items.shift();
      if (!item) break;
      this.absorbTools(item);
      // Sigue justo donde terminó el anterior, aunque el frame llegue tarde; tras una pausa, desde ahora.
      const start = this.clockEnd !== undefined && now - this.clockEnd < 250 ? this.clockEnd : now;
      const active: ActiveItem = { item, start, duration: this.durationOf(item) };
      this.current = active;
      this.clockEnd = start;
      steps.push({ phase: 'start', active });
    }
    return steps;
  }

  clear(): void {
    this.items = [];
    this.current = undefined;
    this.clockEnd = undefined;
    this.knownSubagents.clear();
    this.endedSubagents.clear();
  }
}
