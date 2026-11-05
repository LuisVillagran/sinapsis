#!/usr/bin/env node

// src/cli.ts
import { existsSync, readFileSync as readFileSync2 } from "fs";
import { fileURLToPath } from "url";

// src/core/describe.ts
function displayModel(id) {
  if (!id) return "\u2014";
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!match) return id;
  const family = match[1];
  return `${family[0]?.toUpperCase()}${family.slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}
function modelAlias(id) {
  if (!id) return "\u2014";
  return /^claude-([a-z]+)-/.exec(id)?.[1] ?? id;
}
function formatTokens(value) {
  if (value >= 999500) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e5) return `${Math.round(value / 1e3)}k`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}
function formatDuration(ms) {
  if (ms === void 0) return "\u2014";
  if (ms < 1e4) return `${(ms / 1e3).toFixed(1)} s`;
  return `${Math.round(ms / 1e3)} s`;
}
function plainText(text) {
  return text.replace(/…<recortado:\d+>/g, "\u2026").replace(/<\/?[a-z-]+>/gi, " ").replace(/[*`#>_]+/g, "").replace(/\s+/g, " ").trim();
}
function subagentName(state, id) {
  const sub = state.subagents.find((s) => s.id === id);
  return sub?.description ?? sub?.agentType ?? id.slice(0, 7);
}
function agentLabel(state, id) {
  const sub = state.subagents.find((s) => s.id === id);
  return (sub?.agentType ?? sub?.description?.split(/\s+/)[0] ?? id.slice(0, 7)).toLowerCase();
}
function who(state, agentId) {
  if (!agentId) return { who: displayModel(state.mainModel), kind: "main" };
  return { who: agentLabel(state, agentId), kind: "sub" };
}
function describeEvent(event, state) {
  const { t } = event;
  const advisor = modelAlias(state.advisorModel);
  switch (event.type) {
    case "user_prompt":
      return { t, who: "you", kind: "main", text: plainText(event.text) };
    case "memory_load":
      return { t, who: "memory", kind: "memory", text: `loaded ${event.files.map((f) => f.file).join(", ")}` };
    case "tool_call":
      if (event.memory) {
        const actor = event.agentId ? `${agentLabel(state, event.agentId)} \xB7 ` : "";
        return { t, who: "memory", kind: "memory", text: `${actor}${event.memory.op === "write" ? "save" : "recall"} ${event.memory.file}` };
      }
      return { t, ...who(state, event.agentId), text: event.summary ? `${event.name} \xB7 ${event.summary.replace(/\s+/g, " ")}` : event.name };
    case "tool_result":
      if (!event.isError) return void 0;
      return { t, ...who(state, event.agentId), kind: "error", text: "tool returned an error" };
    case "advisor_consult":
      return { t, who: advisor, kind: "advisor", text: `consulted \xB7 ${event.reason} (inferred)` };
    case "advisor_reply":
      return {
        t,
        who: advisor,
        kind: event.isError ? "error" : "advisor",
        text: `${event.isError ? "failed" : "sealed reply"} \xB7 ${formatDuration(event.durationMs)} \xB7 ${formatTokens(event.tokensRead)} read \xB7 ${formatTokens(event.tokensWritten)} written`
      };
    case "subagent_start":
      return { t, who: agentLabel(state, event.subagentId), kind: "sub", text: "subagent started" };
    case "subagent_info":
      return event.description ? { t, ...who(state, event.subagentId), kind: "sub", text: `delegated \xB7 ${plainText(event.description)}` } : void 0;
    case "subagent_end":
      return { t, ...who(state, event.subagentId), kind: event.status === "completed" ? "sub" : "error", text: event.status === "completed" ? "summary sent back to lead" : `subagent ${event.status}` };
    case "turn_end":
      return { t, ...who(state, void 0), text: "turn finished" };
    case "api_error":
      return { t, who: "api", kind: "error", text: `${event.status ?? "error"}${event.message ? ` \xB7 ${plainText(event.message)}` : ""}` };
    case "compaction":
      return { t, who: "session", kind: "tool", text: `context compacted${event.preTokens ? ` \xB7 ${formatTokens(event.preTokens)} \u2192 ${formatTokens(event.postTokens ?? 0)}` : ""}` };
    case "session_end":
      return { t, who: "session", kind: "tool", text: `ended (inferred)${event.costUSD !== void 0 ? ` \xB7 $${event.costUSD.toFixed(2)}` : ""}` };
    default:
      return void 0;
  }
}

