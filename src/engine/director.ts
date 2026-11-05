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
import type { AnimFrame, ReplayStatus, SceneView, ShownLogEntry } from '../scene/view.js';
import type { SourceUpdate } from '../sources/types.js';
import { progress } from './easing.js';
import { type ActiveItem, AnimationQueue } from './queue.js';

const LOG_LIMIT = 200;
/** Parte de la consulta que ocupa cada viaje. El resto es la espera, con el panel latiendo. */
const PACKET_SHARE = 0.35;
const PULSE_PERIOD_MS = 170;
const TYPE_CHARS_PER_MS = 0.03;
/** Los eventos esperan a que el arranque casi termine, para que no se mezclen con él. */
const QUEUE_AFTER_BOOT_MS = 1600;

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
        if (event.type === 'subagent_start') this.queue.markKnown(event.subagentId);
        this.show(event, undefined);
      }
    } else {
      this.queue.push(update.events);
    }
    this.version += 1;
    void now;
  }

  private show(event: SinapsisEvent, bornAt: number | undefined): void {
    // El parser puede repetir un inicio para corregir su hora: no es otra línea de log.
    const repeated = event.type === 'subagent_start' && this.shown.subagents.some((s) => s.id === event.subagentId);
    applyEvent(this.shown, event);
    const entry = repeated ? undefined : describeEvent(event, this.shown);
    if (entry) {
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

    if (item.kind === 'tool' && first?.type === 'tool_call' && !first.agentId) {
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
    }
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
    if (steps.length) this.version += 1;
    return steps.length > 0;
  }

  /** La cola está vacía: lo visible ya es lo real. */
  get settled(): boolean {
    return this.queue.isEmpty;
  }

  /** Hay algo moviéndose que exige la frecuencia alta. */
  isBusy(now: number): boolean {
    const boot = this.bootElapsed(now);
    return !this.queue.isEmpty || this.packets.length > 0 || (boot !== undefined && boot < BOOT_MS);
  }

  private animFrame(now: number): AnimFrame {
    const boot = this.bootElapsed(now);
    return {
      bootMs: boot !== undefined && boot < BOOT_MS ? boot : undefined,
      packets: this.activePackets(now),
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
