import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ArgsError, type ParsedArgs, USAGE, parseArgs } from './args.js';
import { createLiveSource } from './sources/live.js';
import { printEvents } from './sources/printEvents.js';
import { type ReplaySource, createReplay, loadTranscript } from './sources/replay.js';
import type { EventSource } from './sources/types.js';

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

  await source.stop();
  process.stderr.write('La interfaz todavía no está disponible. Usa --print-events.\n');
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof ArgsError) process.stderr.write(`\n${USAGE}`);
  process.exitCode = 1;
});
