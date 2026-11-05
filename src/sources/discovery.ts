// Encuentra transcripts en la carpeta de Claude Code.

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface SessionFile {
  id: string;
  path: string;
  mtimeMs: number;
}

export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
}

/** Nombre de carpeta que Claude Code usa para un proyecto: todo lo que no es alfanumérico pasa a `-`. */
export const encodeProjectPath = (folder: string): string => resolve(folder).replace(/[^a-zA-Z0-9]/g, '-');

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Transcripts principales de una carpeta de proyecto. Los subagentes están más adentro y no aparecen. */
export function sessionsInProject(projectDir: string): SessionFile[] {
  const sessions: SessionFile[] = [];
  for (const name of safeList(projectDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(projectDir, name);
    try {
      const stat = statSync(path);
      if (stat.isFile()) sessions.push({ id: basename(name, '.jsonl'), path, mtimeMs: stat.mtimeMs });
    } catch {
      // Pudo borrarse entre listar y consultar.
    }
  }
  return sessions;
}

export const allSessions = (root: string): SessionFile[] => safeList(root).flatMap((dir) => sessionsInProject(join(root, dir)));

const newest = (sessions: SessionFile[]): SessionFile | undefined => sessions.reduce<SessionFile | undefined>((best, s) => (!best || s.mtimeMs > best.mtimeMs ? s : best), undefined);

/** Qué seguir: una sesión concreta, la más reciente de una carpeta o la más reciente de todas. */
export interface SessionQuery {
  root?: string;
  sessionId?: string;
  project?: string;
}

export function findSession(query: SessionQuery): SessionFile | undefined {
  const root = query.root ?? projectsRoot();
  if (query.sessionId) return allSessions(root).find((s) => s.id === query.sessionId);
  if (query.project) return newest(sessionsInProject(join(root, encodeProjectPath(query.project))));
  return newest(allSessions(root));
}
