// Dibuja un frame completo. Función pura de la vista y del tamaño del buffer.

import { displayModel, formatDuration, formatTokens, modelAlias, plainText, subagentName } from '../core/describe.js';
import type { ConsultState, SubagentState } from '../core/state.js';
import { easeInOutCubic, easeOutCubic, segment } from '../engine/easing.js';
import { BOOT_MS, applyBootFade, applyBootFull } from './boot.js';
import { BOLD, type CellBuffer, cellLength, fit, toCells } from '../tui/buffer.js';
import { type Rgb, mix } from '../tui/color.js';
import { type Rect, type Segment, bar, box, centerSegments, centerText, indeterminateBar, rightText, segmentsWidth, spinnerFrame, thinBar, wrap, writeSegments } from './draw.js';
import { FULL, FULL_COLS, FULL_ROWS, MIN_COLS, MIN_ROWS, consultSlot, layoutKind } from './layout.js';
import { drawPacket } from './packets.js';
import { theme } from './theme.js';
import type { CardView, SceneView } from './view.js';

const backgroundCache = new Map<string, Int32Array>();

/** Viñeta: claro al centro, oscuro en las esquinas. Se calcula una vez por tamaño. */
function paintBackground(buf: CellBuffer, flat: boolean): void {
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
  buf.chars.fill(0x20);
  buf.attrs.fill(0);
  buf.fg.set(cached);
}

/** Color del fondo sin paneles en una celda. */
function baseColor(buf: CellBuffer, flat: boolean): (x: number, y: number) => number {
  const cached = backgroundCache.get(`${buf.width}x${buf.height}`);
  if (flat || !cached) return () => theme.bgEdge;
  return (x, y) => cached[y * buf.width + x] ?? theme.bgEdge;
}

const folderName = (cwd: string | undefined): string => (cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd) : 'no session');

/** Quien hace de hilo principal, o un guion si aún no se sabe. */
const mainName = (view: SceneView): string => displayModel(view.state.mainModel);
const advisorName = (view: SceneView): string => displayModel(view.state.advisorModel);

const EFFORT_LEVELS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

function effortMeter(effort: string | undefined): string {
  const level = effort ? (EFFORT_LEVELS[effort] ?? 0) : 0;
  return `${'▮'.repeat(level)}${'▯'.repeat(5 - level)}`;
}

