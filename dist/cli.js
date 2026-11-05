#!/usr/bin/env node

// src/cli.ts
import { existsSync, readFileSync as readFileSync2, writeSync } from "fs";
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
function who(state, agentId) {
  if (!agentId) return { who: modelAlias(state.mainModel), kind: "main" };
  const sub = state.subagents.find((s) => s.id === agentId);
  const short = (sub?.description ?? sub?.agentType ?? agentId.slice(0, 7)).split(/\s+/)[0]?.toLowerCase() ?? "";
  return { who: `${modelAlias(sub?.model ?? state.mainModel)}:${short}`, kind: "sub" };
}
function describeEvent(event, state) {
  const { t } = event;
  const advisor = modelAlias(state.advisorModel);
  switch (event.type) {
    case "user_prompt":
      return { t, who: "you", kind: "main", text: plainText(event.text) };
    case "tool_call":
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
      return { t, who: `${modelAlias(event.model ?? state.mainModel)}:${event.subagentId.slice(0, 7)}`, kind: "sub", text: "subagent started" };
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
    subagents: []
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

// src/scene/layout.ts
var FULL_COLS = 96;
var FULL_ROWS = 48;
var MIN_COLS = 80;
var MIN_ROWS = 24;
var span = (x0, x1, y0, y1) => ({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
var FULL = {
  advisor: span(2, 23, 5, 38),
  main: span(39, 76, 5, 11),
  advisorState: span(78, 94, 5, 11),
  metrics: span(38, 83, 13, 19),
  cards: [span(28, 48, 24, 30), span(50, 71, 24, 30), span(73, 94, 24, 30)],
  lead: span(43, 78, 35, 38),
  log: span(2, 94, 39, 44),
  rows: { windowBar: 0, header: 2, separator: 3, legend: 4, delegate: 21, prompt: 45, status: 46 },
  /** Columna de la columna vertebral y centros de las tarjetas. */
  spine: 61,
  cardCenters: [38, 61, 84],
  arrows: { main: 9, cards: 26, lead: 35 }
};
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
var delegateRoute = (center) => route([FULL.spine, 20], [FULL.spine, 22], [center, 22], [center, 23]);
var backRoute = (center) => route([center, 31], [center, 32], [FULL.spine, 32], [FULL.spine, 34]);
var advisorRow = (from, y) => route([from, y], [24, y]);
var ROUTES = {
  tool: route([FULL.spine, 11], [FULL.spine, 13]),
  "delegate-0": delegateRoute(FULL.cardCenters[0]),
  "delegate-1": delegateRoute(FULL.cardCenters[1]),
  "delegate-2": delegateRoute(FULL.cardCenters[2]),
  "back-0": backRoute(FULL.cardCenters[0]),
  "back-1": backRoute(FULL.cardCenters[1]),
  "back-2": backRoute(FULL.cardCenters[2]),
  "advisor-out-0": advisorRow(38, FULL.arrows.main),
  "advisor-out-1": advisorRow(27, FULL.arrows.cards),
  "advisor-out-2": advisorRow(42, FULL.arrows.lead + 1),
  "advisor-back-0": advisorRow(38, FULL.arrows.main).reverse(),
  "advisor-back-1": advisorRow(27, FULL.arrows.cards).reverse(),
  "advisor-back-2": advisorRow(42, FULL.arrows.lead + 1).reverse()
};
function consultSlot(reason) {
  if (reason === "after errors" || reason === "after subagents") return 1;
  return reason === "before done" ? 2 : 0;
}
function layoutKind(cols, rows) {
  if (cols >= FULL_COLS && rows >= FULL_ROWS) return "full";
  if (cols >= MIN_COLS && rows >= MIN_ROWS) return "reduced";
  return "too-small";
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
  /** Fondo: viñeta de esquinas oscuras a un centro más claro. */
  bgEdge: rgb("#13182d"),
  bgCenter: rgb("#232b4e"),
  /** Interior de los paneles, más oscuro que el fondo que los rodea. */
  panel: rgb("#0f1225"),
  chip: rgb("#161d32"),
  windowBar: rgb("#0f1426"),
  main: rgb("#7ec2ed"),
  sub: rgb("#afd5ff"),
  subBright: rgb("#e6ffff"),
  advisor: rgb("#adacfa"),
  metrics: rgb("#75c8a6"),
  alert: rgb("#e08a4f"),
  text: rgb("#eaefff"),
  dim: rgb("#7c88a8"),
  faint: rgb("#4c5164"),
  barTrack: rgb("#253352"),
  barGood: rgb("#34977a"),
  barAlert: rgb("#bb763d"),
  barSub: rgb("#5797c8"),
  dotRed: rgb("#ff5f57"),
  dotYellow: rgb("#febc2e"),
  dotGreen: rgb("#28c840")
};

// src/scene/boot.ts
var BOOT_MS = 2200;
var PANELS = [
  { rect: FULL.advisor, from: 150, to: 1150 },
  { rect: FULL.main, from: 350, to: 1250 },
  { rect: FULL.advisorState, from: 500, to: 1300 },
  { rect: FULL.metrics, from: 650, to: 1450 },
  { rect: FULL.cards[0], from: 850, to: 1550 },
  { rect: FULL.cards[1], from: 950, to: 1650 },
  { rect: FULL.cards[2], from: 1050, to: 1750 },
  { rect: FULL.lead, from: 1200, to: 1850 },
  { rect: FULL.log, from: 1300, to: 2e3 }
];
var BORDER_SHARE = 0.6;
var MARGIN_X = 2;
var MARGIN_Y = 1;
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
var insideRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
function revealPanel(buf, r, t, base) {
  if (t >= 1) return;
  const borderT = easeInOutCubic(segment(t, 0, BORDER_SHARE));
  const contentT = easeOutCubic(segment(t, BORDER_SHARE, 1));
  for (let y = r.y - MARGIN_Y; y < r.y + r.h + MARGIN_Y; y += 1) {
    for (let x = r.x - MARGIN_X; x < r.x + r.w + MARGIN_X; x += 1) {
      const inside = insideRect(r, x, y);
      const onBorder = inside && (x === r.x || x === r.x + r.w - 1 || y === r.y || y === r.y + r.h - 1);
      if (onBorder) continue;
      if (!inside && PANELS.some(({ rect }) => rect !== r && insideRect(rect, x, y))) continue;
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
function hideRow(buf, y, fromCol, base) {
  for (let x = fromCol; x < FULL_COLS; x += 1) hide(buf, x, y, base);
}
function fadeRow(buf, y, amount, base) {
  for (let x = 0; x < FULL_COLS; x += 1) {
    buf.tintFg(x, y, base(x, y), amount);
    buf.blendBg(x, y, base(x, y), amount);
  }
}
function fadeConnectors(buf, amount, base) {
  const panelCells = (x, y) => PANELS.some(({ rect: r }) => x >= r.x - MARGIN_X && x < r.x + r.w + MARGIN_X && y >= r.y - MARGIN_Y && y < r.y + r.h + MARGIN_Y);
  for (let y = FULL.rows.legend + 1; y < FULL.log.y; y += 1) {
    for (let x = 0; x < FULL_COLS; x += 1) {
      if (panelCells(x, y)) continue;
      if (amount >= 1) {
        hide(buf, x, y, base);
      } else {
        buf.tintFg(x, y, base(x, y), amount);
        buf.blendBg(x, y, base(x, y), amount);
      }
    }
  }
}
function applyBootFull(buf, ms, headerStart, headerLength, base) {
  const typed = Math.floor(easeInOutCubic(segment(ms, 0, 800)) * headerLength);
  hideRow(buf, FULL.rows.header, headerStart + typed, base);
  if (typed > 0 && typed < headerLength) {
    buf.put(headerStart + typed, FULL.rows.header, "\u258C", theme.main);
  }
  fadeRow(buf, FULL.rows.separator, 1 - easeOutCubic(segment(ms, 300, 800)), base);
  fadeRow(buf, FULL.rows.legend, 1 - easeOutCubic(segment(ms, 450, 950)), base);
  fadeConnectors(buf, 1 - easeOutCubic(segment(ms, 1500, 2100)), base);
  for (const panel of PANELS) revealPanel(buf, panel.rect, segment(ms, panel.from, panel.to), base);
  const bottom = 1 - easeOutCubic(segment(ms, 1700, BOOT_MS));
  fadeRow(buf, FULL.rows.prompt, bottom, base);
  fadeRow(buf, FULL.rows.status, bottom, base);
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
      return "tool";
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
var isNeutral = (item) => item.kind === "instant" && item.events.every((e) => e.type === "message_usage" || e.type === "session_info" || e.type === "request_start");
var KIND_COLOR = {
  instant: "tool",
  tool: "tool",
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
var TYPE_CHARS_PER_MS = 0.03;
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
  packets = [];
  consultAnim;
  consultSlotById = /* @__PURE__ */ new Map();
  cards = [void 0, void 0, void 0];
  /** Subagentes activos sin tarjeta libre. */
  waitingCards = [];
  leadGlowStart;
  tweens = new TweenSet();
  lastLogBorn;
  flashStart;
  constructor(options = {}) {
    this.animateBoot = options.boot ?? false;
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
      this.consultAnim = void 0;
      this.consultSlotById.clear();
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
      this.log.push({ ...entry, bornAt });
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
    } else if (item.kind === "tool" && first?.type === "tool_call" && !first.agentId) {
      this.addPacket("tool", start, duration);
    } else if (item.kind === "advisor" && first?.type === "advisor_consult") {
      const slot = consultSlot(first.reason);
      this.consultSlotById.set(first.id, slot);
      this.consultAnim = { id: first.id, start };
      if (item.endEvents.length) {
        this.addPacket(`advisor-out-${slot}`, start, duration * PACKET_SHARE);
        this.addPacket(`advisor-back-${slot}`, start + duration * (1 - PACKET_SHARE), duration * PACKET_SHARE);
      } else {
        this.addPacket(`advisor-out-${slot}`, start, duration * 0.6);
      }
    } else if (item.kind === "advisor-reply" && first?.type === "advisor_reply") {
      const slot = this.consultSlotById.get(first.id) ?? 0;
      this.addPacket(`advisor-back-${slot}`, start, duration);
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
    const { advisor, toolCalls, tools } = this.shown;
    const follow = (key, target, duration = COUNT_MS) => this.tweens.track(key, target, now, duration);
    return {
      toolCalls: follow("toolCalls", toolCalls),
      calls: follow("calls", advisor.calls),
      tokensRead: follow("tokensRead", advisor.tokensRead, TOKENS_MS),
      routineTurns: follow("routineTurns", advisor.routineTurns),
      tools: Object.fromEntries(Object.entries(tools).map(([name, stat]) => [name, follow(`tool:${name}`, stat.count)]))
    };
  }
  /** Lleva los contadores a su valor sin animarlos: lo que ya había ocurrido no se cuenta otra vez. */
  settleNumbers() {
    const { advisor, toolCalls, tools } = this.shown;
    this.tweens.settle("toolCalls", toolCalls);
    this.tweens.settle("calls", advisor.calls);
    this.tweens.settle("tokensRead", advisor.tokensRead);
    this.tweens.settle("routineTurns", advisor.routineTurns);
    for (const [name, stat] of Object.entries(tools)) this.tweens.settle(`tool:${name}`, stat.count);
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
    return this.packets.filter((p) => now >= p.start).map((p) => ({ route: p.route, t: progress(now, p.start, p.duration) }));
  }
  advisorMotion(now) {
    const active = this.queue.active;
    if (!active || active.item.kind !== "advisor" && active.item.kind !== "advisor-reply") return {};
    const elapsed = now - active.start;
    const typing = this.consultAnim ? { id: this.consultAnim.id, chars: Math.floor((now - this.consultAnim.start) * TYPE_CHARS_PER_MS) } : void 0;
    return { advisorPulse: 0.5 + 0.5 * Math.sin(elapsed / PULSE_PERIOD_MS), typingConsult: typing };
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
  /** Hay algo moviéndose que exige la frecuencia alta. */
  isBusy(now) {
    const boot = this.bootElapsed(now);
    return !this.queue.isEmpty || this.packets.length > 0 || this.tweens.isActive(now) || this.cardsMoving(now) || this.flashStart !== void 0 && now < this.flashStart + ERROR_FLASH_MS || this.lastLogBorn !== void 0 && now < this.lastLogBorn + LOG_MOTION_MS || boot !== void 0 && boot < BOOT_MS;
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
      ...this.advisorMotion(now)
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
var HEAVY = { h: "\u2501", v: "\u2503", tl: "\u250F", tr: "\u2513", bl: "\u2517", br: "\u251B" };
var DASHED = { h: "\u254D", v: "\u254F", tl: "\u250F", tr: "\u2513", bl: "\u2517", br: "\u251B" };
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
  const glyphs = options.dashed ? DASHED : HEAVY;
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
function bar(buf, x, y, width, fraction, color, track = theme.barTrack) {
  const total = Math.max(0, Math.min(1, fraction)) * width;
  const full = Math.floor(total);
  const eighths = Math.floor((total - full) * 8);
  for (let i = 0; i < width; i += 1) {
    buf.clearCell(x + i, y, track);
    if (i < full) buf.put(x + i, y, "\u2588", color);
    else if (i === full && eighths > 0) buf.put(x + i, y, PARTIAL[eighths], color);
  }
}
function thinBar(buf, x, y, width, fraction, color, track = theme.barTrack) {
  const halves = Math.round(Math.max(0, Math.min(1, fraction)) * width * 2);
  for (let i = 0; i < width; i += 1) {
    const filled = halves - i * 2;
    if (filled >= 2) buf.put(x + i, y, "\u2584", color);
    else if (filled === 1) {
      buf.put(x + i, y, "\u2596", color);
    } else buf.put(x + i, y, "\u2584", track);
  }
}
function indeterminateBar(buf, x, y, width, phase, color, track = theme.barTrack) {
  const band = Math.max(3, width * 0.32);
  const start = (phase - Math.floor(phase)) * (width + band) - band;
  const end = start + band;
  for (let i = 0; i < width; i += 1) {
    buf.clearCell(x + i, y, track);
    const covered = Math.min(i + 1, end) - Math.max(i, start);
    if (covered <= 0) continue;
    if (covered >= 1) {
      buf.put(x + i, y, "\u2588", color);
    } else if (start > i) {
      buf.setBg(x + i, y, color);
      buf.put(x + i, y, PARTIAL[Math.max(1, Math.round((1 - covered) * 8))] ?? "\u258F", track);
    } else {
      buf.put(x + i, y, PARTIAL[Math.max(1, Math.round(covered * 8))] ?? "\u2589", color);
    }
  }
}
var SPINNER = ["|", "/", "-", "\\"];
var spinnerFrame = (now, period = 120) => SPINNER[Math.floor(now / period) % SPINNER.length];
function wrap(text, width, maxLines) {
  const lines = [];
  let line = "";
  for (const raw of toCells(text).split(/\s+/)) {
    let word = raw;
    while (cellLength(word) > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      const chars = [...word];
      lines.push(chars.slice(0, width).join(""));
      word = chars.slice(width).join("");
    }
    const next = line ? `${line} ${word}` : word;
    if (cellLength(next) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = cellLength(last) >= width ? fit(last, width) : `${last}\u2026`;
    return kept;
  }
  return lines;
}

// src/scene/packets.ts
var TRAIL_CELLS = 5;
function packetColor(route2) {
  if (route2.startsWith("advisor")) return theme.advisor;
  if (route2 === "tool") return theme.metrics;
  return route2.startsWith("back") ? theme.subBright : theme.sub;
}
var isText = (char) => /[\p{L}\p{N}]/u.test(char);
function drawPacket(buf, packet) {
  const cells = ROUTES[packet.route];
  const color = packetColor(packet.route);
  const bright = mix(color, theme.subBright, 0.6);
  const head = packet.t * (cells.length - 1 + TRAIL_CELLS);
  cells.forEach(([x, y], i) => {
    const distance = head - i;
    if (distance < -1 || distance > TRAIL_CELLS) return;
    const intensity = distance < 0 ? 1 + distance : (1 - distance / TRAIL_CELLS) ** 2;
    buf.tintFg(x, y, bright, intensity);
    buf.blendBg(x, y, color, intensity * 0.3);
  });
  const headCell = Math.round(head);
  const cell = cells[headCell];
  if (cell && !isText(buf.charAtDraw(cell[0], cell[1]))) buf.put(cell[0], cell[1], "\u25CF", bright);
}

// src/scene/scene.ts
var backgroundCache = /* @__PURE__ */ new Map();
function paintBackground(buf, flat) {
  if (flat) {
    buf.fill(0, 0, buf.width, buf.height, theme.bgEdge);
    return;
  }
  const key = `${buf.width}x${buf.height}`;
  let cached = backgroundCache.get(key);
  if (!cached) {
    cached = new Int32Array(buf.width * buf.height);
    const cx = (buf.width - 1) / 2;
    const cy = (buf.height - 1) / 2;
    for (let y = 0; y < buf.height; y += 1) {
      for (let x = 0; x < buf.width; x += 1) {
        const distance = Math.hypot((x - cx) / (cx || 1), (y - cy) / (cy || 1)) / Math.SQRT2;
        cached[y * buf.width + x] = mix(theme.bgCenter, theme.bgEdge, Math.min(1, distance * 1.15) ** 1.4);
      }
    }
    backgroundCache.set(key, cached);
  }
  buf.bg.set(cached);
  buf.chars.fill(32);
  buf.attrs.fill(0);
  buf.fg.set(cached);
}
function baseColor(buf, flat) {
  const cached = backgroundCache.get(`${buf.width}x${buf.height}`);
  if (flat || !cached) return () => theme.bgEdge;
  return (x, y) => cached[y * buf.width + x] ?? theme.bgEdge;
}
var folderName = (cwd) => cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : "no session";
var mainName = (view) => displayModel(view.state.mainModel);
var advisorName = (view) => displayModel(view.state.advisorModel);
var EFFORT_LEVELS = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
function effortMeter(effort) {
  const level = effort ? EFFORT_LEVELS[effort] ?? 0 : 0;
  return `${"\u25AE".repeat(level)}${"\u25AF".repeat(5 - level)}`;
}
function formatClock(t) {
  if (t <= 0) return "--:--:--";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
var KIND_COLOR2 = {
  main: theme.main,
  sub: theme.sub,
  advisor: theme.advisor,
  tool: theme.metrics,
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
  return "idle";
}
function drawWindowBar(buf, view, y, width, ox) {
  buf.fill(ox, y, width, 1, theme.windowBar);
  buf.put(ox + 1, y, "\u25CF", theme.dotRed);
  buf.put(ox + 3, y, "\u25CF", theme.dotYellow);
  buf.put(ox + 5, y, "\u25CF", theme.dotGreen);
  centerText(buf, ox, width, y, `${folderName(view.state.cwd)} \u2014 sinapsis \u2014 ${buf.width}x${buf.height}`, theme.dim);
}
function headerSegments(view) {
  if (!view.state.mainModel) {
    return [
      { text: "CLAUDE CODE ADVISOR", color: theme.text, bold: true },
      { text: "  \xB7  ", color: theme.dim },
      { text: "WAITING FOR A SESSION", color: theme.dim }
    ];
  }
  const main2 = mainName(view).toUpperCase();
  const advisor = advisorName(view).toUpperCase();
  return [
    { text: "CLAUDE CODE ADVISOR", color: theme.text, bold: true },
    { text: "  \xB7  ", color: theme.dim },
    { text: main2, color: theme.main, bold: true },
    { text: " BUILDS", color: theme.text, bold: true },
    { text: "  \xB7  ", color: theme.dim },
    { text: advisor, color: theme.advisor, bold: true },
    { text: " THINKS", color: theme.text, bold: true }
  ];
}
function drawLegend(buf, view, ox, oy) {
  const y = oy + FULL.rows.legend;
  const main2 = mainName(view).toLowerCase();
  const items = [
    [3, theme.main, `${main2} \xB7 main`],
    [23, theme.sub, `${main2} \xB7 subagents`],
    [48, theme.advisor, `${advisorName(view).toLowerCase()} \xB7 advisor`],
    [71, theme.metrics, "tools"]
  ];
  for (const [x, color, label] of items) {
    buf.put(ox + x, y, "\u25A0", color);
    buf.text(ox + x + 2, y, label, theme.dim);
  }
}
var BREATH_DEPTH = 0.22;
var panelBorder = (color, view) => mix(color, theme.panel, 0.2 + BREATH_DEPTH * (view.anim?.breath ?? 0));
var SLOTS = [
  { row: FULL.arrows.main, index: 0, empty: "before a plan" },
  { row: FULL.arrows.cards, index: 1, empty: "after errors" },
  { row: FULL.arrows.lead, index: 2, empty: "before done" }
];
function drawSlot(buf, x, row, consults, empty, inner, typing) {
  const last = consults[consults.length - 1];
  if (!last) {
    buf.put(x, row, "\u25C7", theme.faint);
    buf.text(x + 2, row, empty, theme.faint);
    return;
  }
  buf.put(x, row, "\u25C6", last.isError ? theme.alert : theme.advisor, BOLD);
  const times = consults.length > 1 ? ` x${consults.length}` : "";
  const label = fit(`${last.reason}${times}`, inner - 2);
  if (typing?.id === last.id && typing.chars < cellLength(label)) {
    const end = buf.text(x + 2, row, [...label].slice(0, typing.chars).join(""), theme.text);
    buf.put(end, row, "\u258C", theme.advisor);
    return;
  }
  buf.text(x + 2, row, label, theme.text);
  const detail = last.open ? "replying\u2026" : `${formatDuration(last.durationMs)} \xB7 ${formatTokens(last.tokensRead)}`;
  buf.text(x + 2, row + 1, fit(detail, inner - 2), theme.dim);
}
function drawAdvisorPanel(buf, view, r) {
  const { advisor } = view.state;
  const pulse = view.anim?.advisorPulse ?? 0;
  box(buf, r, {
    color: mix(panelBorder(theme.advisor, view), theme.subBright, pulse * 0.75),
    fill: mix(theme.panel, theme.advisor, pulse * 0.08),
    halo: 0.35 + pulse * 0.9,
    bold: pulse > 0.5
  });
  const inner = r.w - 2;
  const left = r.x + 1;
  centerText(buf, left, inner, r.y + 1, advisorName(view).toUpperCase(), theme.advisor, true);
  centerText(buf, left, inner, r.y + 2, "advisor \xB7 on call", theme.dim);
  const chip = `[ --advisor ${modelAlias(view.state.advisorModel)} ]`;
  buf.fill(left + 1, r.y + 3, inner - 2, 1, theme.chip);
  centerText(buf, left + 1, inner - 2, r.y + 3, chip, theme.dim);
  const lineX = left;
  const textWidth = inner - 2;
  for (let y2 = r.y + 4; y2 < r.y + r.h - 1; y2 += 1) buf.put(lineX, y2, "\u254E", theme.faint);
  for (const slot of SLOTS) {
    drawSlot(buf, lineX, slot.row, advisor.consults.filter((c) => consultSlot(c.reason) === slot.index), slot.empty, textWidth + 1, view.anim?.typingConsult);
  }
  const text = lineX + 2;
  let y = FULL.arrows.main + 3;
  for (const line of ["reads the whole", "session, every", "tool call and", "result"]) {
    buf.text(text, y, line, theme.dim);
    y += 1;
  }
  y = 17;
  const last = advisor.consults.filter((c) => !c.open).pop();
  buf.text(text, y, "last consult:", theme.dim);
  if (last) {
    buf.text(text, y + 1, fit(`sealed \xB7 ${formatDuration(last.durationMs)}`, textWidth), theme.alert);
    buf.text(text, y + 2, fit(`${formatTokens(last.tokensRead)} read`, textWidth), theme.alert);
    buf.text(text, y + 3, fit(`${formatTokens(last.tokensWritten)} written`, textWidth), theme.alert);
  } else {
    buf.text(text, y + 1, "none yet", theme.faint);
  }
  const stat = (row, label, value) => {
    buf.text(text, row, label, theme.dim);
    rightText(buf, r.x + r.w - 3, row, value, theme.text, true);
  };
  const numbers = view.anim?.numbers;
  stat(22, "calls", String(Math.round(numbers?.calls ?? advisor.calls)));
  stat(23, "tokens read", formatTokens(Math.round(numbers?.tokensRead ?? advisor.tokensRead)));
  stat(24, "routine turns", String(Math.round(numbers?.routineTurns ?? advisor.routineTurns)));
  const followUp = last?.followUp;
  buf.text(text, 29, `then ${mainName(view).toLowerCase()}:`, theme.dim);
  if (followUp) {
    wrap(plainText(followUp), textWidth, 4).forEach((line, i) => buf.text(text, 30 + i, line, theme.dim));
  } else {
    buf.text(text, 30, "\u2014", theme.faint);
  }
}
function dashedArrow(buf, y, from, to, color) {
  for (let x = from; x < to; x += 1) buf.put(x, y, "\u254C", color);
  buf.put(to, y, "\u25B8", color);
}
function drawConnectors(buf, view) {
  const { arrows, spine, cardCenters, metrics, main: main2, lead } = FULL;
  const { advisor, subagents } = view.state;
  const hasSubagents = subagents.length > 0;
  const anyDone = subagents.some((s) => !s.running);
  const edge = FULL.advisor.x + FULL.advisor.w;
  const lit = (slot) => advisor.consults.some((c) => consultSlot(c.reason) === slot);
  const arrowColor = (slot) => lit(slot) ? theme.advisor : mix(theme.advisor, theme.bgEdge, 0.6);
  dashedArrow(buf, arrows.main, edge, main2.x - 1, arrowColor(0));
  dashedArrow(buf, arrows.cards, edge, FULL.cards[0].x - 1, arrowColor(1));
  dashedArrow(buf, arrows.lead + 1, edge, lead.x - 1, arrowColor(2));
  buf.put(spine, main2.y + main2.h, "\u2503", theme.main);
  const busColor = hasSubagents ? theme.sub : mix(theme.sub, theme.bgEdge, 0.65);
  buf.put(spine, metrics.y + metrics.h, "\u2503", mix(theme.metrics, busColor, 0.5));
  const top = FULL.rows.delegate + 1;
  const [c0, c1, c2] = cardCenters;
  for (let x = c0; x <= c2; x += 1) buf.put(x, top, "\u2501", busColor, BOLD);
  buf.put(c0, top, "\u250F", busColor, BOLD);
  buf.put(c2, top, "\u2513", busColor, BOLD);
  buf.put(c1, top, "\u254B", busColor, BOLD);
  for (const center of cardCenters) buf.put(center, top + 1, "\u25BC", busColor);
  const bright = anyDone ? theme.subBright : mix(theme.sub, theme.bgEdge, 0.65);
  const back = FULL.cards[0].y + FULL.cards[0].h;
  for (const center of cardCenters) buf.put(center, back, "\u2503", bright, BOLD);
  for (let x = c0; x <= c2; x += 1) buf.put(x, back + 1, "\u2501", bright, BOLD);
  buf.put(c0, back + 1, "\u2517", bright, BOLD);
  buf.put(c2, back + 1, "\u251B", bright, BOLD);
  buf.put(c1, back + 1, "\u254B", bright, BOLD);
  for (let y = back + 2; y < lead.y; y += 1) buf.put(spine, y, "\u2503", bright, BOLD);
  const glow = view.anim?.leadGlow ?? 0;
  if (anyDone) {
    for (let x = c0; x <= c2; x += 1) buf.tintBg(x, back + 1, theme.sub, 0.08 + glow * 0.15);
    for (let y = back; y < lead.y; y += 1) {
      buf.tintBg(spine, y, theme.sub, 0.1 + glow * 0.25);
      buf.tintBg(spine - 1, y, theme.sub, 0.06 + glow * 0.15);
      buf.tintBg(spine + 1, y, theme.sub, 0.06 + glow * 0.15);
    }
  }
}
function drawMainPanel(buf, view, r) {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.main, view), fill: theme.panel, halo: 0.4 });
  const inner = r.w - 2;
  const left = r.x + 1;
  centerSegments(buf, left, inner, r.y + 1, [
    { text: mainName(view), color: theme.main, bold: true },
    { text: " \xB7 main session", color: theme.text }
  ]);
  const task = state.title ?? state.lastPrompt;
  centerText(buf, left, inner - 2, r.y + 2, task ? plainText(task) : "no task yet", task ? theme.text : theme.faint);
  centerSegments(buf, left, inner, r.y + 3, [
    { text: "effort ", color: theme.dim },
    { text: effortMeter(state.effort), color: theme.main },
    { text: ` ${state.effort ?? "\u2014"}`, color: theme.dim }
  ]);
  const active = view.connected && !state.ended && state.status !== "idle";
  const activity = mainActivity(view, inner - 10);
  buf.fill(left + 1, r.y + 4, inner - 2, 1, theme.chip);
  centerSegments(buf, left + 1, inner - 2, r.y + 4, [
    { text: "[ ", color: theme.faint },
    { text: activity, color: state.status === "tool" ? theme.metrics : theme.dim },
    { text: active ? `  ${spinnerFrame(view.now)}` : "", color: theme.main },
    { text: " ]", color: theme.faint }
  ]);
}
function drawAdvisorState(buf, view, r) {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.advisor, view), dashed: true, fill: theme.panel, halo: 0.25 });
  centerText(buf, r.x + 1, r.w - 2, r.y + 1, "ADVISOR", theme.advisor, true);
  const replaying = state.advisor.consults.some((c) => c.open);
  const row = (y, label, value, color = theme.text) => {
    buf.text(r.x + 1, y, label, theme.dim);
    const shown = fit(value, r.w - 8);
    rightText(buf, r.x + r.w - (cellLength(shown) > r.w - 9 ? 2 : 3), y, shown, color, true);
  };
  row(r.y + 2, "model", advisorName(view).toLowerCase());
  row(r.y + 3, "mode", state.advisorEnabled || state.advisorModel ? "on call" : "off");
  row(r.y + 4, "state", replaying ? "replaying" : "silent", replaying ? theme.advisor : theme.text);
}
function drawMetrics(buf, view, r) {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.metrics, view), fill: theme.panel, halo: 0.3 });
  const left = r.x + 2;
  const right = r.x + r.w - 3;
  const toolRunning = view.connected && (state.status === "tool" || state.subagents.some((s) => s.currentTool));
  writeSegments(buf, left, r.y + 1, [
    { text: "TOOLS", color: theme.metrics, bold: true },
    { text: " \xB7 real distribution", color: theme.metrics },
    { text: toolRunning ? `  [ ${spinnerFrame(view.now, 140)} ]` : "", color: theme.metrics }
  ]);
  const numbers = view.anim?.numbers;
  const totalCalls = String(Math.round(numbers?.toolCalls ?? state.toolCalls));
  rightText(buf, right, r.y + 1, totalCalls, theme.metrics, true);
  rightText(buf, right - cellLength(totalCalls) - 1, r.y + 1, "calls", theme.dim);
  const sorted = Object.entries(state.tools).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, 3);
  const countOf = (name, real) => numbers?.tools[name] ?? real;
  const max = Math.max(1, ...top.map(([name, stat]) => countOf(name, stat.count)));
  const barX = left + 15;
  const barWidth = 17;
  top.forEach(([name, stat], i) => {
    const y = r.y + 2 + i;
    const failed = stat.errors > 0;
    const shown = countOf(name, stat.count);
    buf.text(left, y, fit(toCells(name), 14), failed ? theme.alert : theme.text);
    thinBar(buf, barX, y, barWidth, shown / max, failed ? theme.barAlert : theme.barGood);
    rightText(buf, barX + barWidth + 4, y, String(Math.round(shown)), theme.text);
    if (failed) rightText(buf, right, y, `${stat.errors} err`, theme.alert);
  });
  if (top.length === 0) buf.text(left, r.y + 2, "no tool calls yet", theme.faint);
  const rest = sorted.slice(3);
  const footer = rest.length ? `+ ${rest.map(([name, stat]) => `${name} ${stat.count}`).join(" \xB7 ")}` : state.toolErrors > 0 ? `${state.toolErrors} failed \xB7 orange = had errors` : "green = no errors \xB7 orange = had errors";
  buf.text(left, r.y + 5, fit(toCells(footer), r.w - 4), theme.dim);
}
var GROW_SHARE = 0.6;
var FILL_SHARE = 0.4;
var DONE_DIM = 0.38;
function drawGrowingBox(buf, r, grow) {
  const k = easeOutCubic(segment(grow, 0, GROW_SHARE));
  const w = Math.max(3, Math.round(r.w * k));
  const h = Math.max(3, Math.round(r.h * k));
  const rect = { x: r.x + Math.floor((r.w - w) / 2), y: r.y + Math.floor((r.h - h) / 2), w, h };
  box(buf, rect, { color: mix(theme.bgEdge, theme.subBright, k), fill: theme.panel, halo: 0.5 * k, bold: true });
}
function fadeArea(buf, r, toward, amount) {
  if (amount <= 0) return;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) buf.tintFg(x, y, toward, amount);
  }
}
function drawCard(buf, r, sub, index, view, card) {
  if (!sub) {
    box(buf, r, { color: mix(theme.sub, theme.bgEdge, 0.72), dashed: true, fill: mix(theme.panel, theme.bgEdge, 0.4) });
    centerText(buf, r.x + 1, r.w - 2, r.y + 3, "no subagent", mix(theme.dim, theme.bgEdge, 0.45));
    return;
  }
  const grow = card?.grow ?? 1;
  const fade = card?.fade ?? 0;
  if (grow < GROW_SHARE) {
    drawGrowingBox(buf, r, grow);
    return;
  }
  const failed = sub.status !== void 0 && sub.status !== "completed";
  const color = failed ? theme.alert : sub.running ? theme.subBright : theme.sub;
  box(buf, r, { color, fill: theme.panel, halo: sub.running ? 0.3 : 0.15, bold: true });
  const inner = r.w - 2;
  const left = r.x + 1;
  const name = sub.description || sub.agentType ? plainText(subagentName(view.state, sub.id)) : "starting\u2026";
  const label = fit(`${String(index + 1).padStart(2, "0")} ${(sub.agentType ?? "agent").toLowerCase()}`, inner - 2);
  const chipEnd = left + cellLength(label) + 2;
  for (let x = left; x < chipEnd; x += 1) buf.setBg(x, r.y, mix(theme.panel, theme.sub, sub.running ? 0.3 : 0.12));
  buf.text(left, r.y, ` ${label} `, sub.running ? theme.subBright : theme.dim);
  centerText(buf, left + 1, inner - 2, r.y + 1, name, theme.text, true);
  const tags = sub.model ? [{ text: displayModel(sub.model), color: theme.main }] : [];
  if (sub.running) tags.push({ text: `${sub.model ? " " : ""}[ ${spinnerFrame(view.now + index * 40)} ]`, color: theme.sub });
  centerSegments(buf, left, inner, r.y + 2, tags);
  const barX = left + 1;
  const barWidth = inner - 2;
  if (sub.running) indeterminateBar(buf, barX, r.y + 3, barWidth, view.now / 1800 + index * 0.27, theme.barSub);
  else bar(buf, barX, r.y + 3, barWidth, easeOutCubic(segment(fade, 0, FILL_SHARE)), failed ? theme.barAlert : theme.barSub);
  const detail = sub.running ? `tools: ${sub.toolCount}${sub.currentTool ? ` \xB7 ${sub.currentTool}` : ""}` : `${sub.toolCount} tools${sub.durationMs !== void 0 ? ` \xB7 ${formatDuration(sub.durationMs)}` : ""}`;
  centerText(buf, left, inner, r.y + 4, detail, failed ? theme.alert : theme.sub);
  const status = sub.running ? ["\u25D0", "\u25D3", "\u25D1", "\u25D2"][Math.floor(view.now / 160 + index) % 4] : failed ? "\u2715" : "\u25CF";
  const tokens = !sub.running && sub.totalTokens !== void 0 ? ` ${formatTokens(sub.totalTokens)}` : "";
  centerSegments(buf, left, inner, r.y + 5, [
    { text: status, color: failed ? theme.alert : theme.sub },
    { text: tokens, color: theme.sub },
    { text: sub.readOnly ? " read-only" : "", color: theme.dim }
  ]);
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
function drawDelegate(buf, view, y, x, width) {
  const { subagents } = view.state;
  const active = subagents.filter((s) => s.running).length;
  centerSegments(buf, x, width, y, [
    { text: "delegate to subagents", color: subagents.length ? theme.text : theme.dim },
    { text: " \xB7 ", color: theme.dim },
    { text: mainName(view).toLowerCase(), color: theme.main, bold: true },
    { text: `  [ ${active} / ${subagents.length} ]`, color: theme.dim },
    { text: active > 0 ? ` ${spinnerFrame(view.now, 110)}` : "", color: theme.sub }
  ]);
}
function drawLead(buf, view, r) {
  const done = view.state.subagents.filter((s) => !s.running);
  const glow = view.anim?.leadGlow ?? 0;
  box(buf, r, {
    color: done.length ? theme.subBright : mix(mix(theme.sub, theme.bgEdge, 0.5), theme.subBright, glow),
    fill: mix(theme.panel, theme.sub, glow * 0.14),
    halo: (done.length ? 0.5 : 0.1) + glow * 0.9,
    bold: true
  });
  centerSegments(buf, r.x + 1, r.w - 2, r.y + 1, [
    { text: "back to ", color: theme.text },
    { text: mainName(view), color: theme.main, bold: true },
    { text: " \xB7 lead", color: theme.text }
  ]);
  const latest = done[done.length - 1];
  const summary = latest?.summary ? `${done.length} back \xB7 ${plainText(latest.summary)}` : "no summaries yet";
  centerText(buf, r.x + 2, r.w - 4, r.y + 2, summary, latest ? theme.dim : theme.faint);
}
var LOG_SLIDE_MS = 260;
var LOG_SLIDE_CELLS = 8;
var LOG_TYPE_MS = 600;
var LOG_TYPE_MIN_RATE = 0.05;
function drawLog(buf, view, r) {
  box(buf, r, { color: mix(theme.main, theme.panel, 0.55), fill: mix(theme.panel, theme.bgEdge, 0.3) });
  const live = view.replay ? view.replay.paused ? "paused" : view.replay.finished ? "replay end" : `replay x${view.replay.speed}` : view.connected ? "live" : "idle";
  writeSegments(buf, r.x + 3, r.y, [
    { text: " session log ", color: theme.text },
    { text: `[ ${live} \xB7 ${spinnerFrame(view.now, 200)} ] `, color: theme.dim }
  ]);
  const rows = r.h - 2;
  const entries = view.log.slice(-rows);
  entries.forEach((entry, i) => {
    const y = r.y + 1 + i;
    const text = fit(toCells(entry.text), r.w - 27);
    const age = entry.bornAt === void 0 ? Number.POSITIVE_INFINITY : Math.max(0, view.now - entry.bornAt);
    const slide = Math.round((1 - easeOutCubic(age / LOG_SLIDE_MS)) * LOG_SLIDE_CELLS);
    const headFade = 1 - easeOutCubic(age / LOG_SLIDE_MS);
    const length = cellLength(text);
    const typed = age === Number.POSITIVE_INFINITY ? length : Math.min(length, Math.floor(age * Math.max(LOG_TYPE_MIN_RATE, length / LOG_TYPE_MS)));
    const fadeTo = mix(theme.panel, theme.bgEdge, 0.3);
    buf.text(r.x + 2 + slide, y, formatClock(entry.t), mix(theme.faint, fadeTo, headFade));
    buf.text(r.x + 11 + slide, y, fit(toCells(entry.who), 13), mix(KIND_COLOR2[entry.kind], fadeTo, headFade));
    const end = buf.text(r.x + 25 + slide, y, [...text].slice(0, typed).join(""), entry.kind === "error" ? theme.alert : theme.text);
    if (typed < length && end < r.x + r.w - 1) buf.put(end, y, "\u258C", KIND_COLOR2[entry.kind]);
  });
  if (entries.length === 0) buf.text(r.x + 2, r.y + 1, "nothing yet", theme.faint);
}
function drawPrompt(buf, view, y, x, width) {
  const { state } = view;
  const main2 = modelAlias(state.mainModel);
  const adv = modelAlias(state.advisorModel);
  const end = writeSegments(buf, x + 1, y, [
    { text: `${fit(toCells(folderName(state.cwd)), 18)} $ `, color: theme.main, bold: true },
    { text: "claude", color: theme.text },
    { text: " --model ", color: theme.dim },
    { text: main2, color: theme.main },
    { text: " --advisor ", color: theme.dim },
    { text: adv, color: theme.advisor },
    { text: " ", color: theme.text }
  ]);
  if (Math.floor(view.now / 530) % 2 === 0) buf.put(end, y, "\u2588", theme.text);
  rightText(buf, x + width - 2, y, "reconstructed, not literal", theme.faint);
}
function drawStatus(buf, view, y, x, width) {
  const chipWidth = Math.floor(width * 0.42);
  buf.fill(x + 1, y, chipWidth, 1, theme.chip);
  buf.text(x + 2, y, fit(`# ${toCells(view.queue.last ?? "no events yet")}`, chipWidth - 2), theme.dim);
  const squares = view.queue.pending.slice(0, 16);
  squares.forEach((kind, i) => buf.put(x + chipWidth + 3 + i, y, "\u25A0", KIND_COLOR2[kind]));
  rightText(buf, x + width - 2, y, `${view.queue.pending.length} queued`, theme.dim);
}
function flashPanel(buf, r, amount) {
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      buf.blendBg(x, y, theme.alert, amount * 0.26);
      const onBorder = x === r.x || x === r.x + r.w - 1 || y === r.y || y === r.y + r.h - 1;
      if (onBorder) buf.tintFg(x, y, theme.alert, amount);
    }
  }
}
function renderFull(buf, view) {
  buf.originX = Math.floor((buf.width - FULL_COLS) / 2);
  buf.originY = Math.floor((buf.height - FULL_ROWS) / 2);
  const target = buf;
  const { rows } = FULL;
  drawWindowBar(target, view, rows.windowBar, FULL_COLS, 0);
  centerSegments(target, 0, FULL_COLS, rows.header, headerSegments(view));
  for (let x = 2; x <= 93; x += 1) target.put(x, rows.separator, "\u2500", mix(theme.main, theme.bgEdge, 0.6));
  drawLegend(target, view, 0, 0);
  drawConnectors(target, view);
  drawAdvisorPanel(target, view, FULL.advisor);
  drawMainPanel(target, view, FULL.main);
  drawAdvisorState(target, view, FULL.advisorState);
  drawMetrics(target, view, FULL.metrics);
  drawDelegate(target, view, rows.delegate, 28, 67);
  const visible = cardSlots(view, FULL.cards.length);
  FULL.cards.forEach((rect, i) => {
    const slot = visible[i];
    drawCard(target, rect, slot?.sub, slot?.sub ? view.state.subagents.indexOf(slot.sub) : -1, view, slot?.card);
  });
  drawLead(target, view, FULL.lead);
  drawLog(target, view, FULL.log);
  drawPrompt(target, view, rows.prompt, 0, FULL_COLS);
  drawStatus(target, view, rows.status, 0, FULL_COLS);
  for (const packet of view.anim?.packets ?? []) drawPacket(target, packet);
  const flash = view.anim?.errorFlash ?? 0;
  if (flash > 0) {
    flashPanel(target, FULL.main, flash);
    flashPanel(target, FULL.metrics, flash);
    flashPanel(target, FULL.log, flash);
  }
  const bootMs = view.anim?.bootMs;
  if (bootMs !== void 0 && bootMs < BOOT_MS) {
    const width = segmentsWidth(headerSegments(view));
    const { originX, originY } = buf;
    const base = baseColor(buf, view.flatBackground ?? false);
    applyBootFull(buf, bootMs, Math.floor((FULL_COLS - width) / 2), width, (x, y) => base(x + originX, y + originY));
  }
  buf.originX = 0;
  buf.originY = 0;
}
function renderReduced(buf, view) {
  const { width, height } = buf;
  centerSegments(buf, 0, width, 0, headerSegments(view));
  const advisorRect = { x: 0, y: 1, w: 24, h: height - 8 };
  const { advisor } = view.state;
  box(buf, advisorRect, { color: theme.advisor, fill: theme.panel, halo: 0.25 });
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
  buf.text(ax, statsY, fit(last ? `sealed \xB7 ${formatDuration(last.durationMs)}` : "inferred labels", aw), last ? theme.alert : theme.faint);
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
  box(buf, mainRect, { color: theme.main, fill: theme.panel, halo: 0.25 });
  centerSegments(buf, rightX + 1, rightW - 2, 2, [
    { text: mainName(view), color: theme.main, bold: true },
    { text: " \xB7 main \xB7 effort ", color: theme.dim },
    { text: view.state.effort ?? "\u2014", color: theme.main }
  ]);
  const task = view.state.title ?? view.state.lastPrompt;
  centerText(buf, rightX + 2, rightW - 4, 3, task ? plainText(task) : "no task yet", task ? theme.text : theme.faint);
  const active = view.connected && !view.state.ended && view.state.status !== "idle";
  centerSegments(buf, rightX + 1, rightW - 2, 4, [
    { text: mainActivity(view, rightW - 12), color: view.state.status === "tool" ? theme.metrics : theme.dim },
    { text: active ? `  ${spinnerFrame(view.now)}` : "", color: theme.main }
  ]);
  const cardCount = 3;
  const gap = 1;
  const cardW = Math.floor((rightW - gap * (cardCount - 1)) / cardCount);
  const visible = cardSlots(view, cardCount);
  for (let i = 0; i < cardCount; i += 1) {
    const r = { x: rightX + i * (cardW + gap), y: 6, w: cardW, h: 5 };
    const sub = visible[i]?.sub;
    if (!sub) {
      box(buf, r, { color: mix(theme.sub, theme.bgEdge, 0.72), dashed: true, fill: mix(theme.panel, theme.bgEdge, 0.4) });
      continue;
    }
    const failed = sub.status !== void 0 && sub.status !== "completed";
    box(buf, r, { color: failed ? theme.alert : sub.running ? theme.subBright : theme.sub, fill: theme.panel, bold: true });
    const index = view.state.subagents.indexOf(sub);
    centerText(buf, r.x + 1, r.w - 2, r.y + 1, plainText(subagentName(view.state, sub.id)), theme.text, true);
    if (sub.running) indeterminateBar(buf, r.x + 2, r.y + 2, r.w - 4, view.now / 1800 + index * 0.27, theme.barSub);
    else bar(buf, r.x + 2, r.y + 2, r.w - 4, 1, failed ? theme.barAlert : theme.barSub);
    centerText(buf, r.x + 1, r.w - 2, r.y + 3, sub.running ? `tools: ${sub.toolCount}` : `${sub.toolCount} tools \xB7 ${formatDuration(sub.durationMs)}`, failed ? theme.alert : theme.sub);
  }
  const toolsY = 11;
  const sorted = Object.entries(view.state.tools).sort((a, b) => b[1].count - a[1].count);
  buf.text(rightX, toolsY, fit(toCells(`tools ${view.state.toolCalls}: ${sorted.map(([n, s]) => `${n} ${s.count}${s.errors ? `!${s.errors}` : ""}`).join(" \xB7 ")}`), rightW), view.state.toolErrors ? theme.alert : theme.metrics);
  const logRect = { x: 0, y: advisorRect.y + advisorRect.h, w: width, h: height - advisorRect.h - 3 };
  drawLog(buf, view, logRect);
  drawPrompt(buf, view, height - 2, 0, width);
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
  const flat = view.flatBackground ?? false;
  paintBackground(buf, flat);
  buf.tintsEnabled = !flat;
  const kind = layoutKind(buf.width, buf.height);
  if (kind === "full") renderFull(buf, view);
  else if (kind === "reduced") {
    renderReduced(buf, view);
    const bootMs = view.anim?.bootMs;
    if (bootMs !== void 0 && bootMs < BOOT_MS) applyBootFade(buf, bootMs, baseColor(buf, flat));
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
  constructor(output, input, writeSync2 = (data) => {
    output.write(data);
  }) {
    this.output = output;
    this.input = input;
    this.writeSync = writeSync2;
  }
  output;
  input;
  writeSync;
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
      this.writeSync(RESTORE_SEQUENCE);
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
function runApp(options) {
  const now = options.now ?? (() => performance.now());
  const director = new Director({ boot: true });
  const session = new TerminalSession(options.output, options.input, options.writeSync);
  const { source, replay, output } = options;
  let front = null;
  let back = null;
  let fps = options.fps ?? MAX_FPS;
  let timer;
  let waitingDrain = false;
  let stopped = false;
  let frames = 0;
  let lastKey = "";
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
    if (options.exitWhenDone && replay?.finished && director.settled && !director.isBusy(time)) stop();
  }
  function schedule() {
    if (stopped || waitingDrain) return;
    const rate = options.fps ?? (director.isBusy(now()) ? fps : IDLE_FPS);
    timer = setTimeout(tick, 1e3 / rate);
  }
  function tick() {
    if (stopped) return;
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
  const fd = stdout.fd;
  const app = runApp({
    source,
    replay,
    output: stdout,
    input: stdin.isTTY ? stdin : void 0,
    // Al morir el proceso no se alcanza a vaciar una escritura asíncrona.
    writeSync: (data) => {
      writeSync(fd, data);
    },
    size: () => forced ?? { cols: stdout.columns || 80, rows: stdout.rows || 24 },
    onResize: (listener) => {
      stdout.on("resize", listener);
      return () => stdout.off("resize", listener);
    },
    colorMode: forced ? env.SINAPSIS_COLOR === "256" ? "256" : "truecolor" : detectColorMode(stdout.getColorDepth()),
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
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  if (error instanceof ArgsError) process.stderr.write(`
${USAGE}`);
  process.exitCode = 1;
});
