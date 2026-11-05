// Prueba de extremo a extremo con una sesión real: lanza la TUI y luego `claude -p`, con la salida de la TUI
// conectada a un emulador. Captura pantallas y compara el resultado con un conteo independiente del transcript.
//
// Uso: npx tsx tools/live-run.ts <carpeta-de-capturas> [--budget USD]

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import { encodeProjectPath } from '../src/sources/discovery.js';
import { RESTORE_SEQUENCE } from '../src/tui/terminal.js';
import { XtermCapture } from './lib/xterm-capture.js';

const ROOT = join(import.meta.dirname, '..');
const outDir = process.argv[2] ?? join(ROOT, 'docs', 'capturas');
const budgetIndex = process.argv.indexOf('--budget');
const budget = budgetIndex >= 0 ? (process.argv[budgetIndex + 1] as string) : '2';
mkdirSync(outDir, { recursive: true });

const COLS = 90;
const ROWS = 47;
const PROMPT = [
  'Sin modificar ningún archivo, haz esto en orden:',
  '1. Consulta al advisor antes de planificar.',
  '2. Lanza 2 subagentes en paralelo, solo de lectura: uno que resuma package.json y otro que cuente los archivos de src/core.',
  '3. Lee el archivo no-existe-este-archivo.txt, que falla a propósito, y sigue adelante.',
  '4. Consulta al advisor otra vez antes de terminar.',
  '5. Responde en 2 líneas.',
].join(' ');