function formatClock(t: number): string {
  if (t <= 0) return '--:--:--';
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const KIND_COLOR = {
  main: theme.main,
  sub: theme.sub,
  advisor: theme.advisor,
  tool: theme.metrics,
  error: theme.alert,
} as const;

/** Estado actual del modelo principal. En vivo no se puede saber si está consultando al advisor. */
function mainActivity(view: SceneView, width: number): string {
  const { state } = view;
  if (!view.connected) return fit('waiting for a session', width);
  if (state.ended) return 'session ended';
  // Solo se llega aquí al reproducir un lote: en vivo, la consulta no se ve mientras ocurre.
  if (state.advisor.consults.some((c) => c.open)) return 'replaying consult';
  if (state.status === 'tool' && state.currentTool) {
    const { name, summary } = state.currentTool;
    return fit(toCells(summary ? `${name} · ${summary.replace(/\s+/g, ' ')}` : name), width);
  }
  if (state.status === 'working') return 'working';
  return 'idle';
}

function drawWindowBar(buf: CellBuffer, view: SceneView, y: number, width: number, ox: number): void {
  buf.fill(ox, y, width, 1, theme.windowBar);
  buf.put(ox + 1, y, '●', theme.dotRed);
  buf.put(ox + 3, y, '●', theme.dotYellow);
  buf.put(ox + 5, y, '●', theme.dotGreen);
  centerText(buf, ox, width, y, `${folderName(view.state.cwd)} — sinapsis — ${buf.width}x${buf.height}`, theme.dim);
}

function headerSegments(view: SceneView): Segment[] {
  if (!view.state.mainModel) {
    return [
      { text: 'CLAUDE CODE ADVISOR', color: theme.text, bold: true },
      { text: '  ·  ', color: theme.dim },
      { text: 'WAITING FOR A SESSION', color: theme.dim },
    ];
  }
  const main = mainName(view).toUpperCase();
  const advisor = advisorName(view).toUpperCase();
  return [
    { text: 'CLAUDE CODE ADVISOR', color: theme.text, bold: true },
    { text: '  ·  ', color: theme.dim },
    { text: main, color: theme.main, bold: true },
    { text: ' BUILDS', color: theme.text, bold: true },
    { text: '  ·  ', color: theme.dim },
    { text: advisor, color: theme.advisor, bold: true },
    { text: ' THINKS', color: theme.text, bold: true },
  ];
}

function drawLegend(buf: CellBuffer, view: SceneView, ox: number, oy: number): void {
  const y = oy + FULL.rows.legend;
  const main = mainName(view).toLowerCase();
  const items: Array<[number, Rgb, string]> = [
    [3, theme.main, `${main} · main`],
    [23, theme.sub, `${main} · subagents`],
    [48, theme.advisor, `${advisorName(view).toLowerCase()} · advisor`],
    [71, theme.metrics, 'tools'],
  ];
  for (const [x, color, label] of items) {
    buf.put(ox + x, y, '■', color);
    buf.text(ox + x + 2, y, label, theme.dim);
  }
}

/** Los bordes son más tenues que el color puro del token, como en la referencia. */
const panelBorder = (color: Rgb): Rgb => mix(color, theme.panel, 0.2);

// --- Panel del advisor ---

/** Las consultas se agrupan en los tres hitos del panel. La etiqueta es inferida, y así se rotula. */
const SLOTS: Array<{ row: number; index: 0 | 1 | 2; empty: string }> = [
  { row: FULL.arrows.main, index: 0, empty: 'before a plan' },
  { row: FULL.arrows.cards, index: 1, empty: 'after errors' },
  { row: FULL.arrows.lead, index: 2, empty: 'before done' },
];

function drawSlot(buf: CellBuffer, x: number, row: number, consults: ConsultState[], empty: string, inner: number, typing: { id: string; chars: number } | undefined): void {
  const last = consults[consults.length - 1];
  if (!last) {
    buf.put(x, row, '◇', theme.faint);
    buf.text(x + 2, row, empty, theme.faint);
    return;
  }
  buf.put(x, row, '◆', last.isError ? theme.alert : theme.advisor, BOLD);
  const times = consults.length > 1 ? ` x${consults.length}` : '';
  const label = fit(`${last.reason}${times}`, inner - 2);
  if (typing?.id === last.id && typing.chars < cellLength(label)) {
    // El motivo se escribe mientras llega la consulta.
    const end = buf.text(x + 2, row, [...label].slice(0, typing.chars).join(''), theme.text);
    buf.put(end, row, '▌', theme.advisor);
    return;
  }
  buf.text(x + 2, row, label, theme.text);
  const detail = last.open ? 'replying…' : `${formatDuration(last.durationMs)} · ${formatTokens(last.tokensRead)}`;
  buf.text(x + 2, row + 1, fit(detail, inner - 2), theme.dim);
}

function drawAdvisorPanel(buf: CellBuffer, view: SceneView, r: Rect): void {
  const { advisor } = view.state;
  const pulse = view.anim?.advisorPulse ?? 0;
  box(buf, r, {
    color: mix(panelBorder(theme.advisor), theme.subBright, pulse * 0.75),
    fill: mix(theme.panel, theme.advisor, pulse * 0.08),
    halo: 0.35 + pulse * 0.9,
    bold: pulse > 0.5,
  });
  const inner = r.w - 2;
  const left = r.x + 1;
  centerText(buf, left, inner, r.y + 1, advisorName(view).toUpperCase(), theme.advisor, true);
  centerText(buf, left, inner, r.y + 2, 'advisor · on call', theme.dim);
  const chip = `[ --advisor ${modelAlias(view.state.advisorModel)} ]`;
  buf.fill(left + 1, r.y + 3, inner - 2, 1, theme.chip);
  centerText(buf, left + 1, inner - 2, r.y + 3, chip, theme.dim);

  // Línea de tiempo: punteada de arriba abajo, con los hitos encima.
  const lineX = left;
  const textWidth = inner - 2;
  for (let y = r.y + 4; y < r.y + r.h - 1; y += 1) buf.put(lineX, y, '╎', theme.faint);
  for (const slot of SLOTS) {
    drawSlot(buf, lineX, slot.row, advisor.consults.filter((c) => consultSlot(c.reason) === slot.index), slot.empty, textWidth + 1, view.anim?.typingConsult);
  }

  const text = lineX + 2;
  let y = FULL.arrows.main + 3;
  for (const line of ['reads the whole', 'session, every', 'tool call and', 'result']) {
    buf.text(text, y, line, theme.dim);
    y += 1;
  }

  y = 17;
  const last = advisor.consults.filter((c) => !c.open).pop();
  buf.text(text, y, 'last consult:', theme.dim);
  if (last) {
    buf.text(text, y + 1, fit(`sealed · ${formatDuration(last.durationMs)}`, textWidth), theme.alert);
    buf.text(text, y + 2, fit(`${formatTokens(last.tokensRead)} read`, textWidth), theme.alert);
    buf.text(text, y + 3, fit(`${formatTokens(last.tokensWritten)} written`, textWidth), theme.alert);
  } else {
    buf.text(text, y + 1, 'none yet', theme.faint);
  }

  const stat = (row: number, label: string, value: string): void => {
    buf.text(text, row, label, theme.dim);
    rightText(buf, r.x + r.w - 3, row, value, theme.text, true);
  };
  const numbers = view.anim?.numbers;
  stat(22, 'calls', String(Math.round(numbers?.calls ?? advisor.calls)));
  stat(23, 'tokens read', formatTokens(Math.round(numbers?.tokensRead ?? advisor.tokensRead)));
  stat(24, 'routine turns', String(Math.round(numbers?.routineTurns ?? advisor.routineTurns)));

  // Lo que siguió haciendo el principal: rotulado con su nombre porque el consejo está cifrado.
  const followUp = last?.followUp;
  buf.text(text, 29, `then ${mainName(view).toLowerCase()}:`, theme.dim);
  if (followUp) {
    wrap(plainText(followUp), textWidth, 4).forEach((line, i) => buf.text(text, 30 + i, line, theme.dim));
  } else {
    buf.text(text, 30, '—', theme.faint);
  }
}

// --- Conectores ---

function dashedArrow(buf: CellBuffer, y: number, from: number, to: number, color: Rgb): void {
  for (let x = from; x < to; x += 1) buf.put(x, y, '╌', color);
  buf.put(to, y, '▸', color);
}

function drawConnectors(buf: CellBuffer, view: SceneView): void {
  const { arrows, spine, cardCenters, metrics, main, lead } = FULL;
  const { advisor, subagents } = view.state;
  const hasSubagents = subagents.length > 0;
  const anyDone = subagents.some((s) => !s.running);

  const edge = FULL.advisor.x + FULL.advisor.w;
  const lit = (slot: 0 | 1 | 2): boolean => advisor.consults.some((c) => consultSlot(c.reason) === slot);
  const arrowColor = (slot: 0 | 1 | 2): Rgb => (lit(slot) ? theme.advisor : mix(theme.advisor, theme.bgEdge, 0.6));
  dashedArrow(buf, arrows.main, edge, main.x - 1, arrowColor(0));
  dashedArrow(buf, arrows.cards, edge, FULL.cards[0].x - 1, arrowColor(1));
  dashedArrow(buf, arrows.lead + 1, edge, lead.x - 1, arrowColor(2));

  // Principal hacia métricas y hacia los subagentes.
  buf.put(spine, main.y + main.h, '┃', theme.main);
  const busColor = hasSubagents ? theme.sub : mix(theme.sub, theme.bgEdge, 0.65);
  buf.put(spine, metrics.y + metrics.h, '┃', mix(theme.metrics, busColor, 0.5));

  // Distribución hacia las tarjetas.
  const top = FULL.rows.delegate + 1;
  const [c0, c1, c2] = cardCenters;
  for (let x = c0; x <= c2; x += 1) buf.put(x, top, '━', busColor, BOLD);
  buf.put(c0, top, '┏', busColor, BOLD);
  buf.put(c2, top, '┓', busColor, BOLD);
  buf.put(c1, top, '╋', busColor, BOLD);
  for (const center of cardCenters) buf.put(center, top + 1, '▼', busColor);

  // Regreso hacia el principal.
  const bright = anyDone ? theme.subBright : mix(theme.sub, theme.bgEdge, 0.65);
  const back = FULL.cards[0].y + FULL.cards[0].h;
  for (const center of cardCenters) buf.put(center, back, '┃', bright, BOLD);
  for (let x = c0; x <= c2; x += 1) buf.put(x, back + 1, '━', bright, BOLD);
  buf.put(c0, back + 1, '┗', bright, BOLD);
  buf.put(c2, back + 1, '┛', bright, BOLD);
  buf.put(c1, back + 1, '╋', bright, BOLD);
  for (let y = back + 2; y < lead.y; y += 1) buf.put(spine, y, '┃', bright, BOLD);
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

// --- Sesión principal y estado del advisor ---

function drawMainPanel(buf: CellBuffer, view: SceneView, r: Rect): void {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.main), fill: theme.panel, halo: 0.4 });
  const inner = r.w - 2;
  const left = r.x + 1;
  centerSegments(buf, left, inner, r.y + 1, [
    { text: mainName(view), color: theme.main, bold: true },
    { text: ' · main session', color: theme.text },
  ]);
  const task = state.title ?? state.lastPrompt;
  centerText(buf, left, inner - 2, r.y + 2, task ? plainText(task) : 'no task yet', task ? theme.text : theme.faint);
  centerSegments(buf, left, inner, r.y + 3, [
    { text: 'effort ', color: theme.dim },
    { text: effortMeter(state.effort), color: theme.main },
    { text: ` ${state.effort ?? '—'}`, color: theme.dim },
  ]);

  const active = view.connected && !state.ended && state.status !== 'idle';
  const activity = mainActivity(view, inner - 10);
  buf.fill(left + 1, r.y + 4, inner - 2, 1, theme.chip);
  centerSegments(buf, left + 1, inner - 2, r.y + 4, [
    { text: '[ ', color: theme.faint },
    { text: activity, color: state.status === 'tool' ? theme.metrics : theme.dim },
    { text: active ? `  ${spinnerFrame(view.now)}` : '', color: theme.main },
    { text: ' ]', color: theme.faint },
  ]);
}

