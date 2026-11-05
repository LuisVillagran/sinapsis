// Estado de sesión calculado a partir de los eventos. Sin E/S.
//
// `applyEvent` modifica el estado recibido: se llama por cada evento y la escena lee el resultado.
// El estado final no depende del orden en que se intercalen los archivos de una sesión.

import type { ConsultReason, SinapsisEvent } from './events.js';

export interface ToolStat {
  count: number;
  errors: number;
}

export interface ConsultState {
  id: string;
  t: number;
  reason: ConsultReason;
  open: boolean;
  durationMs?: number;
  tokensRead: number;
  tokensWritten: number;
  model?: string;
  resultType?: string;
  isError: boolean;
  /** Primer texto del modelo principal después de la respuesta. No es el consejo, que está cifrado. */
  followUp?: string;
}

export interface SubagentState {
  id: string;
  startedAt: number;
  endedAt?: number;
  description?: string;
  agentType?: string;
  toolUseId?: string;
  model?: string;
  running: boolean;
  status?: string;
  summary?: string;
  /** Solo se infiere del tipo: `Explore` y `Plan`. */
  readOnly: boolean;
  /** Herramientas vistas en su archivo, reemplazado por el total definitivo al volver. */
  toolCount: number;
  errors: number;
  currentTool?: string;
  durationMs?: number;
  totalTokens?: number;
  /** Ya llegaron los totales del proceso principal. */
  finalized: boolean;
}

export type MainStatus = 'idle' | 'working' | 'tool';

export interface SessionState {
  sessionId?: string;
  cwd?: string;
  version?: string;
  mode?: string;
  title?: string;
  lastPrompt?: string;
  mainModel?: string;
  advisorModel?: string;
  advisorEnabled: boolean;
  effort?: string;
  startedAt?: number;
  lastEventAt?: number;
  ended: boolean;
  costUSD?: number;
  status: MainStatus;
  currentTool?: { name: string; summary?: string };
  tools: Record<string, ToolStat>;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
  compactions: number;
  prompts: number;
  turns: number;
  /** Tokens del proceso principal, deduplicados por `message.id`. */
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  messages: number;
  advisor: {
    calls: number;
    tokensRead: number;
    tokensWritten: number;
    /** Mensajes del proceso principal sin iteración de advisor. */
    routineTurns: number;
    consults: ConsultState[];
  };
  subagents: SubagentState[];
}

interface CallRecord {
  name?: string;
  agentId?: string;
  summary?: string;
  error?: boolean;
  counted?: boolean;
  done?: boolean;
}

interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  hasAdvisor: boolean;
}

interface Internals {
  usage: Map<string, UsageRecord>;
  calls: Map<string, CallRecord>;
  /** Herramientas abiertas del proceso principal, en orden de llamada. */
  openMain: string[];
  awaitingFollowUp?: ConsultState;
}

const internals = new WeakMap<SessionState, Internals>();

export function createState(): SessionState {
  const state: SessionState = {
    advisorEnabled: false,
    ended: false,
    status: 'idle',
    tools: {},
    toolCalls: 0,
    toolErrors: 0,
    apiErrors: 0,
    compactions: 0,
    prompts: 0,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    messages: 0,
    advisor: { calls: 0, tokensRead: 0, tokensWritten: 0, routineTurns: 0, consults: [] },
    subagents: [],
  };
  internals.set(state, { usage: new Map(), calls: new Map(), openMain: [] });
  return state;
}

const bySubagentStart = (a: SubagentState, b: SubagentState): number => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

function upsertSubagent(state: SessionState, id: string, t: number): SubagentState {
  let sub = state.subagents.find((s) => s.id === id);
  if (!sub) {
    sub = { id, startedAt: t, running: true, readOnly: false, toolCount: 0, errors: 0, finalized: false };
    state.subagents.push(sub);
    state.subagents.sort(bySubagentStart);
  }
  return sub;
}