const sessionId = randomUUID();
const tui = spawn(process.execPath, [join(ROOT, 'dist', 'cli.js'), '--session', sessionId], {
  cwd: ROOT,
  env: { ...process.env, SINAPSIS_FORCE_TTY: `${COLS}x${ROWS}` },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const emulator = new headless.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const capture = await XtermCapture.open({ cols: COLS, rows: ROWS, lineHeight: 1.15 });
const chunks: Buffer[] = [];
let tuiStderr = '';
let pendingWrites = Promise.resolve();
tui.stdout.on('data', (chunk: Buffer) => {
  chunks.push(chunk);
  const text = chunk.toString('utf8');
  emulator.write(text);
  pendingWrites = pendingWrites.then(() => capture.write(text));
});
tui.stderr.on('data', (chunk: Buffer) => {
  tuiStderr += chunk.toString('utf8');
});
const tuiExit = new Promise<number | null>((resolve) => tui.on('exit', resolve));

const screenText = (): string =>
  Array.from({ length: ROWS }, (_, y) => emulator.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n');

let shots = 0;
async function shot(name: string): Promise<void> {
  await pendingWrites;
  shots += 1;
  await capture.screenshot(join(outDir, `vivo-${String(shots).padStart(2, '0')}-${name}.png`));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Antes de que exista la sesión: la TUI debe esperar sin fallar.
await sleep(3000);
if (!screenText().includes('waiting for a session')) process.stderr.write('Aviso: la pantalla de espera no apareció\n');
await shot('esperando');

const claude: ChildProcess = spawn(
  'claude',
  ['-p', '--model', 'haiku', '--advisor', 'opus', '--max-budget-usd', budget, '--session-id', sessionId, '--tools', 'Read', 'Glob', 'Grep', 'Agent', '--allowedTools', 'Read', 'Glob', 'Grep', 'Agent'],
  // El comando puede ser un .cmd en Windows, y Node exige un shell para ejecutarlo. Ningún argumento viene de afuera.
  { cwd: ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
claude.stdin?.end(PROMPT);
let claudeOut = '';
claude.stdout?.on('data', (c: Buffer) => {
  claudeOut += c.toString('utf8');
});
claude.stderr?.on('data', (c: Buffer) => {
  claudeOut += c.toString('utf8');
});
const claudeExit = new Promise<number | null>((resolve) => claude.on('exit', resolve));

let finished = false;
void claudeExit.then(() => {
  finished = true;
});
const started = Date.now();
while (!finished && Date.now() - started < 400_000) {
  await sleep(8000);
  await shot('sesion');
}
const claudeCode = await claudeExit;
process.stdout.write(`claude terminó con código ${claudeCode}: ${claudeOut.trim().slice(0, 400)}\n`);

// La cola todavía puede estar animando el último lote.
await sleep(12_000);
await shot('final');
const finalScreen = screenText();

tui.stdin.write('q');
const tuiCode = await tuiExit;
await pendingWrites;
await capture.close();
const bytes = Buffer.concat(chunks).toString('utf8');

// Conteo independiente: solo lee el JSON del transcript, sin usar nada de src/core.
const projectDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', encodeProjectPath(ROOT));
const transcript = join(projectDir, `${sessionId}.jsonl`);
const parse = (file: string): Array<Record<string, any>> => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const main = parse(transcript);
const subDir = join(projectDir, sessionId, 'subagents');
const subs = existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => parse(join(subDir, f))) : [];
// Solo mensajes: las líneas `api-request-blob` repiten los bloques dentro de cada petición.
const blocks = (lines: Array<Record<string, any>>): Array<Record<string, any>> =>
  lines.flatMap((l) => ((l.type === 'assistant' || l.type === 'user') && Array.isArray(l.message?.content) ? l.message.content : []));
const toolCalls = [main, ...subs].flatMap(blocks).filter((b) => b.type === 'tool_use').length;
const consults = blocks(main).filter((b) => b.type === 'server_tool_use' && b.name === 'advisor').length;
const usage = new Map<string, Record<string, any>>();
for (const line of main) if (line.type === 'assistant' && line.message?.id) usage.set(line.message.id, line.message.usage ?? {});
let tokensRead = 0;
for (const u of usage.values()) for (const i of u.iterations ?? []) if (i.type === 'advisor_message') tokensRead += i.input_tokens;
const errors = [main, ...subs].flatMap(blocks).filter((b) => b.type === 'tool_result' && b.is_error === true).length;

const tokensText = tokensRead >= 100_000 ? `${Math.round(tokensRead / 1000)}k` : tokensRead >= 1000 ? `${(tokensRead / 1000).toFixed(1)}k` : String(tokensRead);
const checks: Array<[string, boolean]> = [
  [`la TUI salió con código 0 (fue ${tuiCode})`, tuiCode === 0],
  ['la TUI no escribió errores', tuiStderr === ''],
  ['la terminal quedó restaurada', bytes.endsWith(RESTORE_SEQUENCE)],
  [`total de herramientas en pantalla: ${toolCalls}`, new RegExp(`tools\\s+${toolCalls}\\b`).test(finalScreen)],
  [`consultas en pantalla: ${consults}`, new RegExp(`\\b${consults} · `).test(finalScreen)],
  [`tokens leídos en pantalla: ${tokensText}`, finalScreen.includes(tokensText)],
  ['la sesión aparece terminada', finalScreen.includes('session ended')],
  ...(errors > 0 ? ([[`hay ${errors} error(es) marcados en pantalla`, /errors\s+\d/.test(finalScreen)]] as Array<[string, boolean]>) : []),
];

process.stdout.write(`\nSesión ${sessionId}: ${toolCalls} herramientas, ${consults} consultas, ${errors} errores, ${subs.length} subagentes, ${(bytes.length / 1024).toFixed(0)} KB emitidos\n`);
let failed = 0;
for (const [label, ok] of checks) {
  process.stdout.write(`${ok ? 'OK   ' : 'FALLA'} ${label}\n`);
  if (!ok) failed += 1;
}
if (tuiStderr) process.stdout.write(`stderr de la TUI: ${tuiStderr.slice(0, 800)}\n`);
process.stdout.write(`\nPantalla final:\n${finalScreen}\n`);
process.exit(failed ? 1 : 0);