function drawAdvisorState(buf: CellBuffer, view: SceneView, r: Rect): void {
  const { state } = view;
  box(buf, r, { color: theme.advisor, dashed: true, fill: theme.panel, halo: 0.25 });
  centerText(buf, r.x + 1, r.w - 2, r.y + 1, 'ADVISOR', theme.advisor, true);
  const replaying = state.advisor.consults.some((c) => c.open);
  const row = (y: number, label: string, value: string, color: Rgb = theme.text): void => {
    buf.text(r.x + 1, y, label, theme.dim);
    // `replaying` ocupa una celda más: usa el margen derecho en vez de recortarse.
    const shown = fit(value, r.w - 8);
    rightText(buf, r.x + r.w - (cellLength(shown) > r.w - 9 ? 2 : 3), y, shown, color, true);
  };
  row(r.y + 2, 'model', advisorName(view).toLowerCase());
  row(r.y + 3, 'mode', state.advisorEnabled || state.advisorModel ? 'on call' : 'off');
  // `replaying` solo se enciende al reproducir un lote: en vivo la consulta no se ve mientras ocurre.
  row(r.y + 4, 'state', replaying ? 'replaying' : 'silent', replaying ? theme.advisor : theme.text);
}

// --- Métricas ---

function drawMetrics(buf: CellBuffer, view: SceneView, r: Rect): void {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.metrics), fill: theme.panel, halo: 0.3 });
  const left = r.x + 2;
  const right = r.x + r.w - 3;
  // Gira si alguna herramienta está corriendo, en el proceso principal o en un subagente.
  const toolRunning = view.connected && (state.status === 'tool' || state.subagents.some((s) => s.currentTool));
  writeSegments(buf, left, r.y + 1, [
    { text: 'TOOLS', color: theme.metrics, bold: true },
    { text: ' · real distribution', color: theme.metrics },
    { text: toolRunning ? `  [ ${spinnerFrame(view.now, 140)} ]` : '', color: theme.metrics },
  ]);
  const numbers = view.anim?.numbers;
  const totalCalls = String(Math.round(numbers?.toolCalls ?? state.toolCalls));
  rightText(buf, right, r.y + 1, totalCalls, theme.metrics, true);
  rightText(buf, right - cellLength(totalCalls) - 1, r.y + 1, 'calls', theme.dim);

  const sorted = Object.entries(state.tools).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, 3);
  const countOf = (name: string, real: number): number => numbers?.tools[name] ?? real;
  // Las barras se miden contra la mayor de las que están creciendo, así que nunca se pasan del riel.
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
  if (top.length === 0) buf.text(left, r.y + 2, 'no tool calls yet', theme.faint);

  const rest = sorted.slice(3);
  const footer = rest.length
    ? `+ ${rest.map(([name, stat]) => `${name} ${stat.count}`).join(' · ')}`
    : state.toolErrors > 0
      ? `${state.toolErrors} failed · orange = had errors`
      : 'green = no errors · orange = had errors';
  buf.text(left, r.y + 5, fit(toCells(footer), r.w - 4), theme.dim);
}

