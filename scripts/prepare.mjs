#!/usr/bin/env node
// Compila si tsup está disponible. Si no, usa el dist/ versionado.
//
// `npm install -g` desde git ejecuta `prepare` en un clon sin dependencias de desarrollo: el npm interno hereda
// el modo global y no las instala. Por eso dist/ está en el repositorio. Ver docs/estado.md.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsup = join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js');

if (existsSync(tsup)) {
  const result = spawnSync(process.execPath, [tsup], { cwd: root, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (!existsSync(join(root, 'dist', 'cli.js'))) {
  console.error('sinapsis: falta dist/cli.js y tsup no está disponible para compilar.');
  process.exit(1);
}
