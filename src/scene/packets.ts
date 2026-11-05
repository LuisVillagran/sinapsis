// Animación 2, los paquetes: un punto brillante con estela que recorre un conector.
//
// La celda es la unidad mínima, así que el avance entre dos celdas se reparte como intensidad entre ambas: el
// ojo lo percibe como un movimiento más fino que una celda.

import type { CellBuffer } from '../tui/buffer.js';
import { type Rgb, mix } from '../tui/color.js';
import { ROUTES, type RouteName } from './layout.js';
import { theme } from './theme.js';

const TRAIL_CELLS = 5;

export interface PacketView {
  route: RouteName;
  /** De 0, al entrar al camino, a 1, cuando la estela ya salió. */
  t: number;
}

function packetColor(route: RouteName): Rgb {
  if (route.startsWith('advisor')) return theme.advisor;
  if (route === 'tool') return theme.metrics;
  return route.startsWith('back') ? theme.subBright : theme.sub;
}

const isText = (char: string): boolean => /[\p{L}\p{N}]/u.test(char);

export function drawPacket(buf: CellBuffer, packet: PacketView): void {
  const cells = ROUTES[packet.route];
  const color = packetColor(packet.route);
  const bright = mix(color, theme.subBright, 0.6);
  // El recorrido incluye el largo de la estela, para que termine de salir por el extremo.
  const head = packet.t * (cells.length - 1 + TRAIL_CELLS);

  cells.forEach(([x, y], i) => {
    const distance = head - i;
    if (distance < -1 || distance > TRAIL_CELLS) return;
    // Delante de la cabeza: la fracción que ya entró a esta celda. Detrás: la estela que se apaga.
    const intensity = distance < 0 ? 1 + distance : (1 - distance / TRAIL_CELLS) ** 2;
    buf.tintFg(x, y, bright, intensity);
    buf.blendBg(x, y, color, intensity * 0.3);
  });

  const headCell = Math.round(head);
  const cell = cells[headCell];
  if (cell && !isText(buf.charAtDraw(cell[0], cell[1]))) buf.put(cell[0], cell[1], '●', bright);
}
