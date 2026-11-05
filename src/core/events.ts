// Eventos normalizados: lo único que el resto de la aplicación sabe de los transcripts.

/** Motivo de una consulta. Siempre es inferido: el transcript no lo registra. */
export type ConsultReason = 'after errors' | 'after subagents' | 'before done' | 'before a plan' | 'check-in';

export interface EventBase {
  /** Milisegundos desde la época. Viene del `timestamp` de la línea o de la línea anterior de la misma fuente. */
  t: number;
  /** Presente si el evento ocurrió dentro de un subagente. */
  agentId?: string;
}

export interface SessionStart extends EventBase {
  type: 'session_start';
  sessionId?: string;
}

/** Metadatos que cambian: solo trae los campos nuevos. */
export interface SessionInfo extends EventBase {
  type: 'session_info';
  cwd?: string;
  version?: string;
  mode?: string;
  title?: string;
  lastPrompt?: string;
  mainModel?: string;
  advisorModel?: string;
  advisorEnabled?: boolean;
  effort?: string;
}

export interface UserPrompt extends EventBase {
  type: 'user_prompt';
  text: string;
}

export interface RequestStart extends EventBase {
  type: 'request_start';
  model?: string;
  effort?: string;
}

export interface MessageUsage extends EventBase {
  type: 'message_usage';
  messageId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Si este mensaje incluyó una iteración del advisor. */
  hasAdvisor: boolean;
}

/** De dónde es un archivo de memoria. Se deduce de su ruta. */
export type MemoryScope = 'project' | 'agent' | 'auto';

/** Una herramienta que tocó un archivo de memoria. Es un dato real: sale de su `file_path`. */
export interface MemoryTouch {
  file: string;
  scope: MemoryScope;
  op: 'read' | 'write';
}

export interface ToolCall extends EventBase {
  type: 'tool_call';
  id: string;
  name: string;
  summary?: string;
  /** Presente si la herramienta leyó o escribió un archivo de memoria. */
  memory?: MemoryTouch;
}

/** Archivos de memoria que Claude Code cargó por su cuenta, según el adjunto `instructions`. */
export interface MemoryLoad extends EventBase {
  type: 'memory_load';
  files: Array<{ file: string; scope: MemoryScope }>;
}

export interface ToolResult extends EventBase {
  type: 'tool_result';
  id: string;
  isError: boolean;
}

export interface AdvisorConsult extends EventBase {
  type: 'advisor_consult';
  id: string;
  messageId?: string;
  /** Inferido con reglas. Ver `inferConsultReason`. */
  reason: ConsultReason;
}

export interface AdvisorReply extends EventBase {
  type: 'advisor_reply';
  id: string;
  /** Diferencia real entre los `timestamp` de consulta y respuesta. */
  durationMs?: number;
  tokensRead: number;
  tokensWritten: number;
  model?: string;
  /** `content.type` del resultado; normalmente `advisor_redacted_result`. */
  resultType?: string;
  isError: boolean;
}

/**
 * Una consulta que nunca recibió respuesta: su misma fuente siguió con otro mensaje de la API. Se observó una vez, con
 * un reintento en un mensaje posterior (ver docs/eventos.md).
 */
export interface AdvisorAbandoned extends EventBase {
  type: 'advisor_abandoned';
  id: string;
}

export interface AssistantText extends EventBase {
  type: 'assistant_text';
  text: string;
}

export interface SubagentStart extends EventBase {
  type: 'subagent_start';
  subagentId: string;
  model?: string;
}

/** Nombre y tipo de un subagente, que pueden conocerse después de que empezó. */
export interface SubagentInfo extends EventBase {
  type: 'subagent_info';
  subagentId: string;
  description?: string;
  agentType?: string;
  toolUseId?: string;
}

export interface SubagentEnd extends EventBase {
  type: 'subagent_end';
  subagentId: string;
  status: string;
  summary?: string;
  /**
   * El resumen es el mensaje de `SubagentHandback`, el informe real de un subagente en segundo plano. Prevalece sobre
   * cualquier otro resumen y puede llegar después de que el subagente ya estuviera cerrado.
   */
  handback?: boolean;
}

/** Totales definitivos que el proceso principal recibe al volver un subagente. */
export interface SubagentResult extends EventBase {
  type: 'subagent_result';
  subagentId: string;
  status: string;
  summary?: string;
  model?: string;
  durationMs?: number;
  totalTokens?: number;
  toolCount?: number;
}

export interface TurnEnd extends EventBase {
  type: 'turn_end';
  messageId?: string;
}

/** Error de la API, registrado en una línea con modelo `<synthetic>`. */
export interface ApiError extends EventBase {
  type: 'api_error';
  status?: number;
  message?: string;
}

export interface Compaction extends EventBase {
  type: 'compaction';
  preTokens?: number;
  postTokens?: number;
}

/** Inferido de `cost-state`: una sesión puede reanudarse después. */
export interface SessionEnd extends EventBase {
  type: 'session_end';
  costUSD?: number;
}

export type SinapsisEvent =
  | SessionStart
  | SessionInfo
  | UserPrompt
  | RequestStart
  | MessageUsage
  | ToolCall
  | MemoryLoad
  | ToolResult
  | AdvisorConsult
  | AdvisorReply
  | AdvisorAbandoned
  | AssistantText
  | SubagentStart
  | SubagentInfo
  | SubagentEnd
  | SubagentResult
  | TurnEnd
  | ApiError
  | Compaction
  | SessionEnd;
