// Une los eventos con la animación. Sin E/S y con el tiempo siempre recibido de afuera.
//
// Mantiene dos estados alimentados por el mismo reductor: `truth`, con todo lo llegado, y `shown`, con lo que la
// cola ya dejó ver. Ninguna animación toca los datos: cuando la cola se vacía, ambos son iguales.

import { describeEvent } from '../core/describe.js';
import type { SinapsisEvent } from '../core/events.js';
import { type SessionState, applyEvent, createState } from '../core/state.js';
import { BOOT_MS } from '../scene/boot.js';
import { type RouteName, consultSlot } from '../scene/layout.js';
import type { PacketView } from '../scene/packets.js';
import type { AnimFrame, CardView, ReplayStatus, SceneView, ShownLogEntry, ShownNumbers } from '../scene/view.js';
import type { SourceUpdate } from '../sources/types.js';
import { easeOutCubic, progress } from './easing.js';
import { type ActiveItem, AnimationQueue } from './queue.js';
import { TweenSet } from './tweens.js';

const LOG_LIMIT = 200;
/** Parte de la consulta que ocupa cada viaje. El resto es la espera, con el panel latiendo. */
const PACKET_SHARE = 0.35;
const PULSE_PERIOD_MS = 170;
const TYPE_CHARS_PER_MS = 0.03;
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
}

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
  private packets: Array<{ route: RouteName; start: number; duration: number }> = [];
  private consultAnim: { id: string; start: number } | undefined;
  private readonly consultSlotById = new Map<string, 0 | 1 | 2>();
  private cards: Array<CardAnim | undefined> = [undefined, undefined, undefined];
  /** Subagentes activos sin tarjeta libre. */
  private waitingCards: string[] = [];
  private leadGlowStart: number | undefined;
  private readonly tweens = new TweenSet();
  private lastLogBorn: number | undefined;
  private flashStart: number | undefined;

  constructor(options: DirectorOptions = {}) {
    this.animateBoot = options.boot ?? false;
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
      this.consultAnim = undefined;
      this.consultSlotById.clear();
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
    const repeated = event.type === 'subagent_start' && this.shown.subagents.some((s) => s.id === event.subagentId);
    applyEvent(this.shown, event);
    const entry = repeated ? undefined : describeEvent(event, this.shown);
    if (entry) {
      if (bornAt !== undefined) this.lastLogBorn = bornAt;
      this.log.push({ ...entry, bornAt });
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
    } else if (item.kind === 'tool' && first?.type === 'tool_call' && !first.agentId) {
      this.addPacket('tool', start, duration);
    } else if (item.kind === 'advisor' && first?.type === 'advisor_consult') {
      const slot = consultSlot(first.reason);
      this.consultSlotById.set(first.id, slot);
      this.consultAnim = { id: first.id, start };
      if (item.endEvents.length) {
        // Ida, espera y vuelta dentro del mismo elemento.
        this.addPacket(`advisor-out-${slot}`, start, duration * PACKET_SHARE);
        this.addPacket(`advisor-back-${slot}`, start + duration * (1 - PACKET_SHARE), duration * PACKET_SHARE);
      } else {
        this.addPacket(`advisor-out-${slot}`, start, duration * 0.6);
      }
    } else if (item.kind === 'advisor-reply' && first?.type === 'advisor_reply') {
      const slot = this.consultSlotById.get(first.id) ?? 0;
      this.addPacket(`advisor-back-${slot}`, start, duration);
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
    const { advisor, toolCalls, tools } = this.shown;
    const follow = (key: string, target: number, duration = COUNT_MS): number => this.tweens.track(key, target, now, duration);
    return {
      toolCalls: follow('toolCalls', toolCalls),
      calls: follow('calls', advisor.calls),
      tokensRead: follow('tokensRead', advisor.tokensRead, TOKENS_MS),
      routineTurns: follow('routineTurns', advisor.routineTurns),
      tools: Object.fromEntries(Object.entries(tools).map(([name, stat]) => [name, follow(`tool:${name}`, stat.count)])),
    };
  }

  /** Lleva los contadores a su valor sin animarlos: lo que ya había ocurrido no se cuenta otra vez. */
  private settleNumbers(): void {
    const { advisor, toolCalls, tools } = this.shown;
    this.tweens.settle('toolCalls', toolCalls);
    this.tweens.settle('calls', advisor.calls);
    this.tweens.settle('tokensRead', advisor.tokensRead);
    this.tweens.settle('routineTurns', advisor.routineTurns);
    for (const [name, stat] of Object.entries(tools)) this.tweens.settle(`tool:${name}`, stat.count);
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
    return this.packets.filter((p) => now >= p.start).map((p) => ({ route: p.route, t: progress(now, p.start, p.duration) }));
  }

  private advisorMotion(now: number): Pick<AnimFrame, 'advisorPulse' | 'typingConsult'> {
    const active = this.queue.active;
    if (!active || (active.item.kind !== 'advisor' && active.item.kind !== 'advisor-reply')) return {};
    const elapsed = now - active.start;
    const typing = this.consultAnim ? { id: this.consultAnim.id, chars: Math.floor((now - this.consultAnim.start) * TYPE_CHARS_PER_MS) } : undefined;
    return { advisorPulse: 0.5 + 0.5 * Math.sin(elapsed / PULSE_PERIOD_MS), typingConsult: typing };
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

  /** Hay algo moviéndose que exige la frecuencia alta. */
  isBusy(now: number): boolean {
    const boot = this.bootElapsed(now);
    return (
      !this.queue.isEmpty ||
      this.packets.length > 0 ||
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
      anim: this.animFrame(now),
    };
  }
}