function upsertConsult(state: SessionState, id: string, t: number): ConsultState {
  let consult = state.advisor.consults.find((c) => c.id === id);
  if (!consult) {
    consult = { id, t, reason: 'check-in', open: true, tokensRead: 0, tokensWritten: 0, isError: false };
    state.advisor.consults.push(consult);
    state.advisor.consults.sort((a, b) => a.t - b.t);
  }
  return consult;
}

function countToolError(state: SessionState, internal: Internals, id: string): void {
  const call = internal.calls.get(id);
  if (!call?.name || !call.error || call.counted) return;
  call.counted = true;
  (state.tools[call.name] ??= { count: 0, errors: 0 }).errors += 1;
  state.toolErrors += 1;
  if (call.agentId) {
    const sub = state.subagents.find((s) => s.id === call.agentId);
    if (sub) sub.errors += 1;
  }
}

function refreshMainTool(state: SessionState, internal: Internals): void {
  const id = internal.openMain[internal.openMain.length - 1];
  const call = id ? internal.calls.get(id) : undefined;
  if (call?.name) {
    state.currentTool = { name: call.name, summary: call.summary };
    state.status = 'tool';
  } else {
    state.currentTool = undefined;
  }
}

export function applyEvent(state: SessionState, event: SinapsisEvent): void {
  const internal = internals.get(state);
  if (!internal) throw new Error('El estado debe crearse con createState()');

  // Los metadatos llevan la hora de la primera línea que los trae, y esa cambia según el orden de llegada.
  if (event.t > 0 && event.type !== 'session_info') {
    if (state.startedAt === undefined || event.t < state.startedAt) state.startedAt = event.t;
    if (state.lastEventAt === undefined || event.t > state.lastEventAt) state.lastEventAt = event.t;
  }

  switch (event.type) {
    case 'session_start':
      if (event.sessionId) state.sessionId = event.sessionId;
      break;

    case 'session_info': {
      const { type: _type, t: _t, agentId: _agentId, ...fields } = event;
      Object.assign(state, fields);
      break;
    }

    case 'user_prompt':
      state.prompts += 1;
      state.ended = false;
      state.status = 'working';
      break;

    case 'request_start':
      if (event.agentId) {
        if (event.model) upsertSubagent(state, event.agentId, event.t).model ??= event.model;
        break;
      }
      state.ended = false;
      if (internal.openMain.length === 0) state.status = 'working';
      break;

    case 'message_usage': {
      if (event.agentId) break;
      const previous = internal.usage.get(event.messageId);
      if (previous) {
        state.tokens.input -= previous.input;
        state.tokens.output -= previous.output;
        state.tokens.cacheRead -= previous.cacheRead;
        state.tokens.cacheCreation -= previous.cacheCreation;
        if (!previous.hasAdvisor) state.advisor.routineTurns -= 1;
      } else {
        state.messages += 1;
      }
      internal.usage.set(event.messageId, event);
      state.tokens.input += event.input;
      state.tokens.output += event.output;
      state.tokens.cacheRead += event.cacheRead;
      state.tokens.cacheCreation += event.cacheCreation;
      if (!event.hasAdvisor) state.advisor.routineTurns += 1;
      break;
    }

    case 'tool_call': {
      const call = internal.calls.get(event.id) ?? {};
      Object.assign(call, { name: event.name, agentId: event.agentId, summary: event.summary });
      internal.calls.set(event.id, call);
      (state.tools[event.name] ??= { count: 0, errors: 0 }).count += 1;
      state.toolCalls += 1;
      if (event.agentId) {
        const sub = upsertSubagent(state, event.agentId, event.t);
        if (!sub.finalized) sub.toolCount += 1;
        if (!call.done && sub.running) sub.currentTool = event.name;
      } else if (!call.done) {
        internal.openMain.push(event.id);
        refreshMainTool(state, internal);
      }
      countToolError(state, internal, event.id);
      break;
    }

    case 'tool_result': {
      const call = internal.calls.get(event.id) ?? {};
      call.done = true;
      call.error = event.isError;
      call.agentId = call.agentId ?? event.agentId;
      internal.calls.set(event.id, call);
      countToolError(state, internal, event.id);
      if (event.agentId) {
        const sub = state.subagents.find((s) => s.id === event.agentId);
        if (sub && sub.currentTool === call.name) sub.currentTool = undefined;
      } else {
        internal.openMain = internal.openMain.filter((id) => id !== event.id);
        refreshMainTool(state, internal);
        if (internal.openMain.length === 0) state.status = 'working';
      }
      break;
    }

    case 'advisor_consult': {
      const consult = upsertConsult(state, event.id, event.t);
      consult.t = event.t;
      consult.reason = event.reason;
      state.advisor.calls += 1;
      break;
    }

    case 'advisor_reply': {
      const consult = upsertConsult(state, event.id, event.t);
      consult.open = false;
      consult.durationMs = event.durationMs;
      consult.tokensRead = event.tokensRead;
      consult.tokensWritten = event.tokensWritten;
      consult.model = event.model;
      consult.resultType = event.resultType;
      consult.isError = event.isError;
      state.advisor.tokensRead += event.tokensRead;
      state.advisor.tokensWritten += event.tokensWritten;
      if (!event.agentId) internal.awaitingFollowUp = consult;
      break;
    }

    case 'assistant_text':
      if (!event.agentId && internal.awaitingFollowUp) {
        internal.awaitingFollowUp.followUp = event.text;
        internal.awaitingFollowUp = undefined;
      }
      break;

    case 'subagent_start': {
      const sub = upsertSubagent(state, event.subagentId, event.t);
      if (event.t > 0 && event.t < sub.startedAt) {
        sub.startedAt = event.t;
        state.subagents.sort(bySubagentStart);
      }
      if (event.model) sub.model = event.model;
      break;
    }

    case 'subagent_info': {
      const sub = upsertSubagent(state, event.subagentId, event.t);
      if (event.description) sub.description = event.description;
      if (event.toolUseId) sub.toolUseId = event.toolUseId;
      if (event.agentType) {
        sub.agentType = event.agentType;
        sub.readOnly = event.agentType === 'Explore' || event.agentType === 'Plan';
      }
      break;
    }

    case 'subagent_end': {
      const sub = upsertSubagent(state, event.subagentId, event.t);
      sub.running = false;
      sub.currentTool = undefined;
      if (!sub.finalized) {
        sub.endedAt = event.t;
        sub.status = event.status;
        sub.summary = event.summary;
      }
      break;
    }

    case 'subagent_result': {
      const sub = upsertSubagent(state, event.subagentId, event.t);
      sub.running = false;
      sub.currentTool = undefined;
      sub.finalized = true;
      sub.status = event.status;
      sub.endedAt = event.t;
      if (event.summary) sub.summary = event.summary;
      if (event.model) sub.model = event.model;
      if (event.durationMs !== undefined) sub.durationMs = event.durationMs;
      if (event.totalTokens !== undefined) sub.totalTokens = event.totalTokens;
      if (event.toolCount !== undefined) sub.toolCount = event.toolCount;
      break;
    }

    case 'turn_end':
      state.turns += 1;
      internal.openMain = [];
      state.currentTool = undefined;
      state.status = 'idle';
      break;

    case 'api_error':
      state.apiErrors += 1;
      break;

    case 'compaction':
      state.compactions += 1;
      break;

    case 'session_end':
      state.ended = true;
      state.costUSD = event.costUSD;
      state.status = 'idle';
      state.currentTool = undefined;
      internal.openMain = [];
      break;

    default:
      break;
  }
}

export function reduce(events: Iterable<SinapsisEvent>, state: SessionState = createState()): SessionState {
  for (const event of events) applyEvent(state, event);
  return state;
}
