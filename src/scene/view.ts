// Lo que la escena necesita para dibujar un frame. La escena es una función pura de esto.

import type { LogEntry, LogKind } from '../core/describe.js';
import type { SessionState } from '../core/state.js';
import type { PacketView } from './packets.js';

export interface QueueStatus {
  /** Último evento mostrado. */
  last?: string;
  /** Tipos de los eventos en cola, para los cuadros de color. */
  pending: LogKind[];
}

export interface ReplayStatus {
  speed: number;
  paused: boolean;
  finished: boolean;
}

/** Una línea del log y cuándo entró, para animar su entrada en función del tiempo. */
export interface ShownLogEntry extends LogEntry {
  /** Tiempo de animación en que apareció. Sin esto, se dibuja completa. */
  bornAt?: number;
}

/** Lo que se mueve en este frame. Sin esto, la escena dibuja todo en su estado final. */
export interface AnimFrame {
  /** Milisegundos desde el arranque, mientras dura. Después, ausente. */
  bootMs?: number;
  packets?: PacketView[];
  /** Intensidad del pulso del panel del advisor, de 0 a 1. */
  advisorPulse?: number;
  /** Consulta cuyo motivo se está escribiendo, y cuántos caracteres van. */
  typingConsult?: { id: string; chars: number };
  /** Tarjetas en posiciones fijas: una tarjeta no cambia de lugar mientras se anima. */
  cards?: Array<CardView | undefined>;
  /** Brillo de "back to lead" al recibir un resumen, de 0 a 1. */
  leadGlow?: number;
}

export interface CardView {
  id: string;
  /** Entrada, de 0 a 1: primero crece la caja y luego aparece el contenido. */
  grow: number;
  /** Salida, de 0 a 1: primero se llena la barra y luego se atenúa. Los datos siguen visibles. */
  fade: number;
}

export interface SceneView {
  state: SessionState;
  log: ShownLogEntry[];
  anim?: AnimFrame;
  /** Tiempo de la animación en ms. Todo lo que se mueve sale de aquí. */
  now: number;
  queue: QueueStatus;
  replay?: ReplayStatus;
  /** Hay una sesión conectada. Sin ella se muestra el panel en reposo. */
  connected: boolean;
  /** En 256 colores una viñeta se ve como anillos, así que el fondo es plano. */
  flatBackground?: boolean;
}
