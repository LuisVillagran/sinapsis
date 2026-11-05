#!/usr/bin/env node

// src/cli.ts
import { existsSync, readFileSync as readFileSync2 } from "fs";
import { fileURLToPath } from "url";

// src/args.ts
var USAGE = `sinapsis: visor animado de consola para el modo advisor de Claude Code

Uso:
  sinapsis                               Sigue la sesi\xF3n activa m\xE1s reciente
  sinapsis --session <id>                Sigue una sesi\xF3n concreta
  sinapsis --project <carpeta>           Sigue la sesi\xF3n m\xE1s reciente de esa carpeta
  sinapsis replay <archivo> [--speed N]  Reproduce un transcript guardado
  sinapsis demo [--speed N]              Reproduce el fixture incluido
  sinapsis --help | --version

Opciones:
  --speed <N>       Velocidad del replay (por defecto 1)
  --fps <N>         Fija los cuadros por segundo (por defecto, adaptativo entre 30 y 60)
  --print-events    Sin interfaz: imprime los eventos, uno por l\xEDnea

Teclas:
  q o Ctrl+C        Salir
  espacio, + y -    En replay: pausa y velocidad
`;
var ArgsError = class extends Error {
};
function parseArgs(argv) {
  let session;
  let project;
  let speed = 1;
  let fps;
  let printEvents2 = false;
  let help = false;
  let version2 = false;
  const positional = [];
  const valueOf = (flag, value) => {
    if (value === void 0 || value.startsWith("--")) throw new ArgsError(`Falta el valor de ${flag}`);
    return value;
  };
  const positiveNumber = (flag, value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new ArgsError(`${flag} debe ser un n\xFAmero positivo: ${value}`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--session":
        session = valueOf(arg, argv[++i]);
        break;
      case "--project":
        project = valueOf(arg, argv[++i]);
        break;
      case "--speed":
        speed = positiveNumber(arg, valueOf(arg, argv[++i]));
        break;
      case "--fps":
        fps = positiveNumber(arg, valueOf(arg, argv[++i]));
        break;
      case "--print-events":
        printEvents2 = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--version":
      case "-v":
        version2 = true;
        break;
      default:
        if (arg.startsWith("-")) throw new ArgsError(`Opci\xF3n desconocida: ${arg}`);
        positional.push(arg);
    }
  }
  const base = { speed, fps, printEvents: printEvents2 };
  if (help) return { ...base, command: { kind: "help" } };
  if (version2) return { ...base, command: { kind: "version" } };
  const [name, ...rest] = positional;
  if (name === "replay") {
    if (!rest[0]) throw new ArgsError("replay necesita un archivo");
    if (rest.length > 1) throw new ArgsError(`Argumento de m\xE1s: ${rest[1]}`);
    return { ...base, command: { kind: "replay", file: rest[0] } };
  }
  if (name === "demo") {
    if (rest.length) throw new ArgsError(`Argumento de m\xE1s: ${rest[0]}`);
    return { ...base, command: { kind: "demo" } };
  }
  if (name) throw new ArgsError(`Comando desconocido: ${name}`);
  if (session && project) throw new ArgsError("Usa --session o --project, no ambos");
  return { ...base, command: { kind: "follow", session, project } };
}

// src/sources/live.ts
import { readdirSync as readdirSync2 } from "fs";
import { dirname, join as join2 } from "path";
import { watch } from "chokidar";