// --- Subagentes ---

/** Parte de la entrada de una tarjeta en que crece la caja. Después se funde el contenido. */
const GROW_SHARE = 0.6;
/** Parte de la salida en que se llena la barra. Después se atenúa. */
const FILL_SHARE = 0.4;
/** Cuánto se atenúa una tarjeta terminada. Debe seguir siendo legible. */
const DONE_DIM = 0.38;

/** Caja de un tamaño intermedio, creciendo desde el centro. */
function drawGrowingBox(buf: CellBuffer, r: Rect, grow: number): void {
  const k = easeOutCubic(segment(grow, 0, GROW_SHARE));
  const w = Math.max(3, Math.round(r.w * k));
  const h = Math.max(3, Math.round(r.h * k));
  const rect: Rect = { x: r.x + Math.floor((r.w - w) / 2), y: r.y + Math.floor((r.h - h) / 2), w, h };
  box(buf, rect, { color: mix(theme.bgEdge, theme.subBright, k), fill: theme.panel, halo: 0.5 * k, bold: true });
}

function fadeArea(buf: CellBuffer, r: Rect, toward: Rgb, amount: number): void {
  if (amount <= 0) return;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) buf.tintFg(x, y, toward, amount);
  }
}

function drawCard(buf: CellBuffer, r: Rect, sub: SubagentState | undefined, index: number, view: SceneView, card?: CardView): void {
  if (!sub) {
    box(buf, r, { color: mix(theme.sub, theme.bgEdge, 0.72), dashed: true, fill: mix(theme.panel, theme.bgEdge, 0.4) });
    centerText(buf, r.x + 1, r.w - 2, r.y + 3, 'no subagent', mix(theme.dim, theme.bgEdge, 0.45));
    return;
  }
  const grow = card?.grow ?? 1;
  const fade = card?.fade ?? 0;
  if (grow < GROW_SHARE) {
    drawGrowingBox(buf, r, grow);
    return;
  }
  const failed = sub.status !== undefined && sub.status !== 'completed';
  const color = failed ? theme.alert : sub.running ? theme.subBright : theme.sub;
  box(buf, r, { color, fill: theme.panel, halo: sub.running ? 0.3 : 0.15, bold: true });
  const inner = r.w - 2;
  const left = r.x + 1;
  // El archivo del subagente aparece antes que el `tool_use` que trae su descripción.
  const name = sub.description || sub.agentType ? plainText(subagentName(view.state, sub.id)) : 'starting…';

  // Etiqueta sobre el borde superior: número de orden y tipo real.
  const label = fit(`${String(index + 1).padStart(2, '0')} ${(sub.agentType ?? 'agent').toLowerCase()}`, inner - 2);
  const chipEnd = left + cellLength(label) + 2;
  for (let x = left; x < chipEnd; x += 1) buf.setBg(x, r.y, mix(theme.panel, theme.sub, sub.running ? 0.3 : 0.12));
  buf.text(left, r.y, ` ${label} `, sub.running ? theme.subBright : theme.dim);

  centerText(buf, left + 1, inner - 2, r.y + 1, name, theme.text, true);
  const tags: Segment[] = sub.model ? [{ text: displayModel(sub.model), color: theme.main }] : [];
  if (sub.running) tags.push({ text: `${sub.model ? ' ' : ''}[ ${spinnerFrame(view.now + index * 40)} ]`, color: theme.sub });
  centerSegments(buf, left, inner, r.y + 2, tags);

  const barX = left + 1;
  const barWidth = inner - 2;
  if (sub.running) indeterminateBar(buf, barX, r.y + 3, barWidth, view.now / 1800 + index * 0.27, theme.barSub);
  else bar(buf, barX, r.y + 3, barWidth, easeOutCubic(segment(fade, 0, FILL_SHARE)), failed ? theme.barAlert : theme.barSub);

  const detail = sub.running
    ? `tools: ${sub.toolCount}${sub.currentTool ? ` · ${sub.currentTool}` : ''}`
    : `${sub.toolCount} tools${sub.durationMs !== undefined ? ` · ${formatDuration(sub.durationMs)}` : ''}`;
  centerText(buf, left, inner, r.y + 4, detail, failed ? theme.alert : theme.sub);
  const status = sub.running ? ['◐', '◓', '◑', '◒'][Math.floor(view.now / 160 + index) % 4] : failed ? '✕' : '●';
  const tokens = !sub.running && sub.totalTokens !== undefined ? ` ${formatTokens(sub.totalTokens)}` : '';
  centerSegments(buf, left, inner, r.y + 5, [
    { text: status as string, color: failed ? theme.alert : theme.sub },
    { text: tokens, color: theme.sub },
    { text: sub.readOnly ? ' read-only' : '', color: theme.dim },
  ]);

  // Entrada: el contenido aparece desde el fondo del panel. Salida: se atenúa, sin perder los datos.
  const appear = segment(grow, GROW_SHARE, 1);
  if (appear < 1) fadeArea(buf, { x: r.x + 1, y: r.y, w: r.w - 2, h: r.h - 1 }, theme.panel, 1 - appear);
  fadeArea(buf, r, theme.panel, DONE_DIM * easeInOutCubic(segment(fade, FILL_SHARE, 1)));
}

