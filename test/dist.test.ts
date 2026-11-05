import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

// dist/ está versionado porque la instalación global desde git no puede compilar. Si queda atrás, se instala
// código viejo sin que nadie lo note.
describe('dist versionado', () => {
  it('coincide con lo que produce el código actual', () => {
    const out = mkdtempSync(join(tmpdir(), 'sinapsis-dist-'));
    try {
      const tsup = join(ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js');
      const result = spawnSync(process.execPath, [tsup, '--out-dir', out], { cwd: ROOT, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const strip = (text: string): string => text.replace(/^#!.*\r?\n/, '').replace(/\r\n/g, '\n');
      expect(strip(readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf8')) === strip(readFileSync(join(out, 'cli.js'), 'utf8')), 'dist/ está desactualizado: ejecuta npm run build').toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('empieza con la línea para ejecutarse como comando', () => {
    expect(readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
