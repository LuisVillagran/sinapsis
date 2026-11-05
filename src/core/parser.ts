// Convierte líneas de transcript en eventos normalizados. Sin E/S.
//
// El formato no está documentado (ver docs/eventos.md): lo desconocido se ignora sin fallar.
// Las líneas de varios archivos llegan intercaladas y un archivo de subagente puede aparecer antes que
// el `tool_use` que lo lanzó, así que todo se enlaza por identificador y nada depende del orden entre archivos.

import type { ConsultReason, MemoryScope, MemoryTouch, SinapsisEvent } from './events.js';

export interface LineSource {
  /** Identificador del subagente, si la línea viene de su archivo. */
  agentId?: string;
}

/** Lo que el parser recuerda de un turno del proceso principal para inferir el motivo de una consulta. */
export interface TurnFacts {
  consults: number;
  edited: boolean;
  errorsSinceConsult: number;
  subagentResultsSinceConsult: number;
}

export const newTurnFacts = (): TurnFacts => ({
  consults: 0,
  edited: false,
  errorsSinceConsult: 0,
  subagentResultsSinceConsult: 0,
});

/** Reglas en orden de prioridad. Solo miran el pasado y el propio mensaje, que ya trae su `stop_reason`. */
export function inferConsultReason(turn: TurnFacts, stopReason: string | undefined): ConsultReason {
  if (turn.errorsSinceConsult > 0) return 'after errors';
  if (turn.subagentResultsSinceConsult > 0) return 'after subagents';
  if (stopReason === 'end_turn') return 'before done';
  if (turn.consults === 0 && !turn.edited) return 'before a plan';
  return 'check-in';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const SYNTHETIC_MODEL = '<synthetic>';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const blocksOf = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

function firstLineShort(text: string, max: number): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Resume la entrada de una herramienta para mostrarla en una línea. */
export function summarizeToolInput(name: string, input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (path) return baseName(path);
  if (SUBAGENT_TOOLS.has(name)) return str(input.description);
  const text = str(input.description) ?? str(input.pattern) ?? str(input.command) ?? str(input.query) ?? str(input.url);
  return text ? firstLineShort(text, 60) : undefined;
}

/**
 * ¿El subagente recibió un índice `MEMORY.md` con notas? Llega en su prompt de sistema, sin usar herramientas.
 * Sin `systemPrompt` (por ejemplo, en un fixture sanitizado) no se sabe. Solo se responde sí o no: el texto no se guarda.
 */
export function memoryIndexedOf(attachment: Record<string, unknown>): boolean | undefined {
  if (!Array.isArray(attachment.systemPrompt)) return undefined;
  const prompt = attachment.systemPrompt.filter((part): part is string => typeof part === 'string').join('\n');
  const heading = '\n## MEMORY.md\n';
  const at = prompt.lastIndexOf(heading);
  if (at < 0) return false;
  const section = prompt.slice(at + heading.length).split(/\n#{1,2} /, 1)[0] as string;
  return section.trim() !== '' && !section.includes('currently empty');
}

/** Clasifica una ruta como archivo de memoria. Las tres formas se observaron en transcripts reales (ver docs/eventos.md). */
export function memoryScopeOf(path: string): MemoryScope | undefined {
  const normal = path.replace(/\\/g, '/').toLowerCase();
  if (normal.includes('/.claude/agent-memory/') || normal.startsWith('.claude/agent-memory/')) return 'agent';
  if (/\/\.claude\/projects\/[^/]+\/memory\//.test(normal)) return 'auto';
  const name = baseName(normal);
  if (name === 'claude.md' || name === 'claude.local.md') return 'project';
  if (name === 'memory.md') return 'auto';
  return undefined;
}

const MEMORY_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const MEMORY_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Lo que una herramienta hizo con un archivo de memoria, si es que tocó alguno. */
export function memoryTouchOf(name: string, input: unknown): MemoryTouch | undefined {
  if (!isObject(input)) return undefined;
  const op = MEMORY_WRITE_TOOLS.has(name) ? 'write' : MEMORY_READ_TOOLS.has(name) ? 'read' : undefined;
  const path = str(input.file_path) ?? str(input.path);
  if (!op || !path) return undefined;
  const scope = memoryScopeOf(path);
  return scope ? { file: baseName(path), scope, op } : undefined;
}

/** Texto de un prompt real del usuario, o `undefined` si la línea es otra cosa. */
function realPromptText(line: Json, message: Json): string | undefined {
  if (line.isMeta || line.isCompactSummary) return undefined;
  const content = message.content;
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else {
    const blocks = blocksOf(content);
    if (blocks.some((b) => b.type === 'tool_result')) return undefined;
    text = blocks.filter((b) => b.type === 'text').map((b) => str(b.text) ?? '').join('\n');
  }
  if (!text?.trim()) return undefined;
  // Las líneas sin `turnOrigin` que empiezan con una etiqueta son comandos locales y su salida.
  if (!line.turnOrigin && text.trimStart().startsWith('<')) return undefined;
  return text;
}

function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  const text = blocksOf(content).filter((b) => b.type === 'text').map((b) => str(b.text) ?? '').join('\n');
  return text || undefined;
}

interface Launch {
  toolUseId: string;
  prompt?: string;
  description?: string;
  agentType?: string;
  subagentId?: string;
}

interface SubagentRecord {
  id: string;
  prompt?: string;
  linked: boolean;
  ended: boolean;
  started: boolean;
  /** Ya llegó alguna línea de su propio archivo. */
  fileSeen: boolean;
  /** Ya se emitió su informe (`SubagentHandback`). */
  handback: boolean;
}

/** Una consulta sin respuesta y lo que gastó de los hechos del turno, para devolverlo si se abandona. */
interface PendingConsult {
  id: string;
  messageId: string;
  t: number;
  reason: ConsultReason;
  errors: number;
  subagentResults: number;
  /** Turno en que se hizo: si ya empezó otro, no hay nada que devolver. */
  turn: TurnFacts;
}

export interface Parser {
  feed(line: string, source?: LineSource): SinapsisEvent[];
  /** Líneas que no eran JSON válido o no eran un objeto. */
  readonly invalidLines: number;
}

// Un subagente que aún no termina puede devolver estos estados al lanzarse en segundo plano.
const isTerminalStatus = (status: string): boolean => !/launch|running|started|pending/i.test(status);

const HANDBACK_TOOL = 'SubagentHandback';
const NOTIFICATION_TAG = '<task-notification>';
/** El aviso no repite el informe cuando este ya se entregó con `SubagentHandback`: ese texto no sirve de resumen. */
const REPORT_DELIVERED = /report was delivered to you as a message/i;

const tagValue = (text: string, tag: string): string | undefined => {
  const value = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text)?.[1]?.trim();
  return value || undefined;
};
const tagNumber = (text: string, tag: string): number | undefined => {
  const raw = tagValue(text, tag);
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) ? value : undefined;
};

