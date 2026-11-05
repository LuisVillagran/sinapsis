// Une los eventos con la animación. Sin E/S y con el tiempo siempre recibido de afuera.
//
// Mantiene dos estados alimentados por el mismo reductor: `truth`, con todo lo llegado, y `shown`, con lo que la
// cola ya dejó ver. Ninguna animación toca los datos: cuando la cola se vacía, ambos son iguales.

import { describeEvent } from '../core/describe.js';
import type { SinapsisEvent } from '../core/events.js';
import { type SessionState, applyEvent, createState, memoryMilestone } from '../core/state.js';
import { BOOT_MS } from '../scene/boot.js';
import type { RouteName } from '../scene/layout.js';
import type { PacketView } from '../scene/packets.js';
import type { AnimFrame, CardView, IllustrativeFrame, ReplayStatus, SceneView, ShownLogEntry, ShownNumbers } from '../scene/view.js';
import type { SourceUpdate } from '../sources/types.js';
import { easeOutCubic, progress } from './easing.js';
import { type ActiveItem, AnimationQueue } from './queue.js';
import { TweenSet } from './tweens.js';

const LOG_LIMIT = 200;
/** Parte de la consulta que ocupa cada viaje. El resto es la espera, con la caja latiendo. */
const PACKET_SHARE = 0.35;
const PULSE_PERIOD_MS = 170;
const MEMORY_PULSE_MS = 1200;
/** Los eventos esperan a que el arranque casi termine, para que no se mezclen con él. */
const QUEUE_AFTER_BOOT_MS = 1600;

const LEAD_GLOW_MS = 900;
const ERROR_FLASH_MS = 750;
/** Lo que tarda una línea del log en terminar de entrar. */
const LOG_MOTION_MS = 800;
const COUNT_MS = 500;
const TOKENS_MS = 900;

const BREATH_PERIOD_MS = 4200;
const BREATH_LEVELS = 6;

/** Respiración cuantizada: pocos valores por ciclo, para que el diff casi nunca tenga que reescribir los bordes. */
export function breathLevel(now: number): number {
  const wave = 0.5 + 0.5 * Math.sin((now / BREATH_PERIOD_MS) * 2 * Math.PI);
  return Math.round(wave * BREATH_LEVELS) / BREATH_LEVELS;
}

interface Span {
  start: number;
  duration: number;
}

interface CardAnim {
  id: string;
  enter?: Span;
  exit?: Span;
}

export interface DirectorOptions {
  /** Anima el arranque. Las pruebas de datos lo omiten. */
  boot?: boolean;
  /** Solo para `sinapsis demo`: agrega actividad de ejemplo, rotulada, sin tocar el estado de la sesión. */
  illustrative?: boolean;
}

/** Periodo, desfase y duración de los paquetes de ejemplo. Dependen solo del tiempo, así que son reproducibles. */
const EXAMPLE_FLOW: Array<{ route: RouteName; period: number; offset: number; duration: number; whileRunning: boolean }> = [
  { route: 'tool', period: 2300, offset: 0, duration: 800, whileRunning: false },
  { route: 'work-0', period: 3100, offset: 300, duration: 1300, whileRunning: true },
  { route: 'work-1', period: 3400, offset: 1500, duration: 900, whileRunning: true },
  { route: 'work-2', period: 2900, offset: 2200, duration: 1300, whileRunning: true },
  { route: 'back-0', period: 3700, offset: 900, duration: 1700, whileRunning: true },
  { route: 'back-1', period: 4100, offset: 2500, duration: 1200, whileRunning: true },
  { route: 'back-2', period: 3300, offset: 1800, duration: 1700, whileRunning: true },
];
const EXAMPLE_MILESTONE_MS = 3600;
const EXAMPLE_MILESTONE_ROUTE_MS = 1100;

/** Avance de ejemplo de una tarjeta: rápido al principio y sin llegar nunca al 100 % antes de terminar. */
export function examplePercent(elapsedMs: number, seed: number): number {
  const pace = 7000 + (seed % 5) * 2600;
  return Math.min(97, Math.floor(100 * (1 - Math.exp(-Math.max(0, elapsedMs) / pace))));
}

const hashOf = (text: string): number => [...text].reduce((sum, char) => (sum * 31 + (char.codePointAt(0) as number)) % 9973, 7);