// src/core/parser.ts
var newTurnFacts = () => ({
  consults: 0,
  edited: false,
  errorsSinceConsult: 0,
  subagentResultsSinceConsult: 0
});
function inferConsultReason(turn, stopReason) {
  if (turn.errorsSinceConsult > 0) return "after errors";
  if (turn.subagentResultsSinceConsult > 0) return "after subagents";
  if (stopReason === "end_turn") return "before done";
  if (turn.consults === 0 && !turn.edited) return "before a plan";
  return "check-in";
}
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "NotebookEdit"]);
var SUBAGENT_TOOLS = /* @__PURE__ */ new Set(["Agent", "Task"]);
var SYNTHETIC_MODEL = "<synthetic>";
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var str = (value) => typeof value === "string" ? value : void 0;
var num = (value) => typeof value === "number" ? value : void 0;
var blocksOf = (value) => Array.isArray(value) ? value.filter(isObject) : [];
function firstLineShort(text, max) {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}
var baseName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
function summarizeToolInput(name, input) {
  if (!isObject(input)) return void 0;
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (path) return baseName(path);
  if (SUBAGENT_TOOLS.has(name)) return str(input.description);
  const text = str(input.description) ?? str(input.pattern) ?? str(input.command) ?? str(input.query) ?? str(input.url);
  return text ? firstLineShort(text, 60) : void 0;
}
function realPromptText(line, message) {
  if (line.isMeta || line.isCompactSummary) return void 0;
  const content = message.content;
  let text;
  if (typeof content === "string") text = content;
  else {
    const blocks = blocksOf(content);
    if (blocks.some((b) => b.type === "tool_result")) return void 0;
    text = blocks.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n");
  }
  if (!text?.trim()) return void 0;
  if (!line.turnOrigin && text.trimStart().startsWith("<")) return void 0;
  return text;
}
function resultText(content) {
  if (typeof content === "string") return content;
  const text = blocksOf(content).filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n");
  return text || void 0;
}
var isTerminalStatus = (status) => !/launch|running|started|pending/i.test(status);
function createParser() {
  let invalidLines = 0;
  let mainStarted = false;
  let turn = newTurnFacts();
  const lastTimeBySource = /* @__PURE__ */ new Map();
  const toolNames = /* @__PURE__ */ new Map();
  const consultTimes = /* @__PURE__ */ new Map();
  const advisorSeenByMessage = /* @__PURE__ */ new Map();
  const usageSeen = /* @__PURE__ */ new Map();
  const turnEnded = /* @__PURE__ */ new Set();
  const launches = [];
  const subagents = /* @__PURE__ */ new Map();
  const info = {};
  function sessionInfo(t, fields) {
    const changed = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== void 0 && info[key] !== value) {
        info[key] = value;
        changed[key] = value;
      }
    }
    return Object.keys(changed).length ? [{ type: "session_info", t, ...changed }] : [];
  }
  function subagentRecord(id) {
    let record = subagents.get(id);
    if (!record) {
      record = { id, linked: false, ended: false, started: false, fileSeen: false };
      subagents.set(id, record);
    }
    return record;
  }
  function linkEvent(launch, record, t) {
    launch.subagentId = record.id;
    record.linked = true;
    return {
      type: "subagent_info",
      t,
      subagentId: record.id,
      description: launch.description,
      agentType: launch.agentType,
      toolUseId: launch.toolUseId
    };
  }
  function linkSubagents(t) {
    const events = [];
    const unlinked = () => [...subagents.values()].filter((s) => !s.linked && s.started);
    const pending = () => launches.filter((l) => !l.subagentId);
    const matchers = [
      (s, l) => s.prompt !== void 0 && s.prompt === l.prompt,
      (s, l) => s.prompt !== void 0 && l.prompt !== void 0 && (s.prompt.includes(l.prompt) || l.prompt.includes(s.prompt)),
      (s) => s.prompt === void 0
    ];
    for (const matches of matchers) {
      for (const launch of pending()) {
        const found = unlinked().find((s) => matches(s, launch));
        if (found) events.push(linkEvent(launch, found, t));
      }
    }
    return events;
  }
  function parseAssistant(line, agentId, t) {
    const message = line.message;
    if (!isObject(message)) return [];
    const events = [];
    const model = str(message.model);
    const messageId = str(message.id);
    const stopReason = str(message.stop_reason);
    if (model === SYNTHETIC_MODEL) {
      if (line.isApiErrorMessage) {
        const text = resultText(message.content);
        events.push({ type: "api_error", t, status: num(line.apiErrorStatus), message: text && firstLineShort(text, 120), ...agentId ? { agentId } : {} });
      }
      return events;
    }
    if (!agentId) {
      events.push(...sessionInfo(t, { mainModel: model, advisorModel: str(line.advisorModel), effort: str(line.effort), cwd: str(line.cwd), version: str(line.version) }));
    }
    const usage = isObject(message.usage) ? message.usage : void 0;
    if (messageId && usage) {
      const iterations = blocksOf(usage.iterations);
      const key = JSON.stringify(usage);
      if (usageSeen.get(messageId) !== key) {
        usageSeen.set(messageId, key);
        events.push({
          type: "message_usage",
          t,
          messageId,
          input: num(usage.input_tokens) ?? 0,
          output: num(usage.output_tokens) ?? 0,
          cacheRead: num(usage.cache_read_input_tokens) ?? 0,
          cacheCreation: num(usage.cache_creation_input_tokens) ?? 0,
          hasAdvisor: iterations.some((i) => i.type === "advisor_message"),
          ...agentId ? { agentId } : {}
        });
      }
    }
    for (const block of blocksOf(message.content)) {
      if (block.type === "tool_use") {
        const id = str(block.id) ?? "";
        const name = str(block.name) ?? "unknown";
        toolNames.set(id, name);
        if (!agentId && EDIT_TOOLS.has(name)) turn.edited = true;
        events.push({ type: "tool_call", t, id, name, summary: summarizeToolInput(name, block.input), ...agentId ? { agentId } : {} });
        if (SUBAGENT_TOOLS.has(name) && isObject(block.input)) {
          launches.push({ toolUseId: id, prompt: str(block.input.prompt), description: str(block.input.description), agentType: str(block.input.subagent_type) });
          events.push(...linkSubagents(t));
        }
      } else if (block.type === "server_tool_use" && block.name === "advisor") {
        const id = str(block.id) ?? "";
        consultTimes.set(id, t);
        const reason = inferConsultReason(turn, stopReason);
        turn.consults += 1;
        turn.errorsSinceConsult = 0;
        turn.subagentResultsSinceConsult = 0;
        events.push({ type: "advisor_consult", t, id, messageId, reason, ...agentId ? { agentId } : {} });
      } else if (block.type === "advisor_tool_result") {
        const advisorIterations = blocksOf(usage?.iterations).filter((i) => i.type === "advisor_message");
        const seen = messageId ? advisorSeenByMessage.get(messageId) ?? 0 : 0;
        if (messageId) advisorSeenByMessage.set(messageId, seen + 1);
        const iteration = advisorIterations[seen];
        const id = str(block.tool_use_id) ?? "";
        const startedAt = consultTimes.get(id);
        const resultType = isObject(block.content) ? str(block.content.type) : void 0;
        events.push({
          type: "advisor_reply",
          t,
          id,
          durationMs: startedAt !== void 0 ? t - startedAt : void 0,
          tokensRead: num(iteration?.input_tokens) ?? 0,
          tokensWritten: num(iteration?.output_tokens) ?? 0,
          model: str(iteration?.model),
          resultType,
          isError: resultType !== void 0 && /error/i.test(resultType),
          ...agentId ? { agentId } : {}
        });
      } else if (block.type === "text") {
        const text = str(block.text);
        if (text?.trim()) events.push({ type: "assistant_text", t, text, ...agentId ? { agentId } : {} });
      }
    }
    if (stopReason === "end_turn") {
      if (!agentId) {
        const key = messageId ?? `t${t}`;
        if (!turnEnded.has(key)) {
          turnEnded.add(key);
          events.push({ type: "turn_end", t, messageId });
        }
      } else {
        const text = resultText(message.content);
        const record = subagentRecord(agentId);
        if (text && !record.ended) {
          record.ended = true;
          events.push({ type: "subagent_end", t, subagentId: agentId, status: "completed", summary: text });
        }
      }
    }
    return events;
  }
  function parseUser(line, agentId, t) {
    const message = line.message;
    if (!isObject(message)) return [];
    const events = [];
    const toolUseResult = line.toolUseResult;
    for (const block of blocksOf(message.content)) {
      if (block.type !== "tool_result") continue;
      const id = str(block.tool_use_id) ?? "";
      const isError = block.is_error === true;
      if (!agentId && isError) turn.errorsSinceConsult += 1;
      events.push({ type: "tool_result", t, id, isError, ...agentId ? { agentId } : {} });
      const returnedSubagent = isObject(toolUseResult) && str(toolUseResult.agentId) !== void 0;
      if (returnedSubagent || SUBAGENT_TOOLS.has(toolNames.get(id) ?? "")) {
        if (!agentId && returnedSubagent) turn.subagentResultsSinceConsult += 1;
        events.push(...parseSubagentReturn(id, block, toolUseResult, t));
      }
    }
    if (!agentId && !line.isSidechain) {
      const text = realPromptText(line, message);
      if (text) {
        turn = newTurnFacts();
        events.push({ type: "user_prompt", t, text });
      }
    }
    return events;
  }
  function parseSubagentReturn(toolUseId, block, result, t) {
    const events = [];
    const launch = launches.find((l) => l.toolUseId === toolUseId);
    const totals = isObject(result) ? result : void 0;
    const reportBlocks = blocksOf(totals?.content).filter((b) => b.type === "text");
    const summary = str(reportBlocks[reportBlocks.length - 1]?.text) ?? resultText(block.content);
    const subagentId = str(totals?.agentId);
    if (!subagentId) {
      if (block.is_error === true && launch?.subagentId) {
        const record2 = subagentRecord(launch.subagentId);
        if (!record2.ended) {
          record2.ended = true;
          events.push({ type: "subagent_end", t, subagentId: record2.id, status: "error", summary });
        }
      }
      return events;
    }
    const status = str(totals?.status) ?? (block.is_error === true ? "error" : "completed");
    const record = subagentRecord(subagentId);
    if (!record.started) {
      record.started = true;
      events.push({ type: "subagent_start", t, subagentId });
    }
    if (launch && launch.subagentId !== subagentId) {
      for (const other of launches) if (other.subagentId === subagentId) other.subagentId = void 0;
      events.push(linkEvent(launch, record, t));
    }
    if (!isTerminalStatus(status)) return events;
    if (!record.ended) {
      record.ended = true;
      events.push({ type: "subagent_end", t, subagentId, status, summary });
    }
    events.push({
      type: "subagent_result",
      t,
      subagentId,
      status,
      summary,
      model: str(totals?.resolvedModel),
      durationMs: num(totals?.totalDurationMs),
      totalTokens: num(totals?.totalTokens),
      toolCount: num(totals?.totalToolUseCount)
    });
    return events;
  }
  function parseLine(line, source) {
    const agentId = source.agentId ?? (line.isSidechain === true ? str(line.agentId) : void 0);
    const sourceKey = agentId ?? "main";
    const parsedTime = str(line.timestamp) ? Date.parse(line.timestamp) : Number.NaN;
    const t = Number.isNaN(parsedTime) ? lastTimeBySource.get(sourceKey) ?? 0 : parsedTime;
    lastTimeBySource.set(sourceKey, t);
    const events = [];
    if (!agentId && !mainStarted) {
      mainStarted = true;
      events.push({ type: "session_start", t, sessionId: str(line.sessionId) });
    }
    if (agentId) {
      const record = subagentRecord(agentId);
      const message = isObject(line.message) ? line.message : void 0;
      if (record.prompt === void 0 && line.type === "user" && line.parentUuid === null && typeof message?.content === "string") {
        record.prompt = message.content;
      }
      if (!record.started || !record.fileSeen) {
        record.started = true;
        record.fileSeen = true;
        events.push({ type: "subagent_start", t, subagentId: agentId, model: str(message?.model) });
        events.push(...linkSubagents(t));
      }
    }
    switch (line.type) {
      case "assistant":
        events.push(...parseAssistant(line, agentId, t));
        break;
      case "user":
        events.push(...parseUser(line, agentId, t));
        break;
      case "api-request": {
        const params = isObject(line.params) ? line.params : void 0;
        const output = isObject(params?.output_config) ? params.output_config : void 0;
        const model = str(params?.model);
        const effort = str(output?.effort);
        events.push({ type: "request_start", t, model, effort, ...agentId ? { agentId } : {} });
        if (!agentId) events.push(...sessionInfo(t, { mainModel: model === SYNTHETIC_MODEL ? void 0 : model, effort }));
        break;
      }
      case "mode":
        events.push(...sessionInfo(t, { mode: str(line.mode) }));
        break;
      case "ai-title":
        events.push(...sessionInfo(t, { title: str(line.aiTitle) }));
        break;
      case "last-prompt":
        events.push(...sessionInfo(t, { lastPrompt: str(line.lastPrompt) }));
        break;
      case "attachment": {
        const attachment = isObject(line.attachment) ? line.attachment : void 0;
        if (!agentId && attachment?.type === "advisor_tool") {
          events.push(...sessionInfo(t, { advisorEnabled: attachment.available === true, advisorModel: str(attachment.model) }));
        }
        break;
      }
      case "system":
        if (line.subtype === "compact_boundary" && !agentId) {
          const meta = isObject(line.compactMetadata) ? line.compactMetadata : void 0;
          events.push({ type: "compaction", t, preTokens: num(meta?.preTokens), postTokens: num(meta?.postTokens) });
        }
        break;
      case "cost-state":
        if (!agentId) events.push({ type: "session_end", t, costUSD: num(line.totalCostUSD) });
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
      let line;
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
    }
  };
}

