// Interpreta los argumentos de la línea de comandos. Sin efectos.

export type Command =
  | { kind: 'follow'; session?: string; project?: string }
  | { kind: 'replay'; file: string }
  | { kind: 'demo' }
  | { kind: 'help' }
  | { kind: 'version' };

export interface ParsedArgs {
  command: Command;
  speed: number;
  fps?: number;
  printEvents: boolean;
}

export const USAGE = `sinapsis: visor animado de consola para el modo advisor de Claude Code

Uso:
  sinapsis                               Sigue la sesión activa más reciente
  sinapsis --session <id>                Sigue una sesión concreta
  sinapsis --project <carpeta>           Sigue la sesión más reciente de esa carpeta
  sinapsis replay <archivo> [--speed N]  Reproduce un transcript guardado
  sinapsis demo [--speed N]              Reproduce el fixture incluido
  sinapsis --help | --version

Opciones:
  --speed <N>       Velocidad del replay (por defecto 1)
  --fps <N>         Fija los cuadros por segundo (por defecto, adaptativo entre 30 y 60)
  --print-events    Sin interfaz: imprime los eventos, uno por línea

Teclas:
  q o Ctrl+C        Salir
  espacio, + y -    En replay: pausa y velocidad
`;

export class ArgsError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  let session: string | undefined;
  let project: string | undefined;
  let speed = 1;
  let fps: number | undefined;
  let printEvents = false;
  let help = false;
  let version = false;
  const positional: string[] = [];

  const valueOf = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) throw new ArgsError(`Falta el valor de ${flag}`);
    return value;
  };
  const positiveNumber = (flag: string, value: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new ArgsError(`${flag} debe ser un número positivo: ${value}`);
    return parsed;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--session':
        session = valueOf(arg, argv[++i]);
        break;
      case '--project':
        project = valueOf(arg, argv[++i]);
        break;
      case '--speed':
        speed = positiveNumber(arg, valueOf(arg, argv[++i]));
        break;
      case '--fps':
        fps = positiveNumber(arg, valueOf(arg, argv[++i]));
        break;
      case '--print-events':
        printEvents = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-v':
        version = true;
        break;
      default:
        if (arg.startsWith('-')) throw new ArgsError(`Opción desconocida: ${arg}`);
        positional.push(arg);
    }
  }

  const base = { speed, fps, printEvents };
  if (help) return { ...base, command: { kind: 'help' } };
  if (version) return { ...base, command: { kind: 'version' } };

  const [name, ...rest] = positional;
  if (name === 'replay') {
    if (!rest[0]) throw new ArgsError('replay necesita un archivo');
    if (rest.length > 1) throw new ArgsError(`Argumento de más: ${rest[1]}`);
    return { ...base, command: { kind: 'replay', file: rest[0] } };
  }
  if (name === 'demo') {
    if (rest.length) throw new ArgsError(`Argumento de más: ${rest[0]}`);
    return { ...base, command: { kind: 'demo' } };
  }
  if (name) throw new ArgsError(`Comando desconocido: ${name}`);
  if (session && project) throw new ArgsError('Usa --session o --project, no ambos');
  return { ...base, command: { kind: 'follow', session, project } };
}
