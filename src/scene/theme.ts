// Paleta muestreada de la imagen de referencia con tools/sample-colors.ts. Ver docs/colores.md.

import { rgb } from '../tui/color.js';

export const theme = {
  /** Fondo: viñeta de esquinas oscuras a un centro más claro. */
  bgEdge: rgb('#13182d'),
  bgCenter: rgb('#232b4e'),
  /** Interior de los paneles, más oscuro que el fondo que los rodea. */
  panel: rgb('#0f1225'),
  chip: rgb('#161d32'),
  windowBar: rgb('#0f1426'),

  main: rgb('#7ec2ed'),
  sub: rgb('#afd5ff'),
  subBright: rgb('#e6ffff'),
  advisor: rgb('#adacfa'),
  metrics: rgb('#75c8a6'),
  alert: rgb('#e08a4f'),

  text: rgb('#eaefff'),
  dim: rgb('#7c88a8'),
  faint: rgb('#4c5164'),

  barTrack: rgb('#253352'),
  barGood: rgb('#34977a'),
  barAlert: rgb('#bb763d'),
  barSub: rgb('#5797c8'),

  dotRed: rgb('#ff5f57'),
  dotYellow: rgb('#febc2e'),
  dotGreen: rgb('#28c840'),
};
