// Lo que la escena necesita para dibujar un frame. La escena es una función pura de esto.

import type { LogEntry, LogKind } from '../core/describe.js';
import type { SessionState } from '../core/state.js';

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

export interface SceneView {
  state: SessionState;
  log: LogEntry[];
  /** Tiempo de la animación en ms. Todo lo que se mueve sale de aquí. */
  now: number;
  queue: QueueStatus;
  replay?: ReplayStatus;
  /** Hay una sesión conectada. Sin ella se muestra el panel en reposo. */
  connected: boolean;
  /** En 256 colores una viñeta se ve como anillos, así que el fondo es plano. */
  flatBackground?: boolean;
}
