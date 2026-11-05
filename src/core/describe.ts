// Texto para el session log y formatos de datos reales. Sin E/S.

import type { SinapsisEvent } from './events.js';
import type { SessionState } from './state.js';

export type LogKind = 'main' | 'sub' | 'advisor' | 'tool' | 'error';

export interface LogEntry {
  t: number;
  who: string;
  kind: LogKind;
  text: string;
}

/** `claude-haiku-5-5` pasa a `Haiku 5.5`. Un id desconocido se muestra tal cual. */
export function displayModel(id: string | undefined): string {
  if (!id) return '—';
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!match) return id;
  const family = match[1] as string;
  return `${family[0]?.toUpperCase()}${family.slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

/** Nombre corto para reconstruir el comando: `haiku`, `opus`. */
export function modelAlias(id: string | undefined): string {
  if (!id) return '—';
  return /^claude-([a-z]+)-/.exec(id)?.[1] ?? id;
}

export function formatTokens(value: number): string {
  if (value >= 999_500) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 100_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

/** Quita marcas de markdown y saltos de línea para mostrar un texto del modelo en pocas celdas. */
export function plainText(text: string): string {
  return text
    .replace(/…<recortado:\d+>/g, '…')
    .replace(/<\/?[a-z-]+>/gi, ' ')
    .replace(/[*`#>_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nombre de una tarjeta o de una línea del log: la descripción o, si aún no se conoce, el tipo. */
export function subagentName(state: SessionState, id: string): string {
  const sub = state.subagents.find((s) => s.id === id);
  return sub?.description ?? sub?.agentType ?? id.slice(0, 7);
}

function who(state: SessionState, agentId: string | undefined): { who: string; kind: LogKind } {
  if (!agentId) return { who: modelAlias(state.mainModel), kind: 'main' };
  const sub = state.subagents.find((s) => s.id === agentId);
  const short = (sub?.description ?? sub?.agentType ?? agentId.slice(0, 7)).split(/\s+/)[0]?.toLowerCase() ?? '';
  return { who: `${modelAlias(sub?.model ?? state.mainModel)}:${short}`, kind: 'sub' };
}

/** Línea de log para un evento, o `undefined` si no merece una. El estado ya incluye el evento. */
export function describeEvent(event: SinapsisEvent, state: SessionState): LogEntry | undefined {
  const { t } = event;
  const advisor = modelAlias(state.advisorModel);
  switch (event.type) {
    case 'user_prompt':
      return { t, who: 'you', kind: 'main', text: plainText(event.text) };
    case 'tool_call':
      // El resumen es un dato literal, como un patrón `*.jsonl`: no pasa por `plainText`.
      return { t, ...who(state, event.agentId), text: event.summary ? `${event.name} · ${event.summary.replace(/\s+/g, ' ')}` : event.name };
    case 'tool_result':
      if (!event.isError) return undefined;
      return { t, ...who(state, event.agentId), kind: 'error', text: 'tool returned an error' };
    case 'advisor_consult':
      return { t, who: advisor, kind: 'advisor', text: `consulted · ${event.reason} (inferred)` };
    case 'advisor_reply':
      return {
        t,
        who: advisor,
        kind: event.isError ? 'error' : 'advisor',
        text: `${event.isError ? 'failed' : 'sealed reply'} · ${formatDuration(event.durationMs)} · ${formatTokens(event.tokensRead)} read · ${formatTokens(event.tokensWritten)} written`,
      };
    case 'subagent_start':
      return { t, who: `${modelAlias(event.model ?? state.mainModel)}:${event.subagentId.slice(0, 7)}`, kind: 'sub', text: 'subagent started' };
    case 'subagent_info':
      return event.description ? { t, ...who(state, event.subagentId), kind: 'sub', text: `delegated · ${plainText(event.description)}` } : undefined;
    case 'subagent_end':
      return { t, ...who(state, event.subagentId), kind: event.status === 'completed' ? 'sub' : 'error', text: event.status === 'completed' ? 'summary sent back to lead' : `subagent ${event.status}` };
    case 'turn_end':
      return { t, ...who(state, undefined), text: 'turn finished' };
    case 'api_error':
      return { t, who: 'api', kind: 'error', text: `${event.status ?? 'error'}${event.message ? ` · ${plainText(event.message)}` : ''}` };
    case 'compaction':
      return { t, who: 'session', kind: 'tool', text: `context compacted${event.preTokens ? ` · ${formatTokens(event.preTokens)} → ${formatTokens(event.postTokens ?? 0)}` : ''}` };
    case 'session_end':
      return { t, who: 'session', kind: 'tool', text: `ended (inferred)${event.costUSD !== undefined ? ` · $${event.costUSD.toFixed(2)}` : ''}` };
    default:
      return undefined;
  }
}