export class Director {
  truth: SessionState = createState();
  shown: SessionState = createState();
  private readonly queue = new AnimationQueue();
  private log: ShownLogEntry[] = [];
  private last: string | undefined;
  private connected = false;
  /** Cambia cada vez que algo visible cambia, para no redibujar sin necesidad. */
  version = 0;
  private bootStart: number | undefined;
  private readonly animateBoot: boolean;
  private readonly illustrative: boolean;
  private packets: Array<{ route: RouteName; start: number; duration: number }> = [];
  private memoryPulse: { slot: 0 | 1 | 2; start: number; card?: number } | undefined;
  private cards: Array<CardAnim | undefined> = [undefined, undefined, undefined];
  /** Subagentes activos sin tarjeta libre. */
  private waitingCards: string[] = [];
  private leadGlowStart: number | undefined;
  private readonly tweens = new TweenSet();
  private lastLogBorn: number | undefined;
  private flashStart: number | undefined;

  constructor(options: DirectorOptions = {}) {
    this.animateBoot = options.boot ?? false;
    this.illustrative = options.illustrative ?? false;
  }

  private bootElapsed(now: number): number | undefined {
    if (!this.animateBoot) return undefined;
    this.bootStart ??= now;
    return now - this.bootStart;
  }

  ingest(update: SourceUpdate, now: number): void {
    if (update.kind === 'reset') {
      this.truth = createState();
      this.shown = createState();
      this.queue.clear();
      this.packets = [];
      this.memoryPulse = undefined;
      this.cards = [undefined, undefined, undefined];
      this.waitingCards = [];
      this.leadGlowStart = undefined;
      this.tweens.clear();
      this.flashStart = undefined;
      this.lastLogBorn = undefined;
      this.log = [];
      this.last = undefined;
      this.connected = true;
      this.version += 1;
      return;
    }
    this.connected = true;
    for (const event of update.events) applyEvent(this.truth, event);
    if (update.historical) {
      // Ya ocurrió: se muestra de inmediato, sin animación.
      for (const event of update.events) {
        const isNew = event.type === 'subagent_start' && !this.shown.subagents.some((s) => s.id === event.subagentId);
        if (event.type === 'subagent_start') this.queue.markKnown(event.subagentId);
        if (event.type === 'subagent_end') this.queue.markEnded(event.subagentId);
        this.show(event, undefined);
        if (isNew && event.type === 'subagent_start') this.placeCard(event.subagentId, now, undefined);
      }
      this.settleNumbers();
    } else {
      this.queue.push(update.events);
    }
    this.version += 1;
  }

  /** Pone un subagente en la primera posición libre, o en la de uno que ya terminó de desvanecerse. */
  private placeCard(id: string, now: number, enter: { start: number; duration: number } | undefined): number | undefined {
    const finished = (card: CardAnim): boolean => {
      const sub = this.shown.subagents.find((s) => s.id === card.id);
      return !sub?.running && (card.exit === undefined || now >= card.exit.start + card.exit.duration);
    };
    let slot = this.cards.findIndex((card) => !card);
    if (slot < 0) slot = this.cards.findIndex((card) => card !== undefined && finished(card));
    if (slot < 0) {
      this.waitingCards.push(id);
      return undefined;
    }
    this.cards[slot] = { id, enter };
    return slot;
  }

  private show(event: SinapsisEvent, bornAt: number | undefined): void {
    // El parser puede repetir un inicio para corregir su hora: no es otra línea de log.
    // Lo mismo con el informe de un subagente que el aviso del principal ya había cerrado.
    const repeated =
      (event.type === 'subagent_start' && this.shown.subagents.some((s) => s.id === event.subagentId)) ||
      (event.type === 'subagent_end' && event.handback && this.shown.subagents.some((s) => s.id === event.subagentId && !s.running));
    applyEvent(this.shown, event);
    const entry = repeated ? undefined : describeEvent(event, this.shown);
    if (entry) {
      if (bornAt !== undefined) this.lastLogBorn = bornAt;
      // `end_turn` lleva la hora de la primera línea del mensaje, pero el turno termina después de todo lo anterior.
      const t = event.type === 'turn_end' ? Math.max(entry.t, this.log[this.log.length - 1]?.t ?? 0) : entry.t;
      this.log.push({ ...entry, t, bornAt });
      if (this.log.length > LOG_LIMIT) this.log.shift();
      this.last = `${entry.who} · ${entry.text}`;
    }
  }