// src/sources/lineTail.ts
import { closeSync, openSync, readSync, statSync } from "fs";
var CHUNK_SIZE = 256 * 1024;
var NEWLINE = 10;
var LineTail = class {
  constructor(path) {
    this.path = path;
  }
  path;
  offset = 0;
  carry = Buffer.alloc(0);
  chunk = Buffer.allocUnsafe(CHUNK_SIZE);
  /** Devuelve las líneas completas escritas desde la última llamada. Si el archivo no existe, ninguna. */
  readNewLines() {
    let size;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.carry = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    let fd;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    const lines = [];
    try {
      for (; ; ) {
        const read = readSync(fd, this.chunk, 0, CHUNK_SIZE, this.offset);
        if (read === 0) break;
        this.offset += read;
        this.consume(this.chunk.subarray(0, read), lines);
      }
    } finally {
      closeSync(fd);
    }
    return lines;
  }
  consume(data, lines) {
    let start = 0;
    for (; ; ) {
      const end = data.indexOf(NEWLINE, start);
      if (end < 0) break;
      const piece = data.subarray(start, end);
      const whole = this.carry.length ? Buffer.concat([this.carry, piece]) : piece;
      this.carry = Buffer.alloc(0);
      const line = whole.toString("utf8").replace(/\r$/, "");
      if (line.trim()) lines.push(line);
      start = end + 1;
    }
    if (start < data.length) {
      const rest = Buffer.from(data.subarray(start));
      this.carry = this.carry.length ? Buffer.concat([this.carry, rest]) : rest;
    }
  }
};

