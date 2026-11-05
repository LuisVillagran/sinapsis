// Prepara la terminal y garantiza que quede restaurada, salga como salga la aplicación.

import { LEAVE_SCREEN, ENTER_SCREEN, SYNC_END } from './ansi.js';

/** Lo mínimo que la aplicación necesita de una salida. Las pruebas pasan la suya. */
export interface TerminalOutput {
  write(data: string, callback?: () => void): boolean;
  once(event: 'drain', listener: () => void): unknown;
}

export interface TerminalInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  off(event: 'data', listener: (data: Buffer | string) => void): unknown;
}

/** Cierra un frame que pudo quedar a medias y vuelve a la pantalla normal. */
export const RESTORE_SEQUENCE = `${SYNC_END}${LEAVE_SCREEN}`;

export class TerminalSession {
  private restored = false;
  private keyListener: ((data: Buffer | string) => void) | undefined;

  constructor(
    private readonly output: TerminalOutput,
    private readonly input: TerminalInput | undefined,
    /** Escritura sincrónica para los casos en que el proceso muere enseguida. */
    private readonly writeSync: (data: string) => void = (data) => {
      output.write(data);
    },
  ) {}

  enter(onKey: (key: string) => void): void {
    this.output.write(ENTER_SCREEN);
    if (this.input?.isTTY) this.input.setRawMode?.(true);
    if (this.input) {
      this.keyListener = (data) => onKey(typeof data === 'string' ? data : data.toString('utf8'));
      this.input.on('data', this.keyListener);
      this.input.resume();
    }
  }

  /** Se puede llamar varias veces: solo la primera hace algo. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    try {
      this.writeSync(RESTORE_SEQUENCE);
    } catch {
      // La salida ya pudo cerrarse: no hay nada más que hacer.
    }
    try {
      if (this.input) {
        if (this.keyListener) this.input.off('data', this.keyListener);
        if (this.input.isTTY) this.input.setRawMode?.(false);
        this.input.pause();
      }
    } catch {
      // Igual que arriba.
    }
  }

  get isRestored(): boolean {
    return this.restored;
  }
}