  private addPacket(route: RouteName, start: number, duration: number): void {
    this.packets.push({ route, start, duration });
  }

  private onStart(active: ActiveItem, now: number): void {
    for (const event of active.item.events) this.show(event, now);
    const { item, start, duration } = active;
    const first = item.events[0];

    if (item.kind === 'error') {
      this.flashStart = start;
    } else if (item.kind === 'tool' && first?.type === 'tool_call') {
      // Las del principal bajan por el tronco. Las de un subagente, por la rama de su tarjeta.
      if (!first.agentId) {
        this.addPacket('tool', start, duration);
      } else {
        const slot = this.cards.findIndex((card) => card?.id === first.agentId);
        if (slot >= 0) this.addPacket(`work-${slot as 0 | 1 | 2}`, start, duration);
      }
    } else if (item.kind === 'memory') {
      const slot = first?.type === 'tool_call' ? memoryMilestone(this.shown, { t: first.t }) : 0;
      const agentId = first?.type === 'tool_call' ? first.agentId : undefined;
      const card = agentId ? this.cards.findIndex((c) => c?.id === agentId) : -1;
      this.addPacket(`memory-${slot}`, start, duration);
      this.memoryPulse = { slot, start, ...(card >= 0 ? { card } : {}) };
    } else if (item.kind === 'advisor' && first?.type === 'advisor_consult') {
      if (item.endEvents.length) {
        // Ida, espera y vuelta dentro del mismo elemento.
        this.addPacket('advisor-out', start, duration * PACKET_SHARE);
        this.addPacket('advisor-back', start + duration * (1 - PACKET_SHARE), duration * PACKET_SHARE);
      } else {
        this.addPacket('advisor-out', start, duration * 0.6);
      }
    } else if (item.kind === 'advisor-reply' && first?.type === 'advisor_reply') {
      this.addPacket('advisor-back', start, duration);
    } else if (item.kind === 'subagent-start' && first?.type === 'subagent_start') {
      // El paquete sale primero y la tarjeta crece cuando llega.
      const growStart = start + duration * 0.4;
      const slot = this.placeCard(first.subagentId, now, { start: growStart, duration: duration * 0.6 });
      if (slot !== undefined) this.addPacket(`delegate-${slot as 0 | 1 | 2}`, start, duration * 0.5);
    } else if (item.kind === 'subagent-end' && first?.type === 'subagent_end') {
      const slot = this.cards.findIndex((card) => card?.id === first.subagentId);
      const card = this.cards[slot];
      if (card) {
        card.exit = { start, duration };
        this.addPacket(`back-${slot as 0 | 1 | 2}`, start + duration * 0.25, duration * 0.75);
        this.leadGlowStart = start + duration * 0.8;
      } else {
        this.waitingCards = this.waitingCards.filter((id) => id !== first.subagentId);
      }
    }
  }

  /** Un subagente sin tarjeta entra cuando una queda libre. */
  private promoteWaitingCards(now: number): void {
    while (this.waitingCards.length) {
      const id = this.waitingCards[0] as string;
      this.waitingCards.shift();
      if (this.placeCard(id, now, { start: now, duration: 500 }) === undefined) {
        // `placeCard` la volvió a poner al final; se devuelve a su lugar y se deja para después.
        this.waitingCards.pop();
        this.waitingCards.unshift(id);
        return;
      }
    }
  }

  private cardViews(now: number): CardView[] | Array<CardView | undefined> {
    this.promoteWaitingCards(now);
    return this.cards.map((card) => {
      if (!card) return undefined;
      const sub = this.shown.subagents.find((s) => s.id === card.id);
      const grow = card.enter ? progress(now, card.enter.start, card.enter.duration) : 1;
      // Una tarjeta del historial ya terminada se muestra atenuada desde el principio.
      const fade = card.exit ? progress(now, card.exit.start, card.exit.duration) : sub && !sub.running ? 1 : 0;
      return { id: card.id, grow, fade };
    });
  }

