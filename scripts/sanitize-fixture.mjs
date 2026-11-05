#!/usr/bin/env node
// Crea un fixture publicable a partir de un transcript .jsonl real.
//
// Conserva la ESTRUCTURA (tipos de línea, bloques, claves, modelos, tokens,
// timestamps e ids) y elimina lo privado: prompts de sistema, contenido largo,
// rutas personales, correos y nombres de otros proyectos. Los términos privados
// se calculan en cada máquina para no escribirlos en el repositorio.
//
// Uso: node scripts/sanitize-fixture.mjs <entrada.jsonl> <salida.jsonl>

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

const MAX_STRING = 240;

// Líneas que solo repiten el contexto completo enviado a la API.
// Las de historial de archivos pueden revelar rutas y respaldos locales.
const DROPPED_LINE_TYPES = new Set([
  'api-request-blob',
  'api-request-shape',
  'file-history-snapshot',
  'file-history-delta',
]);

// Adjuntos sin datos personales. Del resto se conserva únicamente `type`.
const SAFE_ATTACHMENTS = new Set(['advisor_tool', 'model']);

// Campos opacos: se conserva la clave y su largo, nunca el valor.
const OPAQUE_KEYS = new Set([
  'signature',
  'encrypted_content',
  'requestDigest',
  'accountUuid',
  'organizationUuid',
]);

// Segmentos genéricos de rutas que no identifican un proyecto.
const GENERIC_PATH_SEGMENTS = new Set([
  'desktop', 'documents', 'projects', 'appdata', 'local', 'programs', 'microsoft',
  'code', 'proyecto', 'sinapsis', 'users',
]);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function commandOutput(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Sin --global: también ve la identidad configurada solo en este repositorio.
const gitConfig = (key) => commandOutput(`git config ${key}`);

function buildScrubber() {
  const user = userInfo().username;
  const projectsDir = join(homedir(), '.claude', 'projects');
  const projectDirs = existsSync(projectsDir) ? readdirSync(projectsDir) : [];

  // Segmentos de otros proyectos: "C--Users-x-Desktop-Mi-App" => "Mi", "App".
  const userPrefix = new RegExp(`^[A-Za-z]--Users-${escapeRegex(user)}-?`, 'i');
  const projectSegments = [
    ...new Set(
      projectDirs.flatMap((dir) => dir.replace(userPrefix, '').split('-')).filter(
        (part) => part.length >= 4 && !GENERIC_PATH_SEGMENTS.has(part.toLowerCase()),
      ),
    ),
  ];

  const rules = [
    // Rutas de transcripts: "C--Users-x-algo".
    [new RegExp(`[A-Za-z]--Users-${escapeRegex(user)}[\\w.-]*`, 'gi'), '<directorio-proyecto>'],
    // Carpeta personal, con cualquier separador.
    [new RegExp(escapeRegex(homedir()).replace(/\\\\/g, '[\\\\/]+'), 'gi'), '<home>'],
    // Correos.
    [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<correo>'],
  ];
  for (const segment of projectSegments) {
    rules.push([new RegExp(`\\b${escapeRegex(segment)}\\b`, 'gi'), '<proyecto>']);
  }
  // Dominio del correo: puede aparecer sin el resto de la dirección.
  const email = gitConfig('user.email');
  const emailDomain = email.split('@')[1];
  if (emailDomain) rules.push([new RegExp(escapeRegex(emailDomain), 'gi'), '<dominio>']);
  // Nombres de cuenta: se buscan también dentro de palabras más largas.
  const accountNames = [gitConfig('user.name'), email.split('@')[0], commandOutput('gh api user --jq .login')];
  for (const name of accountNames.filter(Boolean)) {
    rules.push([new RegExp(escapeRegex(name), 'gi'), '<usuario>']);
  }
  rules.push([new RegExp(escapeRegex(user), 'gi'), '<usuario>']);

  return (text) => rules.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function sanitizeValue(value, key, scrub) {
  if (typeof value === 'string') {
    if (OPAQUE_KEYS.has(key)) return `<redactado:${value.length}>`;
    const clean = scrub(value);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…<recortado:${clean.length}>` : clean;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key, scrub));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [scrub(k), sanitizeValue(v, k, scrub)]),
    );
  }
  return value;
}

function sanitizeLine(line, scrub) {
  const entry = { ...line };
  // `wireToolInputs` duplica los inputs de los bloques tool_use.
  delete entry.wireToolInputs;
  if (entry.type === 'attachment') {
    delete entry.rendered;
    if (!SAFE_ATTACHMENTS.has(entry.attachment?.type)) entry.attachment = { type: entry.attachment?.type };
  }
  if (entry.type === 'api-request') {
    delete entry.tail;
    delete entry.cacheControl;
  }
  return sanitizeValue(entry, undefined, scrub);
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Uso: node scripts/sanitize-fixture.mjs <entrada.jsonl> <salida.jsonl>');
    process.exit(1);
  }
  const scrub = buildScrubber();
  const rawLines = readFileSync(input, 'utf8').split('\n').filter((l) => l.trim());
  const kept = rawLines
    .map((l) => JSON.parse(l))
    .filter((l) => !DROPPED_LINE_TYPES.has(l.type))
    .map((l) => JSON.stringify(sanitizeLine(l, scrub)));
  writeFileSync(output, `${kept.join('\n')}\n`);
  console.log(`${basename(output)}: ${kept.length}/${rawLines.length} líneas conservadas`);
}

main();
