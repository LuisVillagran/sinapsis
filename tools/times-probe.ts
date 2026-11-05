// Busca en qué momento de una sesión ocurre cada animación, para elegir los instantes de `tools/strip.ts`.
//
// Uso: npx tsx tools/times-probe.ts [haiku|opus|error]

import { join } from 'node:path';
import { Director } from '../src/engine/director.js';
import { createReplay, loadTranscript } from '../src/sources/replay.js';

const FILES: Record<string, string> = { haiku: 'sesion-haiku-advisor-opus.jsonl', opus: 'sesion-opus-advisor-opus.jsonl', error: 'sesion-haiku-con-error.jsonl' };
const file = FILES[process.argv[2] ?? 'haiku'] as string;
const director = new Director();
const replay = createReplay(loadTranscript(join(import.meta.dirname, '..', 'fixtures', file)));

const first = new Map<string, number>();
const note = (name: string, now: number): void => {
  if (!first.has(name)) first.set(name, Math.round(now));
};
for (let now = 0; now < 180_000; now += 1000 / 60) {
  for (const update of replay.tick(now)) director.ingest(update, now);
  director.update(now);
  const { anim } = director.view(now);
  for (const packet of anim?.packets ?? []) note(packet.route, now);
  if (anim?.advisorPulse !== undefined) note('advisorPulse', now);
  if (anim?.errorFlash !== undefined) note('errorFlash', now);
  if (anim?.memoryPulse) note(`memoryPulse-${anim.memoryPulse.slot}`, now);
  if (anim?.leadGlow !== undefined) note('leadGlow', now);
  if (director.shown.ended) note('ended', now);
}
for (const [name, at] of [...first].sort((a, b) => a[1] - b[1])) process.stdout.write(`${String(at).padStart(7)} ms  ${name}\n`);
