// Paleta muestreada de las imágenes de referencia. Ver docs/colores.md.

import { rgb } from '../tui/color.js';

export const theme = {
  /** Fondo plano, sin viñeta: los paneles comparten el color del fondo. */
  bg: rgb('#191e24'),
  panel: rgb('#191e24'),
  chip: rgb('#262c36'),
  windowBar: rgb('#242831'),

  /** Modelo principal: sesión principal y "back to lead". */
  main: rgb('#e38d63'),
  /** Subagentes y sus barras. */
  sub: rgb('#81b0f6'),
  /** Paquetes de regreso y destellos. */
  subBright: rgb('#f2f6ff'),
  /** Memoria de agentes. */
  metrics: rgb('#77ce9b'),
  /** Memoria de proyecto. */
  notes: rgb('#af9eec'),
  /** El advisor no está en la referencia: lleva un tono propio para no confundirse con la memoria. */
  advisor: rgb('#e59ad8'),
  /** Errores: más rojo que el naranjo del modelo principal, para que se distingan. */
  alert: rgb('#f0695a'),
  /** Pie del panel de memoria. */
  caption: rgb('#e8b56e'),

  text: rgb('#dfe3ea'),
  dim: rgb('#8b909b'),
  faint: rgb('#50555f'),
  /** Conectores en reposo y borde del log. */
  line: rgb('#4a505c'),

  barTrack: rgb('#3a404b'),
  barGood: rgb('#76d099'),
  barAlert: rgb('#c9574b'),
  barSub: rgb('#8cc0ff'),

  dotRed: rgb('#ff5f57'),
  dotYellow: rgb('#febc2e'),
  dotGreen: rgb('#28c840'),
};
