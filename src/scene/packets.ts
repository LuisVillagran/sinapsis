// Animación 2, los paquetes: un punto brillante con estela que recorre un conector.
//
// La celda es la unidad mínima, así que el avance entre dos celdas se reparte como intensidad entre ambas: el
// ojo lo percibe como un movimiento más fino que una celda.

import type { CellBuffer } from '../tui/buffer.js';
import { type Rgb, mix } from '../tui/color.js';
import type { RouteName, SceneLayout } from './layout.js';
import { theme } from './theme.js';

export const TRAIL_CELLS = 3;
/** Estela: de más a menos brillante, como los puntos que siguen a cada paquete en la referencia. */
const TRAIL_GLYPHS = ['•', '·', '·'];

export interface PacketView {
  route: RouteName;
  /** De 0, al entrar al camino, a 1, cuando la estela ya salió. */
  t: number;
}

export function packetColor(route: RouteName): Rgb {
  if (route.startsWith('advisor')) return theme.advisor;
  if (route.startsWith('memory')) return theme.notes;
  if (route === 'tool') return theme.main;
  return route.startsWith('back') ? theme.subBright : theme.barSub;
}

const isText = (char: string): boolean => /[\p{L}\p{N}]/u.test(char);

export function drawPacket(buf: CellBuffer, packet: PacketView, layout: SceneLayout): void {
  const cells = layout.routes[packet.route];
  const color = packetColor(packet.route);
  // El recorrido incluye el largo de la estela, para que termine de salir por el extremo.
  const head = packet.t * (cells.length - 1 + TRAIL_CELLS);
  const headCell = Math.round(head);

  cells.forEach(([x, y], i) => {
    const distance = head - i;
    if (distance < -1 || distance > TRAIL_CELLS + 1) return;
    // Delante de la cabeza: la fracción que ya entró a esta celda. Detrás: la estela que se apaga.
    const intensity = distance < 0 ? 1 + distance : (1 - distance / (TRAIL_CELLS + 1)) ** 2;
    buf.tintFg(x, y, color, intensity);
    buf.blendBg(x, y, color, intensity * 0.05);
    if (isText(buf.charAtDraw(x, y))) return;
    const behind = headCell - i;
    if (behind === 0) buf.put(x, y, '●', color);
    else if (behind > 0 && behind <= TRAIL_GLYPHS.length) buf.put(x, y, TRAIL_GLYPHS[behind - 1] as string, mix(color, theme.bg, (behind - 1) * 0.25));
  });
}