interface CardSlot {
  sub: SubagentState | undefined;
  card?: CardView;
}

/**
 * Sin animación, muestra los subagentes activos primero y, si no, los últimos en terminar. Con animación, el
 * director asigna posiciones fijas para que una tarjeta no salte al terminar otra.
 */
function cardSlots(view: SceneView, count: number): CardSlot[] {
  const { subagents } = view.state;
  const slots = view.anim?.cards;
  if (slots) return slots.slice(0, count).map((card) => ({ sub: card && subagents.find((s) => s.id === card.id), card }));
  const running = subagents.filter((s) => s.running);
  const done = subagents.filter((s) => !s.running);
  const picked = [...running.slice(-count), ...done.slice(-Math.max(0, count - running.length))];
  return subagents.filter((s) => picked.includes(s)).map((sub) => ({ sub }));
}

function drawDelegate(buf: CellBuffer, view: SceneView, y: number, x: number, width: number): void {
  const { subagents } = view.state;
  const active = subagents.filter((s) => s.running).length;
  centerSegments(buf, x, width, y, [
    { text: 'delegate to subagents', color: subagents.length ? theme.text : theme.dim },
    { text: ' · ', color: theme.dim },
    { text: mainName(view).toLowerCase(), color: theme.main, bold: true },
    { text: `  [ ${active} / ${subagents.length} ]`, color: theme.dim },
    { text: active > 0 ? ` ${spinnerFrame(view.now, 110)}` : '', color: theme.sub },
  ]);
}

