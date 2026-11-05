// Dibuja un frame completo. Función pura de la vista y del tamaño del buffer.

import { agentLabel, displayModel, formatDuration, formatTokens, modelAlias, plainText, subagentName } from '../core/describe.js';
import { type MemoryTouchState, type SubagentState, memoryLabel, memoryMilestone } from '../core/state.js';
import { easeInOutCubic, easeOutCubic, segment } from '../engine/easing.js';
import { BOOT_MS, applyBootFade, applyBootFull } from './boot.js';
import { BOLD, type CellBuffer, cellLength, fit, toCells } from '../tui/buffer.js';
import { type Rgb, mix } from '../tui/color.js';
import { type Rect, type Segment, bar, box, centerSegments, centerText, countBar, discFrame, rightText, segmentsWidth, spinnerFrame, writeSegments } from './draw.js';
import { COMPACT_ROWS, MIN_COLS, MIN_ROWS, type SceneLayout, layoutFor, layoutKind } from './layout.js';
import { drawPacket } from './packets.js';
import { theme } from './theme.js';
import type { CardView, SceneView } from './view.js';

function paintBackground(buf: CellBuffer): void {
  buf.originX = 0;
  buf.originY = 0;
  buf.bg.fill(theme.bg);
  buf.fg.fill(theme.bg);
  buf.chars.fill(0x20);
  buf.attrs.fill(0);
}

const folderName = (cwd: string | undefined): string => (cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd) : 'no session');

/** Quien hace de hilo principal, o un guion si aún no se sabe. */
const mainModelOf = (view: SceneView): string | undefined => view.state.mainModel ?? view.preview?.main;
const advisorModelOf = (view: SceneView): string | undefined => view.state.advisorModel ?? view.preview?.advisor;
const mainName = (view: SceneView): string => displayModel(mainModelOf(view));
const advisorName = (view: SceneView): string => displayModel(advisorModelOf(view));

/** Modelo que hace el trabajo delegado: el del subagente más reciente o, sin subagentes, el principal. */
function builderName(view: SceneView): string {
  const { subagents } = view.state;
  const latest = [...subagents].reverse().find((s) => s.model);
  return displayModel(latest?.model ?? mainModelOf(view));
}

const EFFORT_LEVELS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

function effortSegments(effort: string | undefined): Segment[] {
  const level = effort ? (EFFORT_LEVELS[effort] ?? 0) : 0;
  return [
    { text: 'effort ', color: theme.dim },
    { text: '▮'.repeat(level), color: theme.main },
    { text: '▯'.repeat(5 - level), color: theme.faint },
    { text: ` ${effort ?? '—'}`, color: theme.main },
  ];
}

