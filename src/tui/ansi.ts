// Convierte la diferencia entre dos buffers en secuencias ANSI. Es lo único que produce bytes para la terminal.

import { BOLD, type CellBuffer } from './buffer.js';
import { type ColorMode, to256 } from './color.js';

export const SYNC_BEGIN = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';

/** Pantalla alternativa, cursor oculto y sin salto automático al llegar a la última columna. */
export const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J';
export const LEAVE_SCREEN = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';

const colorCode = (ground: 38 | 48, color: number, mode: ColorMode): string =>
  mode === 'truecolor'
    ? `${ground};2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}`
    : `${ground};5;${to256(color)}`;

/**
 * Bytes necesarios para pasar de `prev` a `next`. Con `prev` nulo, o de otro tamaño, redibuja todo.
 * Devuelve un texto vacío si nada cambió.
 */
export function encodeFrame(prev: CellBuffer | null, next: CellBuffer, mode: ColorMode): string {
  const sameSize = prev !== null && prev.width === next.width && prev.height === next.height;
  const parts: string[] = [];
  const { width, height, chars, fg, bg, attrs } = next;

  let cursorX = -1;
  let cursorY = -1;
  let currentFg = -1;
  let currentBg = -1;
  let currentAttrs = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const char = chars[i] as number;
      const cellFg = fg[i] as number;
      const cellBg = bg[i] as number;
      const cellAttrs = attrs[i] as number;

      if (sameSize && char === prev.chars[i] && cellBg === prev.bg[i] && cellAttrs === prev.attrs[i]) {
        // Un espacio no muestra su color de texto: no hace falta reescribirlo si solo cambió ese color.
        if (char === 0x20 || cellFg === prev.fg[i]) continue;
      }

      if (x !== cursorX || y !== cursorY) parts.push(`\x1b[${y + 1};${x + 1}H`);

      if (cellAttrs !== currentAttrs || cellFg !== currentFg || cellBg !== currentBg) {
        const codes: string[] = [];
        if (cellAttrs !== currentAttrs) codes.push(cellAttrs & BOLD ? '1' : '22');
        if (cellFg !== currentFg) codes.push(colorCode(38, cellFg, mode));
        if (cellBg !== currentBg) codes.push(colorCode(48, cellBg, mode));
        parts.push(`\x1b[${codes.join(';')}m`);
        currentAttrs = cellAttrs;
        currentFg = cellFg;
        currentBg = cellBg;
      }

      parts.push(String.fromCodePoint(char));
      cursorX = x + 1;
      cursorY = y;
    }
  }

  if (parts.length === 0) return '';
  return `${SYNC_BEGIN}${parts.join('')}\x1b[0m${SYNC_END}`;
}