function drawLead(buf: CellBuffer, view: SceneView, r: Rect): void {
  const done = view.state.subagents.filter((s) => !s.running);
  const glow = view.anim?.leadGlow ?? 0;
  box(buf, r, {
    color: done.length ? theme.subBright : mix(mix(theme.sub, theme.bgEdge, 0.5), theme.subBright, glow),
    fill: mix(theme.panel, theme.sub, glow * 0.14),
    halo: (done.length ? 0.5 : 0.1) + glow * 0.9,
    bold: true,
  });
  centerSegments(buf, r.x + 1, r.w - 2, r.y + 1, [
    { text: 'back to ', color: theme.text },
    { text: mainName(view), color: theme.main, bold: true },
    { text: ' · lead', color: theme.text },
  ]);
  const latest = done[done.length - 1];
  const summary = latest?.summary ? `${done.length} back · ${plainText(latest.summary)}` : 'no summaries yet';
  centerText(buf, r.x + 2, r.w - 4, r.y + 2, summary, latest ? theme.dim : theme.faint);
}

// --- Log, prompt y estado ---

const LOG_SLIDE_MS = 260;
const LOG_SLIDE_CELLS = 8;
/** Una línea larga se escribe en este tiempo, y una corta a una velocidad mínima. */
const LOG_TYPE_MS = 600;
const LOG_TYPE_MIN_RATE = 0.05;

function drawLog(buf: CellBuffer, view: SceneView, r: Rect): void {
  box(buf, r, { color: mix(theme.main, theme.panel, 0.55), fill: mix(theme.panel, theme.bgEdge, 0.3) });
  const live = view.replay ? (view.replay.paused ? 'paused' : view.replay.finished ? 'replay end' : `replay x${view.replay.speed}`) : view.connected ? 'live' : 'idle';
  writeSegments(buf, r.x + 3, r.y, [
    { text: ' session log ', color: theme.text },
    { text: `[ ${live} · ${spinnerFrame(view.now, 200)} ] `, color: theme.dim },
  ]);
  const rows = r.h - 2;
  const entries = view.log.slice(-rows);
  entries.forEach((entry, i) => {
    const y = r.y + 1 + i;
    const text = fit(toCells(entry.text), r.w - 27);
    // Entrada: la línea desliza desde la derecha mientras su texto se escribe. El tiempo decide en qué punto va.
    const age = entry.bornAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, view.now - entry.bornAt);
    const slide = Math.round((1 - easeOutCubic(age / LOG_SLIDE_MS)) * LOG_SLIDE_CELLS);
    const headFade = 1 - easeOutCubic(age / LOG_SLIDE_MS);
    const length = cellLength(text);
    const typed = age === Number.POSITIVE_INFINITY ? length : Math.min(length, Math.floor(age * Math.max(LOG_TYPE_MIN_RATE, length / LOG_TYPE_MS)));
    const fadeTo = mix(theme.panel, theme.bgEdge, 0.3);
    buf.text(r.x + 2 + slide, y, formatClock(entry.t), mix(theme.faint, fadeTo, headFade));
    buf.text(r.x + 11 + slide, y, fit(toCells(entry.who), 13), mix(KIND_COLOR[entry.kind], fadeTo, headFade));
    const end = buf.text(r.x + 25 + slide, y, [...text].slice(0, typed).join(''), entry.kind === 'error' ? theme.alert : theme.text);
    if (typed < length && end < r.x + r.w - 1) buf.put(end, y, '▌', KIND_COLOR[entry.kind]);
  });
  if (entries.length === 0) buf.text(r.x + 2, r.y + 1, 'nothing yet', theme.faint);
}

