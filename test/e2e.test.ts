// Ejecuta el comando ya empaquetado, como lo haría un usuario, con su salida conectada a un emulador.

import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import { RESTORE_SEQUENCE } from '../src/tui/terminal.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js');

const running: ChildProcess[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

interface Run {
  child: ChildProcess;
  output: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
}

function run(args: string[], env: Record<string, string> = {}): Run {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  running.push(child);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => out.push(c));
  child.stderr?.on('data', (c: Buffer) => err.push(c));
  return {
    child,
    output: () => Buffer.concat(out).toString('utf8'),
    stderr: () => Buffer.concat(err).toString('utf8'),
    exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
  };
}

const waitUntil = async (check: () => boolean, ms = 8000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Tiempo de espera agotado');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const FORCED = { SINAPSIS_FORCE_TTY: '96x48' };

async function screenOf(bytes: string, cols = 96, rows = 48): Promise<string[]> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(bytes, resolve));
  const lines = Array.from({ length: rows }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '');
  term.dispose();
  return lines;
}

describe('comando empaquetado', () => {
  it('--version y --help', async () => {
    const version = run(['--version']);
    expect(await version.exit).toBe(0);
    expect(version.output().trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const help = run(['--help']);
    expect(await help.exit).toBe(0);
    expect(help.output()).toContain('sinapsis replay');
  });

  it('un argumento inválido termina con un mensaje claro, sin tocar la terminal', async () => {
    const bad = run(['--nada']);
    expect(await bad.exit).toBe(1);
    expect(bad.stderr()).toContain('Opción desconocida');
    expect(bad.output()).toBe('');
  });

  it('un archivo que no existe termina con un mensaje claro', async () => {
    const missing = run(['replay', 'no-existe.jsonl']);
    expect(await missing.exit).toBe(1);
    expect(missing.stderr()).toContain('No existe el archivo');
  });

  it('si la salida no es una TTY, termina con un mensaje claro', async () => {
    const piped = run(['demo']);
    expect(await piped.exit).toBe(1);
    expect(piped.stderr()).toContain('necesita una terminal');
    expect(piped.output()).toBe('');
  });

  it('--print-events funciona sin terminal', async () => {
    const printed = run(['demo', '--print-events', '--speed', '64']);
    expect(await printed.exit).toBe(0);
    expect(printed.output()).toContain('advisor_consult');
    expect(printed.output()).toContain('subagent_end');
    expect(printed.output()).not.toContain('\x1b[');
  });
});

describe('restauración de la terminal', () => {
  it('al salir con q: entra a la pantalla alternativa y restaura todo al final', async () => {
    const demo = run(['demo'], FORCED);
    await waitUntil(() => demo.output().includes('\x1b[?2026l'));
    demo.child.stdin?.write('q');
    expect(await demo.exit).toBe(0);
    const bytes = demo.output();
    expect(bytes.startsWith('\x1b[?1049h\x1b[?25l')).toBe(true);
    expect(bytes.endsWith(RESTORE_SEQUENCE)).toBe(true);
  });

  it('con Ctrl+C igual', async () => {
    const demo = run(['demo'], FORCED);
    await waitUntil(() => demo.output().includes('\x1b[?2026l'));
    demo.child.stdin?.write('\x03');
    expect(await demo.exit).toBe(0);
    expect(demo.output().endsWith(RESTORE_SEQUENCE)).toBe(true);
  });

  it('con un error forzado: restaura, informa y sale con error', async () => {
    const crash = run(['demo'], { ...FORCED, SINAPSIS_CRASH_AT_FRAME: '5' });
    expect(await crash.exit).toBe(1);
    expect(crash.output().endsWith(RESTORE_SEQUENCE)).toBe(true);
    expect(crash.stderr()).toContain('Fallo forzado');
  });

  it('una terminal real vuelve a su estado: un emulador termina en la pantalla normal con cursor visible', async () => {
    const demo = run(['demo'], FORCED);
    await waitUntil(() => demo.output().includes('\x1b[?2026l'));
    demo.child.stdin?.write('q');
    await demo.exit;
    const term = new Terminal({ cols: 96, rows: 48, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(demo.output(), resolve));
    expect(term.buffer.active.type).toBe('normal');
    expect((term as unknown as { modes: { wraparoundMode: boolean } }).modes.wraparoundMode).toBe(true);
    term.dispose();
  });

  it('señal de terminación, donde el sistema la entrega a los manejadores', async () => {
    if (process.platform === 'win32') return; // En Windows, kill() termina el proceso sin ejecutar manejadores.
    const demo = run(['demo'], FORCED);
    await waitUntil(() => demo.output().includes('\x1b[?2026l'));
    demo.child.kill('SIGTERM');
    await demo.exit;
    expect(demo.output().endsWith(RESTORE_SEQUENCE)).toBe(true);
  });
});

describe('demo de principio a fin', () => {
  it('llega al estado real, en truecolor', { timeout: 30_000 }, async () => {
    const demo = run(['demo', '--speed', '8'], { ...FORCED, SINAPSIS_EXIT_WHEN_DONE: '1' });
    expect(await demo.exit).toBe(0);
    const bytes = demo.output();
    // La última pantalla es la anterior a salir de la pantalla alternativa.
    const screen = (await screenOf(bytes.slice(0, bytes.lastIndexOf(RESTORE_SEQUENCE)))).join('\n');
    expect(screen).toContain('SINAPSIS');
    expect(screen).toContain('DEMO');
    expect(screen).toContain('Haiku 5.5');
    expect(screen).toContain('Opus 5.5');
    expect(screen).toContain('97.9k tok');
    expect(screen).toMatch(/tools\s+11/);
    expect(screen).toContain('PROJECT MEMORY');
    expect(screen).toContain('AGENT MEMORY');
    expect(screen).toContain('illustrative activity');
    expect(screen).toContain('explore');
    expect(screen).toContain('session ended');
    expect(bytes).toContain('38;2;');
    expect(demo.stderr()).toBe('');
  });

  it('en 256 colores no emite truecolor', { timeout: 30_000 }, async () => {
    const demo = run(['demo', '--speed', '16'], { ...FORCED, SINAPSIS_COLOR: '256', SINAPSIS_EXIT_WHEN_DONE: '1' });
    expect(await demo.exit).toBe(0);
    expect(demo.output()).not.toContain('38;2;');
    expect(demo.output()).toContain('38;5;');
  });

  it('a 80x24 usa el layout reducido, y a 60x20 pide agrandar', { timeout: 40_000 }, async () => {
    const reduced = run(['demo', '--speed', '32'], { SINAPSIS_FORCE_TTY: '80x24', SINAPSIS_EXIT_WHEN_DONE: '1' });
    expect(await reduced.exit).toBe(0);
    const bytes = reduced.output();
    const screen = (await screenOf(bytes.slice(0, bytes.lastIndexOf(RESTORE_SEQUENCE)), 80, 24)).join('\n');
    expect(screen).toContain('session log');
    expect(screen).toContain('calls');

    // Una ventana normal de Windows Terminal: es el tamaño en que antes desaparecía la parte de abajo.
    const compact = run(['demo', '--speed', '32'], { SINAPSIS_FORCE_TTY: '120x30', SINAPSIS_EXIT_WHEN_DONE: '1' });
    expect(await compact.exit).toBe(0);
    const compactBytes = compact.output();
    const compactScreen = (await screenOf(compactBytes.slice(0, compactBytes.lastIndexOf(RESTORE_SEQUENCE)), 120, 30)).join('\n');
    for (const part of ['PROJECT MEMORY', 'main session', 'AGENT MEMORY', 'delegated ·', 'back to', 'session log']) expect(compactScreen).toContain(part);

    const small =run(['demo'], { SINAPSIS_FORCE_TTY: '60x20' });
    await waitUntil(() => small.output().includes('Agranda'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    small.child.stdin?.write('q');
    expect(await small.exit).toBe(0);
    const smallBytes = small.output();
    const message = (await screenOf(smallBytes.slice(0, smallBytes.lastIndexOf(RESTORE_SEQUENCE)), 60, 20)).join('\n');
    expect(message).toContain('Agranda la ventana');
    expect(message).toContain('60x20');
  });
});