export function createParser(): Parser {
  let invalidLines = 0;
  let mainStarted = false;
  let turn = newTurnFacts();

  const lastTimeBySource = new Map<string, number>();
  const toolNames = new Map<string, string>();
  const consultTimes = new Map<string, number>();
  const advisorSeenByMessage = new Map<string, number>();
  /** Consultas sin respuesta por fuente (`main` o el id del subagente). */
  const pendingConsults = new Map<string, PendingConsult[]>();
  /** Mensajes de la API ya vistos por fuente (`fuente|message.id`). */
  const seenMessages = new Set<string>();
  /** Consultas abandonadas: si su resultado llega tarde, la consulta vuelve a existir. */
  const abandonedConsults = new Map<string, PendingConsult>();
  const usageSeen = new Map<string, string>();
  const turnEnded = new Set<string>();
  const launches: Launch[] = [];
  const subagents = new Map<string, SubagentRecord>();
  const info: Record<string, string | boolean | undefined> = {};
  const loadedMemory = new Set<string>();
  /** El adjunto `prompt_snapshot` se repite: solo se avisa si la respuesta cambia. */
  const memoryIndexed = new Map<string, boolean>();
  /** Avisos de tarea ya procesados: el mismo texto llega por varios portadores. */
  const notified = new Set<string>();

  /** El adjunto se repite durante la sesión: solo se avisa de los archivos nuevos. */
  function memoryLoads(attachment: Json, t: number): SinapsisEvent[] {
    const files: Array<{ file: string; scope: MemoryScope }> = [];
    for (const entry of blocksOf(attachment.files)) {
      const path = str(entry.path);
      const scope = path ? memoryScopeOf(path) : undefined;
      if (!path || !scope || loadedMemory.has(path)) continue;
      loadedMemory.add(path);
      files.push({ file: baseName(path), scope });
    }
    return files.length ? [{ type: 'memory_load', t, files }] : [];
  }

  function sessionInfo(t: number, fields: Record<string, string | boolean | undefined>): SinapsisEvent[] {
    const changed: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && info[key] !== value) {
        info[key] = value;
        changed[key] = value;
      }
    }
    return Object.keys(changed).length ? [{ type: 'session_info', t, ...changed }] : [];
  }

  function subagentRecord(id: string): SubagentRecord {
    let record = subagents.get(id);
    if (!record) {
      record = { id, linked: false, ended: false, started: false, fileSeen: false, handback: false };
      subagents.set(id, record);
    }
    return record;
  }

  function linkEvent(launch: Launch, record: SubagentRecord, t: number): SinapsisEvent {
    launch.subagentId = record.id;
    record.linked = true;
    return {
      type: 'subagent_info',
      t,
      subagentId: record.id,
      description: launch.description,
      agentType: launch.agentType,
      toolUseId: launch.toolUseId,
    };
  }

  /**
   * Enlaza lanzamientos y subagentes de forma provisional: por prompt idéntico, por prompt contenido o, si el
   * subagente no trae prompt, en orden de llegada. El enlace definitivo es `toolUseResult.agentId`.
   */
  function linkSubagents(t: number): SinapsisEvent[] {
    const events: SinapsisEvent[] = [];
    const unlinked = (): SubagentRecord[] => [...subagents.values()].filter((s) => !s.linked && s.started);
    const pending = (): Launch[] => launches.filter((l) => !l.subagentId);
    const matchers: Array<(s: SubagentRecord, l: Launch) => boolean> = [
      (s, l) => s.prompt !== undefined && s.prompt === l.prompt,
      (s, l) => s.prompt !== undefined && l.prompt !== undefined && (s.prompt.includes(l.prompt) || l.prompt.includes(s.prompt)),
      (s) => s.prompt === undefined,
    ];
    for (const matches of matchers) {
      for (const launch of pending()) {
        const found = unlinked().find((s) => matches(s, launch));
        if (found) events.push(linkEvent(launch, found, t));
      }
    }
    return events;
  }

  /**
   * Si la fuente siguió con otro mensaje de la API, sus consultas sin respuesta se reintentaron o se perdieron: ya no
   * van a recibirla. Consulta y resultado comparten `message.id`, así que las del mismo mensaje siguen abiertas.
   */
  function abandonStale(sourceKey: string, messageId: string, agentId: string | undefined, t: number): SinapsisEvent[] {
    const pending = pendingConsults.get(sourceKey) ?? [];
    const stale = pending.filter((c) => c.messageId !== messageId);
    if (!stale.length) return [];
    pendingConsults.set(sourceKey, pending.filter((c) => c.messageId === messageId));
    return stale.map((c) => {
      abandonedConsults.set(c.id, c);
      // El reintento debe inferir el mismo motivo: se devuelve lo que la consulta gastó, salvo que ya sea otro turno.
      if (c.turn === turn) {
        turn.consults = Math.max(0, turn.consults - 1);
        turn.errorsSinceConsult += c.errors;
        turn.subagentResultsSinceConsult += c.subagentResults;
      }
      return { type: 'advisor_abandoned', t, id: c.id, ...(agentId ? { agentId } : {}) };
    });
  }

  function parseAssistant(line: Json, agentId: string | undefined, t: number): SinapsisEvent[] {
    const message = line.message;
    if (!isObject(message)) return [];
    const events: SinapsisEvent[] = [];
    const model = str(message.model);
    const messageId = str(message.id);
    const stopReason = str(message.stop_reason);

    if (model === SYNTHETIC_MODEL) {
      // Solo se conserva como error de la API; no es un cambio de modelo ni un mensaje del modelo.
      if (line.isApiErrorMessage) {
        const text = resultText(message.content);
        events.push({ type: 'api_error', t, status: num(line.apiErrorStatus), message: text && firstLineShort(text, 120), ...(agentId ? { agentId } : {}) });
      }
      return events;
    }

    // El mensaje nuevo se procesa después: un reintento dentro de él no se cancela a sí mismo.
    // Solo cuenta un mensaje nuevo: una línea tardía de un mensaje anterior no abandona nada.
    if (messageId && !seenMessages.has(`${agentId ?? 'main'}|${messageId}`)) {
      seenMessages.add(`${agentId ?? 'main'}|${messageId}`);
      events.push(...abandonStale(agentId ?? 'main', messageId, agentId, t));
    }

    if (!agentId) {
      events.push(...sessionInfo(t, { mainModel: model, advisorModel: str(line.advisorModel), effort: str(line.effort), cwd: str(line.cwd), version: str(line.version) }));
    }

    const usage = isObject(message.usage) ? message.usage : undefined;
    if (messageId && usage) {
      const iterations = blocksOf(usage.iterations);
      const key = JSON.stringify(usage);
      if (usageSeen.get(messageId) !== key) {
        usageSeen.set(messageId, key);
        events.push({
          type: 'message_usage',
          t,
          messageId,
          input: num(usage.input_tokens) ?? 0,
          output: num(usage.output_tokens) ?? 0,
          cacheRead: num(usage.cache_read_input_tokens) ?? 0,
          cacheCreation: num(usage.cache_creation_input_tokens) ?? 0,
          hasAdvisor: iterations.some((i) => i.type === 'advisor_message'),
          ...(agentId ? { agentId } : {}),
        });
      }
    }

    for (const block of blocksOf(message.content)) {
      if (block.type === 'tool_use') {
        const id = str(block.id) ?? '';
        const name = str(block.name) ?? 'unknown';
        toolNames.set(id, name);
        if (!agentId && EDIT_TOOLS.has(name)) turn.edited = true;
        const memory = memoryTouchOf(name, block.input);
        events.push({ type: 'tool_call', t, id, name, summary: summarizeToolInput(name, block.input), ...(agentId ? { agentId } : {}), ...(memory ? { memory } : {}) });
        if (SUBAGENT_TOOLS.has(name) && isObject(block.input)) {
          launches.push({ toolUseId: id, prompt: str(block.input.prompt), description: str(block.input.description), agentType: str(block.input.subagent_type) });
          events.push(...linkSubagents(t));
        }
        // Un subagente en segundo plano no termina con `end_turn`: su último mensaje entrega el informe con esta herramienta.
        if (agentId && name === HANDBACK_TOOL && isObject(block.input) && str(block.input.message) !== undefined) {
          const record = subagentRecord(agentId);
          if (!record.handback) {
            record.handback = true;
            record.ended = true;
            events.push({ type: 'subagent_end', t, subagentId: agentId, status: 'completed', summary: str(block.input.message), handback: true });
          }
        }
      } else if (block.type === 'server_tool_use' && block.name === 'advisor') {
        const id = str(block.id) ?? '';
        consultTimes.set(id, t);
        const reason = inferConsultReason(turn, stopReason);
        if (messageId) {
          const list = pendingConsults.get(agentId ?? 'main') ?? [];
          list.push({ id, messageId, t, reason, errors: turn.errorsSinceConsult, subagentResults: turn.subagentResultsSinceConsult, turn });
          pendingConsults.set(agentId ?? 'main', list);
        }
        turn.consults += 1;
        turn.errorsSinceConsult = 0;
        turn.subagentResultsSinceConsult = 0;
        events.push({ type: 'advisor_consult', t, id, messageId, reason, ...(agentId ? { agentId } : {}) });
      } else if (block.type === 'advisor_tool_result') {
        // Cada consulta de un mensaje corresponde a su iteración `advisor_message`, en orden.
        const advisorIterations = blocksOf(usage?.iterations).filter((i) => i.type === 'advisor_message');
        const seen = messageId ? (advisorSeenByMessage.get(messageId) ?? 0) : 0;
        if (messageId) advisorSeenByMessage.set(messageId, seen + 1);
        const iteration = advisorIterations[seen];
        const id = str(block.tool_use_id) ?? '';
        const startedAt = consultTimes.get(id);
        const pending = pendingConsults.get(agentId ?? 'main');
        if (pending) pendingConsults.set(agentId ?? 'main', pending.filter((c) => c.id !== id));
        // Un resultado tardío de una consulta ya abandonada: vuelve a existir, ahora respondida.
        const late = abandonedConsults.get(id);
        if (late) {
          abandonedConsults.delete(id);
          events.push({ type: 'advisor_consult', t: late.t, id, messageId: late.messageId, reason: late.reason, ...(agentId ? { agentId } : {}) });
        }
        const resultType = isObject(block.content) ? str(block.content.type) : undefined;
        events.push({
          type: 'advisor_reply',
          t,
          id,
          durationMs: startedAt !== undefined ? t - startedAt : undefined,
          tokensRead: num(iteration?.input_tokens) ?? 0,
          tokensWritten: num(iteration?.output_tokens) ?? 0,
          model: str(iteration?.model),
          resultType,
          isError: resultType !== undefined && /error/i.test(resultType),
          ...(agentId ? { agentId } : {}),
        });
      } else if (block.type === 'text') {
        const text = str(block.text);
        if (text?.trim()) events.push({ type: 'assistant_text', t, text, ...(agentId ? { agentId } : {}) });
      }
    }

    if (stopReason === 'end_turn') {
      if (!agentId) {
        const key = messageId ?? `t${t}`;
        if (!turnEnded.has(key)) {
          turnEnded.add(key);
          events.push({ type: 'turn_end', t, messageId });
        }
      } else {
        // Un mensaje final se reparte en varias líneas: se espera a la que trae el texto.
        const text = resultText(message.content);
        const record = subagentRecord(agentId);
        if (text && !record.ended) {
          record.ended = true;
          events.push({ type: 'subagent_end', t, subagentId: agentId, status: 'completed', summary: text });
        }
      }
    }
    return events;
  }

  function parseUser(line: Json, agentId: string | undefined, t: number): SinapsisEvent[] {
    const message = line.message;
    if (!isObject(message)) return [];
    const events: SinapsisEvent[] = [];
    const toolUseResult = line.toolUseResult;

    for (const block of blocksOf(message.content)) {
      if (block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id) ?? '';
      const isError = block.is_error === true;
      if (!agentId && isError) turn.errorsSinceConsult += 1;
      events.push({ type: 'tool_result', t, id, isError, ...(agentId ? { agentId } : {}) });

      const returnedSubagent = isObject(toolUseResult) && str(toolUseResult.agentId) !== undefined;
      if (returnedSubagent || SUBAGENT_TOOLS.has(toolNames.get(id) ?? '')) {
        if (!agentId && returnedSubagent) turn.subagentResultsSinceConsult += 1;
        events.push(...parseSubagentReturn(id, block, toolUseResult, t));
      }
    }

    // Solo cuenta si el arnés lo marca: un humano podría escribir un texto que empiece igual.
    const fromHarness = isObject(line.origin) && line.origin.kind === 'task-notification';
    if (!agentId && fromHarness) events.push(...parseNotification(resultText(message.content), t));

    if (!agentId && !line.isSidechain) {
      const text = realPromptText(line, message);
      if (text) {
        turn = newTurnFacts();
        events.push({ type: 'user_prompt', t, text });
      }
    }
    return events;
  }

  function parseSubagentReturn(toolUseId: string, block: Json, result: unknown, t: number): SinapsisEvent[] {
    const events: SinapsisEvent[] = [];
    const launch = launches.find((l) => l.toolUseId === toolUseId);
    const totals = isObject(result) ? result : undefined;
    // El texto del `tool_result` trae envoltorios del arnés; el informe limpio es el último bloque de `content`.
    const reportBlocks = blocksOf(totals?.content).filter((b) => b.type === 'text');
    const summary = str(reportBlocks[reportBlocks.length - 1]?.text) ?? resultText(block.content);
    const subagentId = str(totals?.agentId);

    if (!subagentId) {
      // Sin totales, como en un error antes de lanzar: solo se cierra si ya estaba enlazado.
      if (block.is_error === true && launch?.subagentId) {
        const record = subagentRecord(launch.subagentId);
        if (!record.ended) {
          record.ended = true;
          events.push({ type: 'subagent_end', t, subagentId: record.id, status: 'error', summary });
        }
      }
      return events;
    }

    const status = str(totals?.status) ?? (block.is_error === true ? 'error' : 'completed');
    events.push(
      ...settleSubagent(t, subagentId, launch, status, summary, {
        model: str(totals?.resolvedModel),
        durationMs: num(totals?.totalDurationMs),
        totalTokens: num(totals?.totalTokens),
        toolCount: num(totals?.totalToolUseCount),
      }),
    );
    return events;
  }

  /** Inicio, enlace, fin y totales definitivos de un subagente que el proceso principal da por terminado. */
  function settleSubagent(
    t: number,
    subagentId: string,
    launch: Launch | undefined,
    status: string,
    summary: string | undefined,
    totals: Pick<Extract<SinapsisEvent, { type: 'subagent_result' }>, 'model' | 'durationMs' | 'totalTokens' | 'toolCount'>,
  ): SinapsisEvent[] {
    const events: SinapsisEvent[] = [];
    const record = subagentRecord(subagentId);
    if (!record.started) {
      record.started = true;
      events.push({ type: 'subagent_start', t, subagentId });
    }
    // Enlace definitivo: si el emparejamiento provisional fue otro, este lo corrige.
    if (launch && launch.subagentId !== subagentId) {
      for (const other of launches) if (other.subagentId === subagentId) other.subagentId = undefined;
      events.push(linkEvent(launch, record, t));
    }
    if (!isTerminalStatus(status)) return events;

    if (!record.ended) {
      record.ended = true;
      events.push({ type: 'subagent_end', t, subagentId, status, summary });
    }
    events.push({ type: 'subagent_result', t, subagentId, status, summary, ...totals });
    return events;
  }

  /**
   * Aviso `<task-notification>` que el proceso principal recibe cuando termina un subagente en segundo plano. El mismo
   * texto llega por tres portadores (`queue-operation`, línea de usuario y adjunto `queued_command`): se procesa una vez.
   */
  function parseNotification(text: string | undefined, t: number): SinapsisEvent[] {
    const body = text?.trimStart();
    if (!body?.startsWith(NOTIFICATION_TAG)) return [];
    // Estado e identificadores van antes de `<result>` y el uso después del último `</result>`: el informe podría
    // traer etiquetas parecidas.
    const resultStart = body.indexOf('<result>');
    const resultEnd = body.lastIndexOf('</result>');
    const head = resultStart >= 0 ? body.slice(0, resultStart) : body;
    const tail = resultEnd >= 0 ? body.slice(resultEnd + '</result>'.length) : resultStart >= 0 ? '' : body;
    const report = resultStart >= 0 && resultEnd > resultStart ? body.slice(resultStart + '<result>'.length, resultEnd).trim() : undefined;

    const toolUseId = tagValue(head, 'tool-use-id');
    const launch = launches.find((l) => l.toolUseId === toolUseId);
    // Las tareas de `Bash` en segundo plano también avisan y no son subagentes.
    if (!toolUseId || (!launch && !SUBAGENT_TOOLS.has(toolNames.get(toolUseId) ?? ''))) return [];
    const subagentId = tagValue(head, 'task-id') ?? launch?.subagentId;
    if (!subagentId) return [];
    const status = tagValue(head, 'status') ?? 'completed';
    const key = `${subagentId}|${status}|${tail.trim()}`;
    if (notified.has(key)) return [];
    notified.add(key);

    return settleSubagent(t, subagentId, launch, status, report && !REPORT_DELIVERED.test(report) ? report : undefined, {
      durationMs: tagNumber(tail, 'duration_ms'),
      totalTokens: tagNumber(tail, 'subagent_tokens'),
      toolCount: tagNumber(tail, 'tool_uses'),
    });
  }

  function parseLine(line: Json, source: LineSource): SinapsisEvent[] {
    const agentId = source.agentId ?? (line.isSidechain === true ? str(line.agentId) : undefined);
    const sourceKey = agentId ?? 'main';
    const parsedTime = str(line.timestamp) ? Date.parse(line.timestamp as string) : Number.NaN;
    const t = Number.isNaN(parsedTime) ? (lastTimeBySource.get(sourceKey) ?? 0) : parsedTime;
    lastTimeBySource.set(sourceKey, t);

    const events: SinapsisEvent[] = [];

    if (!agentId && !mainStarted) {
      mainStarted = true;
      events.push({ type: 'session_start', t, sessionId: str(line.sessionId) });
    }
    // La carpeta viene en casi todas las líneas: se toma de la primera que la traiga.
    if (!agentId) events.push(...sessionInfo(t, { cwd: str(line.cwd) }));

    if (agentId) {
      const record = subagentRecord(agentId);
      const message = isObject(line.message) ? line.message : undefined;
      // La primera línea del archivo (`parentUuid: null`) trae el prompt, aunque el subagente ya se conociera.
      if (record.prompt === undefined && line.type === 'user' && line.parentUuid === null && typeof message?.content === 'string') {
        record.prompt = message.content;
      }
      // También si ya se conocía por su resultado: la primera línea de su archivo trae la hora real de inicio.
      if (!record.started || !record.fileSeen) {
        record.started = true;
        record.fileSeen = true;
        events.push({ type: 'subagent_start', t, subagentId: agentId, model: str(message?.model) });
        events.push(...linkSubagents(t));
      }
    }

    switch (line.type) {
      case 'assistant':
        events.push(...parseAssistant(line, agentId, t));
        break;
      case 'user':
        events.push(...parseUser(line, agentId, t));
        break;
      case 'api-request': {
        const params = isObject(line.params) ? line.params : undefined;
        const output = isObject(params?.output_config) ? params.output_config : undefined;
        const model = str(params?.model);
        const effort = str(output?.effort);
        events.push({ type: 'request_start', t, model, effort, ...(agentId ? { agentId } : {}) });
        if (!agentId) events.push(...sessionInfo(t, { mainModel: model === SYNTHETIC_MODEL ? undefined : model, effort }));
        break;
      }
      case 'queue-operation':
        // `remove` repite el texto del aviso: solo cuenta la entrada en la cola.
        if (!agentId && line.operation === 'enqueue') events.push(...parseNotification(str(line.content), t));
        break;
      case 'mode':
        events.push(...sessionInfo(t, { mode: str(line.mode) }));
        break;
      case 'ai-title':
        events.push(...sessionInfo(t, { title: str(line.aiTitle) }));
        break;
      case 'last-prompt':
        events.push(...sessionInfo(t, { lastPrompt: str(line.lastPrompt) }));
        break;
      case 'attachment': {
        const attachment = isObject(line.attachment) ? line.attachment : undefined;
        if (!agentId && attachment?.type === 'advisor_tool') {
          events.push(...sessionInfo(t, { advisorEnabled: attachment.available === true, advisorModel: str(attachment.model) }));
        }
        if (!agentId && attachment?.type === 'instructions') events.push(...memoryLoads(attachment, t));
        if (!agentId && attachment?.type === 'queued_command') events.push(...parseNotification(str(attachment.prompt), t));
        if (agentId && attachment?.type === 'prompt_snapshot') {
          const indexed = memoryIndexedOf(attachment);
          if (indexed !== undefined && memoryIndexed.get(agentId) !== indexed) {
            memoryIndexed.set(agentId, indexed);
            events.push({ type: 'subagent_info', t, subagentId: agentId, memoryIndexed: indexed });
          }
        }
        break;
      }
      case 'system':
        if (line.subtype === 'compact_boundary' && !agentId) {
          const meta = isObject(line.compactMetadata) ? line.compactMetadata : undefined;
          events.push({ type: 'compaction', t, preTokens: num(meta?.preTokens), postTokens: num(meta?.postTokens) });
        }
        break;
      case 'cost-state':
        if (!agentId) events.push({ type: 'session_end', t, costUSD: num(line.totalCostUSD) });
        break;
      default:
        break;
    }
    return events;
  }

  return {
    feed(raw, source = {}) {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      let line: unknown;
      try {
        line = JSON.parse(trimmed);
      } catch {
        invalidLines += 1;
        return [];
      }
      if (!isObject(line)) {
        invalidLines += 1;
        return [];
      }
      return parseLine(line, source);
    },
    get invalidLines() {
      return invalidLines;
    },
  };
}