function drawPrompt(buf: CellBuffer, view: SceneView, y: number, x: number, width: number): void {
  const { state } = view;
  const main = modelAlias(state.mainModel);
  const adv = modelAlias(state.advisorModel);
  const end = writeSegments(buf, x + 1, y, [
    { text: `${fit(toCells(folderName(state.cwd)), 18)} $ `, color: theme.main, bold: true },
    { text: 'claude', color: theme.text },
    { text: ' --model ', color: theme.dim },
    { text: main, color: theme.main },
    { text: ' --advisor ', color: theme.dim },
    { text: adv, color: theme.advisor },
    { text: ' ', color: theme.text },
  ]);
  // Cursor parpadeante.
  if (Math.floor(view.now / 530) % 2 === 0) buf.put(end, y, '█', theme.text);
  rightText(buf, x + width - 2, y, 'reconstructed, not literal', theme.faint);
}

function drawStatus(buf: CellBuffer, view: SceneView, y: number, x: number, width: number): void {
  const chipWidth = Math.floor(width * 0.42);
  buf.fill(x + 1, y, chipWidth, 1, theme.chip);
  buf.text(x + 2, y, fit(`# ${toCells(view.queue.last ?? 'no events yet')}`, chipWidth - 2), theme.dim);
  const squares = view.queue.pending.slice(0, 16);
  squares.forEach((kind, i) => buf.put(x + chipWidth + 3 + i, y, '■', KIND_COLOR[kind]));
  rightText(buf, x + width - 2, y, `${view.queue.pending.length} queued`, theme.dim);
}

// --- Layouts ---

function renderFull(buf: CellBuffer, view: SceneView): void {
  // Los rectángulos son absolutos para 96x48: en una terminal mayor se desplaza el origen para centrarlos.
  buf.originX = Math.floor((buf.width - FULL_COLS) / 2);
  buf.originY = Math.floor((buf.height - FULL_ROWS) / 2);
  const target = buf;
  const { rows } = FULL;
  drawWindowBar(target, view, rows.windowBar, FULL_COLS, 0);
  centerSegments(target, 0, FULL_COLS, rows.header, headerSegments(view));
  for (let x = 2; x <= 93; x += 1) target.put(x, rows.separator, '─', mix(theme.main, theme.bgEdge, 0.6));
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
  const bootMs = view.anim?.bootMs;
  if (bootMs !== undefined && bootMs < BOOT_MS) {
    const width = segmentsWidth(headerSegments(view));
    const { originX, originY } = buf;
    const base = baseColor(buf, view.flatBackground ?? false);
    applyBootFull(buf, bootMs, Math.floor((FULL_COLS - width) / 2), width, (x, y) => base(x + originX, y + originY));
  }
  buf.originX = 0;
  buf.originY = 0;
}

