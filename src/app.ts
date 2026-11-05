// Bucle principal: fuente, director, escena, diff y terminal. Es lo único con temporizadores.

import { Director } from './engine/director.js';
import { renderScene } from './scene/scene.js';
import type { ReplaySource } from './sources/replay.js';
import type { EventSource } from './sources/types.js';
import { encodeFrame } from './tui/ansi.js';
import { CellBuffer } from './tui/buffer.js';
import type { ColorMode } from './tui/color.js';
import { type TerminalInput, type TerminalOutput, TerminalSession } from './tui/terminal.js';

const MAX_FPS = 60;
const MIN_FPS = 30;
/** Sin nada moviéndose basta con esto para spinners, cursor y respiración. */
const IDLE_FPS = 20;
const IDLE_FRAME_MS = 120;
/** Salto del temporizador en Windows. Más allá de esto se puede esperar de una vez. */
const TIMER_STEP_MS = 16;
/** Cuánto antes de su hora se acepta un frame. En Windows se toma el salto más cercano del temporizador. */
const PACE_TOLERANCE_MS = process.platform === 'win32' ? 8 : 0.5;

export interface Size {
  cols: number;
  rows: number;
}

export interface AppOptions {
  source: EventSource;
  replay?: ReplaySource;
  output: TerminalOutput;
  input?: TerminalInput;
  size: () => Size;
  /** Avisa de un cambio de tamaño. Devuelve cómo dejar de escuchar. */
  onResize?: (listener: () => void) => () => void;
  colorMode: ColorMode;
  fps?: number;
  now?: () => number;
  /** Para probar la restauración: falla a propósito en este frame. */
  crashAtFrame?: number;
  /** `sinapsis demo`: agrega actividad de ejemplo, rotulada como ilustrativa. */
  illustrative?: boolean;
  /** Termina al acabar el replay y vaciar la cola. Para mediciones y pruebas. */
  exitWhenDone?: boolean;
  /** Recibe el tiempo de cálculo de cada frame dibujado y los bytes escritos. */
  onFrame?: (stats: { computeMs: number; bytes: number }) => void;
}

export interface App {
  done: Promise<void>;
  stop(): void;
  session: TerminalSession;
  director: Director;
}

export function runApp(options: AppOptions): App {
  const now = options.now ?? (() => performance.now());
  const director = new Director({ boot: true, illustrative: options.illustrative });
  const session = new TerminalSession(options.output, options.input);
  const { source, replay, output } = options;

  let front: CellBuffer | null = null;
  let back: CellBuffer | null = null;
  let fps = options.fps ?? MAX_FPS;
  let timer: NodeJS.Timeout | undefined;
  let waitingDrain = false;
  let stopped = false;
  let frames = 0;
  let lastKey = '';
  let lastTick = 0;
  let unsubscribeResize: (() => void) | undefined;
  let finish: () => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribeResize?.();
    session.restore();
    void source.stop().finally(finish);
  }

  function onKey(key: string): void {
    if (key === 'q' || key === 'Q' || key === '\x03') {
      stop();
      return;
    }
    if (!replay) return;
    if (key === ' ') replay.togglePause();
    else if (key === '+' || key === '=') replay.setSpeed(replay.speed * 2);
    else if (key === '-' || key === '_') replay.setSpeed(replay.speed / 2);
    lastKey = '';
  }

  /** Identifica lo que se vería. Si no cambió, no hace falta dibujar ni comparar. */
  function frameKey(time: number, size: Size): string {
    const status = replay ? `${replay.speed}|${replay.paused}|${replay.finished}` : '';
    // En reposo solo se mueven spinners, cursor y respiración: basta con mirar unas ocho veces por segundo.
    const moving = director.isBusy(time) ? time : Math.floor(time / IDLE_FRAME_MS);
    return `${size.cols}x${size.rows}|${director.version}|${moving}|${status}`;
  }

  function frame(): void {
    const time = now();
    const size = options.size();
    for (const update of source.tick(time)) director.ingest(update, time);
    director.update(time);

    const key = frameKey(time, size);
    if (key !== lastKey) {
      lastKey = key;
      const started = performance.now();
      if (!back || back.width !== size.cols || back.height !== size.rows) back = new CellBuffer(size.cols, size.rows);
      const status = replay ? { speed: replay.speed, paused: replay.paused, finished: replay.finished } : undefined;
      renderScene(back, director.view(time, status, options.colorMode === '256'));
      const bytes = encodeFrame(front, back, options.colorMode);
      const computeMs = performance.now() - started;
      if (bytes) {
        if (!output.write(bytes)) {
          // La terminal no da abasto: se espera y se baja la frecuencia.
          waitingDrain = true;
          if (!options.fps) fps = Math.max(MIN_FPS, fps - 10);
          output.once('drain', () => {
            waitingDrain = false;
            schedule();
          });
        } else if (!options.fps && fps < MAX_FPS) {
          fps = Math.min(MAX_FPS, fps + 0.25);
        }
      }
      options.onFrame?.({ computeMs, bytes: bytes.length });
      const swap: CellBuffer | null = front;
      front = back;
      back = swap;
    }

    frames += 1;
    if (options.crashAtFrame !== undefined && frames >= options.crashAtFrame) throw new Error(`Fallo forzado en el frame ${frames}`);
    if (options.exitWhenDone && replay?.finished && director.settled && !director.isAnimating(time)) stop();
  }

  /**
   * Espera hasta la hora del siguiente frame. En Windows el temporizador avanza a saltos de unos 15,6 ms: pedir
   * 16,7 ms cae en el segundo salto y deja el bucle en 32 fps. Por eso el último tramo se hace con esperas cortas.
   */
  function schedule(): void {
    if (stopped || waitingDrain) return;
    const rate = options.fps ?? (director.isBusy(now()) ? fps : IDLE_FPS);
    const due = lastTick + 1000 / rate;
    const waitFor = (remaining: number): number => (remaining > TIMER_STEP_MS ? remaining - TIMER_STEP_MS : 1);
    const pace = (): void => {
      if (stopped) return;
      const remaining = due - now();
      if (remaining <= PACE_TOLERANCE_MS) tick();
      else timer = setTimeout(pace, waitFor(remaining));
    };
    // Siempre pasa por el temporizador: llamar a `tick` desde aquí crecería la pila sin fin con un --fps alto.
    timer = setTimeout(pace, waitFor(due - now()));
  }

  function tick(): void {
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
    lastKey = '';
  });
  tick();

  return { done, stop, session, director };
}
