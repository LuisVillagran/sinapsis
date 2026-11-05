import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
export const HAIKU_MAIN = join(FIXTURES, 'sesion-haiku-advisor-opus.jsonl');
export const HAIKU_SUBAGENTS = join(FIXTURES, 'sesion-haiku-advisor-opus', 'subagents');
export const OPUS_MAIN = join(FIXTURES, 'sesion-opus-advisor-opus.jsonl');

export const readLines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

/** Todos los transcripts principales incluidos en fixtures/. */
export const mainFixtures = (): string[] =>
  readdirSync(FIXTURES)
    .map((f) => join(FIXTURES, f))
    .filter((f) => f.endsWith('.jsonl') && statSync(f).isFile());

export interface TaggedLine {
  key: string;
  agentId?: string;
  raw: string;
  index: number;
}

/** Líneas de la sesión Haiku por archivo. `key` es `main` o el id del subagente. */
export function haikuLines(): Map<string, TaggedLine[]> {
  const out = new Map<string, TaggedLine[]>();
  out.set('main', readLines(HAIKU_MAIN).map((raw, index) => ({ key: 'main', raw, index })));
  for (const file of readdirSync(HAIKU_SUBAGENTS).filter((f) => f.endsWith('.jsonl'))) {
    const agentId = file.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    out.set(agentId, readLines(join(HAIKU_SUBAGENTS, file)).map((raw, index) => ({ key: agentId, agentId, raw, index })));
  }
  return out;
}

/** Conteo que no usa nada de src/: recorre el JSON directamente. */
export function independentCount(lines: string[]): {
  tools: Record<string, number>;
  toolErrors: number;
  consults: number;
  replies: number;
  advisorRead: number;
  advisorWritten: number;
  messages: number;
  routine: number;
  input: number;
  output: number;
} {
  const tools: Record<string, number> = {};
  let toolErrors = 0;
  let consults = 0;
  let replies = 0;
  const lastUsage = new Map<string, Record<string, any>>();
  for (const raw of lines) {
    const line = JSON.parse(raw);
    const content = line.message?.content;
    if (line.message?.model === '<synthetic>') continue;
    if (line.type === 'assistant' && line.message?.id) lastUsage.set(line.message.id, line.message.usage ?? {});
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') tools[block.name] = (tools[block.name] ?? 0) + 1;
      if (block.type === 'tool_result' && block.is_error === true) toolErrors += 1;
      if (block.type === 'server_tool_use' && block.name === 'advisor') consults += 1;
      if (block.type === 'advisor_tool_result') replies += 1;
    }
  }
  let advisorRead = 0;
  let advisorWritten = 0;
  let routine = 0;
  let input = 0;
  let output = 0;
  for (const usage of lastUsage.values()) {
    input += usage.input_tokens ?? 0;
    output += usage.output_tokens ?? 0;
    const advisors = (usage.iterations ?? []).filter((i: any) => i.type === 'advisor_message');
    if (advisors.length === 0) routine += 1;
    for (const i of advisors) {
      advisorRead += i.input_tokens;
      advisorWritten += i.output_tokens;
    }
  }
  return { tools, toolErrors, consults, replies, advisorRead, advisorWritten, messages: lastUsage.size, routine, input, output };
}
