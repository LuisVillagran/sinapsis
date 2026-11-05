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
  /** Intensidad del pulso de la caja del advisor, de 0 a 1. */
  advisorPulse?: number;
  /** Hito de memoria que acaba de dispararse, y su brillo de 1 a 0. */
  memoryPulse?: { slot: 0 | 1 | 2; amount: number; card?: number };
  /** Solo en la demo: valores de ejemplo, rotulados como ilustrativos. */
  illustrative?: IllustrativeFrame;
  /** Tarjetas en posiciones fijas: una tarjeta no cambia de lugar mientras se anima. */
  cards?: Array<CardView | undefined>;
  /** Brillo de "back to lead" al recibir un resumen, de 0 a 1. */
  leadGlow?: number;
  /** Contadores en camino a su valor real. */
  numbers?: ShownNumbers;
  /** Respiración de los bordes, de 0 a 1, en pocos niveles para no reescribirlos en cada frame. */
  breath?: number;
  /** Destello naranjo tras un error, de 1 a 0. */
  errorFlash?: number;
}

export interface ShownNumbers {
  toolCalls: number;
  calls: number;
  tokensRead: number;
  /** Lecturas y escrituras de memoria mostradas por agente. También da el largo de su barra. */
  memory: Record<string, number>;
}

/** Actividad inventada para que la demo se vea como la referencia. Nunca pasa por el estado de sesión. */
export interface IllustrativeFrame {
  /** Porcentaje de ejemplo de cada tarjeta. */
  percents: Array<number | undefined>;
  /** Fila de ejemplo del panel de memoria de agentes. */
  memory: Array<{ fraction: number; label: 'recall' | 'check' }>;
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
  /** En 256 colores los tintes pequeños saltan a otro gris, así que se apagan. */
  flatBackground?: boolean;
  /** Solo en `sinapsis demo`: hay actividad de ejemplo en pantalla y se rotula como tal. */
  illustrativeDemo?: boolean;
  /** Modelos ya conocidos que la cola aún no deja ver: evitan un encabezado en espera durante el arranque. */
  preview?: { main?: string; advisor?: string };
}