// src/sources/discovery.ts
import { readdirSync, statSync as statSync2 } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
function projectsRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}
var encodeProjectPath = (folder) => resolve(folder).replace(/[^a-zA-Z0-9]/g, "-");
function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function sessionsInProject(projectDir) {
  const sessions = [];
  for (const name of safeList(projectDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(projectDir, name);
    try {
      const stat = statSync2(path);
      if (stat.isFile()) sessions.push({ id: basename(name, ".jsonl"), path, mtimeMs: stat.mtimeMs });
    } catch {
    }
  }
  return sessions;
}
var allSessions = (root) => safeList(root).flatMap((dir) => sessionsInProject(join(root, dir)));
var newest = (sessions) => sessions.reduce((best, s) => !best || s.mtimeMs > best.mtimeMs ? s : best, void 0);
function findSession(query) {
  const root = query.root ?? projectsRoot();
  if (query.sessionId) return allSessions(root).find((s) => s.id === query.sessionId);
  if (query.project) return newest(sessionsInProject(join(root, encodeProjectPath(query.project))));
  return newest(allSessions(root));
}

// src/sources/live.ts
var SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;
var ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1e3;
var SWITCH_MARGIN_MS = 5e3;
var SessionTail = class {
  constructor(mainPath) {
    this.mainPath = mainPath;
    this.mainTail = new LineTail(mainPath);
    this.subagentsDir = join2(mainPath.replace(/\.jsonl$/, ""), "subagents");
  }
  mainPath;
  parser = createParser();
  mainTail;
  subagentTails = /* @__PURE__ */ new Map();
  subagentsDir;
  get watchedDir() {
    return dirname(this.mainPath);
  }
  get invalidLines() {
    return this.parser.invalidLines;
  }
  discoverSubagents() {
    let names;
    try {
      names = readdirSync2(this.subagentsDir);
    } catch {
      return;
    }
    for (const name of names) {
      const agentId = SUBAGENT_FILE.exec(name)?.[1];
      if (agentId && !this.subagentTails.has(agentId)) {
        this.subagentTails.set(agentId, new LineTail(join2(this.subagentsDir, name)));
      }
    }
  }
  /** Eventos de las líneas nuevas de todos los archivos. */
  pump() {
    this.discoverSubagents();
    const events = this.mainTail.readNewLines().flatMap((line) => this.parser.feed(line));
    for (const [agentId, tail] of this.subagentTails) {
      for (const line of tail.readNewLines()) events.push(...this.parser.feed(line, { agentId }));
    }
    return events;
  }
};
function createLiveSource(options) {
  const pollMs = options.pollMs ?? 100;
  const discoverMs = options.discoverMs ?? 1e3;
  const useWatcher = options.useWatcher ?? true;
  let current;
  let watcher;
  let wake = true;
  let nextPollAt = 0;
  let nextDiscoverAt = 0;
  let stopped = false;
  const closeWatcher = () => {
    const closing = watcher?.close() ?? Promise.resolve();
    watcher = void 0;
    return closing;
  };
  function attach(file, updates) {
    void closeWatcher();
    const tail = new SessionTail(file.path);
    current = { file, tail };
    updates.push({ kind: "reset", sessionId: file.id });
    const events = tail.pump();
    if (events.length) updates.push({ kind: "events", events, historical: true });
    if (useWatcher && !stopped) {
      watcher = watch([file.path, file.path.replace(/\.jsonl$/, "")], { ignoreInitial: true, depth: 2 });
      const onChange = () => {
        wake = true;
      };
      watcher.on("add", onChange).on("change", onChange).on("error", () => void 0);
    }
  }
  function pickSession(updates, now) {
    const found = findSession(options);
    if (!found) return;
    if (!current) {
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
      const updates = [];
      if (now >= nextDiscoverAt) {
        nextDiscoverAt = now + discoverMs;
        pickSession(updates, Date.now());
      }
      if (current && (wake || now >= nextPollAt)) {
        wake = false;
        nextPollAt = now + pollMs;
        const events = current.tail.pump();
        if (events.length) updates.push({ kind: "events", events, historical: false });
      }
      return updates;
    },
    async stop() {
      stopped = true;
      await closeWatcher();
    }
  };
}

// src/sources/printEvents.ts
function clock(t) {
  return t > 0 ? new Date(t).toISOString().slice(11, 23) : "--:--:--.---";
}
function formatEvent(event) {
  const { type, t, agentId, ...rest } = event;
  const who = agentId ? `[${agentId.slice(0, 8)}] ` : "";
  const details = Object.entries(rest).filter(([, value]) => value !== void 0).map(([key, value]) => {
    const text = typeof value === "string" ? value.replace(/\s+/g, " ") : String(value);
    return `${key}=${text.length > 60 ? `${text.slice(0, 59)}\u2026` : text}`;
  }).join(" ");
  return `${clock(t)} ${who}${type}${details ? ` ${details}` : ""}`;
}
function printEvents(source, options) {
  let timer;
  let finish = () => void 0;
  const done = new Promise((resolve2) => {
    finish = resolve2;
  });
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = void 0;
    void source.stop().finally(finish);
  };
  const pump = () => {
    for (const update of source.tick(Date.now())) {
      if (update.kind === "reset") options.write(`-- sesi\xF3n ${update.sessionId}
`);
      else for (const event of update.events) options.write(`${formatEvent(event)}${update.historical ? " (historial)" : ""}
`);
    }
    if (options.isDone?.()) stop();
  };
  timer = setInterval(pump, options.intervalMs ?? 50);
  pump();
  return { done, stop };
}