  /** Valores que persiguen el estado visible, para que los números suban y las barras crezcan. */
  private shownNumbers(now: number): ShownNumbers {
    const { advisor, toolCalls } = this.shown;
    const follow = (key: string, target: number, duration = COUNT_MS): number => this.tweens.track(key, target, now, duration);
    return {
      toolCalls: follow('toolCalls', toolCalls),
      calls: follow('calls', advisor.calls),
      tokensRead: follow('tokensRead', advisor.tokensRead, TOKENS_MS),
      memory: Object.fromEntries(Object.entries(this.memoryCounts()).map(([id, count]) => [id, follow(`memory:${id}`, count)])),
    };
  }

  private memoryCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const touch of this.shown.memory.touches) if (touch.agentId) counts[touch.agentId] = (counts[touch.agentId] ?? 0) + 1;
    return counts;
  }

  /** Lleva los contadores a su valor sin animarlos: lo que ya había ocurrido no se cuenta otra vez. */
  private settleNumbers(): void {
    const { advisor, toolCalls } = this.shown;
    this.tweens.settle('toolCalls', toolCalls);
    this.tweens.settle('calls', advisor.calls);
    this.tweens.settle('tokensRead', advisor.tokensRead);
    for (const [id, count] of Object.entries(this.memoryCounts())) this.tweens.settle(`memory:${id}`, count);
  }

  private errorFlash(now: number): number | undefined {
    if (this.flashStart === undefined) return undefined;
    const t = progress(now, this.flashStart, ERROR_FLASH_MS);
    return t < 1 ? 1 - easeOutCubic(t) : undefined;
  }

  private leadGlow(now: number): number | undefined {
    if (this.leadGlowStart === undefined || now < this.leadGlowStart) return undefined;
    const t = progress(now, this.leadGlowStart, LEAD_GLOW_MS);
    return t < 1 ? 1 - easeOutCubic(t) : undefined;
  }

  private cardsMoving(now: number): boolean {
    return (
      this.cards.some((card) => card && ((card.enter && now < card.enter.start + card.enter.duration) || (card.exit && now < card.exit.start + card.exit.duration))) ||
      (this.leadGlowStart !== undefined && now < this.leadGlowStart + LEAD_GLOW_MS)
    );
  }

  private onEnd(active: ActiveItem, now: number): void {
    for (const event of active.item.endEvents) this.show(event, now);
  }

  private activePackets(now: number): PacketView[] {
    this.packets = this.packets.filter((p) => now < p.start + p.duration);
    const real = this.packets.filter((p) => now >= p.start).map((p) => ({ route: p.route, t: progress(now, p.start, p.duration) }));
    return this.illustrative ? [...real, ...this.examplePackets(now)] : real;
  }

  private advisorMotion(now: number): Pick<AnimFrame, 'advisorPulse'> {
    const active = this.queue.active;
    if (!active || (active.item.kind !== 'advisor' && active.item.kind !== 'advisor-reply')) return {};
    return { advisorPulse: 0.5 + 0.5 * Math.sin((now - active.start) / PULSE_PERIOD_MS) };
  }

  private memoryMotion(now: number): Pick<AnimFrame, 'memoryPulse'> {
    const example = this.illustrative ? this.exampleMilestone(now) : undefined;
    const pulse = this.memoryPulse;
    if (pulse && now >= pulse.start && now < pulse.start + MEMORY_PULSE_MS) {
      const amount = 1 - easeOutCubic(progress(now, pulse.start, MEMORY_PULSE_MS));
      return { memoryPulse: { slot: pulse.slot, amount, ...(pulse.card !== undefined ? { card: pulse.card } : {}) } };
    }
    return example ? { memoryPulse: example } : {};
  }

  // --- Actividad de ejemplo, solo en la demo. No toca `truth` ni `shown`. ---

  private get hasRunningCards(): boolean {
    return this.shown.subagents.some((s) => s.running);
  }

  private examplePackets(now: number): PacketView[] {
    if (!this.exampleRunning) return [];
    const packets: PacketView[] = [];
    for (const flow of EXAMPLE_FLOW) {
      if (flow.whileRunning && !this.hasRunningCards) continue;
      const t = ((now + flow.offset) % flow.period) / flow.duration;
      if (t < 1) packets.push({ route: flow.route, t });
    }
    const cycle = now / EXAMPLE_MILESTONE_MS;
    const t = (cycle - Math.floor(cycle)) * (EXAMPLE_MILESTONE_MS / EXAMPLE_MILESTONE_ROUTE_MS);
    if (t < 1) packets.push({ route: `memory-${Math.floor(cycle) % 3 as 0 | 1 | 2}`, t });
    return packets;
  }

  private exampleMilestone(now: number): NonNullable<AnimFrame['memoryPulse']> | undefined {
    if (!this.exampleRunning) return undefined;
    const cycle = now / EXAMPLE_MILESTONE_MS;
    const phase = cycle - Math.floor(cycle);
    const amount = 1 - easeOutCubic(Math.min(1, phase * 2.2));
    if (amount <= 0) return undefined;
    const slot = (Math.floor(cycle) % 3) as 0 | 1 | 2;
    return { slot, amount, ...(slot === 1 ? { card: 0 } : {}) };
  }

  private exampleFrame(now: number): IllustrativeFrame {
    const percents = this.cards.map((card) => {
      if (!card) return undefined;
      return examplePercent(now - (card.enter?.start ?? 0), hashOf(card.id));
    });
    const memory = this.cards.map((card, i) => {
      if (!card) return { fraction: 0, label: 'recall' as const };
      const seed = hashOf(card.id) % 7;
      const wave = Math.sin(now / (1700 + seed * 240) + i * 1.7);
      // Solo unos pocos niveles: una barra que cambia en cada frame no se lee y gasta bytes.
      const fraction = 0.68 + Math.round((wave + 1) * 6) / 6 * 0.14;
      const checking = (now + i * 2900) % 9000 < 2200;
      return { fraction: checking ? 0.55 : fraction, label: checking ? ('check' as const) : ('recall' as const) };
    });
    return { percents, memory };
  }

  /** Avanza hasta `now`. Devuelve si algo de los datos cambió. */
  update(now: number): boolean {
    const boot = this.bootElapsed(now);
    if (boot !== undefined && boot < QUEUE_AFTER_BOOT_MS) return false;
    const steps = this.queue.update(now);
    for (const step of steps) {
      if (step.phase === 'start') this.onStart(step.active, now);
      else this.onEnd(step.active, now);
    }
    if (steps.length) {
      this.version += 1;
      // Los contadores parten cuando cambia el dato, no cuando se dibuja: así no dependen de los frames.
      this.shownNumbers(now);
    }
    return steps.length > 0;
  }

  /** La cola está vacía: lo visible ya es lo real. */
  get settled(): boolean {
    return this.queue.isEmpty;
  }

  /** Hay algo moviéndose que exige la frecuencia alta. La demo siempre tiene paquetes de ejemplo circulando. */
  isBusy(now: number): boolean {
    return this.exampleRunning || this.isAnimating(now);
  }

  /** La actividad de ejemplo acompaña a la sesión: si la pantalla dice que terminó, nada debe seguir moviéndose. */
  private get exampleRunning(): boolean {
    return this.illustrative && this.connected && !this.shown.ended;
  }

  /** Lo que depende de datos reales sigue en movimiento. Al terminar, lo visible ya es definitivo. */
  isAnimating(now: number): boolean {
    const boot = this.bootElapsed(now);
    return (
      !this.queue.isEmpty ||
      this.packets.length > 0 ||
      (this.memoryPulse !== undefined && now < this.memoryPulse.start + MEMORY_PULSE_MS) ||
      this.tweens.isActive(now) ||
      this.cardsMoving(now) ||
      (this.flashStart !== undefined && now < this.flashStart + ERROR_FLASH_MS) ||
      (this.lastLogBorn !== undefined && now < this.lastLogBorn + LOG_MOTION_MS) ||
      (boot !== undefined && boot < BOOT_MS)
    );
  }

  private animFrame(now: number): AnimFrame {
    const boot = this.bootElapsed(now);
    return {
      bootMs: boot !== undefined && boot < BOOT_MS ? boot : undefined,
      packets: this.activePackets(now),
      cards: this.cardViews(now),
      leadGlow: this.leadGlow(now),
      numbers: this.shownNumbers(now),
      breath: breathLevel(now),
      errorFlash: this.errorFlash(now),
      ...this.advisorMotion(now),
      ...this.memoryMotion(now),
      ...(this.illustrative ? { illustrative: this.exampleFrame(now) } : {}),
    };
  }

  view(now: number, replay?: ReplayStatus, flatBackground = false): SceneView {
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
      anim: this.animFrame(now),
    };
  }
}