// src/core/state.ts
function insertSorted(list, value) {
  let i = list.length;
  while (i > 0 && list[i - 1] > value) i -= 1;
  list.splice(i, 0, value);
}
function lastUpTo(list, t) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] <= t) return list[i];
  return void 0;
}
function memoryMilestone(state, touch) {
  const turnStart = lastUpTo(state.promptTimes, touch.t) ?? Number.NEGATIVE_INFINITY;
  const inTurn = (t) => t !== void 0 && t >= turnStart && t < touch.t;
  if (state.errorTimes.some(inTurn)) return 1;
  if (state.subagents.some((s) => inTurn(s.endedAt))) return 2;
  return 0;
}
function memoryLabel(state, touch) {
  if (touch.op === "write") return "save";
  return memoryMilestone(state, touch) === 1 ? "check" : "recall";
}
var internals = /* @__PURE__ */ new WeakMap();
function createState() {
  const state = {
    advisorEnabled: false,
    ended: false,
    status: "idle",
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
    memory: { loaded: [], touches: [] },
    errorTimes: [],
    promptTimes: []
  };
  internals.set(state, { usage: /* @__PURE__ */ new Map(), calls: /* @__PURE__ */ new Map(), openMain: [] });
  return state;
}
var bySubagentStart = (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
function upsertSubagent(state, id, t) {
  let sub = state.subagents.find((s) => s.id === id);
  if (!sub) {
    sub = { id, startedAt: t, running: true, readOnly: false, toolCount: 0, errors: 0, finalized: false };
    state.subagents.push(sub);
    state.subagents.sort(bySubagentStart);
  }
  return sub;
}
function upsertConsult(state, id, t) {
  let consult = state.advisor.consults.find((c) => c.id === id);
  if (!consult) {
    consult = { id, t, reason: "check-in", open: true, tokensRead: 0, tokensWritten: 0, isError: false };
    state.advisor.consults.push(consult);
    state.advisor.consults.sort((a, b) => a.t - b.t);
  }
  return consult;
}
function countToolError(state, internal, id) {
  const call = internal.calls.get(id);
  if (!call?.name || !call.error || call.counted) return;
  call.counted = true;
  (state.tools[call.name] ??= { count: 0, errors: 0 }).errors += 1;
  state.toolErrors += 1;
  if (call.errorAt !== void 0) insertSorted(state.errorTimes, call.errorAt);
  if (call.agentId) {
    const sub = state.subagents.find((s) => s.id === call.agentId);
    if (sub) sub.errors += 1;
  }
}
function refreshMainTool(state, internal) {
  const id = internal.openMain[internal.openMain.length - 1];
  const call = id ? internal.calls.get(id) : void 0;
  if (call?.name) {
    state.currentTool = { name: call.name, summary: call.summary };
    state.status = "tool";
  } else {
    state.currentTool = void 0;
  }
}
function applyEvent(state, event) {
  const internal = internals.get(state);
  if (!internal) throw new Error("El estado debe crearse con createState()");
  if (event.t > 0 && event.type !== "session_info") {
    if (state.startedAt === void 0 || event.t < state.startedAt) state.startedAt = event.t;
    if (state.lastEventAt === void 0 || event.t > state.lastEventAt) state.lastEventAt = event.t;
  }
  switch (event.type) {
    case "session_start":
      if (event.sessionId) state.sessionId = event.sessionId;
      break;
    case "session_info": {
      const { type: _type, t: _t, agentId: _agentId, ...fields } = event;
      Object.assign(state, fields);
      break;
    }
    case "user_prompt":
      state.prompts += 1;
      insertSorted(state.promptTimes, event.t);
      state.ended = false;
      state.status = "working";
      break;
    case "request_start":
      if (event.agentId) {
        if (event.model) upsertSubagent(state, event.agentId, event.t).model ??= event.model;
        break;
      }
      state.ended = false;
      if (internal.openMain.length === 0) state.status = "working";
      break;
    case "message_usage": {
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
    case "tool_call": {
      const call = internal.calls.get(event.id) ?? {};
      Object.assign(call, { name: event.name, agentId: event.agentId, summary: event.summary });
      internal.calls.set(event.id, call);
      (state.tools[event.name] ??= { count: 0, errors: 0 }).count += 1;
      state.toolCalls += 1;
      if (event.memory) {
        const touch = { t: event.t, ...event.memory, ...event.agentId ? { agentId: event.agentId } : {} };
        const { touches } = state.memory;
        let at = touches.length;
        while (at > 0 && touches[at - 1].t > touch.t) at -= 1;
        touches.splice(at, 0, touch);
      }
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
    case "tool_result": {
      const call = internal.calls.get(event.id) ?? {};
      call.done = true;
      call.error = event.isError;
      if (event.isError) call.errorAt = event.t;
      call.agentId = call.agentId ?? event.agentId;
      internal.calls.set(event.id, call);
      countToolError(state, internal, event.id);
      if (event.agentId) {
        const sub = state.subagents.find((s) => s.id === event.agentId);
        if (sub && sub.currentTool === call.name) sub.currentTool = void 0;
      } else {
        internal.openMain = internal.openMain.filter((id) => id !== event.id);
        refreshMainTool(state, internal);
        if (internal.openMain.length === 0) state.status = "working";
      }
      break;
    }
    case "memory_load":
      for (const file of event.files) {
        if (!state.memory.loaded.some((known) => known.file === file.file && known.scope === file.scope)) state.memory.loaded.push(file);
      }
      break;
    case "advisor_consult": {
      const consult = upsertConsult(state, event.id, event.t);
      consult.t = event.t;
      consult.reason = event.reason;
      state.advisor.calls += 1;
      break;
    }
    case "advisor_reply": {
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
    case "assistant_text":
      if (!event.agentId && internal.awaitingFollowUp) {
        internal.awaitingFollowUp.followUp = event.text;
        internal.awaitingFollowUp = void 0;
      }
      break;
    case "subagent_start": {
      const sub = upsertSubagent(state, event.subagentId, event.t);
      if (event.t > 0 && event.t < sub.startedAt) {
        sub.startedAt = event.t;
        state.subagents.sort(bySubagentStart);
      }
      if (event.model) sub.model = event.model;
      break;
    }
    case "subagent_info": {
      const sub = upsertSubagent(state, event.subagentId, event.t);
      if (event.description) sub.description = event.description;
      if (event.toolUseId) sub.toolUseId = event.toolUseId;
      if (event.agentType) {
        sub.agentType = event.agentType;
        sub.readOnly = event.agentType === "Explore" || event.agentType === "Plan";
      }
      break;
    }
    case "subagent_end": {
      const sub = upsertSubagent(state, event.subagentId, event.t);
      sub.running = false;
      sub.currentTool = void 0;
      if (!sub.finalized) {
        sub.endedAt = event.t;
        sub.status = event.status;
        sub.summary = event.summary;
      }
      break;
    }
    case "subagent_result": {
      const sub = upsertSubagent(state, event.subagentId, event.t);
      sub.running = false;
      sub.currentTool = void 0;
      sub.finalized = true;
      sub.status = event.status;
      sub.endedAt = event.t;
      if (event.summary) sub.summary = event.summary;
      if (event.model) sub.model = event.model;
      if (event.durationMs !== void 0) sub.durationMs = event.durationMs;
      if (event.totalTokens !== void 0) sub.totalTokens = event.totalTokens;
      if (event.toolCount !== void 0) sub.toolCount = event.toolCount;
      break;
    }
    case "turn_end":
      state.turns += 1;
      internal.openMain = [];
      state.currentTool = void 0;
      state.status = "idle";
      break;
    case "api_error":
      state.apiErrors += 1;
      break;
    case "compaction":
      state.compactions += 1;
      break;
    case "session_end":
      state.ended = true;
      state.costUSD = event.costUSD;
      state.status = "idle";
      state.currentTool = void 0;
      internal.openMain = [];
      break;
    default:
      break;
  }
}

// src/engine/easing.ts
var clamp01 = (t) => t <= 0 ? 0 : t >= 1 ? 1 : t;
var easeOutCubic = (t) => 1 - (1 - clamp01(t)) ** 3;
var easeInOutCubic = (t) => {
  const k = clamp01(t);
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
};
function progress(now, start, duration) {
  return duration <= 0 ? 1 : clamp01((now - start) / duration);
}
function segment(t, from, to) {
  return to <= from ? t >= to ? 1 : 0 : clamp01((t - from) / (to - from));
}

// src/tui/color.ts
var rgb = (hex) => Number.parseInt(hex.replace("#", ""), 16);
var red = (c) => c >> 16 & 255;
var green = (c) => c >> 8 & 255;
var blue = (c) => c & 255;
function mix(a, b, t) {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const r = Math.round(red(a) + (red(b) - red(a)) * k);
  const g = Math.round(green(a) + (green(b) - green(a)) * k);
  const bl = Math.round(blue(a) + (blue(b) - blue(a)) * k);
  return r << 16 | g << 8 | bl;
}
function detectColorMode(depth) {
  return depth >= 24 ? "truecolor" : "256";
}
var CUBE_STEPS = [0, 95, 135, 175, 215, 255];
function nearestStep(value) {
  let best = 0;
  for (let i = 1; i < CUBE_STEPS.length; i += 1) {
    if (Math.abs(CUBE_STEPS[i] - value) < Math.abs(CUBE_STEPS[best] - value)) best = i;
  }
  return best;
}
var cache256 = /* @__PURE__ */ new Map();
function to256(c) {
  const cached = cache256.get(c);
  if (cached !== void 0) return cached;
  const r = red(c);
  const g = green(c);
  const b = blue(c);
  const ri = nearestStep(r);
  const gi = nearestStep(g);
  const bi = nearestStep(b);
  const cubeR = CUBE_STEPS[ri];
  const cubeG = CUBE_STEPS[gi];
  const cubeB = CUBE_STEPS[bi];
  const cubeDistance = (r - cubeR) ** 2 + (g - cubeG) ** 2 + (b - cubeB) ** 2;
  const grayIndex = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + grayIndex * 10;
  const grayDistance = (r - gray) ** 2 + (g - gray) ** 2 + (b - gray) ** 2;
  const result = grayDistance < cubeDistance ? 232 + grayIndex : 16 + 36 * ri + 6 * gi + bi;
  cache256.set(c, result);
  return result;
}

// src/scene/theme.ts
var theme = {
  /** Fondo plano, sin viñeta: los paneles comparten el color del fondo. */
  bg: rgb("#191e24"),
  panel: rgb("#191e24"),
  chip: rgb("#262c36"),
  windowBar: rgb("#242831"),
  /** Modelo principal: sesión principal y "back to lead". */
  main: rgb("#e38d63"),
  /** Subagentes y sus barras. */
  sub: rgb("#81b0f6"),
  /** Paquetes de regreso y destellos. */
  subBright: rgb("#f2f6ff"),
  /** Memoria de agentes. */
  metrics: rgb("#77ce9b"),
  /** Memoria de proyecto. */
  notes: rgb("#af9eec"),
  /** El advisor no está en la referencia: lleva un tono propio para no confundirse con la memoria. */
  advisor: rgb("#e59ad8"),
  /** Errores: más rojo que el naranjo del modelo principal, para que se distingan. */
  alert: rgb("#f0695a"),
  /** Pie del panel de memoria. */
  caption: rgb("#e8b56e"),
  text: rgb("#dfe3ea"),
  dim: rgb("#8b909b"),
  faint: rgb("#50555f"),
  /** Conectores en reposo y borde del log. */
  line: rgb("#4a505c"),
  barTrack: rgb("#3a404b"),
  barGood: rgb("#76d099"),
  barAlert: rgb("#c9574b"),
  barSub: rgb("#8cc0ff"),
  dotRed: rgb("#ff5f57"),
  dotYellow: rgb("#febc2e"),
  dotGreen: rgb("#28c840")
};

// src/scene/boot.ts
var BOOT_MS = 2200;
var timingCache = /* @__PURE__ */ new WeakMap();
function panelsOf(layout) {
  let panels = timingCache.get(layout);
  if (!panels) {
    panels = [
      { rect: layout.project, from: 150, to: 1150 },
      { rect: layout.main, from: 350, to: 1250 },
      { rect: layout.advisor, from: 500, to: 1300 },
      { rect: layout.memory, from: 650, to: 1450 },
      { rect: layout.cards[0], from: 850, to: 1550 },
      { rect: layout.cards[1], from: 950, to: 1650 },
      { rect: layout.cards[2], from: 1050, to: 1750 },
      { rect: layout.lead, from: 1200, to: 1850 },
      { rect: layout.log, from: 1300, to: 2e3 }
    ];
    timingCache.set(layout, panels);
  }
  return panels;
}
var BORDER_SHARE = 0.6;
function hide(buf, x, y, base) {
  buf.clearCell(x, y, base(x, y));
}
function perimeter(r) {
  const cells = [];
  const right = r.x + r.w - 1;
  const bottom = r.y + r.h - 1;
  for (let x = r.x; x <= right; x += 1) cells.push([x, r.y]);
  for (let y = r.y + 1; y <= bottom; y += 1) cells.push([right, y]);
  for (let x = right - 1; x >= r.x; x -= 1) cells.push([x, bottom]);
  for (let y = bottom - 1; y > r.y; y -= 1) cells.push([r.x, y]);
  return cells;
}
var perimeterCache = /* @__PURE__ */ new Map();
function revealPanel(buf, r, t, base) {
  if (t >= 1) return;
  const borderT = easeInOutCubic(segment(t, 0, BORDER_SHARE));
  const contentT = easeOutCubic(segment(t, BORDER_SHARE, 1));
  for (let y = r.y + 1; y < r.y + r.h - 1; y += 1) {
    for (let x = r.x + 1; x < r.x + r.w - 1; x += 1) {
      if (contentT <= 0) {
        hide(buf, x, y, base);
      } else {
        const fade = 1 - contentT;
        buf.tintFg(x, y, base(x, y), fade);
        buf.blendBg(x, y, base(x, y), fade);
      }
    }
  }
  let cells = perimeterCache.get(r);
  if (!cells) {
    cells = perimeter(r);
    perimeterCache.set(r, cells);
  }
  const drawn = t <= 0 ? -1 : Math.floor(borderT * cells.length);
  cells.forEach(([x, y], i) => {
    if (i > drawn) hide(buf, x, y, base);
    else if (i >= drawn - 3 && borderT < 1) buf.tintFg(x, y, theme.subBright, 1 - (drawn - i) / 4);
  });
}
function hideRow(buf, y, fromCol, width, base) {
  for (let x = fromCol; x < width; x += 1) hide(buf, x, y, base);
}
function fadeRow(buf, y, width, amount, base) {
  for (let x = 0; x < width; x += 1) {
    buf.tintFg(x, y, base(x, y), amount);
    buf.blendBg(x, y, base(x, y), amount);
  }
}
function fadeConnectors(buf, layout, amount, base) {
  const panels = panelsOf(layout);
  const inPanel = (x, y) => panels.some(({ rect: r }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  for (let y = layout.rows.legend + 1; y < layout.log.y; y += 1) {
    for (let x = 0; x < layout.width; x += 1) {
      if (inPanel(x, y)) continue;
      if (amount >= 1) {
        hide(buf, x, y, base);
      } else {
        buf.tintFg(x, y, base(x, y), amount);
        buf.blendBg(x, y, base(x, y), amount);
      }
    }
  }
}
function applyBootFull(buf, ms, layout, headerStart, headerLength, base) {
  const { rows, width } = layout;
  const typed = Math.floor(easeInOutCubic(segment(ms, 0, 800)) * headerLength);
  hideRow(buf, rows.header, headerStart + typed, width, base);
  if (typed > 0 && typed < headerLength) buf.put(headerStart + typed, rows.header, "\u258C", theme.main);
  if (rows.separator !== void 0) fadeRow(buf, rows.separator, width, 1 - easeOutCubic(segment(ms, 300, 800)), base);
  fadeRow(buf, rows.legend, width, 1 - easeOutCubic(segment(ms, 450, 950)), base);
  fadeConnectors(buf, layout, 1 - easeOutCubic(segment(ms, 1500, 2100)), base);
  for (const panel of panelsOf(layout)) revealPanel(buf, panel.rect, segment(ms, panel.from, panel.to), base);
  const bottom = 1 - easeOutCubic(segment(ms, 1700, BOOT_MS));
  fadeRow(buf, rows.prompt, width, bottom, base);
  fadeRow(buf, rows.status, width, bottom, base);
}
function applyBootFade(buf, ms, base) {
  const amount = 1 - easeOutCubic(segment(ms, 0, 700));
  if (amount <= 0) return;
  for (let y = 0; y < buf.height; y += 1) {
    for (let x = 0; x < buf.width; x += 1) {
      buf.tintFg(x, y, base(x, y), amount);
      buf.blendBg(x, y, base(x, y), amount);
    }
  }
}

// src/engine/queue.ts
var BASE = {
  instant: 0,
  tool: 450,
  memory: 800,
  advisor: 1e3,
  "advisor-reply": 900,
  "subagent-start": 800,
  "subagent-end": 900,
  error: 650,
  note: 350
};
var MINIMUM = {
  instant: 0,
  tool: 120,
  memory: 300,
  // Consulta y respuesta separadas suman el mínimo acordado de 1,5 s.
  advisor: 1e3,
  "advisor-reply": 500,
  "subagent-start": 350,
  "subagent-end": 400,
  error: 350,
  note: 120
};
var ADVISOR_MIN_MS = 1500;
var ADVISOR_MAX_MS = 5e3;
var ADVISOR_LONG_MS = 18e4;
function advisorDuration(realMs) {
  const ratio = Math.min(1, Math.max(0, realMs ?? 0) / ADVISOR_LONG_MS);
  return ADVISOR_MIN_MS + (ADVISOR_MAX_MS - ADVISOR_MIN_MS) * Math.sqrt(ratio);
}
function loadScale(pending) {
  return pending <= 3 ? 1 : 1 / (1 + (pending - 3) * 0.12);
}
var GROUP_FROM = 8;
var GROUP_MAX_EVENTS = 40;
function classify(event, known) {
  switch (event.type) {
    case "tool_call":
      return event.memory ? "memory" : "tool";
    case "memory_load":
      return "memory";
    case "tool_result":
      return event.isError ? "error" : "instant";
    case "advisor_consult":
      return "advisor";
    case "advisor_reply":
      return "advisor-reply";
    case "subagent_start":
      if (known.has(event.subagentId)) return "instant";
      known.add(event.subagentId);
      return "subagent-start";
    case "subagent_end":
      return "subagent-end";
    case "api_error":
      return "error";
    case "user_prompt":
    case "turn_end":
    case "session_end":
    case "compaction":
      return "note";
    default:
      return "instant";
  }
}
var isNeutral = (item) => item.events.every((e) => e.type === "message_usage" || e.type === "session_info" || e.type === "request_start" || e.type === "turn_end");
var KIND_COLOR = {
  instant: "tool",
  tool: "tool",
  memory: "memory",
  advisor: "advisor",
  "advisor-reply": "advisor",
  "subagent-start": "sub",
  "subagent-end": "sub",
  error: "error",
  note: "main"
};
var AnimationQueue = class {
  items = [];
  current;
  clockEnd;
  knownSubagents = /* @__PURE__ */ new Set();
  get active() {
    return this.current;
  }
  /** Elementos visibles que aún no empiezan. */
  get pending() {
    return this.items.reduce((sum, item) => sum + (item.kind === "instant" ? 0 : 1), 0);
  }
  get pendingKinds() {
    return this.items.filter((item) => item.kind !== "instant").map((item) => KIND_COLOR[item.kind]);
  }
  get isEmpty() {
    return this.items.length === 0 && !this.current;
  }
  /** Registra un subagente ya visto, para que un inicio repetido no se anime. */
  markKnown(subagentId) {
    this.knownSubagents.add(subagentId);
  }
  push(events) {
    for (const event of events) {
      const kind = classify(event, this.knownSubagents);
      if (kind === "advisor-reply" && event.type === "advisor_reply" && this.attachReply(event)) continue;
      this.items.push({ kind, events: [event], endEvents: [] });
    }
  }
  /** Une la respuesta a su consulta si sigue en espera y no hay nada relevante entre ambas. */
  attachReply(reply) {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i];
      if (isNeutral(item)) continue;
      const consult = item.events[0];
      if (item.kind === "advisor" && consult?.type === "advisor_consult" && consult.id === reply.id && item.endEvents.length === 0) {
        item.endEvents.push(reply);
        return true;
      }
      return false;
    }
    return false;
  }
  durationOf(item) {
    if (item.kind === "advisor") {
      const reply = item.endEvents[0];
      if (reply?.type === "advisor_reply") return advisorDuration(reply.durationMs);
    }
    return Math.max(MINIMUM[item.kind], BASE[item.kind] * loadScale(this.pending));
  }
  /** Une herramientas consecutivas cuando la cola está larga. Sus eventos se aplican todos. */
  absorbTools(item) {
    if (item.kind !== "tool" || this.pending < GROUP_FROM) return;
    while (item.events.length < GROUP_MAX_EVENTS) {
      const next = this.items[0];
      if (!next || next.kind !== "tool" && next.kind !== "instant") break;
      item.events.push(...next.events);
      this.items.shift();
    }
  }
  /** Avanza la cola hasta `now` y devuelve lo que empezó y terminó, en orden. */
  update(now) {
    const steps = [];
    for (; ; ) {
      if (this.current) {
        const end = this.current.start + this.current.duration;
        if (now < end) break;
        steps.push({ phase: "end", active: this.current });
        this.current = void 0;
        this.clockEnd = end;
      }
      const item = this.items.shift();
      if (!item) break;
      this.absorbTools(item);
      const start = this.clockEnd !== void 0 && now - this.clockEnd < 250 ? this.clockEnd : now;
      const active = { item, start, duration: this.durationOf(item) };
      this.current = active;
      this.clockEnd = start;
      steps.push({ phase: "start", active });
    }
    return steps;
  }
  clear() {
    this.items = [];
    this.current = void 0;
    this.clockEnd = void 0;
    this.knownSubagents.clear();
  }
};

// src/engine/tweens.ts
var TweenSet = class {
  tweens = /* @__PURE__ */ new Map();
  /**
   * Valor actual de `key`, que persigue `target`. Si el objetivo cambia, sigue desde donde iba.
   * Un valor nuevo empieza en `initial`.
   */
  track(key, target, now, duration, initial = 0, ease = easeOutCubic) {
    let tween = this.tweens.get(key);
    if (!tween) {
      tween = { from: initial, to: target, start: now, duration, ease };
      this.tweens.set(key, tween);
    } else if (tween.to !== target) {
      tween.from = this.valueOf(tween, now);
      tween.to = target;
      tween.start = now;
      tween.duration = duration;
    }
    return this.valueOf(tween, now);
  }
  valueOf(tween, now) {
    return tween.from + (tween.to - tween.from) * tween.ease(progress(now, tween.start, tween.duration));
  }
  /** Lleva un valor a su objetivo sin animarlo. */
  settle(key, target) {
    this.tweens.set(key, { from: target, to: target, start: 0, duration: 0, ease: easeOutCubic });
  }
  /** Si algún valor sigue moviéndose. */
  isActive(now) {
    for (const tween of this.tweens.values()) {
      if (tween.from !== tween.to && now < tween.start + tween.duration) return true;
    }
    return false;
  }
  clear() {
    this.tweens.clear();
  }
};

// src/engine/director.ts
var LOG_LIMIT = 200;
var PACKET_SHARE = 0.35;
var PULSE_PERIOD_MS = 170;
var MEMORY_PULSE_MS = 1200;
var QUEUE_AFTER_BOOT_MS = 1600;
var LEAD_GLOW_MS = 900;
var ERROR_FLASH_MS = 750;
var LOG_MOTION_MS = 800;
var COUNT_MS = 500;
var TOKENS_MS = 900;
var BREATH_PERIOD_MS = 4200;
var BREATH_LEVELS = 6;
function breathLevel(now) {
  const wave = 0.5 + 0.5 * Math.sin(now / BREATH_PERIOD_MS * 2 * Math.PI);
  return Math.round(wave * BREATH_LEVELS) / BREATH_LEVELS;
}
var EXAMPLE_FLOW = [
  { route: "tool", period: 2300, offset: 0, duration: 800, whileRunning: false },
  { route: "work-0", period: 3100, offset: 300, duration: 1300, whileRunning: true },
  { route: "work-1", period: 3400, offset: 1500, duration: 900, whileRunning: true },
  { route: "work-2", period: 2900, offset: 2200, duration: 1300, whileRunning: true },
  { route: "back-0", period: 3700, offset: 900, duration: 1700, whileRunning: true },
  { route: "back-1", period: 4100, offset: 2500, duration: 1200, whileRunning: true },
  { route: "back-2", period: 3300, offset: 1800, duration: 1700, whileRunning: true }
];
var EXAMPLE_MILESTONE_MS = 3600;
var EXAMPLE_MILESTONE_ROUTE_MS = 1100;
function examplePercent(elapsedMs, seed) {
  const pace = 7e3 + seed % 5 * 2600;
  return Math.min(97, Math.floor(100 * (1 - Math.exp(-Math.max(0, elapsedMs) / pace))));
}
var hashOf = (text) => [...text].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) % 9973, 7);
var Director = class {
  truth = createState();
  shown = createState();
  queue = new AnimationQueue();
  log = [];
  last;
  connected = false;
  /** Cambia cada vez que algo visible cambia, para no redibujar sin necesidad. */
  version = 0;
  bootStart;
  animateBoot;
  illustrative;
  packets = [];
  memoryPulse;
  cards = [void 0, void 0, void 0];
  /** Subagentes activos sin tarjeta libre. */
  waitingCards = [];
  leadGlowStart;
  tweens = new TweenSet();
  lastLogBorn;
  flashStart;
  constructor(options = {}) {
    this.animateBoot = options.boot ?? false;
    this.illustrative = options.illustrative ?? false;
  }
  bootElapsed(now) {
    if (!this.animateBoot) return void 0;
    this.bootStart ??= now;
    return now - this.bootStart;
  }
  ingest(update, now) {
    if (update.kind === "reset") {
      this.truth = createState();
      this.shown = createState();
      this.queue.clear();
      this.packets = [];
      this.memoryPulse = void 0;
      this.cards = [void 0, void 0, void 0];
      this.waitingCards = [];
      this.leadGlowStart = void 0;
      this.tweens.clear();
      this.flashStart = void 0;
      this.lastLogBorn = void 0;
      this.log = [];
      this.last = void 0;
      this.connected = true;
      this.version += 1;
      return;
    }
    this.connected = true;
    for (const event of update.events) applyEvent(this.truth, event);
    if (update.historical) {
      for (const event of update.events) {
        const isNew = event.type === "subagent_start" && !this.shown.subagents.some((s) => s.id === event.subagentId);
        if (event.type === "subagent_start") this.queue.markKnown(event.subagentId);
        this.show(event, void 0);
        if (isNew && event.type === "subagent_start") this.placeCard(event.subagentId, now, void 0);
      }
      this.settleNumbers();
    } else {
      this.queue.push(update.events);
    }
    this.version += 1;
  }
  /** Pone un subagente en la primera posición libre, o en la de uno que ya terminó de desvanecerse. */
  placeCard(id, now, enter) {
    const finished = (card) => {
      const sub = this.shown.subagents.find((s) => s.id === card.id);
      return !sub?.running && (card.exit === void 0 || now >= card.exit.start + card.exit.duration);
    };
    let slot = this.cards.findIndex((card) => !card);
    if (slot < 0) slot = this.cards.findIndex((card) => card !== void 0 && finished(card));
    if (slot < 0) {
      this.waitingCards.push(id);
      return void 0;
    }
    this.cards[slot] = { id, enter };
    return slot;
  }
  show(event, bornAt) {
    const repeated = event.type === "subagent_start" && this.shown.subagents.some((s) => s.id === event.subagentId);
    applyEvent(this.shown, event);
    const entry = repeated ? void 0 : describeEvent(event, this.shown);
    if (entry) {
      if (bornAt !== void 0) this.lastLogBorn = bornAt;
      const t = event.type === "turn_end" ? Math.max(entry.t, this.log[this.log.length - 1]?.t ?? 0) : entry.t;
      this.log.push({ ...entry, t, bornAt });
      if (this.log.length > LOG_LIMIT) this.log.shift();
      this.last = `${entry.who} \xB7 ${entry.text}`;
    }
  }
  addPacket(route2, start, duration) {
    this.packets.push({ route: route2, start, duration });
  }
  onStart(active, now) {
    for (const event of active.item.events) this.show(event, now);
    const { item, start, duration } = active;
    const first = item.events[0];
    if (item.kind === "error") {
      this.flashStart = start;
    } else if (item.kind === "tool" && first?.type === "tool_call") {
      if (!first.agentId) {
        this.addPacket("tool", start, duration);
      } else {
        const slot = this.cards.findIndex((card) => card?.id === first.agentId);
        if (slot >= 0) this.addPacket(`work-${slot}`, start, duration);
      }
    } else if (item.kind === "memory") {
      const slot = first?.type === "tool_call" ? memoryMilestone(this.shown, { t: first.t }) : 0;
      const agentId = first?.type === "tool_call" ? first.agentId : void 0;
      const card = agentId ? this.cards.findIndex((c) => c?.id === agentId) : -1;
      this.addPacket(`memory-${slot}`, start, duration);
      this.memoryPulse = { slot, start, ...card >= 0 ? { card } : {} };
    } else if (item.kind === "advisor" && first?.type === "advisor_consult") {
      if (item.endEvents.length) {
        this.addPacket("advisor-out", start, duration * PACKET_SHARE);
        this.addPacket("advisor-back", start + duration * (1 - PACKET_SHARE), duration * PACKET_SHARE);
      } else {
        this.addPacket("advisor-out", start, duration * 0.6);
      }
    } else if (item.kind === "advisor-reply" && first?.type === "advisor_reply") {
      this.addPacket("advisor-back", start, duration);
    } else if (item.kind === "subagent-start" && first?.type === "subagent_start") {
      const growStart = start + duration * 0.4;
      const slot = this.placeCard(first.subagentId, now, { start: growStart, duration: duration * 0.6 });
      if (slot !== void 0) this.addPacket(`delegate-${slot}`, start, duration * 0.5);
    } else if (item.kind === "subagent-end" && first?.type === "subagent_end") {
      const slot = this.cards.findIndex((card2) => card2?.id === first.subagentId);
      const card = this.cards[slot];
      if (card) {
        card.exit = { start, duration };
        this.addPacket(`back-${slot}`, start + duration * 0.25, duration * 0.75);
        this.leadGlowStart = start + duration * 0.8;
      } else {
        this.waitingCards = this.waitingCards.filter((id) => id !== first.subagentId);
      }
    }
  }
  /** Un subagente sin tarjeta entra cuando una queda libre. */
  promoteWaitingCards(now) {
    while (this.waitingCards.length) {
      const id = this.waitingCards[0];
      this.waitingCards.shift();
      if (this.placeCard(id, now, { start: now, duration: 500 }) === void 0) {
        this.waitingCards.pop();
        this.waitingCards.unshift(id);
        return;
      }
    }
  }
  cardViews(now) {
    this.promoteWaitingCards(now);
    return this.cards.map((card) => {
      if (!card) return void 0;
      const sub = this.shown.subagents.find((s) => s.id === card.id);
      const grow = card.enter ? progress(now, card.enter.start, card.enter.duration) : 1;
      const fade = card.exit ? progress(now, card.exit.start, card.exit.duration) : sub && !sub.running ? 1 : 0;
      return { id: card.id, grow, fade };
    });
  }
  /** Valores que persiguen el estado visible, para que los números suban y las barras crezcan. */
  shownNumbers(now) {
    const { advisor, toolCalls } = this.shown;
    const follow = (key, target, duration = COUNT_MS) => this.tweens.track(key, target, now, duration);
    return {
      toolCalls: follow("toolCalls", toolCalls),
      calls: follow("calls", advisor.calls),
      tokensRead: follow("tokensRead", advisor.tokensRead, TOKENS_MS),
      memory: Object.fromEntries(Object.entries(this.memoryCounts()).map(([id, count]) => [id, follow(`memory:${id}`, count)]))
    };
  }
  memoryCounts() {
    const counts = {};
    for (const touch of this.shown.memory.touches) if (touch.agentId) counts[touch.agentId] = (counts[touch.agentId] ?? 0) + 1;
    return counts;
  }
  /** Lleva los contadores a su valor sin animarlos: lo que ya había ocurrido no se cuenta otra vez. */
  settleNumbers() {
    const { advisor, toolCalls } = this.shown;
    this.tweens.settle("toolCalls", toolCalls);
    this.tweens.settle("calls", advisor.calls);
    this.tweens.settle("tokensRead", advisor.tokensRead);
    for (const [id, count] of Object.entries(this.memoryCounts())) this.tweens.settle(`memory:${id}`, count);
  }
  errorFlash(now) {
    if (this.flashStart === void 0) return void 0;
    const t = progress(now, this.flashStart, ERROR_FLASH_MS);
    return t < 1 ? 1 - easeOutCubic(t) : void 0;
  }
  leadGlow(now) {
    if (this.leadGlowStart === void 0 || now < this.leadGlowStart) return void 0;
    const t = progress(now, this.leadGlowStart, LEAD_GLOW_MS);
    return t < 1 ? 1 - easeOutCubic(t) : void 0;
  }
  cardsMoving(now) {
    return this.cards.some((card) => card && (card.enter && now < card.enter.start + card.enter.duration || card.exit && now < card.exit.start + card.exit.duration)) || this.leadGlowStart !== void 0 && now < this.leadGlowStart + LEAD_GLOW_MS;
  }
  onEnd(active, now) {
    for (const event of active.item.endEvents) this.show(event, now);
  }
  activePackets(now) {
    this.packets = this.packets.filter((p) => now < p.start + p.duration);
    const real = this.packets.filter((p) => now >= p.start).map((p) => ({ route: p.route, t: progress(now, p.start, p.duration) }));
    return this.illustrative ? [...real, ...this.examplePackets(now)] : real;
  }
  advisorMotion(now) {
    const active = this.queue.active;
    if (!active || active.item.kind !== "advisor" && active.item.kind !== "advisor-reply") return {};
    return { advisorPulse: 0.5 + 0.5 * Math.sin((now - active.start) / PULSE_PERIOD_MS) };
  }
  memoryMotion(now) {
    const example = this.illustrative ? this.exampleMilestone(now) : void 0;
    const pulse = this.memoryPulse;
    if (pulse && now >= pulse.start && now < pulse.start + MEMORY_PULSE_MS) {
      const amount = 1 - easeOutCubic(progress(now, pulse.start, MEMORY_PULSE_MS));
      return { memoryPulse: { slot: pulse.slot, amount, ...pulse.card !== void 0 ? { card: pulse.card } : {} } };
    }
    return example ? { memoryPulse: example } : {};
  }
  // --- Actividad de ejemplo, solo en la demo. No toca `truth` ni `shown`. ---
  get hasRunningCards() {
    return this.shown.subagents.some((s) => s.running);
  }
  examplePackets(now) {
    if (!this.exampleRunning) return [];
    const packets = [];
    for (const flow of EXAMPLE_FLOW) {
      if (flow.whileRunning && !this.hasRunningCards) continue;
      const t2 = (now + flow.offset) % flow.period / flow.duration;
      if (t2 < 1) packets.push({ route: flow.route, t: t2 });
    }
    const cycle = now / EXAMPLE_MILESTONE_MS;
    const t = (cycle - Math.floor(cycle)) * (EXAMPLE_MILESTONE_MS / EXAMPLE_MILESTONE_ROUTE_MS);
    if (t < 1) packets.push({ route: `memory-${Math.floor(cycle) % 3}`, t });
    return packets;
  }
  exampleMilestone(now) {
    if (!this.exampleRunning) return void 0;
    const cycle = now / EXAMPLE_MILESTONE_MS;
    const phase = cycle - Math.floor(cycle);
    const amount = 1 - easeOutCubic(Math.min(1, phase * 2.2));
    if (amount <= 0) return void 0;
    const slot = Math.floor(cycle) % 3;
    return { slot, amount, ...slot === 1 ? { card: 0 } : {} };
  }
  exampleFrame(now) {
    const percents = this.cards.map((card) => {
      if (!card) return void 0;
      return examplePercent(now - (card.enter?.start ?? 0), hashOf(card.id));
    });
    const memory = this.cards.map((card, i) => {
      if (!card) return { fraction: 0, label: "recall" };
      const seed = hashOf(card.id) % 7;
      const wave = Math.sin(now / (1700 + seed * 240) + i * 1.7);
      const fraction = 0.68 + Math.round((wave + 1) * 6) / 6 * 0.14;
      const checking = (now + i * 2900) % 9e3 < 2200;
      return { fraction: checking ? 0.55 : fraction, label: checking ? "check" : "recall" };
    });
    return { percents, memory };
  }
  /** Avanza hasta `now`. Devuelve si algo de los datos cambió. */
  update(now) {
    const boot = this.bootElapsed(now);
    if (boot !== void 0 && boot < QUEUE_AFTER_BOOT_MS) return false;
    const steps = this.queue.update(now);
    for (const step of steps) {
      if (step.phase === "start") this.onStart(step.active, now);
      else this.onEnd(step.active, now);
    }
    if (steps.length) {
      this.version += 1;
      this.shownNumbers(now);
    }
    return steps.length > 0;
  }
  /** La cola está vacía: lo visible ya es lo real. */
  get settled() {
    return this.queue.isEmpty;
  }
  /** Hay algo moviéndose que exige la frecuencia alta. La demo siempre tiene paquetes de ejemplo circulando. */
  isBusy(now) {
    return this.exampleRunning || this.isAnimating(now);
  }
  /** La actividad de ejemplo acompaña a la sesión: si la pantalla dice que terminó, nada debe seguir moviéndose. */
  get exampleRunning() {
    return this.illustrative && this.connected && !this.shown.ended;
  }
  /** Lo que depende de datos reales sigue en movimiento. Al terminar, lo visible ya es definitivo. */
  isAnimating(now) {
    const boot = this.bootElapsed(now);
    return !this.queue.isEmpty || this.packets.length > 0 || this.memoryPulse !== void 0 && now < this.memoryPulse.start + MEMORY_PULSE_MS || this.tweens.isActive(now) || this.cardsMoving(now) || this.flashStart !== void 0 && now < this.flashStart + ERROR_FLASH_MS || this.lastLogBorn !== void 0 && now < this.lastLogBorn + LOG_MOTION_MS || boot !== void 0 && boot < BOOT_MS;
  }
  animFrame(now) {
    const boot = this.bootElapsed(now);
    return {
      bootMs: boot !== void 0 && boot < BOOT_MS ? boot : void 0,
      packets: this.activePackets(now),
      cards: this.cardViews(now),
      leadGlow: this.leadGlow(now),
      numbers: this.shownNumbers(now),
      breath: breathLevel(now),
      errorFlash: this.errorFlash(now),
      ...this.advisorMotion(now),
      ...this.memoryMotion(now),
      ...this.illustrative ? { illustrative: this.exampleFrame(now) } : {}
    };
  }
  view(now, replay, flatBackground = false) {
    return {
      state: this.shown,
      log: this.log,
      now,
      queue: { last: this.last, pending: this.queue.pendingKinds },
      replay,
      connected: this.connected,
      flatBackground,
      illustrativeDemo: this.illustrative,
      preview: { main: this.truth.mainModel, advisor: this.truth.advisorModel },
      anim: this.animFrame(now)
    };
  }
};

// src/tui/buffer.ts
var BOLD = 1;
var SPACE = 32;
function charWidth(cp) {
  if (cp < 32 || cp >= 127 && cp < 160) return 0;
  if (cp >= 768 && cp <= 879 || cp >= 8203 && cp <= 8207 || cp >= 65024 && cp <= 65039) return 0;
  if (cp >= 4352 && cp <= 4447 || cp >= 11904 && cp <= 42191 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65072 && cp <= 65135 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 127744 && cp <= 129791 || cp >= 131072 && cp <= 262141) {
    return 2;
  }
  return 1;
}
function toCells(text) {
  let out = "";
  for (const char of text.normalize("NFC")) {
    const width = charWidth(char.codePointAt(0));
    if (width === 1) out += char;
    else if (width === 2) out += "\u25A1";
  }
  return out;
}
var cellLength = (text) => [...text].length;
function fit(text, max) {
  if (max <= 0) return "";
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}\u2026`;
}
var CellBuffer = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    const size = width * height;
    this.chars = new Uint32Array(size).fill(SPACE);
    this.fg = new Int32Array(size);
    this.bg = new Int32Array(size);
    this.attrs = new Uint8Array(size);
  }
  width;
  height;
  chars;
  fg;
  bg;
  attrs;
  /** En 256 colores un tinte pequeño salta a otro gris: los halos se apagan. */
  tintsEnabled = true;
  /** Desplazamiento de las coordenadas de dibujo: centra el layout en una terminal mayor. */
  originX = 0;
  originY = 0;
  /** Índice de una celda en coordenadas de dibujo, o -1 si está fuera. */
  index(x, y) {
    const col = x + this.originX;
    const row = y + this.originY;
    return col >= 0 && row >= 0 && col < this.width && row < this.height ? row * this.width + col : -1;
  }
  /** Escribe un carácter sin tocar el fondo. */
  put(x, y, char, fg, attrs = 0) {
    const i = this.index(x, y);
    if (i < 0) return;
    this.chars[i] = char.codePointAt(0);
    this.fg[i] = fg;
    this.attrs[i] = attrs;
  }
  /** Cambia solo el fondo de una celda. */
  setBg(x, y, color) {
    const i = this.index(x, y);
    if (i >= 0) this.bg[i] = color;
  }
  /** Acerca el fondo de una celda a un color, para halos y destellos. */
  tintBg(x, y, color, amount) {
    if (!this.tintsEnabled) return;
    const i = this.index(x, y);
    if (i >= 0) this.bg[i] = mix(this.bg[i], color, amount);
  }
  /** Como `tintBg`, pero también en 256 colores: es para animaciones breves, no para halos permanentes. */
  blendBg(x, y, color, amount) {
    const i = this.index(x, y);
    if (i >= 0) this.bg[i] = mix(this.bg[i], color, amount);
  }
  /** Acerca el texto de una celda a un color, para fundidos y paquetes. */
  tintFg(x, y, color, amount) {
    const i = this.index(x, y);
    if (i >= 0) this.fg[i] = mix(this.fg[i], color, amount);
  }
  /** Celda vacía con ese fondo. */
  clearCell(x, y, bg) {
    const i = this.index(x, y);
    if (i < 0) return;
    this.chars[i] = SPACE;
    this.fg[i] = bg;
    this.attrs[i] = 0;
    this.bg[i] = bg;
  }
  /** Carácter de una celda en coordenadas de dibujo, o un espacio si está fuera. */
  charAtDraw(x, y) {
    const i = this.index(x, y);
    return i < 0 ? " " : String.fromCodePoint(this.chars[i]);
  }
  fill(x, y, w, h, bg) {
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) this.clearCell(col, row, bg);
    }
  }
  /** Escribe texto ya ajustado a celdas y devuelve la columna siguiente. */
  text(x, y, text, fg, attrs = 0) {
    let col = x;
    for (const char of text) {
      this.put(col, y, char, fg, attrs);
      col += 1;
    }
    return col;
  }
  /** Texto de una fila, para pruebas y mediciones. */
  rowText(y, from = 0, to = this.width) {
    let out = "";
    for (let x = from; x < to; x += 1) out += String.fromCodePoint(this.chars[y * this.width + x]);
    return out;
  }
  charAt(x, y) {
    return String.fromCodePoint(this.chars[y * this.width + x]);
  }
  fgAt(x, y) {
    return this.fg[y * this.width + x];
  }
  bgAt(x, y) {
    return this.bg[y * this.width + x];
  }
  copyFrom(other) {
    this.chars.set(other.chars);
    this.fg.set(other.fg);
    this.bg.set(other.bg);
    this.attrs.set(other.attrs);
  }
};

// src/scene/draw.ts
var THIN = { h: "\u2500", v: "\u2502", tl: "\u250C", tr: "\u2510", bl: "\u2514", br: "\u2518" };
var DASHED = { h: "\u254C", v: "\u254E", tl: "\u250C", tr: "\u2510", bl: "\u2514", br: "\u2518" };
function halo(buf, r, color, strength) {
  if (strength <= 0) return;
  const ring = (dx, dy, amount) => {
    for (let x = r.x - dx; x < r.x + r.w + dx; x += 1) {
      buf.tintBg(x, r.y - dy, color, amount);
      buf.tintBg(x, r.y + r.h - 1 + dy, color, amount);
    }
    for (let y = r.y - dy + 1; y < r.y + r.h - 1 + dy; y += 1) {
      buf.tintBg(r.x - dx, y, color, amount);
      buf.tintBg(r.x + r.w - 1 + dx, y, color, amount);
    }
  };
  ring(2, 1, strength * 0.07);
  ring(1, 0, strength * 0.13);
}
function box(buf, r, options) {
  const glyphs = options.dashed ? DASHED : THIN;
  const attrs = options.bold ? BOLD : 0;
  if (options.halo) halo(buf, r, options.color, options.halo);
  if (options.fill !== void 0) buf.fill(r.x + 1, r.y + 1, r.w - 2, r.h - 2, options.fill);
  const right = r.x + r.w - 1;
  const bottom = r.y + r.h - 1;
  for (let x = r.x + 1; x < right; x += 1) {
    buf.put(x, r.y, glyphs.h, options.color, attrs);
    buf.put(x, bottom, glyphs.h, options.color, attrs);
  }
  for (let y = r.y + 1; y < bottom; y += 1) {
    buf.put(r.x, y, glyphs.v, options.color, attrs);
    buf.put(right, y, glyphs.v, options.color, attrs);
  }
  buf.put(r.x, r.y, glyphs.tl, options.color, attrs);
  buf.put(right, r.y, glyphs.tr, options.color, attrs);
  buf.put(r.x, bottom, glyphs.bl, options.color, attrs);
  buf.put(right, bottom, glyphs.br, options.color, attrs);
}
var segmentsWidth = (segments) => segments.reduce((sum, s) => sum + cellLength(s.text), 0);
function writeSegments(buf, x, y, segments) {
  let col = x;
  for (const segment2 of segments) col = buf.text(col, y, segment2.text, segment2.color, segment2.bold ? BOLD : 0);
  return col;
}
function centerSegments(buf, x, width, y, segments) {
  writeSegments(buf, x + Math.floor((width - segmentsWidth(segments)) / 2), y, segments);
}
function centerText(buf, x, width, y, text, color, bold = false) {
  centerSegments(buf, x, width, y, [{ text: fit(toCells(text), width), color, bold }]);
}
function rightText(buf, rightEdge, y, text, color, bold = false) {
  buf.text(rightEdge - cellLength(text) + 1, y, text, color, bold ? BOLD : 0);
}
var PARTIAL = ["", "\u258F", "\u258E", "\u258D", "\u258C", "\u258B", "\u258A", "\u2589"];
function track(buf, x, y, color) {
  buf.clearCell(x, y, theme.bg);
  buf.put(x, y, "\u2591", color);
}
function bar(buf, x, y, width, fraction, color, rail = theme.barTrack) {
  const total = Math.max(0, Math.min(1, fraction)) * width;
  const full = Math.floor(total);
  const eighths = Math.floor((total - full) * 8);
  for (let i = 0; i < width; i += 1) {
    if (i < full) {
      buf.clearCell(x + i, y, theme.bg);
      buf.put(x + i, y, "\u2588", color);
    } else if (i === full && eighths > 0) {
      buf.clearCell(x + i, y, theme.bg);
      buf.put(x + i, y, PARTIAL[eighths], color);
    } else {
      track(buf, x + i, y, rail);
    }
  }
}
function indeterminateBar(buf, x, y, width, phase, color, rail = theme.barTrack) {
  const band = Math.max(3, width * 0.32);
  const start = (phase - Math.floor(phase)) * (width + band) - band;
  const end = start + band;
  for (let i = 0; i < width; i += 1) {
    track(buf, x + i, y, rail);
    const covered = Math.min(i + 1, end) - Math.max(i, start);
    if (covered <= 0) continue;
    buf.clearCell(x + i, y, theme.bg);
    if (covered >= 1) {
      buf.put(x + i, y, "\u2588", color);
    } else if (start > i) {
      buf.setBg(x + i, y, color);
      buf.put(x + i, y, PARTIAL[Math.max(1, Math.round((1 - covered) * 8))] ?? "\u258F", theme.bg);
    } else {
      buf.put(x + i, y, PARTIAL[Math.max(1, Math.round(covered * 8))] ?? "\u2589", color);
    }
  }
}
var SPINNER = ["|", "/", "-", "\\"];
var DISC = ["\u25D0", "\u25D3", "\u25D1", "\u25D2"];
var discFrame = (now, offset = 0, period = 160) => DISC[Math.floor(now / period + offset) % DISC.length];
var spinnerFrame = (now, period = 120) => SPINNER[Math.floor(now / period) % SPINNER.length];

// src/scene/layout.ts
var FULL_COLS = 90;
var FULL_ROWS = 46;
var COMPACT_COLS = 80;
var COMPACT_ROWS = 30;
var MIN_COLS = 80;
var MIN_ROWS = 24;
var COMPACT_MAX_CARD = 26;
function layoutKind(cols, rows) {
  if (cols >= FULL_COLS && rows >= FULL_ROWS) return "full";
  if (cols >= COMPACT_COLS && rows >= COMPACT_ROWS) return "compact";
  if (cols >= MIN_COLS && rows >= MIN_ROWS) return "reduced";
  return "too-small";
}
var COMPACT_HEIGHTS = { separator: 0, main: 4, stem: 1, memory: 5, afterMemory: 0, afterDelegate: 0, cardArrow: 0, card: 5, cardStem: 0, leadArrow: 0, lead: 3, beforeLog: 0, log: 5 };
var FULL_HEIGHTS = { separator: 1, main: 6, stem: 2, memory: 7, afterMemory: 1, afterDelegate: 1, cardArrow: 1, card: 7, cardStem: 1, leadArrow: 1, lead: 4, beforeLog: 1, log: 6 };
var SPARE_ORDER = ["log", "memory", "card", "memory", "card", "main", "main", "separator", "stem", "afterMemory", "afterDelegate", "cardArrow", "cardStem", "leadArrow", "lead", "beforeLog"];
var span = (x0, x1, y0, y1) => ({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
function route(...points) {
  const cells = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const [tx, ty] = points[i];
    let [x, y] = cells[cells.length - 1];
    while (x !== tx || y !== ty) {
      x += Math.sign(tx - x);
      y += Math.sign(ty - y);
      cells.push([x, y]);
    }
  }
  return cells;
}
var FULL_COLUMNS = {
  width: FULL_COLS,
  project: { x: 3, w: 21 },
  main: { x0: 44, x1: 70 },
  advisor: { x0: 74, x1: 87 },
  memory: { x0: 36, x1: 78 },
  cards: [[26, 45], [47, 66], [68, 87]],
  centers: [36, 57, 78],
  lead: { x0: 41, x1: 73 },
  log: { x0: 3, x1: 87 },
  spine: 57
};
function compactColumns(cols) {
  const left = 21;
  const card = Math.min(COMPACT_MAX_CARD, Math.floor((cols - left - 2) / 3));
  const used = card * 3 + 2;
  const width = Math.min(cols, left + 3 + used);
  const start = width - used;
  const cards = [
    [start, start + card - 1],
    [start + card + 1, start + 2 * card],
    [start + 2 * card + 2, start + 3 * card + 1]
  ];
  const centers = [cards[0][0] + (card >> 1), cards[1][0] + (card >> 1), cards[2][0] + (card >> 1)];
  const spine = centers[1];
  const advisorWidth = 13;
  const half = Math.min(17, width - 1 - advisorWidth - 3 - spine);
  const mainEnd = spine + half;
  return {
    width,
    project: { x: 0, w: 20 },
    main: { x0: spine - half, x1: mainEnd },
    advisor: { x0: mainEnd + 4, x1: mainEnd + 3 + advisorWidth },
    memory: { x0: spine - 20, x1: spine + 20 },
    cards,
    centers,
    lead: { x0: spine - 16, x1: spine + 16 },
    log: { x0: 0, x1: width - 1 },
    spine
  };
}
function build(c, h, kind, cols, rows) {
  let y = 0;
  const next = (n = 1) => {
    const at = y;
    y += n;
    return at;
  };
  const header = next();
  const separator = h.separator ? next() : void 0;
  const legend = next();
  const mainY = next(h.main);
  next(h.stem);
  const memoryY = next(h.memory);
  next(h.afterMemory);
  const delegate = next();
  next(h.afterDelegate);
  const bus = next();
  const cardArrowRow = h.cardArrow ? next() : void 0;
  const cardY = next(h.card);
  next(h.cardStem);
  const merge = next();
  const leadArrowRow = h.leadArrow ? next() : void 0;
  const leadY = next(h.lead);
  next(h.beforeLog);
  const logY = next(h.log);
  const prompt = next();
  const status = next();
  const height = y;
  const rect = (span_, top, rowCount) => span(span_.x0, span_.x1, top, top + rowCount - 1);
  const main2 = rect(c.main, mainY, h.main);
  const advisor = rect(c.advisor, mainY, h.main);
  const memory = rect(c.memory, memoryY, h.memory);
  const cards = c.cards.map(([x0, x1]) => span(x0, x1, cardY, cardY + h.card - 1));
  const lead = rect(c.lead, leadY, h.lead);
  const log = rect(c.log, logY, h.log);
  const project = { x: c.project.x, y: mainY, w: c.project.w, h: leadY + h.lead - mainY };
  const milestones = [mainY + (h.main >= 5 ? 3 : 2), cardY + (h.card >= 7 ? 3 : 2), leadY + 1];
  const advisorLink = mainY + 1;
  const projectEdge = project.x + project.w - 1;
  const { spine } = c;
  const mainBottom = mainY + h.main - 1;
  const memoryBottom = memoryY + h.memory - 1;
  const trunk = [...route([spine, mainBottom], [spine, memoryY]), ...route([spine, memoryBottom], [spine, memoryBottom + h.afterMemory]), ...h.afterDelegate ? route([spine, delegate + 1], [spine, bus]) : [[spine, bus]]];
  const branch = (center) => route([spine, bus], [center, bus], [center, cardY]);
  const toCard = (center) => [...trunk, ...branch(center).slice(1)];
  const home = (center) => route([center, cardY + h.card - 1], [center, merge], [spine, merge], [spine, leadY]);
  const [c0, c1, c2] = c.centers;
  const advisorOut = route([main2.x + main2.w - 1, advisorLink], [advisor.x, advisorLink]);
  const routes = {
    tool: route([spine, mainBottom], [spine, memoryY]),
    "advisor-out": advisorOut,
    "advisor-back": [...advisorOut].reverse(),
    "delegate-0": toCard(c0),
    "delegate-1": toCard(c1),
    "delegate-2": toCard(c2),
    "work-0": branch(c0),
    "work-1": branch(c1),
    "work-2": branch(c2),
    "back-0": home(c0),
    "back-1": home(c1),
    "back-2": home(c2),
    "memory-0": route([projectEdge, milestones[0]], [main2.x, milestones[0]]),
    "memory-1": route([projectEdge, milestones[1]], [cards[0].x, milestones[1]]),
    "memory-2": route([projectEdge, milestones[2]], [lead.x, milestones[2]])
  };
  const windowBar = rows > height;
  return {
    kind,
    width: c.width,
    height,
    originX: Math.max(0, Math.floor((cols - c.width) / 2)),
    originY: Math.max(0, Math.floor((rows - height - (windowBar ? 1 : 0)) / 2)) + (windowBar ? 1 : 0),
    windowBar,
    rows: { header, separator, legend, delegate, bus, merge, prompt, status },
    project,
    main: main2,
    advisor,
    memory,
    cards,
    lead,
    log,
    spine,
    cardCenters: c.centers,
    milestones,
    advisorLink,
    cardArrowRow,
    leadArrowRow,
    routes
  };
}
var cache = /* @__PURE__ */ new Map();
function layoutFor(cols, rows) {
  const kind = layoutKind(cols, rows);
  if (kind !== "full" && kind !== "compact") return void 0;
  const key = `${cols}x${rows}`;
  let layout = cache.get(key);
  if (!layout) {
    if (kind === "full") {
      layout = build(FULL_COLUMNS, FULL_HEIGHTS, "full", cols, rows);
    } else {
      const heights = { ...COMPACT_HEIGHTS };
      const spare = Math.max(0, rows - COMPACT_ROWS);
      for (const part of SPARE_ORDER.slice(0, spare)) heights[part] += 1;
      layout = build(compactColumns(cols), heights, "compact", cols, rows);
    }
    cache.set(key, layout);
  }
  return layout;
}

// src/scene/packets.ts
var TRAIL_CELLS = 3;
var TRAIL_GLYPHS = ["\u2022", "\xB7", "\xB7"];
function packetColor(route2) {
  if (route2.startsWith("advisor")) return theme.advisor;
  if (route2.startsWith("memory")) return theme.notes;
  if (route2 === "tool") return theme.main;
  return route2.startsWith("back") ? theme.subBright : theme.barSub;
}
var isText = (char) => /[\p{L}\p{N}]/u.test(char);
function drawPacket(buf, packet, layout) {
  const cells = layout.routes[packet.route];
  const color = packetColor(packet.route);
  const head = packet.t * (cells.length - 1 + TRAIL_CELLS);
  const headCell = Math.round(head);
  cells.forEach(([x, y], i) => {
    const distance = head - i;
    if (distance < -1 || distance > TRAIL_CELLS + 1) return;
    const intensity = distance < 0 ? 1 + distance : (1 - distance / (TRAIL_CELLS + 1)) ** 2;
    buf.tintFg(x, y, color, intensity);
    buf.blendBg(x, y, color, intensity * 0.05);
    if (isText(buf.charAtDraw(x, y))) return;
    const behind = headCell - i;
    if (behind === 0) buf.put(x, y, "\u25CF", color);
    else if (behind > 0 && behind <= TRAIL_GLYPHS.length) buf.put(x, y, TRAIL_GLYPHS[behind - 1], mix(color, theme.bg, (behind - 1) * 0.25));
  });
}

// src/scene/scene.ts
function paintBackground(buf) {
  buf.originX = 0;
  buf.originY = 0;
  buf.bg.fill(theme.bg);
  buf.fg.fill(theme.bg);
  buf.chars.fill(32);
  buf.attrs.fill(0);
}
var folderName = (cwd) => cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : "no session";
var mainModelOf = (view) => view.state.mainModel ?? view.preview?.main;
var advisorModelOf = (view) => view.state.advisorModel ?? view.preview?.advisor;
var mainName = (view) => displayModel(mainModelOf(view));
var advisorName = (view) => displayModel(advisorModelOf(view));
function builderName(view) {
  const { subagents } = view.state;
  const latest = [...subagents].reverse().find((s) => s.model);
  return displayModel(latest?.model ?? mainModelOf(view));
}
var EFFORT_LEVELS = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
function effortSegments(effort) {
  const level = effort ? EFFORT_LEVELS[effort] ?? 0 : 0;
  return [
    { text: "effort ", color: theme.dim },
    { text: "\u25AE".repeat(level), color: theme.main },
    { text: "\u25AF".repeat(5 - level), color: theme.faint },
    { text: ` ${effort ?? "\u2014"}`, color: theme.main }
  ];
}
function formatElapsed(t, start) {
  if (t <= 0 || start === void 0) return "--:--:--";
  const total = Math.max(0, Math.floor((t - start) / 1e3));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}
var KIND_COLOR2 = {
  main: theme.main,
  sub: theme.sub,
  advisor: theme.advisor,
  tool: theme.dim,
  memory: theme.metrics,
  error: theme.alert
};
function mainActivity(view, width) {
  const { state } = view;
  if (!view.connected) return fit("waiting for a session", width);
  if (state.ended) return "session ended";
  if (state.advisor.consults.some((c) => c.open)) return "replaying consult";
  if (state.status === "tool" && state.currentTool) {
    const { name, summary } = state.currentTool;
    return fit(toCells(summary ? `${name} \xB7 ${summary.replace(/\s+/g, " ")}` : name), width);
  }
  if (state.status === "working") return "working";
  return `--model ${modelAlias(mainModelOf(view))}`;
}
var isMainActive = (view) => view.connected && !view.state.ended && view.state.status !== "idle";
function drawWindowBar(buf, view, y, ox) {
  buf.fill(ox, y, buf.width, 1, theme.windowBar);
  buf.put(ox + 1, y, "\u25CF", theme.dotRed);
  buf.put(ox + 3, y, "\u25CF", theme.dotYellow);
  buf.put(ox + 5, y, "\u25CF", theme.dotGreen);
  centerText(buf, ox, buf.width, y, `${folderName(view.state.cwd)} \xB7 sinapsis \xB7 ${buf.width}x${buf.height}`, theme.dim);
}
function headerSegments(view) {
  const title = { text: "CLAUDE CODE ADVISOR", color: theme.text, bold: true };
  const gap = { text: "  \xB7  ", color: theme.dim };
  if (!mainModelOf(view)) return [title, gap, { text: "WAITING FOR A SESSION", color: theme.dim }];
  return [
    title,
    gap,
    { text: mainName(view).toUpperCase(), color: theme.main, bold: true },
    { text: " LEADS", color: theme.text, bold: true },
    { text: " \xB7 ", color: theme.text },
    { text: builderName(view).toUpperCase(), color: theme.sub, bold: true },
    { text: " BUILDS", color: theme.text, bold: true }
  ];
}
function drawLegend(buf, view, L) {
  const items = [
    [theme.main, `${mainName(view)} \xB7 lead`],
    [theme.sub, `${builderName(view)} \xB7 build`],
    [theme.metrics, "memories"],
    [theme.notes, "notes"],
    [theme.advisor, `${advisorName(view)} \xB7 advisor`]
  ];
  const used = items.reduce((sum, [, label]) => sum + cellLength(label) + 2, 0);
  const gap = Math.max(1, Math.floor((L.width - used) / (items.length + 1)));
  let x = gap;
  for (const [color, label] of items) {
    buf.put(x, L.rows.legend, "\u25A0", color);
    x = buf.text(x + 2, L.rows.legend, label, theme.dim) + gap;
  }
}
var BREATH_DEPTH = 0.22;
var panelBorder = (color, view) => mix(color, theme.panel, 0.12 + BREATH_DEPTH * (view.anim?.breath ?? 0));
var MILESTONES = ["before work", "repeat failure", "before sign-off"];
var fireCounts = (view) => {
  const counts = [view.state.memory.loaded.length ? 1 : 0, 0, 0];
  for (const touch of view.state.memory.touches) counts[memoryMilestone(view.state, touch)] += 1;
  return counts;
};
function memoryScopeLabel(view) {
  const { touches, loaded } = view.state.memory;
  return touches[touches.length - 1]?.scope ?? loaded[0]?.scope ?? (view.illustrativeDemo ? "project" : "\u2014");
}
var blank = { text: "", color: theme.dim };
var caption = (text) => ({ text, color: theme.dim });
function projectStats(view) {
  const { state } = view;
  const { touches, loaded } = state.memory;
  const last = touches[touches.length - 1];
  const actor = last ? last.agentId ? agentLabel(state, last.agentId) : modelAlias(state.mainModel) : loaded.length ? "session" : "none yet";
  const file = last?.file ?? loaded[0]?.file ?? "no files seen";
  const files = /* @__PURE__ */ new Set([...touches.map((t) => t.file), ...loaded.map((l) => l.file)]);
  const wrote = touches.some((t) => t.op === "write");
  const toolsShown = Math.round(view.anim?.numbers?.toolCalls ?? state.toolCalls);
  return {
    memory: [
      caption("agent memories:"),
      { text: `\xBB ${toCells(actor)}`, color: theme.notes },
      { text: `  ${toCells(file)}`, color: theme.notes }
    ],
    stats: [
      { text: "agents", color: theme.dim, value: String(state.subagents.length) },
      { text: "memories", color: theme.dim, value: String(files.size) },
      { text: "tools", color: theme.dim, value: String(toolsShown) },
      ...state.toolErrors ? [{ text: "errors", color: theme.alert, value: String(state.toolErrors) }] : [],
      wrote || files.size ? { text: wrote ? "persistent" : "read so far", color: theme.notes, bold: true } : { text: "none seen", color: theme.faint }
    ]
  };
}
function drawPanelLines(buf, r, x, from, to, lines) {
  const width = r.x + r.w - 1 - x;
  lines.slice(0, Math.max(0, to - from)).forEach((line, i) => {
    const y = from + i;
    buf.text(x, y, fit(line.text, line.value ? width - cellLength(line.value) - 1 : width), line.color, line.bold ? BOLD : 0);
    if (line.value) rightText(buf, r.x + r.w - 2, y, line.value, theme.text);
  });
}
function drawProject(buf, view, L) {
  const r = L.project;
  const memoryPulse = view.anim?.memoryPulse;
  box(buf, r, { color: panelBorder(theme.notes, view), fill: theme.panel });
  const [m0, m1, m2] = L.milestones;
  const inner = r.w - 2;
  const left = r.x + 1;
  const scope = [{ text: `memory: ${memoryScopeLabel(view)}`, color: theme.notes }];
  if (m0 - r.y >= 3) {
    centerText(buf, left, inner, r.y + 1, "PROJECT MEMORY", theme.notes, true);
    centerSegments(buf, left, inner, r.y + 2, scope);
  } else {
    buf.text(left + 1, r.y, " PROJECT MEMORY ", theme.notes, BOLD);
    centerSegments(buf, left, inner, r.y + 1, scope);
  }
  const lineX = left;
  for (let y = m0 + 1; y < m2; y += 1) buf.put(lineX, y, "\u254E", theme.faint);
  const text = lineX + 2;
  const { memory, stats } = projectStats(view);
  const firstSpace = m1 - m0 - 1;
  const notesA = [caption("saved findings"), caption("loaded next time"), caption("check old notes"), caption("against the code")];
  const notesB = [caption("per-agent notes"), caption("across sessions")];
  const a = firstSpace >= 18 ? [blank, ...notesA, blank, blank, ...memory, blank, ...stats, blank, ...notesB] : [...memory, blank, ...stats, ...firstSpace >= stats.length + 7 ? [blank, ...notesB] : []];
  drawPanelLines(buf, r, text, m0 + 1, m1, a);
  const workflow = [caption("build then debug"), caption("review the diff"), caption("save what held"), caption(r.w >= 21 ? "recheck old notes" : "recheck notes")];
  const secondSpace = m2 - m1 - 1;
  drawPanelLines(buf, r, text, m1 + 1, m2, secondSpace >= 6 ? [blank, ...workflow] : workflow);
  const counts = fireCounts(view);
  L.milestones.forEach((row, slot) => {
    const pulse = memoryPulse?.slot === slot ? memoryPulse.amount : 0;
    const fired = (counts[slot] ?? 0) > 0;
    if (pulse > 0) for (let x = left; x < r.x + r.w - 1; x += 1) buf.setBg(x, row, mix(theme.panel, theme.notes, 0.12 + pulse * 0.16));
    buf.put(lineX, row, fired || pulse > 0 ? "\u25C6" : "\u25C7", mix(theme.notes, theme.subBright, pulse * 0.6), fired || pulse > 0 ? BOLD : 0);
    buf.text(text, row, fit(MILESTONES[slot], r.w - 4), fired || pulse > 0 ? theme.text : mix(theme.notes, theme.bg, 0.15));
  });
}
function dashedArrow(buf, y, from, to, color) {
  for (let x = from; x < to; x += 1) buf.put(x, y, "\u2504", color);
  buf.put(to, y, "\u25B8", color);
}
var lineColor = (active, color) => active ? mix(color, theme.bg, 0.3) : theme.line;
function drawConnectors(buf, view, L) {
  const { spine, cardCenters, main: main2, memory, lead, cards, rows } = L;
  const { subagents } = view.state;
  const hasSubagents = subagents.length > 0;
  const anyDone = subagents.some((s) => !s.running);
  const counts = fireCounts(view);
  const edge = L.project.x + L.project.w;
  const targets = [main2.x - 1, cards[0].x - 1, lead.x - 1];
  L.milestones.forEach((row, slot) => {
    const pulse = view.anim?.memoryPulse?.slot === slot ? view.anim.memoryPulse.amount : 0;
    const base = (counts[slot] ?? 0) > 0 ? mix(theme.notes, theme.bg, 0.35) : mix(theme.notes, theme.bg, 0.68);
    dashedArrow(buf, row, edge, targets[slot], mix(base, theme.notes, pulse));
  });
  const consulted = view.state.advisor.calls > 0;
  dashedArrow(buf, L.advisorLink, main2.x + main2.w, L.advisor.x - 1, consulted ? mix(theme.advisor, theme.bg, 0.3) : mix(theme.advisor, theme.bg, 0.65));
  const trunk = lineColor(view.connected, theme.main);
  for (let y = main2.y + main2.h; y < memory.y; y += 1) buf.put(spine, y, "\u2502", trunk);
  const busColor = lineColor(hasSubagents, theme.sub);
  for (let y = memory.y + memory.h; y < rows.bus; y += 1) if (y !== rows.delegate) buf.put(spine, y, "\u2502", busColor);
  const [c0, c1, c2] = cardCenters;
  for (let x = c0; x <= c2; x += 1) buf.put(x, rows.bus, "\u2500", busColor);
  buf.put(c0, rows.bus, "\u250C", busColor);
  buf.put(c2, rows.bus, "\u2510", busColor);
  buf.put(c1, rows.bus, "\u253C", busColor);
  const backColor = lineColor(anyDone, theme.sub);
  const cardBottom = cards[0].y + cards[0].h;
  for (const center of cardCenters) for (let y = cardBottom; y < rows.merge; y += 1) buf.put(center, y, "\u2502", backColor);
  for (let x = c0; x <= c2; x += 1) buf.put(x, rows.merge, "\u2500", backColor);
  buf.put(c0, rows.merge, "\u2514", backColor);
  buf.put(c2, rows.merge, "\u2518", backColor);
  buf.put(c1, rows.merge, "\u253C", backColor);
  for (let y = rows.merge + 1; y < lead.y; y += 1) buf.put(spine, y, "\u2502", backColor);
}
function drawArrows(buf, L) {
  const cardRow = L.cardArrowRow ?? L.cards[0].y;
  for (const center of L.cardCenters) buf.put(center, cardRow, "\u25BC", theme.sub);
  buf.put(L.spine, L.leadArrowRow ?? L.lead.y, "\u25BC", theme.main);
}
function drawMainPanel(buf, view, r) {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.main, view), fill: theme.panel });
  const inner = r.w - 2;
  const left = r.x + 1;
  centerSegments(buf, left, inner, r.y + 1, [
    { text: mainName(view), color: theme.main },
    { text: " \xB7 main session", color: theme.main }
  ]);
  const task = state.title ?? state.lastPrompt;
  const active = isMainActive(view);
  const activity = [
    { text: mainActivity(view, active ? inner - 4 : inner - 2), color: state.status === "tool" ? theme.sub : theme.dim },
    { text: active ? ` ${spinnerFrame(view.now)}` : "", color: theme.main }
  ];
  const line = (y, segments) => centerSegments(buf, left, inner, y, segments);
  if (r.h >= 6) {
    centerText(buf, left + 1, inner - 2, r.y + 2, task ? plainText(task) : "no task yet", task ? theme.text : theme.faint);
    line(r.y + 3, effortSegments(state.effort));
    line(r.y + 4, activity);
  } else if (r.h === 5) {
    centerText(buf, left + 1, inner - 2, r.y + 2, task ? plainText(task) : "no task yet", task ? theme.text : theme.faint);
    line(r.y + 3, active || !view.connected ? activity : effortSegments(state.effort));
  } else {
    line(r.y + 2, active || !view.connected || state.ended ? activity : effortSegments(state.effort));
  }
}
function drawAdvisorBox(buf, view, r) {
  const { state } = view;
  const pulse = view.anim?.advisorPulse ?? 0;
  box(buf, r, {
    color: mix(panelBorder(theme.advisor, view), theme.subBright, pulse * 0.6),
    dashed: true,
    fill: mix(theme.panel, theme.advisor, pulse * 0.06),
    halo: pulse * 0.12,
    bold: pulse > 0.5
  });
  const inner = r.w - 2;
  const left = r.x + 1;
  const replaying = state.advisor.consults.some((c) => c.open);
  const enabled = state.advisorEnabled || Boolean(advisorModelOf(view));
  const status = replaying ? "replaying" : enabled ? "silent" : "off";
  const statusColor = replaying ? theme.advisor : theme.dim;
  const numbers = view.anim?.numbers;
  const calls = String(Math.round(numbers?.calls ?? state.advisor.calls));
  const tokens = formatTokens(Math.round(numbers?.tokensRead ?? state.advisor.tokensRead));
  const shortStatus = replaying ? status : `${status} \xB7 ${calls}`;
  centerText(buf, left, inner, r.y + 1, "ADVISOR", theme.advisor, true);
  if (r.h >= 6) {
    centerText(buf, left, inner, r.y + 2, advisorName(view).toLowerCase(), theme.text);
    centerText(buf, left, inner, r.y + 3, status, statusColor, replaying);
    centerText(buf, left, inner, r.y + 4, `${calls} \xB7 ${tokens}`, theme.dim);
  } else if (r.h === 5) {
    centerText(buf, left, inner, r.y + 2, advisorName(view).toLowerCase(), theme.text);
    centerText(buf, left, inner, r.y + 3, shortStatus, statusColor, replaying);
  } else {
    centerText(buf, left, inner, r.y + 2, shortStatus, statusColor, replaying);
  }
}
function memoryRows(view, count) {
  const { state } = view;
  const slots = cardSlots(view, count);
  const shown = (id) => view.anim?.numbers?.memory[id] ?? state.memory.touches.filter((t) => t.agentId === id).length;
  const ids = slots.map((slot) => slot.sub?.id).filter((id) => id !== void 0);
  const max = Math.max(1, ...ids.map(shown));
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const sub = slots[i]?.sub;
    const example = view.anim?.illustrative?.memory[i];
    const name = sub ? sub.agentType || sub.description ? agentLabel(state, sub.id) : "starting\u2026" : "\u2014";
    if (sub && example) {
      const check2 = example.label === "check";
      rows.push({ name, fraction: example.fraction, label: example.label, labelColor: check2 ? theme.main : theme.metrics, barColor: check2 ? theme.main : theme.barGood });
      continue;
    }
    if (!sub) {
      rows.push({ name: "\u2014", fraction: 0, label: "", labelColor: theme.faint, barColor: theme.barGood });
      continue;
    }
    const own = state.memory.touches.filter((t) => t.agentId === sub.id);
    const last = own[own.length - 1];
    const label = last ? memoryLabel(state, last) : "no memory";
    const check = label === "check";
    rows.push({ name, fraction: shown(sub.id) / max, label, labelColor: last ? check ? theme.main : theme.metrics : theme.faint, barColor: check ? theme.main : theme.barGood });
  }
  return rows;
}
function drawAgentMemory(buf, view, r) {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.metrics, view), fill: theme.panel });
  const left = r.x + 2;
  const right = r.x + r.w - 3;
  const rows = memoryRows(view, 3);
  const withMemory = view.illustrativeDemo ? state.subagents.length : new Set(state.memory.touches.map((t) => t.agentId).filter(Boolean)).size;
  const roles = [
    { text: "roles  ", color: theme.dim },
    { text: `${Math.min(withMemory, state.subagents.length)} / ${state.subagents.length}`, color: theme.metrics }
  ];
  const footerText = view.illustrativeDemo ? "memory \xB7 illustrative activity" : "memory \xB7 real tool calls";
  let y = r.y + 1;
  if (r.h >= 6) {
    buf.text(left, y, "AGENT MEMORY", theme.metrics, BOLD);
    writeSegments(buf, right - segmentsWidth(roles) + 1, y, roles);
    y += 1;
  } else {
    buf.text(left, r.y, " AGENT MEMORY ", theme.metrics, BOLD);
    writeSegments(buf, right - segmentsWidth(roles), r.y, [{ text: " ", color: theme.dim }, ...roles, { text: " ", color: theme.dim }]);
  }
  const barX = left + 15;
  const barWidth = Math.min(10, r.w - 28);
  rows.forEach((row, i) => {
    buf.text(left, y + i, fit(toCells(row.name), 14), row.name === "\u2014" ? theme.faint : theme.text);
    bar(buf, barX, y + i, barWidth, row.fraction, row.barColor);
    if (row.label) buf.text(barX + barWidth + 2, y + i, fit(row.label, right - barX - barWidth - 1), row.labelColor);
  });
  if (r.h >= 7) buf.text(left, r.y + r.h - 2, footerText, theme.caption);
  else buf.text(left, r.y + r.h - 1, ` ${footerText} `, theme.caption);
}
var toolsLabel = (count) => `${count} ${count === 1 ? "tool" : "tools"}`;
var GROW_SHARE = 0.6;
var FILL_SHARE = 0.4;
var DONE_DIM = 0.2;
function drawGrowingBox(buf, r, grow) {
  const k = easeOutCubic(segment(grow, 0, GROW_SHARE));
  const w = Math.max(3, Math.round(r.w * k));
  const h = Math.max(3, Math.round(r.h * k));
  const rect = { x: r.x + Math.floor((r.w - w) / 2), y: r.y + Math.floor((r.h - h) / 2), w, h };
  box(buf, rect, { color: mix(theme.bg, theme.sub, k), fill: theme.panel, halo: 0.12 * k });
}
function fadeArea(buf, r, toward, amount) {
  if (amount <= 0) return;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) buf.tintFg(x, y, toward, amount);
  }
}
function drawCard(buf, r, sub, slot, view, card) {
  if (!sub) {
    box(buf, r, { color: mix(theme.sub, theme.bg, 0.72), dashed: true, fill: theme.panel });
    centerText(buf, r.x + 1, r.w - 2, r.y + Math.floor(r.h / 2), "no subagent", theme.faint);
    return;
  }
  const grow = card?.grow ?? 1;
  const fade = card?.fade ?? (sub.running ? 0 : 1);
  if (grow < GROW_SHARE) {
    drawGrowingBox(buf, r, grow);
    return;
  }
  const index = view.state.subagents.indexOf(sub);
  const failed = sub.status !== void 0 && sub.status !== "completed";
  const pulse = view.anim?.memoryPulse?.card === slot ? view.anim.memoryPulse.amount : 0;
  const base = failed ? theme.alert : sub.running ? theme.sub : mix(theme.sub, theme.bg, 0.15);
  box(buf, r, { color: mix(base, theme.notes, pulse), fill: theme.panel, halo: pulse * 0.35, bold: pulse > 0.3 });
  const inner = r.w - 2;
  const left = r.x + 1;
  const name = sub.agentType || sub.description ? agentLabel(view.state, sub.id) : "starting\u2026";
  const model = displayModel(sub.model);
  const role = sub.description ? plainText(subagentName(view.state, sub.id)) : sub.agentType ?? "";
  const percent = view.anim?.illustrative?.percents[slot];
  const drawBar = (y) => {
    const right = percent !== void 0 && sub.running ? `${Math.round(percent)}%` : toolsLabel(sub.toolCount);
    const barX = left + 1;
    const width = Math.max(4, inner - 3 - cellLength(right));
    if (percent !== void 0 && sub.running) bar(buf, barX, y, width, percent / 100, theme.barSub);
    else if (sub.running) indeterminateBar(buf, barX, y, width, view.now / 1800 + index * 0.27, theme.barSub);
    else bar(buf, barX, y, width, easeOutCubic(segment(fade, 0, FILL_SHARE)), failed ? theme.barAlert : theme.barSub);
    rightText(buf, r.x + r.w - 2, y, right, theme.dim);
  };
  const statusLine = (y) => {
    const segments = sub.running ? [
      { text: `${discFrame(view.now, index)} `, color: theme.sub },
      { text: "running", color: theme.sub },
      { text: sub.currentTool ? ` \xB7 ${sub.currentTool}` : "", color: theme.dim }
    ] : failed ? [{ text: "\u2715 failed", color: theme.alert }] : [
      { text: "\u2713 ", color: theme.metrics },
      { text: "done", color: theme.metrics },
      { text: sub.durationMs !== void 0 ? ` \xB7 ${formatDuration(sub.durationMs)}` : "", color: theme.dim }
    ];
    const width = segmentsWidth(segments);
    if (width <= inner) centerSegments(buf, left, inner, y, segments);
    else centerSegments(buf, left, inner, y, segments.slice(0, 2));
  };
  const nameLine = (y, withModel) => {
    if (withModel) {
      const fitsFull = cellLength(name) + cellLength(model) + 3 <= inner;
      const shownModel = fitsFull ? model : modelAlias(sub.model);
      centerSegments(buf, left, inner, y, [
        { text: fit(toCells(name), Math.max(4, inner - cellLength(shownModel) - 3)), color: theme.text, bold: true },
        { text: " \xB7 ", color: theme.dim },
        { text: shownModel, color: theme.sub }
      ]);
    } else {
      const tag = sub.readOnly && cellLength(name) + 10 <= inner ? " read-only" : "";
      centerSegments(buf, left, inner, y, [
        { text: fit(toCells(name), inner - cellLength(tag)), color: theme.text, bold: true },
        { text: tag, color: theme.dim }
      ]);
    }
  };
  if (r.h >= 7) {
    nameLine(r.y + 1, false);
    centerText(buf, left, inner, r.y + 2, model, theme.sub);
    drawBar(r.y + 3);
    centerText(buf, left + 1, inner - 2, r.y + 4, role, theme.text);
    statusLine(r.y + 5);
  } else if (r.h === 6) {
    nameLine(r.y + 1, true);
    drawBar(r.y + 2);
    centerText(buf, left + 1, inner - 2, r.y + 3, role, theme.text);
    statusLine(r.y + 4);
  } else {
    nameLine(r.y + 1, true);
    drawBar(r.y + 2);
    statusLine(r.y + 3);
  }
  const appear = segment(grow, GROW_SHARE, 1);
  if (appear < 1) fadeArea(buf, { x: r.x + 1, y: r.y, w: r.w - 2, h: r.h - 1 }, theme.panel, 1 - appear);
  fadeArea(buf, r, theme.panel, DONE_DIM * easeInOutCubic(segment(fade, FILL_SHARE, 1)));
}
function cardSlots(view, count) {
  const { subagents } = view.state;
  const slots = view.anim?.cards;
  if (slots) return slots.slice(0, count).map((card) => ({ sub: card && subagents.find((s) => s.id === card.id), card }));
  const running = subagents.filter((s) => s.running);
  const done = subagents.filter((s) => !s.running);
  const picked = [...running.slice(-count), ...done.slice(-Math.max(0, count - running.length))];
  return subagents.filter((s) => picked.includes(s)).map((sub) => ({ sub }));
}
function drawDelegate(buf, view, L) {
  const { subagents } = view.state;
  const active = subagents.filter((s) => s.running).length;
  const text = "delegate to subagents";
  const x = L.spine - (cellLength(text) >> 1);
  buf.text(x, L.rows.delegate, text, subagents.length ? theme.text : theme.dim);
  if (active > 0) buf.put(x + cellLength(text) + 1, L.rows.delegate, spinnerFrame(view.now, 110), theme.sub);
}
function drawLead(buf, view, r) {
  const { subagents } = view.state;
  const done = subagents.filter((s) => !s.running);
  const glow = view.anim?.leadGlow ?? 0;
  const pulse = view.anim?.memoryPulse?.slot === 2 && view.anim.memoryPulse.card === void 0 ? view.anim.memoryPulse.amount : 0;
  box(buf, r, {
    color: mix(mix(panelBorder(theme.main, view), theme.subBright, glow * 0.8), theme.notes, pulse),
    fill: mix(theme.panel, theme.sub, glow * 0.1),
    halo: glow * 0.35 + pulse * 0.35,
    bold: glow > 0.3 || pulse > 0.3
  });
  const title = [
    { text: "back to ", color: theme.main },
    { text: mainName(view), color: theme.main },
    { text: " \xB7 lead", color: theme.main }
  ];
  const left = r.x + 1;
  const inner = r.w - 2;
  if (r.h >= 4) {
    centerSegments(buf, left, inner, r.y + 1, title);
    const latest = done[done.length - 1];
    const summary = latest?.summary ? `${done.length} back \xB7 ${plainText(latest.summary)}` : "integrate + verify";
    centerText(buf, left + 1, inner - 2, r.y + 2, summary, latest ? theme.text : theme.dim);
  } else {
    centerSegments(buf, left, inner, r.y + 1, [...title, { text: subagents.length ? ` \xB7 ${done.length}/${subagents.length}` : "", color: theme.dim }]);
  }
}
var LOG_SLIDE_MS = 260;
var LOG_SLIDE_CELLS = 8;
var LOG_TYPE_MS = 600;
var LOG_TYPE_MIN_RATE = 0.05;
function drawLog(buf, view, r) {
  box(buf, r, { color: theme.line, fill: theme.panel });
  buf.put(r.x + 3, r.y, "\u2524", theme.line);
  const end = buf.text(r.x + 4, r.y, " session log ", theme.dim);
  buf.put(end, r.y, "\u251C", theme.line);
  const live = view.replay ? view.replay.paused ? "paused" : view.replay.finished ? "replay end" : `replay x${view.replay.speed}` : view.connected ? "live" : "idle";
  rightText(buf, r.x + r.w - 3, r.y, ` ${live} \xB7 ${spinnerFrame(view.now, 200)} `, theme.faint);
  const rows = r.h - 2;
  const entries = view.log.slice(-rows);
  const textWidth = r.w - 24;
  entries.forEach((entry, i) => {
    const y = r.y + 1 + i;
    const text = fit(toCells(entry.text), textWidth);
    const age = entry.bornAt === void 0 ? Number.POSITIVE_INFINITY : Math.max(0, view.now - entry.bornAt);
    const slide = Math.round((1 - easeOutCubic(age / LOG_SLIDE_MS)) * LOG_SLIDE_CELLS);
    const headFade = 1 - easeOutCubic(age / LOG_SLIDE_MS);
    const length = cellLength(text);
    const typed = age === Number.POSITIVE_INFINITY ? length : Math.min(length, Math.floor(age * Math.max(LOG_TYPE_MIN_RATE, length / LOG_TYPE_MS)));
    const visible = Math.min(typed, Math.max(0, textWidth - slide));
    buf.text(r.x + 2 + slide, y, formatElapsed(entry.t, view.state.startedAt), mix(theme.dim, theme.panel, headFade));
    buf.text(r.x + 11 + slide, y, fit(toCells(entry.who), 10), mix(KIND_COLOR2[entry.kind], theme.panel, headFade));
    const tail = buf.text(r.x + 22 + slide, y, [...text].slice(0, visible).join(""), entry.kind === "error" ? theme.alert : theme.text);
    if (typed < length && tail < r.x + r.w - 1) buf.put(tail, y, "\u258C", KIND_COLOR2[entry.kind]);
  });
  if (entries.length === 0) buf.text(r.x + 2, r.y + 1, "nothing yet", theme.faint);
}
function drawPrompt(buf, view, y, x, width, note) {
  const { state } = view;
  const end = writeSegments(buf, x + 1, y, [
    { text: `${fit(toCells(folderName(state.cwd)), 18)} $ `, color: theme.metrics, bold: true },
    { text: "claude", color: theme.text },
    { text: " --model ", color: theme.text },
    { text: modelAlias(mainModelOf(view)), color: theme.text },
    { text: " --advisor ", color: theme.text },
    { text: modelAlias(advisorModelOf(view)), color: theme.text },
    { text: " ", color: theme.text }
  ]);
  if (Math.floor(view.now / 530) % 2 === 0) buf.put(end, y, "\u2588", theme.metrics);
  const label = note ?? (view.illustrativeDemo ? "demo: illustrative activity" : "reconstructed, not literal");
  if (end + cellLength(label) + 3 < x + width) rightText(buf, x + width - 2, y, label, view.illustrativeDemo && !note ? theme.caption : theme.faint);
}
function drawStatus(buf, view, y, x, width) {
  const { state } = view;
  const { subagents, memory } = state;
  const active = subagents.filter((s) => s.running).length;
  const bracket = (label, value, color) => [
    { text: `${label} `, color: theme.dim },
    { text: "[", color },
    { text: value, color },
    { text: "] ", color }
  ];
  const replaying = state.advisor.consults.some((c) => c.open);
  const hasMemory = memory.touches.length > 0 || memory.loaded.length > 0 || view.illustrativeDemo;
  const groups = [
    bracket(mainName(view), state.ended ? "ended" : isMainActive(view) ? "lead" : "idle", theme.main),
    bracket("subagents", `${subagents.length - active}/${subagents.length}`, theme.sub),
    bracket("memories", hasMemory ? memoryScopeLabel(view) : "none", theme.metrics),
    bracket(builderName(view), active ? "building" : "idle", theme.sub),
    bracket(advisorName(view), replaying ? "replaying" : "silent", theme.advisor)
  ];
  const pending = view.queue.pending.length;
  const queued = `${pending} queued`;
  const room = width - cellLength(queued) - 4;
  const segments = [];
  for (const group of groups) {
    if (segmentsWidth(segments) + segmentsWidth(group) > room) break;
    segments.push(...group);
  }
  const end = writeSegments(buf, x + 1, y, segments);
  view.queue.pending.slice(0, Math.max(0, x + width - cellLength(queued) - 4 - end)).forEach((kind, i) => buf.put(end + i, y, "\u25A0", KIND_COLOR2[kind]));
  rightText(buf, x + width - 2, y, queued, theme.dim);
}
function flashPanel(buf, r, amount) {
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      buf.blendBg(x, y, theme.alert, amount * 0.22);
      const onBorder = x === r.x || x === r.x + r.w - 1 || y === r.y || y === r.y + r.h - 1;
      if (onBorder) buf.tintFg(x, y, theme.alert, amount);
    }
  }
}
function renderFlow(buf, view, L) {
  buf.originX = L.originX;
  buf.originY = L.originY;
  if (L.windowBar) drawWindowBar(buf, view, -1, -L.originX);
  centerSegments(buf, 0, L.width, L.rows.header, headerSegments(view));
  if (L.rows.separator !== void 0) for (let x = L.log.x; x < L.log.x + L.log.w; x += 1) buf.put(x, L.rows.separator, "\u2501", theme.line);
  drawLegend(buf, view, L);
  drawConnectors(buf, view, L);
  drawProject(buf, view, L);
  drawMainPanel(buf, view, L.main);
  drawAdvisorBox(buf, view, L.advisor);
  drawAgentMemory(buf, view, L.memory);
  drawDelegate(buf, view, L);
  const visible = cardSlots(view, L.cards.length);
  L.cards.forEach((rect, i) => {
    const slot = visible[i];
    drawCard(buf, rect, slot?.sub, i, view, slot?.card);
  });
  drawLead(buf, view, L.lead);
  drawArrows(buf, L);
  drawLog(buf, view, L.log);
  drawPrompt(buf, view, L.rows.prompt, 0, L.width);
  drawStatus(buf, view, L.rows.status, 0, L.width);
  for (const packet of view.anim?.packets ?? []) drawPacket(buf, packet, L);
  const flash = view.anim?.errorFlash ?? 0;
  if (flash > 0) {
    flashPanel(buf, L.main, flash);
    flashPanel(buf, L.memory, flash);
    flashPanel(buf, L.log, flash);
  }
  const bootMs = view.anim?.bootMs;
  if (bootMs !== void 0 && bootMs < BOOT_MS) {
    const width = segmentsWidth(headerSegments(view));
    applyBootFull(buf, bootMs, L, Math.floor((L.width - width) / 2), width, () => theme.bg);
  }
  buf.originX = 0;
  buf.originY = 0;
}
function renderReduced(buf, view) {
  const { width, height } = buf;
  centerSegments(buf, 0, width, 0, headerSegments(view));
  const advisorRect = { x: 0, y: 1, w: 24, h: height - 8 };
  const { advisor } = view.state;
  box(buf, advisorRect, { color: theme.advisor, fill: theme.panel });
  const ax = advisorRect.x + 2;
  const aw = advisorRect.w - 4;
  centerText(buf, advisorRect.x + 1, advisorRect.w - 2, 2, `${advisorName(view).toUpperCase()} \xB7 on call`, theme.advisor, true);
  const consults = advisor.consults.slice(-(advisorRect.h - 8));
  consults.forEach((c, i) => {
    buf.put(ax, 3 + i, "\u25C6", c.isError ? theme.alert : theme.advisor);
    buf.text(ax + 2, 3 + i, fit(c.reason, aw - 2), theme.text);
  });
  if (consults.length === 0) buf.text(ax, 3, "no consults yet", theme.faint);
  const statsY = advisorRect.y + advisorRect.h - 5;
  const last = advisor.consults.filter((c) => !c.open).pop();
  buf.text(ax, statsY, fit(last ? `sealed \xB7 ${formatDuration(last.durationMs)}` : "inferred labels", aw), last ? theme.main : theme.faint);
  const stat = (y, label, value) => {
    buf.text(ax, y, label, theme.dim);
    rightText(buf, ax + aw - 1, y, value, theme.text, true);
  };
  stat(statsY + 1, "calls", String(advisor.calls));
  stat(statsY + 2, "tokens read", formatTokens(advisor.tokensRead));
  stat(statsY + 3, "routine turns", String(advisor.routineTurns));
  const rightX = advisorRect.w + 1;
  const rightW = width - rightX;
  const mainRect = { x: rightX, y: 1, w: rightW, h: 5 };
  box(buf, mainRect, { color: theme.main, fill: theme.panel });
  centerSegments(buf, rightX + 1, rightW - 2, 2, [
    { text: mainName(view), color: theme.main, bold: true },
    { text: " \xB7 main \xB7 effort ", color: theme.dim },
    { text: view.state.effort ?? "\u2014", color: theme.main }
  ]);
  const task = view.state.title ?? view.state.lastPrompt;
  centerText(buf, rightX + 2, rightW - 4, 3, task ? plainText(task) : "no task yet", task ? theme.text : theme.faint);
  centerSegments(buf, rightX + 1, rightW - 2, 4, [
    { text: mainActivity(view, rightW - 12), color: view.state.status === "tool" ? theme.sub : theme.dim },
    { text: isMainActive(view) ? `  ${spinnerFrame(view.now)}` : "", color: theme.main }
  ]);
  const cardCount = 3;
  const gap = 1;
  const cardW = Math.floor((rightW - gap * (cardCount - 1)) / cardCount);
  const visible = cardSlots(view, cardCount);
  for (let i = 0; i < cardCount; i += 1) {
    const r = { x: rightX + i * (cardW + gap), y: 6, w: cardW, h: 5 };
    const sub = visible[i]?.sub;
    if (!sub) {
      box(buf, r, { color: mix(theme.sub, theme.bg, 0.72), dashed: true, fill: theme.panel });
      continue;
    }
    const failed = sub.status !== void 0 && sub.status !== "completed";
    box(buf, r, { color: failed ? theme.alert : theme.sub, fill: theme.panel });
    const index = view.state.subagents.indexOf(sub);
    centerText(buf, r.x + 1, r.w - 2, r.y + 1, plainText(subagentName(view.state, sub.id)), theme.text, true);
    if (sub.running) indeterminateBar(buf, r.x + 2, r.y + 2, r.w - 4, view.now / 1800 + index * 0.27, theme.barSub);
    else bar(buf, r.x + 2, r.y + 2, r.w - 4, 1, failed ? theme.barAlert : theme.barSub);
    centerText(buf, r.x + 1, r.w - 2, r.y + 3, sub.running ? `tools: ${sub.toolCount}` : `${toolsLabel(sub.toolCount)}${sub.durationMs !== void 0 ? ` \xB7 ${formatDuration(sub.durationMs)}` : ""}`, failed ? theme.alert : theme.sub);
  }
  const toolsY = 11;
  const sorted = Object.entries(view.state.tools).sort((a, b) => b[1].count - a[1].count);
  buf.text(rightX, toolsY, fit(toCells(`tools ${view.state.toolCalls}: ${sorted.map(([n, s]) => `${n} ${s.count}${s.errors ? `!${s.errors}` : ""}`).join(" \xB7 ")}`), rightW), view.state.toolErrors ? theme.alert : theme.metrics);
  const logRect = { x: 0, y: advisorRect.y + advisorRect.h, w: width, h: height - advisorRect.h - 3 };
  drawLog(buf, view, logRect);
  drawPrompt(buf, view, height - 2, 0, width, `${COMPACT_ROWS}+ rows: full view`);
  drawStatus(buf, view, height - 1, 0, width);
  const flash = view.anim?.errorFlash ?? 0;
  if (flash > 0) {
    flashPanel(buf, mainRect, flash);
    flashPanel(buf, logRect, flash);
  }
}
function renderTooSmall(buf) {
  const lines = ["Agranda la ventana", `M\xEDnimo ${MIN_COLS}x${MIN_ROWS} \xB7 ahora ${buf.width}x${buf.height}`];
  const y = Math.floor((buf.height - lines.length) / 2);
  lines.forEach((line, i) => centerText(buf, 0, buf.width, y + i, line, i === 0 ? theme.text : theme.dim, i === 0));
}
function renderScene(buf, view) {
  paintBackground(buf);
  buf.tintsEnabled = !(view.flatBackground ?? false);
  const layout = layoutFor(buf.width, buf.height);
  if (layout) {
    renderFlow(buf, view, layout);
  } else if (layoutKind(buf.width, buf.height) === "reduced") {
    renderReduced(buf, view);
    const bootMs = view.anim?.bootMs;
    if (bootMs !== void 0 && bootMs < BOOT_MS) applyBootFade(buf, bootMs, () => theme.bg);
  } else renderTooSmall(buf);
}

// src/tui/ansi.ts
var SYNC_BEGIN = "\x1B[?2026h";
var SYNC_END = "\x1B[?2026l";
var ENTER_SCREEN = "\x1B[?1049h\x1B[?25l\x1B[?7l\x1B[2J";
var LEAVE_SCREEN = "\x1B[0m\x1B[?7h\x1B[?25h\x1B[?1049l";
var colorCode = (ground, color, mode) => mode === "truecolor" ? `${ground};2;${color >> 16 & 255};${color >> 8 & 255};${color & 255}` : `${ground};5;${to256(color)}`;
function encodeFrame(prev, next, mode) {
  const sameSize = prev !== null && prev.width === next.width && prev.height === next.height;
  const parts = [];
  const { width, height, chars, fg, bg, attrs } = next;
  let cursorX = -1;
  let cursorY = -1;
  let currentFg = -1;
  let currentBg = -1;
  let currentAttrs = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const char = chars[i];
      const cellFg = fg[i];
      const cellBg = bg[i];
      const cellAttrs = attrs[i];
      if (sameSize && char === prev.chars[i] && cellBg === prev.bg[i] && cellAttrs === prev.attrs[i]) {
        if (char === 32 || cellFg === prev.fg[i]) continue;
      }
      if (x !== cursorX || y !== cursorY) parts.push(`\x1B[${y + 1};${x + 1}H`);
      if (cellAttrs !== currentAttrs || cellFg !== currentFg || cellBg !== currentBg) {
        const codes = [];
        if (cellAttrs !== currentAttrs) codes.push(cellAttrs & BOLD ? "1" : "22");
        if (cellFg !== currentFg) codes.push(colorCode(38, cellFg, mode));
        if (cellBg !== currentBg) codes.push(colorCode(48, cellBg, mode));
        parts.push(`\x1B[${codes.join(";")}m`);
        currentAttrs = cellAttrs;
        currentFg = cellFg;
        currentBg = cellBg;
      }
      parts.push(String.fromCodePoint(char));
      cursorX = x + 1;
      cursorY = y;
    }
  }
  if (parts.length === 0) return "";
  return `${SYNC_BEGIN}${parts.join("")}\x1B[0m${SYNC_END}`;
}

// src/tui/terminal.ts
var RESTORE_SEQUENCE = `${SYNC_END}${LEAVE_SCREEN}`;
var TerminalSession = class {
  constructor(output, input, writeRestore = (data) => {
    output.write(data);
  }) {
    this.output = output;
    this.input = input;
    this.writeRestore = writeRestore;
  }
  output;
  input;
  writeRestore;
  restored = false;
  keyListener;
  enter(onKey) {
    this.output.write(ENTER_SCREEN);
    if (this.input?.isTTY) this.input.setRawMode?.(true);
    if (this.input) {
      this.keyListener = (data) => onKey(typeof data === "string" ? data : data.toString("utf8"));
      this.input.on("data", this.keyListener);
      this.input.resume();
    }
  }
  /** Se puede llamar varias veces: solo la primera hace algo. */
  restore() {
    if (this.restored) return;
    this.restored = true;
    try {
      this.writeRestore(RESTORE_SEQUENCE);
    } catch {
    }
    try {
      if (this.input) {
        if (this.keyListener) this.input.off("data", this.keyListener);
        if (this.input.isTTY) this.input.setRawMode?.(false);
        this.input.pause();
      }
    } catch {
    }
  }
  get isRestored() {
    return this.restored;
  }
};

// src/app.ts
var MAX_FPS = 60;
var MIN_FPS = 30;
var IDLE_FPS = 20;
var IDLE_FRAME_MS = 120;
var TIMER_STEP_MS = 16;
var PACE_TOLERANCE_MS = process.platform === "win32" ? 8 : 0.5;
function runApp(options) {
  const now = options.now ?? (() => performance.now());
  const director = new Director({ boot: true, illustrative: options.illustrative });
  const session = new TerminalSession(options.output, options.input);
  const { source, replay, output } = options;
  let front = null;
  let back = null;
  let fps = options.fps ?? MAX_FPS;
  let timer;
  let waitingDrain = false;
  let stopped = false;
  let frames = 0;
  let lastKey = "";
  let lastTick = 0;
  let unsubscribeResize;
  let finish = () => void 0;
  let fail = () => void 0;
  const done = new Promise((resolve2, reject) => {
    finish = resolve2;
    fail = reject;
  });
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribeResize?.();
    session.restore();
    void source.stop().finally(finish);
  }
  function onKey(key) {
    if (key === "q" || key === "Q" || key === "") {
      stop();
      return;
    }
    if (!replay) return;
    if (key === " ") replay.togglePause();
    else if (key === "+" || key === "=") replay.setSpeed(replay.speed * 2);
    else if (key === "-" || key === "_") replay.setSpeed(replay.speed / 2);
    lastKey = "";
  }
  function frameKey(time, size) {
    const status = replay ? `${replay.speed}|${replay.paused}|${replay.finished}` : "";
    const moving = director.isBusy(time) ? time : Math.floor(time / IDLE_FRAME_MS);
    return `${size.cols}x${size.rows}|${director.version}|${moving}|${status}`;
  }
  function frame() {
    const time = now();
    const size = options.size();
    for (const update of source.tick(time)) director.ingest(update, time);
    director.update(time);
    const key = frameKey(time, size);
    if (key !== lastKey) {
      lastKey = key;
      const started = performance.now();
      if (!back || back.width !== size.cols || back.height !== size.rows) back = new CellBuffer(size.cols, size.rows);
      const status = replay ? { speed: replay.speed, paused: replay.paused, finished: replay.finished } : void 0;
      renderScene(back, director.view(time, status, options.colorMode === "256"));
      const bytes = encodeFrame(front, back, options.colorMode);
      const computeMs = performance.now() - started;
      if (bytes) {
        if (!output.write(bytes)) {
          waitingDrain = true;
          if (!options.fps) fps = Math.max(MIN_FPS, fps - 10);
          output.once("drain", () => {
            waitingDrain = false;
            schedule();
          });
        } else if (!options.fps && fps < MAX_FPS) {
          fps = Math.min(MAX_FPS, fps + 0.25);
        }
      }
      options.onFrame?.({ computeMs, bytes: bytes.length });
      const swap = front;
      front = back;
      back = swap;
    }
    frames += 1;
    if (options.crashAtFrame !== void 0 && frames >= options.crashAtFrame) throw new Error(`Fallo forzado en el frame ${frames}`);
    if (options.exitWhenDone && replay?.finished && director.settled && !director.isAnimating(time)) stop();
  }
  function schedule() {
    if (stopped || waitingDrain) return;
    const rate = options.fps ?? (director.isBusy(now()) ? fps : IDLE_FPS);
    const due = lastTick + 1e3 / rate;
    const waitFor = (remaining) => remaining > TIMER_STEP_MS ? remaining - TIMER_STEP_MS : 1;
    const pace = () => {
      if (stopped) return;
      const remaining = due - now();
      if (remaining <= PACE_TOLERANCE_MS) tick();
      else timer = setTimeout(pace, waitFor(remaining));
    };
    timer = setTimeout(pace, waitFor(due - now()));
  }
  function tick() {
    if (stopped) return;
    lastTick = now();
    try {
      frame();
    } catch (error) {
      stopped = true;
      unsubscribeResize?.();
      session.restore();
      void source.stop().finally(() => fail(error));
      return;
    }
    schedule();
  }
  session.enter(onKey);
  unsubscribeResize = options.onResize?.(() => {
    front = null;
    back = null;
    lastKey = "";
  });
  tick();
  return { done, stop, session, director };
}

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
function memoryScopeOf(path) {
  const normal = path.replace(/\\/g, "/").toLowerCase();
  if (normal.includes("/.claude/agent-memory/") || normal.startsWith(".claude/agent-memory/")) return "agent";
  if (/\/\.claude\/projects\/[^/]+\/memory\//.test(normal)) return "auto";
  const name = baseName(normal);
  if (name === "claude.md" || name === "claude.local.md") return "project";
  if (name === "memory.md") return "auto";
  return void 0;
}
var MEMORY_READ_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob"]);
var MEMORY_WRITE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function memoryTouchOf(name, input) {
  if (!isObject(input)) return void 0;
  const op = MEMORY_WRITE_TOOLS.has(name) ? "write" : MEMORY_READ_TOOLS.has(name) ? "read" : void 0;
  const path = str(input.file_path) ?? str(input.path);
  if (!op || !path) return void 0;
  const scope = memoryScopeOf(path);
  return scope ? { file: baseName(path), scope, op } : void 0;
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
  const loadedMemory = /* @__PURE__ */ new Set();
  function memoryLoads(attachment, t) {
    const files = [];
    for (const entry of blocksOf(attachment.files)) {
      const path = str(entry.path);
      const scope = path ? memoryScopeOf(path) : void 0;
      if (!path || !scope || loadedMemory.has(path)) continue;
      loadedMemory.add(path);
      files.push({ file: baseName(path), scope });
    }
    return files.length ? [{ type: "memory_load", t, files }] : [];
  }
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
        const memory = memoryTouchOf(name, block.input);
        events.push({ type: "tool_call", t, id, name, summary: summarizeToolInput(name, block.input), ...agentId ? { agentId } : {}, ...memory ? { memory } : {} });
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
    if (!agentId) events.push(...sessionInfo(t, { cwd: str(line.cwd) }));
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
        if (!agentId && attachment?.type === "instructions") events.push(...memoryLoads(attachment, t));
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
  const who2 = agentId ? `[${agentId.slice(0, 8)}] ` : "";
  const details = Object.entries(rest).filter(([, value]) => value !== void 0).map(([key, value]) => {
    const text = typeof value === "string" ? value.replace(/\s+/g, " ") : String(value);
    return `${key}=${text.length > 60 ? `${text.slice(0, 59)}\u2026` : text}`;
  }).join(" ");
  return `${clock(t)} ${who2}${type}${details ? ` ${details}` : ""}`;
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
  let finishedAt;
  let stopped = false;
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
      if (options.loopDelayMs !== void 0 && !stopped && !paused && cursor >= steps.length) {
        finishedAt ??= now;
        if (now - finishedAt >= options.loopDelayMs) {
          updates.push({ kind: "reset", sessionId: "replay" });
          cursor = 0;
          position = 0;
          finishedAt = void 0;
        }
      }
      return updates;
    },
    async stop() {
      stopped = true;
      cursor = steps.length;
    }
  };
}

// src/cli.ts
var assetPath = (relative) => fileURLToPath(new URL(relative, import.meta.url));
var DEMO_LOOP_DELAY_MS = 9e3;
function version() {
  const pkg = JSON.parse(readFileSync2(assetPath("../package.json"), "utf8"));
  return pkg.version;
}
function createSource(args) {
  const { command } = args;
  if (command.kind === "follow") return createLiveSource({ sessionId: command.session, project: command.project });
  const file = command.kind === "demo" ? assetPath("../fixtures/sesion-haiku-advisor-opus.jsonl") : command.file;
  if (!existsSync(file)) throw new ArgsError(`No existe el archivo: ${file}`);
  const loop = command.kind === "demo" && !args.printEvents && process.env.SINAPSIS_EXIT_WHEN_DONE !== "1";
  return createReplay(loadTranscript(file), { speed: args.speed, loopDelayMs: loop ? DEMO_LOOP_DELAY_MS : void 0 });
}
function forcedSize(env) {
  const match = /^(\d+)x(\d+)$/.exec(env.SINAPSIS_FORCE_TTY ?? "");
  return match ? { cols: Number(match[1]), rows: Number(match[2]) } : void 0;
}
async function runInterface(args, source) {
  const { stdout, stdin, env } = process;
  const forced = forcedSize(env);
  if (!stdout.isTTY && !forced) {
    await source.stop();
    process.stderr.write("sinapsis necesita una terminal: la salida no es una TTY. Usa --print-events para ver los eventos como texto.\n");
    process.exitCode = 1;
    return;
  }
  const replay = args.command.kind === "follow" ? void 0 : source;
  const app = runApp({
    source,
    replay,
    output: stdout,
    // En el modo de prueba las teclas llegan por stdin, aunque no sea una terminal.
    input: stdin.isTTY || forced ? stdin : void 0,
    size: () => forced ?? { cols: stdout.columns || 80, rows: stdout.rows || 24 },
    onResize: (listener) => {
      stdout.on("resize", listener);
      return () => stdout.off("resize", listener);
    },
    colorMode: forced ? env.SINAPSIS_COLOR === "256" ? "256" : "truecolor" : detectColorMode(stdout.getColorDepth()),
    illustrative: args.command.kind === "demo",
    fps: args.fps,
    crashAtFrame: env.SINAPSIS_CRASH_AT_FRAME ? Number(env.SINAPSIS_CRASH_AT_FRAME) : void 0,
    exitWhenDone: env.SINAPSIS_EXIT_WHEN_DONE === "1"
  });
  const restoreAndExit = (code) => {
    app.session.restore();
    process.exit(code);
  };
  process.once("SIGINT", () => app.stop());
  process.once("SIGTERM", () => app.stop());
  process.once("SIGHUP", () => app.stop());
  process.once("exit", () => app.session.restore());
  process.once("uncaughtException", (error) => {
    app.session.restore();
    process.stderr.write(`${error.stack ?? error.message}
`);
    restoreAndExit(1);
  });
  process.once("unhandledRejection", (reason) => {
    app.session.restore();
    process.stderr.write(`${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}
`);
    restoreAndExit(1);
  });
  await app.done;
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
  await runInterface(args, source);
}
function flushAndExit() {
  process.stdout.write("", () => process.stderr.write("", () => process.exit()));
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  if (error instanceof ArgsError) process.stderr.write(`
${USAGE}`);
  process.exitCode = 1;
}).finally(flushAndExit);