// src/sources/replay.ts
import { readFileSync, readdirSync as readdirSync3 } from "fs";
import { join as join3 } from "path";
function readLines(path) {
  return readFileSync(path, "utf8").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
}
function arrivalTimes(lines, agentId) {
  const parsed = lines.map((raw) => {
    try {
      const line = JSON.parse(raw);
      const time = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
      const messageId = line.type === "assistant" && typeof line.message?.id === "string" ? line.message.id : void 0;
      return { raw, time: Number.isNaN(time) ? void 0 : time, messageId };
    } catch {
      return { raw, time: void 0, messageId: void 0 };
    }
  });
  const lastOfMessage = /* @__PURE__ */ new Map();
  for (const line of parsed) {
    if (line.messageId && line.time !== void 0) {
      lastOfMessage.set(line.messageId, Math.max(lastOfMessage.get(line.messageId) ?? 0, line.time));
    }
  }
  const firstKnown = parsed.find((l) => l.time !== void 0)?.time ?? 0;
  let previous = firstKnown;
  return parsed.map((line) => {
    const at = line.messageId && lastOfMessage.get(line.messageId) || line.time || previous;
    previous = Math.max(previous, at);
    return { at: previous, raw: line.raw, ...agentId ? { agentId } : {} };
  });
}
function loadTranscript(path) {
  const timed = arrivalTimes(readLines(path));
  const subagentsDir = join3(path.replace(/\.jsonl$/, ""), "subagents");
  let names = [];
  try {
    names = readdirSync3(subagentsDir);
  } catch {
  }
  for (const name of names.sort()) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
    if (agentId) timed.push(...arrivalTimes(readLines(join3(subagentsDir, name)), agentId));
  }
  return timed.sort((a, b) => a.at - b.at);
}
var MIN_SPEED = 0.25;
var MAX_SPEED = 64;
function createReplay(lines, options = {}) {
  const maxGapMs = options.maxGapMs ?? 8e3;
  const parser = createParser();
  const steps = [];
  let virtual = 0;
  let previous;
  for (const line of lines) {
    if (previous !== void 0) virtual += Math.min(line.at - previous, maxGapMs);
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
  let lastTick;
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
      if (lastTick !== void 0 && !paused) position += (now - lastTick) * speed;
      lastTick = now;
      const updates = [];
      while (cursor < steps.length && steps[cursor].at <= position) {
        updates.push({ kind: "events", events: steps[cursor].events, historical: false });
        cursor += 1;
      }
      return updates;
    },
    async stop() {
      cursor = steps.length;
    }
  };
}