/** Tiempo desde el inicio de la sesión, como en la referencia. */
function formatElapsed(t: number, start: number | undefined): string {
  if (t <= 0 || start === undefined) return '--:--:--';
  const total = Math.max(0, Math.floor((t - start) / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** Hora abreviada (`mm:ss` si la sesión lleva menos de 1 h, `hh:mm:ss` si no), para espacios estrechos. */
function formatShortElapsed(t: number, start: number | undefined): string {
  const full = formatElapsed(t, start);
  return full.startsWith('00:') ? full.slice(3) : full;
}

const KIND_COLOR = {
  main: theme.main,
  sub: theme.sub,
  advisor: theme.advisor,
  tool: theme.dim,
  memory: theme.metrics,
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
  return `--model ${modelAlias(mainModelOf(view))}`;
}

const isMainActive = (view: SceneView): boolean => view.connected && !view.state.ended && view.state.status !== 'idle';

function headerSegments(view: SceneView): Segment[] {
  const title: Segment = { text: 'SINAPSIS', color: theme.text, bold: true };
  const gap: Segment = { text: ' · ', color: theme.dim };
  const cwd = view.state.cwd;
  const hasSession = view.connected || Boolean(cwd) || Boolean(mainModelOf(view));
  if (!hasSession && !view.illustrativeDemo && !view.replay) {
    return [title, gap, { text: 'WAITING FOR A SESSION', color: theme.dim }];
  }
  const mode = view.illustrativeDemo
    ? { text: 'DEMO', color: theme.dim }
    : view.replay
      ? {
          text: view.replay.paused ? 'PAUSED' : view.replay.finished ? 'REPLAY END' : `REPLAY x${view.replay.speed}`,
          color: theme.dim,
        }
      : { text: 'LIVE', color: view.state.ended || !view.connected ? theme.dim : theme.main };
  if (!cwd) return [title, gap, mode];
  return [title, gap, { text: toCells(folderName(cwd)), color: theme.text }, gap, mode];
}

function drawLegend(buf: CellBuffer, view: SceneView, L: SceneLayout): void {
  const fullItems: Array<[Rgb, string]> = [
    [theme.main, `lead · ${mainName(view)}`],
    [theme.sub, `build · ${builderName(view)}`],
    [theme.metrics, 'agent memory'],
    [theme.notes, 'project memory'],
    [theme.advisor, `advisor · ${advisorName(view)}`],
  ];
  const aliasItems: Array<[Rgb, string]> = [
    [theme.main, `lead · ${mainName(view)}`],
    [theme.sub, `build · ${modelAlias(view.state.subagents.slice().reverse().find((s) => s.model)?.model ?? mainModelOf(view))}`],
    [theme.metrics, 'agent memory'],
    [theme.notes, 'project memory'],
    [theme.advisor, `advisor · ${modelAlias(advisorModelOf(view))}`],
  ];
  const shortItems: Array<[Rgb, string]> = [
    [theme.main, `lead · ${mainName(view)}`],
    [theme.sub, 'build'],
    [theme.metrics, 'agent memory'],
    [theme.notes, 'project memory'],
    [theme.advisor, 'advisor'],
  ];
  const widthOf = (list: Array<[Rgb, string]>): number => list.reduce((sum, [, label]) => sum + cellLength(label) + 2, 0);
  const fits = (list: Array<[Rgb, string]>): boolean => widthOf(list) + list.length - 1 <= L.width;
  const items = fits(fullItems) ? fullItems : fits(aliasItems) ? aliasItems : shortItems;
  const used = widthOf(items);
  const gap = Math.max(1, Math.floor((L.width - used) / (items.length + 1)));
  let x = gap;
  for (const [color, label] of items) {
    buf.put(x, L.rows.legend, '■', color);
    x = buf.text(x + 2, L.rows.legend, label, theme.dim) + gap;
  }
}

/** Cuánto se apagan los bordes al respirar. */
const BREATH_DEPTH = 0.22;

/** Los bordes son más tenues que el color puro del token, y respiran en reposo. */
const panelBorder = (color: Rgb, view: SceneView): Rgb => mix(color, theme.panel, 0.12 + BREATH_DEPTH * (view.anim?.breath ?? 0));

// --- Memoria de proyecto ---

const MILESTONES = ['before work', 'repeat failure', 'before sign-off'] as const;

const fireCounts = (view: SceneView): [number, number, number] => {
  const counts: [number, number, number] = [view.state.memory.loaded.length ? 1 : 0, 0, 0];
  for (const touch of view.state.memory.touches) counts[memoryMilestone(view.state, touch)] += 1;
  return counts;
};

/** Hora en que se disparó por primera vez cada hito, o `undefined` si aún no ocurrió. */
function milestoneTimes(view: SceneView): [number | undefined, number | undefined, number | undefined] {
  const { state } = view;
  const loadedTimes = state.memory.loaded.map((l) => l.t).filter((t) => t > 0);
  const firstLoaded = loadedTimes.length ? Math.min(...loadedTimes) : state.memory.loaded.length ? state.startedAt : undefined;
  const times: [number | undefined, number | undefined, number | undefined] = [firstLoaded, undefined, undefined];
  for (const touch of state.memory.touches) {
    const slot = memoryMilestone(state, touch);
    const prev = times[slot];
    if (prev === undefined || (touch.t > 0 && (prev <= 0 || touch.t < prev))) times[slot] = touch.t;
  }
  return times;
}

/** Etiqueta de hora compacta para hitos con poco espacio horizontal (ej. `0:26`, `12:03` o `1h02m`). */
function formatCompactMilestoneTime(t: number, start: number | undefined): string {
  if (t <= 0 || start === undefined) return '—';
  const total = Math.max(0, Math.floor((t - start) / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor(total / 60) % 60;
  const secs = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h${pad(mins)}`;
  return `${mins}:${pad(secs)}`;
}

function memoryScopeLabel(view: SceneView): string {
  const { touches, loaded } = view.state.memory;
  return touches[touches.length - 1]?.scope ?? loaded[0]?.scope ?? (view.illustrativeDemo ? 'project' : '—');
}

interface PanelLine {
  text: string;
  color: Rgb;
  value?: string;
  valueColor?: Rgb;
  bold?: boolean;
}

const blank: PanelLine = { text: '', color: theme.dim };
const caption = (text: string): PanelLine => ({ text, color: theme.dim });

function memoryFileLines(view: SceneView, maxRows: number): PanelLine[] {
  if (maxRows <= 0) return [];
  const { state } = view;
  const { touches, loaded } = state.memory;
  const items: Array<{ t: number; file: string; detail: string }> = [
    ...loaded.map((l) => ({ t: l.t || state.startedAt || 0, file: l.file, detail: 'session · loaded' })),
    ...touches.map((t) => ({
      t: t.t,
      file: t.file,
      detail: `${t.agentId ? agentLabel(state, t.agentId) : modelAlias(state.mainModel)} · ${memoryLabel(state, t)}`,
    })),
  ];
  if (items.length === 0) return [{ text: 'no memory files yet', color: theme.faint }];
  const withDetail = maxRows >= 4;
  const step = withDetail ? 2 : 1;
  const recent = items.slice(-Math.max(1, Math.floor(maxRows / step)));
  const lines: PanelLine[] = [];
  for (const item of recent) {
    const time = item.t > 0 ? formatShortElapsed(item.t, state.startedAt) : '--:--';
    lines.push({ text: `${time} ${toCells(item.file)}`, color: theme.notes });
    if (withDetail && lines.length < maxRows) lines.push({ text: toCells(item.detail), color: theme.dim });
  }
  return lines;
}

function projectTotals(view: SceneView): PanelLine[] {
  const { state } = view;
  const { touches, loaded } = state.memory;
  const files = new Set([...touches.map((t) => t.file), ...loaded.map((l) => l.file)]);
  const toolsShown = Math.round(view.anim?.numbers?.toolCalls ?? state.toolCalls);
  const errors = state.toolErrors;
  return [
    caption('totals'),
    { text: 'agents', color: theme.dim, value: String(state.subagents.length) },
    { text: 'memories', color: theme.dim, value: String(files.size) },
    { text: 'tools', color: theme.dim, value: String(toolsShown) },
    { text: 'errors', color: errors > 0 ? theme.alert : theme.dim, value: String(errors), valueColor: errors > 0 ? theme.alert : theme.dim },
  ];
}

function drawPanelLines(buf: CellBuffer, r: Rect, x: number, from: number, to: number, lines: PanelLine[]): void {
  const width = r.x + r.w - 1 - x;
  lines.slice(0, Math.max(0, to - from)).forEach((line, i) => {
    const y = from + i;
    buf.text(x, y, fit(line.text, line.value ? width - cellLength(line.value) - 1 : width), line.color, line.bold ? BOLD : 0);
    if (line.value) rightText(buf, r.x + r.w - 2, y, line.value, line.valueColor ?? theme.text);
  });
}

function drawProject(buf: CellBuffer, view: SceneView, L: SceneLayout): void {
  const r = L.project;
  const memoryPulse = view.anim?.memoryPulse;
  box(buf, r, { color: panelBorder(theme.notes, view), fill: theme.panel });
  const [m0, m1, m2] = L.milestones;
  const inner = r.w - 2;
  const left = r.x + 1;
  const scope: Segment[] = [{ text: `memory: ${memoryScopeLabel(view)}`, color: theme.notes }];

  // Con poca altura, el título va sobre el borde para que el primer hito siga alineado con su panel.
  if (m0 - r.y >= 3) {
    centerText(buf, left, inner, r.y + 1, 'PROJECT MEMORY', theme.notes, true);
    centerSegments(buf, left, inner, r.y + 2, scope);
  } else {
    buf.text(left + 1, r.y, ' PROJECT MEMORY ', theme.notes, BOLD);
    centerSegments(buf, left, inner, r.y + 1, scope);
  }

  // Línea de tiempo punteada entre el primer y el último hito.
  const lineX = left;
  for (let y = m0 + 1; y < m2; y += 1) buf.put(lineX, y, '╎', theme.faint);

  const text = lineX + 2;
  const totals = projectTotals(view);
  const firstSpace = m1 - m0 - 1;
  const secondSpace = m2 - m1 - 1;

  // Prioridad: hitos > totales > lista de archivos. En compacto de 30 filas, secondSpace es 4 y caben las 4 filas de valores.
  const totalsRows = secondSpace === totals.length - 1 ? totals.slice(1) : totals;
  if (secondSpace >= totalsRows.length) {
    const fileBudget = firstSpace >= 3 ? firstSpace - 2 : firstSpace;
    const files = memoryFileLines(view, fileBudget);
    drawPanelLines(buf, r, text, m0 + 1, m1, firstSpace >= files.length + 1 ? [blank, ...files] : files);
    drawPanelLines(buf, r, text, m1 + 1, m2, secondSpace >= totalsRows.length + 1 ? [blank, ...totalsRows] : totalsRows);
  } else {
    const fileBudget = Math.max(0, firstSpace - totals.length - 1);
    const files = fileBudget > 0 ? [...memoryFileLines(view, fileBudget), blank] : [];
    drawPanelLines(buf, r, text, m0 + 1, m1, [...files, ...totals]);
  }

  const counts = fireCounts(view);
  const times = milestoneTimes(view);
  const rowWidth = r.x + r.w - 1 - text;
  L.milestones.forEach((row, slot) => {
    const pulse = memoryPulse?.slot === slot ? memoryPulse.amount : 0;
    const fired = (counts[slot] ?? 0) > 0;
    if (pulse > 0) for (let x = left; x < r.x + r.w - 1; x += 1) buf.setBg(x, row, mix(theme.panel, theme.notes, 0.12 + pulse * 0.16));
    buf.put(lineX, row, fired || pulse > 0 ? '◆' : '◇', mix(theme.notes, theme.subBright, pulse * 0.6), fired || pulse > 0 ? BOLD : 0);
    const name = MILESTONES[slot] as string;
    const firedAt = times[slot];
    const hasFiredTime = fired && firedAt !== undefined && firedAt > 0;
    const candidates = hasFiredTime
      ? [
          formatElapsed(firedAt, view.state.startedAt),
          formatShortElapsed(firedAt, view.state.startedAt),
          formatCompactMilestoneTime(firedAt, view.state.startedAt),
        ]
      : ['—'];
    const fitsOnRow = (t: string): boolean => cellLength(name) + 1 + cellLength(t) <= rowWidth;
    const inlineTime = candidates.find(fitsOnRow);
    buf.text(text, row, fit(name, rowWidth), fired || pulse > 0 ? theme.text : mix(theme.notes, theme.bg, 0.15));
    if (inlineTime) {
      rightText(buf, r.x + r.w - 2, row, inlineTime, hasFiredTime ? theme.dim : theme.faint);
    } else if (hasFiredTime && row + 1 < r.y + r.h - 1 && !L.milestones.includes(row + 1)) {
      rightText(buf, r.x + r.w - 2, row + 1, formatShortElapsed(firedAt, view.state.startedAt), theme.dim);
    }
  });
}

function dashedArrow(buf: CellBuffer, y: number, from: number, to: number, color: Rgb): void {
  for (let x = from; x < to; x += 1) buf.put(x, y, '┄', color);
  buf.put(to, y, '▸', color);
}

// --- Conectores ---

/** Color de un conector: tenue en reposo y con el color de lo que pasa por él cuando se usa. */
const lineColor = (active: boolean, color: Rgb): Rgb => (active ? mix(color, theme.bg, 0.3) : theme.line);

function drawConnectors(buf: CellBuffer, view: SceneView, L: SceneLayout): void {
  const { spine, cardCenters, main, lead, cards, rows } = L;
  const { subagents } = view.state;
  const hasSubagents = subagents.length > 0;
  const anyDone = subagents.some((s) => !s.running);

  // Memoria de proyecto hacia cada panel.
  const counts = fireCounts(view);
  const edge = L.project.x + L.project.w;
  const targets = [main.x - 1, (cards[0] as Rect).x - 1, lead.x - 1];
  L.milestones.forEach((row, slot) => {
    const pulse = view.anim?.memoryPulse?.slot === slot ? view.anim.memoryPulse.amount : 0;
    const base = (counts[slot] ?? 0) > 0 ? mix(theme.notes, theme.bg, 0.35) : mix(theme.notes, theme.bg, 0.68);
    dashedArrow(buf, row, edge, targets[slot] as number, mix(base, theme.notes, pulse));
  });

  // Sesión principal hacia el advisor.
  const consulted = view.state.advisor.calls > 0;
  dashedArrow(buf, L.advisorLink, main.x + main.w, L.advisor.x - 1, consulted ? mix(theme.advisor, theme.bg, 0.3) : mix(theme.advisor, theme.bg, 0.65));

  // Tronco continuo desde la sesión principal hasta el bus de tarjetas.
  const busColor = lineColor(hasSubagents, theme.sub);
  const trunk = hasSubagents ? busColor : lineColor(view.connected, theme.main);
  for (let y = main.y + main.h; y < rows.bus; y += 1) buf.put(spine, y, '│', trunk);

  // Distribución hacia las tarjetas.
  const [c0, c1, c2] = cardCenters;
  for (let x = c0; x <= c2; x += 1) buf.put(x, rows.bus, '─', busColor);
  buf.put(c0, rows.bus, '┌', busColor);
  buf.put(c2, rows.bus, '┐', busColor);
  buf.put(c1, rows.bus, '┼', busColor);

  // Regreso hacia el lead.
  const backColor = lineColor(anyDone, theme.sub);
  const cardBottom = (cards[0] as Rect).y + (cards[0] as Rect).h;
  for (const center of cardCenters) for (let y = cardBottom; y < rows.merge; y += 1) buf.put(center, y, '│', backColor);
  for (let x = c0; x <= c2; x += 1) buf.put(x, rows.merge, '─', backColor);
  buf.put(c0, rows.merge, '└', backColor);
  buf.put(c2, rows.merge, '┘', backColor);
  buf.put(c1, rows.merge, '┼', backColor);
  for (let y = rows.merge + 1; y < lead.y; y += 1) buf.put(spine, y, '│', backColor);
}

/** Flechas de entrada: sobre su propia fila o, en el compacto, sobre el borde superior. Van después de los paneles. */
function drawArrows(buf: CellBuffer, L: SceneLayout): void {
  const cardRow = L.cardArrowRow ?? (L.cards[0] as Rect).y;
  for (const center of L.cardCenters) buf.put(center, cardRow, '▼', theme.sub);
  buf.put(L.spine, L.leadArrowRow ?? L.lead.y, '▼', theme.main);
}

// --- Sesión principal y advisor ---

function drawMainPanel(buf: CellBuffer, view: SceneView, r: Rect): void {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.main, view), fill: theme.panel });
  const inner = r.w - 2;
  const left = r.x + 1;
  centerSegments(buf, left, inner, r.y + 1, [
    { text: mainName(view), color: theme.main },
    { text: ' · main session', color: theme.main },
  ]);

  const task = state.title ?? state.lastPrompt;
  const active = isMainActive(view);
  const activity: Segment[] = [
    { text: mainActivity(view, active ? inner - 4 : inner - 2), color: state.status === 'tool' ? theme.sub : theme.dim },
    { text: active ? ` ${spinnerFrame(view.now)}` : '', color: theme.main },
  ];
  const line = (y: number, segments: Segment[]): void => centerSegments(buf, left, inner, y, segments);

  if (r.h >= 6) {
    centerText(buf, left + 1, inner - 2, r.y + 2, task ? plainText(task) : 'no task yet', task ? theme.text : theme.faint);
    line(r.y + 3, effortSegments(state.effort));
    line(r.y + 4, activity);
  } else if (r.h === 5) {
    centerText(buf, left + 1, inner - 2, r.y + 2, task ? plainText(task) : 'no task yet', task ? theme.text : theme.faint);
    line(r.y + 3, active || !view.connected ? activity : effortSegments(state.effort));
  } else {
    // Una sola fila libre: lo que está pasando manda sobre el effort.
    line(r.y + 2, active || !view.connected || state.ended ? activity : effortSegments(state.effort));
  }
}

function drawAdvisorBox(buf: CellBuffer, view: SceneView, r: Rect): void {
  const { state } = view;
  const pulse = view.anim?.advisorPulse ?? 0;
  // `replaying` solo se enciende al reproducir un lote: en vivo la consulta no se ve mientras ocurre.
  const replaying = state.advisor.consults.some((c) => c.open);
  box(buf, r, {
    color: mix(panelBorder(theme.advisor, view), theme.subBright, pulse * 0.6),
    dashed: !replaying,
    fill: mix(theme.panel, theme.advisor, pulse * 0.06),
    halo: pulse * 0.12,
    bold: replaying || pulse > 0.5,
  });
  const inner = r.w - 2;
  const left = r.x + 1;
  const enabled = state.advisorEnabled || Boolean(advisorModelOf(view));
  const status = replaying ? 'replaying' : enabled ? 'silent' : 'off';
  const statusColor = replaying ? theme.advisor : theme.dim;
  const numbers = view.anim?.numbers;
  const callsCount = Math.round(numbers?.calls ?? state.advisor.calls);
  const calls = String(callsCount);
  const consultWord = callsCount === 1 ? 'consult' : 'consults';
  const tokens = formatTokens(Math.round(numbers?.tokensRead ?? state.advisor.tokensRead));
  const longStats = `${calls} ${consultWord} · ${tokens} tok`;
  const midStats = `${calls} · ${tokens} tok`;
  const compactStats = `${calls}·${tokens} tok`;
  const statsLine = cellLength(longStats) <= inner ? longStats : cellLength(midStats) <= inner ? midStats : cellLength(compactStats) <= inner ? compactStats : `${calls} · ${tokens}`;
  // `replaying` no deja lugar para el contador en una fila.
  const fullShort = `${status} · ${calls} ${consultWord}`;
  const shortStatus = replaying ? status : cellLength(fullShort) <= inner ? fullShort : `${status} · ${calls}`;

  centerText(buf, left, inner, r.y + 1, 'ADVISOR', theme.advisor, true);
  if (r.h >= 6) {
    centerText(buf, left, inner, r.y + 2, advisorName(view), theme.text);
    centerText(buf, left, inner, r.y + 3, status, statusColor, replaying);
    centerText(buf, left, inner, r.y + 4, statsLine, theme.dim);
  } else if (r.h === 5) {
    centerText(buf, left, inner, r.y + 2, advisorName(view), theme.text);
    centerText(buf, left, inner, r.y + 3, shortStatus, statusColor, replaying);
  } else {
    centerText(buf, left, inner, r.y + 2, shortStatus, statusColor, replaying);
  }
}

// --- Memoria de agentes ---

interface MemoryRow {
  name: string;
  fraction: number;
  label: string;
  labelColor: Rgb;
  barColor: Rgb;
}

/** Demo: una fila por tarjeta, con la actividad ilustrativa de cada una. */
function slotMemoryRows(view: SceneView, count: number): MemoryRow[] {
  const { state } = view;
  const slots = cardSlots(view, count);
  const shown = (id: string): number => view.anim?.numbers?.memory[id] ?? state.memory.touches.filter((t) => t.agentId === id).length;
  const ids = slots.map((slot) => slot.sub?.id).filter((id): id is string => id !== undefined);
  const max = Math.max(1, ...ids.map(shown));
  const rows: MemoryRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const sub = slots[i]?.sub;
    if (!sub) continue;
    const example = view.anim?.illustrative?.memory[i];
    const name = sub.agentType || sub.description ? agentLabel(state, sub.id) : 'starting…';
    if (example) {
      const check = example.label === 'check';
      rows.push({ name, fraction: example.fraction, label: example.label, labelColor: check ? theme.main : theme.metrics, barColor: check ? theme.main : theme.barGood });
      continue;
    }
    const own = state.memory.touches.filter((t) => t.agentId === sub.id);
    const last = own[own.length - 1];
    const label = last ? memoryLabel(state, last) : 'no memory';
    const check = label === 'check';
    rows.push({ name, fraction: shown(sub.id) / max, label, labelColor: last ? (check ? theme.main : theme.metrics) : theme.faint, barColor: check ? theme.main : theme.barGood });
  }
  return rows;
}

/** Ejecuciones de un mismo rol (`agentType`). Sin tipo, cada ejecución es su propio rol. */
interface RoleGroup {
  name: string;
  members: SubagentState[];
  running: boolean;
  /** Primera ejecución del rol, en el orden del estado: da el orden estable de las filas. */
  order: number;
  /** Hora de su última operación de memoria. */
  lastTouch?: MemoryTouchState;
}

/** Alguna ejecución del rol recibió un índice de memoria con notas. */
const isIndexed = (group: RoleGroup): boolean => group.members.some((m) => m.memoryIndexed === true);

/** Sin operaciones, distingue tener notas, no tenerlas y no poder saberlo. */
function idleMemoryLabel(group: RoleGroup): string {
  if (isIndexed(group)) return 'indexed';
  return group.members.some((m) => m.memoryIndexed === false) ? 'no memory' : 'no data';
}

function roleGroups(view: SceneView): RoleGroup[] {
  const { state } = view;
  const groups = new Map<string, RoleGroup>();
  const byAgent = new Map<string, RoleGroup>();
  state.subagents.forEach((sub, order) => {
    const key = sub.agentType ? `type:${sub.agentType}` : `id:${sub.id}`;
    let group = groups.get(key);
    if (!group) {
      const name = sub.agentType || sub.description ? agentLabel(state, sub.id) : 'starting…';
      group = { name, members: [], running: false, order };
      groups.set(key, group);
    }
    group.members.push(sub);
    group.running ||= sub.running;
    byAgent.set(sub.id, group);
  });
  // `touches` está ordenada por hora: la última de cada rol es su operación más reciente.
  for (const touch of state.memory.touches) {
    const group = touch.agentId ? byAgent.get(touch.agentId) : undefined;
    if (group) group.lastTouch = touch;
  }
  return [...groups.values()];
}

/** Datos reales: una fila por rol, con las operaciones de memoria de todas sus ejecuciones. */
function memoryRows(view: SceneView, count: number): MemoryRow[] {
  if (view.illustrativeDemo) return slotMemoryRows(view, count);
  const { state } = view;
  let groups = roleGroups(view);
  if (groups.length > count) {
    // Primero los que corren y luego los de memoria más reciente. Se muestran en el orden en que aparecieron.
    const priority = (g: RoleGroup): number => (g.running ? 1e15 : 0) + (g.lastTouch?.t ?? 0);
    groups = [...groups].sort((a, b) => priority(b) - priority(a) || a.order - b.order).slice(0, count).sort((a, b) => a.order - b.order);
  }
  const shown = (id: string): number => view.anim?.numbers?.memory[id] ?? state.memory.touches.filter((t) => t.agentId === id).length;
  const total = (g: RoleGroup): number => g.members.reduce((sum, m) => sum + shown(m.id), 0);
  const max = Math.max(1, ...groups.map(total));
  const rows: MemoryRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const group = groups[i];
    if (!group) continue;
    const last = group.lastTouch;
    const label = last ? memoryLabel(state, last) : idleMemoryLabel(group);
    const check = label === 'check';
    const idleColor = isIndexed(group) ? theme.dim : theme.faint;
    rows.push({ name: group.name, fraction: total(group) / max, label, labelColor: last ? (check ? theme.main : theme.metrics) : idleColor, barColor: check ? theme.main : theme.barGood });
  }
  return rows;
}

function drawAgentMemory(buf: CellBuffer, view: SceneView, r: Rect): void {
  const { state } = view;
  box(buf, r, { color: panelBorder(theme.metrics, view), fill: theme.panel });
  const left = r.x + 2;
  const right = r.x + r.w - 2;
  const rows = memoryRows(view, 3);
  const allRoles = view.illustrativeDemo ? undefined : roleGroups(view);
  const rolesTotal = allRoles ? allRoles.length : state.subagents.length;
  const rolesWithMemory = allRoles ? allRoles.filter((g) => g.lastTouch || isIndexed(g)).length : state.subagents.length;
  const rolesFull: Segment[] = [
    { text: 'roles  ', color: theme.dim },
    { text: `${rolesWithMemory} / ${rolesTotal}`, color: theme.metrics },
  ];
  const rolesShort: Segment[] = [
    { text: 'roles ', color: theme.dim },
    { text: `${rolesWithMemory}/${rolesTotal}`, color: theme.metrics },
  ];
  const footerFull = view.illustrativeDemo ? 'memory · illustrative activity' : 'memory · real tool calls';
  const footerMaxWidth = r.h >= 7 ? r.w - 4 : r.w - 2;
  const footerText = view.illustrativeDemo && cellLength(footerFull) > footerMaxWidth ? 'illustrative activity' : footerFull;

  let y = r.y + 1;
  if (r.h >= 6) {
    buf.text(left, y, 'AGENT MEMORY', theme.metrics, BOLD);
    const roles = left + 13 + segmentsWidth(rolesFull) <= right + 1 ? rolesFull : rolesShort;
    writeSegments(buf, right - segmentsWidth(roles) + 1, y, roles);
    y += 1;
  } else {
    buf.text(left - 1, r.y, ' AGENT MEMORY ', theme.metrics, BOLD);
    const roles = left + 14 + segmentsWidth(rolesFull) + 2 <= right ? rolesFull : rolesShort;
    writeSegments(buf, right - segmentsWidth(roles) - 1, r.y, [{ text: ' ', color: theme.dim }, ...roles, { text: ' ', color: theme.dim }]);
  }

  if (rows.length === 0) {
    buf.text(left, y, 'no subagents yet', theme.faint);
  } else {
    const inner = right - left + 1;
    const labelWidth = Math.min(9, Math.max(6, inner - 16));
    const barWidth = Math.min(10, Math.max(4, inner - labelWidth - 11));
    const nameWidth = Math.max(6, inner - barWidth - labelWidth - 2);
    const barX = left + nameWidth + 1;
    rows.forEach((row, i) => {
      buf.text(left, y + i, fit(toCells(row.name), nameWidth), theme.text);
      bar(buf, barX, y + i, barWidth, row.fraction, row.barColor);
      if (row.label) buf.text(barX + barWidth + 1, y + i, fit(row.label, right - barX - barWidth), row.labelColor);
    });
  }

  // Con espacio va en su fila. Si no, sobre el borde inferior, porque un rótulo ilustrativo debe verse siempre.
  if (r.h >= 7) {
    buf.text(left, r.y + r.h - 2, fit(footerText, r.w - 4), theme.dim);
  } else if (cellLength(footerText) + 2 <= r.w - 2) {
    buf.text(r.x + 1, r.y + r.h - 1, ` ${footerText} `, theme.dim);
  } else {
    buf.text(r.x + 1, r.y + r.h - 1, fit(footerText, r.w - 2), theme.dim);
  }
}

// --- Subagentes ---

const toolsLabel = (count: number): string => `${count} ${count === 1 ? 'tool' : 'tools'}`;

/** Parte de la entrada de una tarjeta en que crece la caja. Después se funde el contenido. */
const GROW_SHARE = 0.6;
/** Parte de la salida en que se llena la barra. Después se atenúa. */
const FILL_SHARE = 0.4;
/** Cuánto se atenúa una tarjeta terminada. Debe seguir siendo legible. */
const DONE_DIM = 0.2;

/** Caja de un tamaño intermedio, creciendo desde el centro. */
function drawGrowingBox(buf: CellBuffer, r: Rect, grow: number): void {
  const k = easeOutCubic(segment(grow, 0, GROW_SHARE));
  const w = Math.max(3, Math.round(r.w * k));
  const h = Math.max(3, Math.round(r.h * k));
  const rect: Rect = { x: r.x + Math.floor((r.w - w) / 2), y: r.y + Math.floor((r.h - h) / 2), w, h };
  box(buf, rect, { color: mix(theme.bg, theme.sub, k), fill: theme.panel, halo: 0.12 * k });
}

function fadeArea(buf: CellBuffer, r: Rect, toward: Rgb, amount: number): void {
  if (amount <= 0) return;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) buf.tintFg(x, y, toward, amount);
  }
}

function drawCard(buf: CellBuffer, r: Rect, sub: SubagentState | undefined, slot: number, view: SceneView, card?: CardView): void {
  if (!sub) {
    box(buf, r, { color: mix(theme.sub, theme.bg, 0.72), dashed: true, fill: theme.panel });
    centerText(buf, r.x + 1, r.w - 2, r.y + Math.floor(r.h / 2), 'no subagent', theme.faint);
    return;
  }
  const grow = card?.grow ?? 1;
  // Sin animación, una tarjeta terminada se dibuja en su estado final.
  const fade = card?.fade ?? (sub.running ? 0 : 1);
  if (grow < GROW_SHARE) {
    drawGrowingBox(buf, r, grow);
    return;
  }
  const index = view.state.subagents.indexOf(sub);
  const failed = sub.status !== undefined && sub.status !== 'completed';
  const pulse = view.anim?.memoryPulse?.card === slot ? view.anim.memoryPulse.amount : 0;
  const base = failed ? theme.alert : sub.running ? theme.sub : mix(theme.sub, theme.bg, 0.15);
  box(buf, r, { color: mix(base, theme.notes, pulse), fill: theme.panel, halo: pulse * 0.35, bold: pulse > 0.3 });
  const inner = r.w - 2;
  const left = r.x + 1;
  const name = sub.agentType || sub.description ? agentLabel(view.state, sub.id) : 'starting…';
  const model = displayModel(sub.model);
  const role = sub.description ? plainText(subagentName(view.state, sub.id)) : (sub.agentType ?? '');

  const percent = view.anim?.illustrative?.percents[slot];
  const drawBar = (y: number): void => {
    const right = percent !== undefined && sub.running ? `${Math.round(percent)}%` : toolsLabel(sub.toolCount);
    const barX = left + 1;
    const width = Math.max(4, inner - 3 - cellLength(right));
    if (percent !== undefined && sub.running) bar(buf, barX, y, width, percent / 100, theme.barSub);
    else if (sub.running) countBar(buf, barX, y, width, sub.toolCount, theme.barSub);
    else bar(buf, barX, y, width, easeOutCubic(segment(fade, 0, FILL_SHARE)), failed ? theme.barAlert : theme.barSub);
    rightText(buf, r.x + r.w - 2, y, right, theme.dim);
  };

  const statusLine = (y: number): void => {
    const segments: Segment[] = sub.running
      ? [
          { text: `${discFrame(view.now, index)} `, color: theme.sub },
          { text: 'running', color: theme.sub },
          { text: sub.currentTool ? ` · ${sub.currentTool}` : '', color: theme.dim },
        ]
      : failed
        ? [{ text: '✕ failed', color: theme.alert }]
        : [
            { text: '✓ ', color: theme.metrics },
            { text: 'done', color: theme.metrics },
            { text: sub.durationMs !== undefined ? ` · ${formatDuration(sub.durationMs)}` : '', color: theme.dim },
          ];
    const width = segmentsWidth(segments);
    if (width <= inner) centerSegments(buf, left, inner, y, segments);
    else centerSegments(buf, left, inner, y, segments.slice(0, 2));
  };

  const nameLine = (y: number, withModel: boolean): void => {
    if (withModel) {
      // Si no cabe el nombre completo del modelo, el nombre del agente manda y el modelo se abrevia.
      const fitsFull = cellLength(name) + cellLength(model) + 3 <= inner;
      const shownModel = fitsFull ? model : modelAlias(sub.model);
      centerSegments(buf, left, inner, y, [
        { text: fit(toCells(name), Math.max(4, inner - cellLength(shownModel) - 3)), color: theme.text, bold: true },
        { text: ' · ', color: theme.dim },
        { text: shownModel, color: theme.sub },
      ]);
    } else {
      const tag = sub.readOnly && cellLength(name) + 10 <= inner ? ' read-only' : '';
      centerSegments(buf, left, inner, y, [
        { text: fit(toCells(name), inner - cellLength(tag)), color: theme.text, bold: true },
        { text: tag, color: theme.dim },
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

function drawDelegate(buf: CellBuffer, view: SceneView, L: SceneLayout): void {
  const { subagents } = view.state;
  const active = subagents.filter((s) => s.running).length;
  const done = subagents.length - active;
  const x = L.spine + 2;
  if (subagents.length === 0) {
    buf.text(x, L.rows.delegate, 'no subagents yet', theme.faint);
    return;
  }
  const text = `${subagents.length} delegated · ${done} done`;
  const end = buf.text(x, L.rows.delegate, text, theme.text);
  if (active > 0) buf.put(end + 1, L.rows.delegate, spinnerFrame(view.now, 110), theme.sub);
}

function drawLead(buf: CellBuffer, view: SceneView, r: Rect): void {
  const { subagents } = view.state;
  const done = subagents.filter((s) => !s.running);
  const running = subagents.length - done.length;
  const glow = view.anim?.leadGlow ?? 0;
  const pulse = view.anim?.memoryPulse?.slot === 2 && view.anim.memoryPulse.card === undefined ? view.anim.memoryPulse.amount : 0;
  box(buf, r, {
    color: mix(mix(panelBorder(theme.main, view), theme.subBright, glow * 0.8), theme.notes, pulse),
    fill: mix(theme.panel, theme.sub, glow * 0.1),
    halo: glow * 0.35 + pulse * 0.35,
    bold: glow > 0.3 || pulse > 0.3,
  });
  const title: Segment[] = [
    { text: 'back to ', color: theme.main },
    { text: mainName(view), color: theme.main },
    { text: ' · lead', color: theme.main },
  ];
  const left = r.x + 1;
  const inner = r.w - 2;
  if (r.h >= 4) {
    centerSegments(buf, left, inner, r.y + 1, title);
    const latest = done[done.length - 1];
    const waiting = running > 0 ? `waiting for ${running} ${running === 1 ? 'summary' : 'summaries'}` : 'no summaries yet';
    const summary = !latest ? waiting : latest.summary ? `${done.length} back · ${plainText(latest.summary)}` : `${done.length} back`;
    centerText(buf, left + 1, inner - 2, r.y + 2, summary, latest ? theme.text : theme.dim);
  } else {
    centerSegments(buf, left, inner, r.y + 1, [...title, { text: subagents.length ? ` · ${done.length}/${subagents.length}` : '', color: theme.dim }]);
  }
}

// --- Log, prompt y estado ---

const LOG_SLIDE_MS = 260;
const LOG_SLIDE_CELLS = 8;
/** Una línea larga se escribe en este tiempo, y una corta a una velocidad mínima. */
const LOG_TYPE_MS = 600;
const LOG_TYPE_MIN_RATE = 0.05;

function drawLog(buf: CellBuffer, view: SceneView, r: Rect): void {
  box(buf, r, { color: theme.line, fill: theme.panel });
  buf.put(r.x + 3, r.y, '┤', theme.line);
  const end = buf.text(r.x + 4, r.y, ' session log ', theme.dim);
  buf.put(end, r.y, '├', theme.line);
  const live = view.replay ? (view.replay.paused ? 'paused' : view.replay.finished ? 'replay end' : `replay x${view.replay.speed}`) : view.connected ? 'live' : 'idle';
  rightText(buf, r.x + r.w - 3, r.y, ` ${live} · ${spinnerFrame(view.now, 200)} `, theme.faint);
  const rows = r.h - 2;
  const entries = view.log.slice(-rows);
  const textWidth = r.w - 24;
  entries.forEach((entry, i) => {
    const y = r.y + 1 + i;
    const text = fit(toCells(entry.text), textWidth);
    // Entrada: la línea desliza desde la derecha mientras su texto se escribe. El tiempo decide en qué punto va.
    const age = entry.bornAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, view.now - entry.bornAt);
    const slide = Math.round((1 - easeOutCubic(age / LOG_SLIDE_MS)) * LOG_SLIDE_CELLS);
    const headFade = 1 - easeOutCubic(age / LOG_SLIDE_MS);
    const length = cellLength(text);
    const typed = age === Number.POSITIVE_INFINITY ? length : Math.min(length, Math.floor(age * Math.max(LOG_TYPE_MIN_RATE, length / LOG_TYPE_MS)));
    const visible = Math.min(typed, Math.max(0, textWidth - slide));
    buf.text(r.x + 2 + slide, y, formatElapsed(entry.t, view.state.startedAt), mix(theme.dim, theme.panel, headFade));
    buf.text(r.x + 11 + slide, y, fit(toCells(entry.who), 10), mix(KIND_COLOR[entry.kind], theme.panel, headFade));
    const tail = buf.text(r.x + 22 + slide, y, [...text].slice(0, visible).join(''), entry.kind === 'error' ? theme.alert : theme.text);
    if (typed < length && tail < r.x + r.w - 1) buf.put(tail, y, '▌', KIND_COLOR[entry.kind]);
  });
  if (entries.length === 0) buf.text(r.x + 2, r.y + 1, 'nothing yet', theme.faint);
}

function drawKeys(buf: CellBuffer, view: SceneView, y: number, x: number, width: number, note?: string): void {
  const key = (k: string, action: string): Segment[] => [
    { text: k, color: theme.text },
    { text: ` ${action}`, color: theme.dim },
  ];
  const sep: Segment = { text: ' · ', color: theme.dim };
  const segments: Segment[] = [...key('q', 'quit')];
  if (view.replay || view.illustrativeDemo) {
    segments.push(sep, ...key('space', 'pause'), sep, ...key('+/-', 'speed'));
  }
  const end = writeSegments(buf, x + 1, y, segments);
  const label = note ?? (view.illustrativeDemo ? 'demo: illustrative activity' : undefined);
  if (label && end + cellLength(label) + 3 < x + width) {
    rightText(buf, x + width - 2, y, label, view.illustrativeDemo && !note ? theme.caption : theme.faint);
  }
}

function drawStatus(buf: CellBuffer, view: SceneView, y: number, x: number, width: number): void {
  const { state } = view;
  const elapsed = formatElapsed(state.lastEventAt ?? 0, state.startedAt);
  const sep: Segment = { text: ' · ', color: theme.dim };
  const costStr = state.costUSD !== undefined ? `$${state.costUSD.toFixed(2)}` : undefined;
  const groups: Segment[][] = [
    [
      { text: 'elapsed ', color: theme.dim },
      { text: elapsed, color: theme.text },
    ],
  ];
  if (costStr !== undefined) {
    groups.push([
      sep,
      { text: 'cost ', color: theme.dim },
      { text: costStr, color: theme.text },
    ]);
  }
  const pending = view.queue.pending.length;
  const queued = `${pending} queued`;
  const reservedForBlocks = Math.min(pending, 10) + (pending > 0 ? 1 : 0);
  const room = width - cellLength(queued) - 4 - reservedForBlocks;
  const segments: Segment[] = [];
  for (const group of groups) {
    if (segmentsWidth(segments) + segmentsWidth(group) > room) break;
    segments.push(...group);
  }
  const rawLast = view.queue.last ? toCells(view.queue.last) : undefined;
  const last = rawLast && costStr && rawLast.endsWith(` · ${costStr}`) ? rawLast.slice(0, -(costStr.length + 3)) : rawLast;
  const remaining = room - segmentsWidth(segments) - 3;
  if (last && remaining >= 10) {
    segments.push(sep, { text: fit(last, remaining), color: theme.dim });
  }
  const end = writeSegments(buf, x + 1, y, segments);
  // Cuadros de color: uno por evento en cola, si queda lugar.
  view.queue.pending.slice(0, Math.max(0, x + width - cellLength(queued) - 4 - end)).forEach((kind, i) => buf.put(end + 1 + i, y, '■', KIND_COLOR[kind]));
  rightText(buf, x + width - 2, y, queued, theme.dim);
}

// --- Errores ---

/** Destello: tiñe el panel y enciende su borde. Se aplica encima, así que no cambia los datos dibujados. */
function flashPanel(buf: CellBuffer, r: Rect, amount: number): void {
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      buf.blendBg(x, y, theme.alert, amount * 0.22);
      const onBorder = x === r.x || x === r.x + r.w - 1 || y === r.y || y === r.y + r.h - 1;
      if (onBorder) buf.tintFg(x, y, theme.alert, amount);
    }
  }
}

// --- Layouts ---

function renderFlow(buf: CellBuffer, view: SceneView, L: SceneLayout): void {
  buf.originX = L.originX;
  buf.originY = L.originY;
  centerSegments(buf, 0, L.width, L.rows.header, headerSegments(view));
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
  drawKeys(buf, view, L.rows.prompt, 0, L.width);
  drawStatus(buf, view, L.rows.status, 0, L.width);
  for (const packet of view.anim?.packets ?? []) drawPacket(buf, packet, L);
  const flash = view.anim?.errorFlash ?? 0;
  if (flash > 0) {
    flashPanel(buf, L.main, flash);
    flashPanel(buf, L.memory, flash);
    flashPanel(buf, L.log, flash);
  }
  const bootMs = view.anim?.bootMs;
  if (bootMs !== undefined && bootMs < BOOT_MS) {
    const width = segmentsWidth(headerSegments(view));
    applyBootFull(buf, bootMs, L, Math.floor((L.width - width) / 2), width, () => theme.bg);
  }
  buf.originX = 0;
  buf.originY = 0;
}

/** Último recurso, con menos de 30 filas: lo esencial en texto y un aviso de cómo ver la escena completa. */
function renderReduced(buf: CellBuffer, view: SceneView): void {
  const { width, height } = buf;
  centerSegments(buf, 0, width, 0, headerSegments(view));

  const advisorRect: Rect = { x: 0, y: 1, w: 24, h: height - 8 };
  const { advisor } = view.state;
  box(buf, advisorRect, { color: theme.advisor, fill: theme.panel });
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
  buf.text(ax, statsY, fit(last ? `sealed · ${formatDuration(last.durationMs)}` : 'inferred labels', aw), last ? theme.main : theme.faint);
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
  box(buf, mainRect, { color: theme.main, fill: theme.panel });
  centerSegments(buf, rightX + 1, rightW - 2, 2, [
    { text: mainName(view), color: theme.main, bold: true },
    { text: ' · main · effort ', color: theme.dim },
    { text: view.state.effort ?? '—', color: theme.main },
  ]);
  const task = view.state.title ?? view.state.lastPrompt;
  centerText(buf, rightX + 2, rightW - 4, 3, task ? plainText(task) : 'no task yet', task ? theme.text : theme.faint);
  centerSegments(buf, rightX + 1, rightW - 2, 4, [
    { text: mainActivity(view, rightW - 12), color: view.state.status === 'tool' ? theme.sub : theme.dim },
    { text: isMainActive(view) ? `  ${spinnerFrame(view.now)}` : '', color: theme.main },
  ]);

  const cardCount = 3;
  const gap = 1;
  const cardW = Math.floor((rightW - gap * (cardCount - 1)) / cardCount);
  const visible = cardSlots(view, cardCount);
  for (let i = 0; i < cardCount; i += 1) {
    const r: Rect = { x: rightX + i * (cardW + gap), y: 6, w: cardW, h: 5 };
    const sub = visible[i]?.sub;
    if (!sub) {
      box(buf, r, { color: mix(theme.sub, theme.bg, 0.72), dashed: true, fill: theme.panel });
      continue;
    }
    const failed = sub.status !== undefined && sub.status !== 'completed';
    box(buf, r, { color: failed ? theme.alert : theme.sub, fill: theme.panel });
    const percent = view.anim?.illustrative?.percents[i];
    centerText(buf, r.x + 1, r.w - 2, r.y + 1, plainText(subagentName(view.state, sub.id)), theme.text, true);
    if (percent !== undefined && sub.running) bar(buf, r.x + 2, r.y + 2, r.w - 4, percent / 100, theme.barSub);
    else if (sub.running) countBar(buf, r.x + 2, r.y + 2, r.w - 4, sub.toolCount, theme.barSub);
    else bar(buf, r.x + 2, r.y + 2, r.w - 4, 1, failed ? theme.barAlert : theme.barSub);
    centerText(buf, r.x + 1, r.w - 2, r.y + 3, sub.running ? `tools: ${sub.toolCount}` : `${toolsLabel(sub.toolCount)}${sub.durationMs !== undefined ? ` · ${formatDuration(sub.durationMs)}` : ''}`, failed ? theme.alert : theme.sub);
  }

  const toolsY = 11;
  const sorted = Object.entries(view.state.tools).sort((a, b) => b[1].count - a[1].count);
  buf.text(rightX, toolsY, fit(toCells(`tools ${view.state.toolCalls}: ${sorted.map(([n, s]) => `${n} ${s.count}${s.errors ? `!${s.errors}` : ''}`).join(' · ')}`), rightW), view.state.toolErrors ? theme.alert : theme.metrics);

  const logRect: Rect = { x: 0, y: advisorRect.y + advisorRect.h, w: width, h: height - advisorRect.h - 3 };
  drawLog(buf, view, logRect);
  drawKeys(buf, view, height - 2, 0, width, `${COMPACT_ROWS}+ rows: full view`);
  drawStatus(buf, view, height - 1, 0, width);
  const flash = view.anim?.errorFlash ?? 0;
  if (flash > 0) {
    flashPanel(buf, mainRect, flash);
    flashPanel(buf, logRect, flash);
  }
}

function renderTooSmall(buf: CellBuffer): void {
  const lines = ['Agranda la ventana', `Mínimo ${MIN_COLS}x${MIN_ROWS} · ahora ${buf.width}x${buf.height}`];
  const y = Math.floor((buf.height - lines.length) / 2);
  lines.forEach((line, i) => centerText(buf, 0, buf.width, y + i, line, i === 0 ? theme.text : theme.dim, i === 0));
}

export function renderScene(buf: CellBuffer, view: SceneView): void {
  paintBackground(buf);
  buf.tintsEnabled = !(view.flatBackground ?? false);
  const layout = layoutFor(buf.width, buf.height);
  if (layout) {
    renderFlow(buf, view, layout);
  } else if (layoutKind(buf.width, buf.height) === 'reduced') {
    renderReduced(buf, view);
    const bootMs = view.anim?.bootMs;
    if (bootMs !== undefined && bootMs < BOOT_MS) applyBootFade(buf, bootMs, () => theme.bg);
  } else renderTooSmall(buf);
}