function renderReduced(buf: CellBuffer, view: SceneView): void {
  const { width, height } = buf;
  centerSegments(buf, 0, width, 0, headerSegments(view));

  const advisorRect: Rect = { x: 0, y: 1, w: 24, h: height - 8 };
  const { advisor } = view.state;
  box(buf, advisorRect, { color: theme.advisor, fill: theme.panel, halo: 0.25 });
  const ax = advisorRect.x + 2;
  const aw = advisorRect.w - 4;
  centerText(buf, advisorRect.x + 1, advisorRect.w - 2, 2, `${advisorName(view).toUpperCase()} · on call`, theme.advisor, true);
  const consults = advisor.consults.slice(-(advisorRect.h - 8));
  consults.forEach((c, i) => {
    buf.put(ax, 3 + i, '◆', c.isError ? theme.alert : theme.advisor);
    buf.text(ax + 2, 3 + i, fit(c.reason, aw - 2), theme.text);
  });
  if (consults.length === 0) buf.text(ax, 3, 'no consults yet', theme.faint);
  const statsY = advisorRect.y + advisorRect.h - 5;
  const last = advisor.consults.filter((c) => !c.open).pop();
  buf.text(ax, statsY, fit(last ? `sealed · ${formatDuration(last.durationMs)}` : 'inferred labels', aw), last ? theme.alert : theme.faint);
  const stat = (y: number, label: string, value: string): void => {
    buf.text(ax, y, label, theme.dim);
    rightText(buf, ax + aw - 1, y, value, theme.text, true);
  };
  stat(statsY + 1, 'calls', String(advisor.calls));
  stat(statsY + 2, 'tokens read', formatTokens(advisor.tokensRead));
  stat(statsY + 3, 'routine turns', String(advisor.routineTurns));

  const rightX = advisorRect.w + 1;
  const rightW = width - rightX;
  const mainRect: Rect = { x: rightX, y: 1, w: rightW, h: 5 };
  box(buf, mainRect, { color: theme.main, fill: theme.panel, halo: 0.25 });
  centerSegments(buf, rightX + 1, rightW - 2, 2, [
    { text: mainName(view), color: theme.main, bold: true },
    { text: ' · main · effort ', color: theme.dim },
    { text: view.state.effort ?? '—', color: theme.main },
  ]);
  const task = view.state.title ?? view.state.lastPrompt;
  centerText(buf, rightX + 2, rightW - 4, 3, task ? plainText(task) : 'no task yet', task ? theme.text : theme.faint);
  const active = view.connected && !view.state.ended && view.state.status !== 'idle';
  centerSegments(buf, rightX + 1, rightW - 2, 4, [
    { text: mainActivity(view, rightW - 12), color: view.state.status === 'tool' ? theme.metrics : theme.dim },
    { text: active ? `  ${spinnerFrame(view.now)}` : '', color: theme.main },
  ]);

  const cardCount = 3;
  const gap = 1;
  const cardW = Math.floor((rightW - gap * (cardCount - 1)) / cardCount);
  const visible = cardSlots(view, cardCount);
  for (let i = 0; i < cardCount; i += 1) {
    const r: Rect = { x: rightX + i * (cardW + gap), y: 6, w: cardW, h: 5 };
    const sub = visible[i]?.sub;
    if (!sub) {
      box(buf, r, { color: mix(theme.sub, theme.bgEdge, 0.72), dashed: true, fill: mix(theme.panel, theme.bgEdge, 0.4) });
      continue;
    }
    const failed = sub.status !== undefined && sub.status !== 'completed';
    box(buf, r, { color: failed ? theme.alert : sub.running ? theme.subBright : theme.sub, fill: theme.panel, bold: true });
    const index = view.state.subagents.indexOf(sub);
    centerText(buf, r.x + 1, r.w - 2, r.y + 1, plainText(subagentName(view.state, sub.id)), theme.text, true);
    if (sub.running) indeterminateBar(buf, r.x + 2, r.y + 2, r.w - 4, view.now / 1800 + index * 0.27, theme.barSub);
    else bar(buf, r.x + 2, r.y + 2, r.w - 4, 1, failed ? theme.barAlert : theme.barSub);
    centerText(buf, r.x + 1, r.w - 2, r.y + 3, sub.running ? `tools: ${sub.toolCount}` : `${sub.toolCount} tools · ${formatDuration(sub.durationMs)}`, failed ? theme.alert : theme.sub);
  }

  // Herramientas: una línea con los conteos reales.
  const toolsY = 11;
  const sorted = Object.entries(view.state.tools).sort((a, b) => b[1].count - a[1].count);
  buf.text(rightX, toolsY, fit(toCells(`tools ${view.state.toolCalls}: ${sorted.map(([n, s]) => `${n} ${s.count}${s.errors ? `!${s.errors}` : ''}`).join(' · ')}`), rightW), view.state.toolErrors ? theme.alert : theme.metrics);

  const logRect: Rect = { x: 0, y: advisorRect.y + advisorRect.h, w: width, h: height - advisorRect.h - 3 };
  drawLog(buf, view, logRect);
  drawPrompt(buf, view, height - 2, 0, width);
  drawStatus(buf, view, height - 1, 0, width);
}

function renderTooSmall(buf: CellBuffer): void {
  const lines = ['Agranda la ventana', `Mínimo ${MIN_COLS}x${MIN_ROWS} · ahora ${buf.width}x${buf.height}`];
  const y = Math.floor((buf.height - lines.length) / 2);
  lines.forEach((line, i) => centerText(buf, 0, buf.width, y + i, line, i === 0 ? theme.text : theme.dim, i === 0));
}

export function renderScene(buf: CellBuffer, view: SceneView): void {
  const flat = view.flatBackground ?? false;
  paintBackground(buf, flat);
  buf.tintsEnabled = !flat;
  const kind = layoutKind(buf.width, buf.height);
  if (kind === 'full') renderFull(buf, view);
  else if (kind === 'reduced') {
    renderReduced(buf, view);
    const bootMs = view.anim?.bootMs;
    if (bootMs !== undefined && bootMs < BOOT_MS) applyBootFade(buf, bootMs, baseColor(buf, flat));
  } else renderTooSmall(buf);
}
