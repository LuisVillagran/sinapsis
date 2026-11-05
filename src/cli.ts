import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type App, runApp } from './app.js';
import { ArgsError, type ParsedArgs, USAGE, parseArgs } from './args.js';
import { createLiveSource } from './sources/live.js';
import { printEvents } from './sources/printEvents.js';
import { type ReplaySource, createReplay, loadTranscript } from './sources/replay.js';
import type { EventSource } from './sources/types.js';
import { detectColorMode } from './tui/color.js';

const assetPath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

function version(): string {
  const pkg = JSON.parse(readFileSync(assetPath('../package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

function createSource(args: ParsedArgs): EventSource {
  const { command } = args;
  if (command.kind === 'follow') return createLiveSource({ sessionId: command.session, project: command.project });
  const file = command.kind === 'demo' ? assetPath('../fixtures/sesion-haiku-advisor-opus.jsonl') : (command as { file: string }).file;
  if (!existsSync(file)) throw new ArgsError(`No existe el archivo: ${file}`);
  return createReplay(loadTranscript(file), { speed: args.speed });
}

/**
 * `SINAPSIS_FORCE_TTY=COLxFIL` permite dibujar hacia una salida que no es una terminal, con un tamaño fijo.
 * Solo sirve para las pruebas automáticas, que conectan la salida a un emulador.
 */
function forcedSize(env: NodeJS.ProcessEnv): { cols: number; rows: number } | undefined {
  const match = /^(\d+)x(\d+)$/.exec(env.SINAPSIS_FORCE_TTY ?? '');
  return match ? { cols: Number(match[1]), rows: Number(match[2]) } : undefined;
}

async function runInterface(args: ParsedArgs, source: EventSource): Promise<void> {
  const { stdout, stdin, env } = process;
  const forced = forcedSize(env);
  if (!stdout.isTTY && !forced) {
    await source.stop();
    process.stderr.write('sinapsis necesita una terminal: la salida no es una TTY. Usa --print-events para ver los eventos como texto.\n');
    process.exitCode = 1;
    return;
  }

  const replay = args.command.kind === 'follow' ? undefined : (source as ReplaySource);
  const app: App = runApp({
    source,
    replay,
    output: stdout,
    // En el modo de prueba las teclas llegan por stdin, aunque no sea una terminal.
    input: stdin.isTTY || forced ? stdin : undefined,
    size: () => forced ?? { cols: stdout.columns || 80, rows: stdout.rows || 24 },
    onResize: (listener) => {
      stdout.on('resize', listener);
      return () => stdout.off('resize', listener);
    },
    colorMode: forced ? (env.SINAPSIS_COLOR === '256' ? '256' : 'truecolor') : detectColorMode(stdout.getColorDepth()),
    fps: args.fps,
    crashAtFrame: env.SINAPSIS_CRASH_AT_FRAME ? Number(env.SINAPSIS_CRASH_AT_FRAME) : undefined,
    exitWhenDone: env.SINAPSIS_EXIT_WHEN_DONE === '1',
  });

  const restoreAndExit = (code: number): void => {
    app.session.restore();
    process.exit(code);
  };
  process.once('SIGINT', () => app.stop());
  process.once('SIGTERM', () => app.stop());
  process.once('SIGHUP', () => app.stop());
  process.once('exit', () => app.session.restore());
  process.once('uncaughtException', (error) => {
    app.session.restore();
    process.stderr.write(`${error.stack ?? error.message}\n`);
    restoreAndExit(1);
  });
  process.once('unhandledRejection', (reason) => {
    app.session.restore();
    process.stderr.write(`${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
    restoreAndExit(1);
  });

  await app.done;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command.kind === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (args.command.kind === 'version') {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const source = createSource(args);
  if (args.printEvents) {
    const replay = args.command.kind === 'follow' ? undefined : (source as ReplaySource);
    const printing = printEvents(source, {
      write: (text) => process.stdout.write(text),
      isDone: replay ? () => replay.finished : undefined,
    });
    process.once('SIGINT', printing.stop);
    process.once('SIGTERM', printing.stop);
    await printing.done;
    return;
  }

  await runInterface(args, source);
}

/**
 * Sale de forma explícita: en Windows, un stdin en pausa puede mantener vivo el proceso. Antes espera a que se
 * vacíe lo escrito, para no perder la secuencia que restaura la terminal.
 */
function flushAndExit(): void {
  process.stdout.write('', () => process.stderr.write('', () => process.exit()));
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof ArgsError) process.stderr.write(`\n${USAGE}`);
    process.exitCode = 1;
  })
  .finally(flushAndExit);