// src/cli.ts
var assetPath = (relative) => fileURLToPath(new URL(relative, import.meta.url));
function version() {
  const pkg = JSON.parse(readFileSync2(assetPath("../package.json"), "utf8"));
  return pkg.version;
}
function createSource(args) {
  const { command } = args;
  if (command.kind === "follow") return createLiveSource({ sessionId: command.session, project: command.project });
  const file = command.kind === "demo" ? assetPath("../fixtures/sesion-haiku-advisor-opus.jsonl") : command.file;
  if (!existsSync(file)) throw new ArgsError(`No existe el archivo: ${file}`);
  return createReplay(loadTranscript(file), { speed: args.speed });
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (args.command.kind === "version") {
    process.stdout.write(`${version()}
`);
    return;
  }
  const source = createSource(args);
  if (args.printEvents) {
    const replay = args.command.kind === "follow" ? void 0 : source;
    const printing = printEvents(source, {
      write: (text) => process.stdout.write(text),
      isDone: replay ? () => replay.finished : void 0
    });
    process.once("SIGINT", printing.stop);
    process.once("SIGTERM", printing.stop);
    await printing.done;
    return;
  }
  await source.stop();
  process.stderr.write("La interfaz todav\xEDa no est\xE1 disponible. Usa --print-events.\n");
  process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  if (error instanceof ArgsError) process.stderr.write(`
${USAGE}`);
  process.exitCode = 1;
});
