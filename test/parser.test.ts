import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SinapsisEvent } from '../src/core/events.js';
import { createParser, inferConsultReason, memoryScopeOf, memoryTouchOf, newTurnFacts, summarizeToolInput } from '../src/core/parser.js';
import { memoryLabel, memoryMilestone, reduce } from '../src/core/state.js';
import { FIXTURES, HAIKU_MAIN, OPUS_MAIN, type TaggedLine, haikuLines, independentCount, mainFixtures, readLines } from './helpers.js';

function feedAll(lines: TaggedLine[]): SinapsisEvent[] {
  const parser = createParser();
  return lines.flatMap((l) => parser.feed(l.raw, l.agentId ? { agentId: l.agentId } : {}));
}

const parseOne = (...objects: object[]): SinapsisEvent[] => {
  const parser = createParser();
  return objects.flatMap((o) => parser.feed(JSON.stringify(o)));
};

const assistant = (id: string, content: object[], extra: object = {}): object => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:01.000Z',
  message: { id, model: 'claude-haiku-5-5', content, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 }, ...extra },
});

const toolResult = (id: string, isError?: boolean): object => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:02.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(isError === undefined ? {} : { is_error: isError }) }] },
});

const consultBlock = (id: string): object => ({ type: 'server_tool_use', id, name: 'advisor', input: {} });

const ofType = <T extends SinapsisEvent['type']>(events: SinapsisEvent[], type: T): Extract<SinapsisEvent, { type: T }>[] =>
  events.filter((e): e is Extract<SinapsisEvent, { type: T }> => e.type === type);

describe('fixtures: totales del reductor frente a un conteo independiente', () => {
  it('hay al menos dos fixtures principales', () => {
    expect(mainFixtures().length).toBeGreaterThanOrEqual(2);
  });

  for (const file of mainFixtures()) {
    it(`${file.split(/[\\/]/).pop()}`, () => {
      const lines = readLines(file);
      const parser = createParser();
      const state = reduce(lines.flatMap((raw) => parser.feed(raw)));
      const expected = independentCount(lines);

      expect(parser.invalidLines).toBe(0);
      expect(Object.fromEntries(Object.entries(state.tools).map(([k, v]) => [k, v.count]))).toEqual(expected.tools);
      expect(state.toolErrors).toBe(expected.toolErrors);
      expect(state.advisor.calls).toBe(expected.consults);
      expect(state.advisor.consults.filter((c) => !c.open)).toHaveLength(expected.replies);
      expect(state.advisor.tokensRead).toBe(expected.advisorRead);
      expect(state.advisor.tokensWritten).toBe(expected.advisorWritten);
      expect(state.advisor.routineTurns).toBe(expected.routine);
      expect(state.messages).toBe(expected.messages);
      expect(state.tokens.input).toBe(expected.input);
      expect(state.tokens.output).toBe(expected.output);
    });
  }

  it('valores fijos de la sesión Opus, sacados con un script aparte', () => {
    const parser = createParser();
    const state = reduce(readLines(OPUS_MAIN).flatMap((raw) => parser.feed(raw)));
    expect(state.advisor.calls).toBe(2);
    expect(state.advisor.tokensRead).toBe(181651);
    expect(state.advisor.tokensWritten).toBe(20813);
    expect(state.advisor.routineTurns).toBe(15);
    expect(state.messages).toBe(17);
    expect(state.tools.PowerShell?.count).toBe(15);
    expect(state.tools.Edit?.count).toBe(14);
    expect(state.mainModel).toBe('claude-opus-5-5');
    expect(state.advisorModel).toBe('claude-opus-5-5');
    expect(state.effort).toBe('high');
    expect(state.mode).toBe('normal');
  });
});

describe('sesión Haiku con subagentes', () => {
  const byFile = haikuLines();
  const fileOrder = [...byFile.values()].flat();
  const allLines = fileOrder.map((l) => l.raw);

  const timestampOrder = (): TaggedLine[] => {
    let last = 0;
    const withTime = fileOrder.map((line, i) => {
      const ts = JSON.parse(line.raw).timestamp;
      const previous = line.index === 0 ? 0 : last;
      last = ts ? Date.parse(ts) : previous;
      return { line, i, time: last };
    });
    return withTime.sort((a, b) => a.time - b.time || a.i - b.i).map((x) => x.line);
  };

  const arrivalOrder = (): TaggedLine[] => {
    const order: Array<[string, number, number]> = JSON.parse(readFileSync(join(FIXTURES, 'sesion-haiku-advisor-opus', 'orden-llegada.json'), 'utf8'));
    return order.map(([key, index]) => byFile.get(key)?.[index] as TaggedLine);
  };

  it('valores fijos, sacados con un script aparte', () => {
    const state = reduce(feedAll(fileOrder));
    expect(state.advisor.calls).toBe(2);
    expect(state.advisor.tokensRead).toBe(97900);
    expect(state.advisor.tokensWritten).toBe(5531);
    expect(state.advisor.routineTurns).toBe(1);
    expect(state.mainModel).toBe('claude-haiku-5-5');
    expect(state.advisorModel).toBe('claude-opus-5-5');
    expect(state.advisorEnabled).toBe(true);
    expect(state.effort).toBe('medium');
    expect(state.tools.Agent?.count).toBe(3);
    expect(state.tools.Glob?.count).toBeGreaterThanOrEqual(1);
    expect(state.costUSD).toBeCloseTo(0.5876, 3);
    expect(state.ended).toBe(true);
  });

  it('la distribución incluye las herramientas de los subagentes', () => {
    const state = reduce(feedAll(fileOrder));
    const tools = Object.fromEntries(Object.entries(state.tools).map(([k, v]) => [k, v.count]));
    expect(tools).toEqual(independentCount(allLines).tools);
    expect(state.toolCalls).toBe(4 + 7);
  });

  it('cada subagente: el contador propio coincide con el total que devuelve', () => {
    for (const [key, lines] of byFile) {
      if (key === 'main') continue;
      const own = lines
        .map((l) => JSON.parse(l.raw))
        .filter((l) => l.type === 'assistant')
        .flatMap((l) => l.message.content)
        .filter((b) => b.type === 'tool_use').length;
      const sub = reduce(feedAll(lines)).subagents[0];
      expect(sub?.toolCount, 'solo su archivo').toBe(own);
      const full = reduce(feedAll(fileOrder)).subagents.find((s) => s.id === key);
      expect(full?.toolCount, 'con el total devuelto').toBe(own);
    }
  });

  it('subagentes enlazados con su descripción y totales reales', () => {
    const state = reduce(feedAll(fileOrder));
    expect(state.subagents.map((s) => s.description)).toEqual([
      'Estructura del repositorio',
      'Usos de advisor en scripts y docs',
      'Resumen de docs/eventos.md',
    ]);
    for (const sub of state.subagents) {
      expect(sub.running).toBe(false);
      expect(sub.status).toBe('completed');
      expect(sub.agentType).toBe('Explore');
      expect(sub.readOnly).toBe(true);
      expect(sub.model).toBe('claude-haiku-5-5');
      expect(sub.finalized).toBe(true);
      expect(sub.summary).toBeTruthy();
    }
    expect(state.subagents.find((s) => s.id === 'ae5f640508bc38035')).toMatchObject({ durationMs: 7686, totalTokens: 63260, toolCount: 1 });
  });

  it('el estado final no depende del orden: archivo, timestamp y llegada real', () => {
    const inFileOrder = reduce(feedAll(fileOrder));
    const inTimestampOrder = reduce(feedAll(timestampOrder()));
    const inArrivalOrder = reduce(feedAll(arrivalOrder()));
    expect(arrivalOrder()).toHaveLength(fileOrder.length);
    expect(inTimestampOrder).toEqual(inFileOrder);
    expect(inArrivalOrder).toEqual(inFileOrder);
  });

  it('en la llegada real, un subagente aparece antes que el tool_use que lo lanzó y aun así queda enlazado', () => {
    const events = feedAll(arrivalOrder());
    const firstStart = events.findIndex((e) => e.type === 'subagent_start');
    const firstAgentCall = events.findIndex((e) => e.type === 'tool_call' && e.name === 'Agent');
    expect(firstStart).toBeLessThan(firstAgentCall);
    expect(ofType(events, 'subagent_start').map((e) => e.subagentId)).toHaveLength(3);
    expect(reduce(events).subagents.every((s) => s.description)).toBe(true);
  });

  it('el emparejamiento no asigna descripciones cruzadas durante la llegada real', () => {
    const infos = ofType(feedAll(arrivalOrder()), 'subagent_info');
    const description = new Map(reduce(feedAll(fileOrder)).subagents.map((s) => [s.id, s.description]));
    for (const info of infos) expect(info.description).toBe(description.get(info.subagentId));
  });
});

describe('motivo inferido', () => {
  it('cada regla', () => {
    expect(inferConsultReason(newTurnFacts(), 'tool_use')).toBe('before a plan');
    expect(inferConsultReason({ ...newTurnFacts(), errorsSinceConsult: 1 }, 'tool_use')).toBe('after errors');
    expect(inferConsultReason({ ...newTurnFacts(), subagentResultsSinceConsult: 2 }, 'tool_use')).toBe('after subagents');
    expect(inferConsultReason(newTurnFacts(), 'end_turn')).toBe('before done');
    expect(inferConsultReason({ ...newTurnFacts(), edited: true }, 'tool_use')).toBe('check-in');
    expect(inferConsultReason({ ...newTurnFacts(), consults: 1 }, 'tool_use')).toBe('check-in');
  });

  it('prioridad: errores, subagentes, fin, plan', () => {
    const all = { consults: 0, edited: false, errorsSinceConsult: 1, subagentResultsSinceConsult: 1 };
    expect(inferConsultReason(all, 'end_turn')).toBe('after errors');
    expect(inferConsultReason({ ...all, errorsSinceConsult: 0 }, 'end_turn')).toBe('after subagents');
    expect(inferConsultReason({ ...all, errorsSinceConsult: 0, subagentResultsSinceConsult: 0 }, 'end_turn')).toBe('before done');
  });

  it('secuencia completa: los hechos se reinician por consulta y por turno', () => {
    const events = parseOne(
      { type: 'user', message: { role: 'user', content: 'primer prompt' }, turnOrigin: 'human' },
      assistant('m1', [consultBlock('c1')]),
      assistant('m2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      toolResult('t1', true),
      assistant('m3', [consultBlock('c2')]),
      assistant('m4', [{ type: 'tool_use', id: 't2', name: 'Edit', input: {} }]),
      toolResult('t2'),
      assistant('m5', [consultBlock('c3')]),
      assistant('m6', [consultBlock('c4')], { stop_reason: 'end_turn' }),
      { type: 'user', message: { role: 'user', content: 'otro prompt' }, turnOrigin: 'human' },
      assistant('m7', [consultBlock('c5')]),
    );
    expect(ofType(events, 'advisor_consult').map((e) => e.reason)).toEqual([
      'before a plan',
      'after errors',
      'check-in',
      'before done',
      'before a plan',
    ]);
  });

  it('etiquetas de las 4 consultas reales', () => {
    const reasons = (lines: string[]): string[] => {
      const parser = createParser();
      return ofType(lines.flatMap((raw) => parser.feed(raw)), 'advisor_consult').map((e) => e.reason);
    };
    expect(reasons(readLines(HAIKU_MAIN))).toEqual(['before a plan', 'after subagents']);
    expect(reasons(readLines(OPUS_MAIN))).toEqual(['check-in', 'after errors']);
  });
});

describe('trampas de docs/eventos.md', () => {
  it('los tokens se deduplican por message.id', () => {
    const usage = { input_tokens: 10, output_tokens: 20 };
    const state = reduce(
      parseOne(
        assistant('m1', [{ type: 'thinking' }], { usage }),
        assistant('m1', [{ type: 'text', text: 'hola' }], { usage }),
        assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], { usage }),
      ),
    );
    expect(state.messages).toBe(1);
    expect(state.tokens.input).toBe(10);
    expect(state.tokens.output).toBe(20);
  });

  it('si el usage de un mensaje cambia, gana el último', () => {
    const state = reduce(
      parseOne(
        assistant('m1', [{ type: 'text', text: 'a' }], { usage: { input_tokens: 10, output_tokens: 5 } }),
        assistant('m1', [{ type: 'text', text: 'b' }], { usage: { input_tokens: 10, output_tokens: 50 } }),
      ),
    );
    expect(state.tokens.output).toBe(50);
    expect(state.messages).toBe(1);
  });

  it('el usage de nivel superior no incluye al advisor', () => {
    const usage = {
      input_tokens: 4,
      output_tokens: 7,
      iterations: [
        { type: 'message', input_tokens: 2, output_tokens: 3 },
        { type: 'advisor_message', input_tokens: 500, output_tokens: 60, model: 'claude-opus-5-5' },
        { type: 'message', input_tokens: 2, output_tokens: 4 },
      ],
    };
    const state = reduce(
      parseOne(
        assistant('m1', [consultBlock('c1')], { usage }),
        assistant('m1', [{ type: 'advisor_tool_result', tool_use_id: 'c1', content: { type: 'advisor_redacted_result' } }], { usage }),
      ),
    );
    expect(state.tokens.output).toBe(7);
    expect(state.advisor.tokensRead).toBe(500);
    expect(state.advisor.tokensWritten).toBe(60);
    expect(state.advisor.routineTurns).toBe(0);
    expect(state.advisor.consults[0]).toMatchObject({ open: false, model: 'claude-opus-5-5', resultType: 'advisor_redacted_result', isError: false });
  });

  it('dos consultas en un mensaje toman sus iteraciones en orden', () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      iterations: [
        { type: 'advisor_message', input_tokens: 100, output_tokens: 10 },
        { type: 'advisor_message', input_tokens: 200, output_tokens: 20 },
      ],
    };
    const reply = (id: string): object => assistant('m1', [{ type: 'advisor_tool_result', tool_use_id: id, content: { type: 'advisor_redacted_result' } }], { usage });
    const state = reduce(parseOne(assistant('m1', [consultBlock('a')], { usage }), reply('a'), assistant('m1', [consultBlock('b')], { usage }), reply('b')));
    expect(state.advisor.consults.map((c) => c.tokensRead)).toEqual([100, 200]);
    expect(state.advisor.tokensRead).toBe(300);
  });

  it('otras variantes de resultado del advisor no fallan y los errores se marcan', () => {
    const state = reduce(
      parseOne(
        assistant('m1', [consultBlock('c1')]),
        assistant('m1', [{ type: 'advisor_tool_result', tool_use_id: 'c1', content: { type: 'advisor_tool_result_error', error_code: 'x' } }]),
        assistant('m2', [{ type: 'advisor_tool_result', tool_use_id: 'huerfano', content: 'texto raro' }]),
      ),
    );
    expect(state.advisor.consults.find((c) => c.id === 'c1')?.isError).toBe(true);
    expect(state.advisor.consults.find((c) => c.id === 'huerfano')?.durationMs).toBeUndefined();
  });

  it('la duración de la consulta sale de los timestamps', () => {
    const events = parseOne(
      { ...assistant('m1', [consultBlock('c1')]), timestamp: '2026-01-01T00:00:10.000Z' },
      { ...assistant('m1', [{ type: 'advisor_tool_result', tool_use_id: 'c1', content: {} }]), timestamp: '2026-01-01T00:00:52.500Z' },
    );
    expect(ofType(events, 'advisor_reply')[0]?.durationMs).toBe(42500);
  });

  it('is_error ausente equivale a false', () => {
    const state = reduce(parseOne(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]), toolResult('t1'), assistant('m2', [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]), toolResult('t2', true)));
    expect(state.toolErrors).toBe(1);
    expect(state.tools.Read).toEqual({ count: 2, errors: 1 });
  });

  it('toolUseResult puede ser string, arreglo u objeto', () => {
    const base = toolResult('t1', true) as Record<string, unknown>;
    for (const toolUseResult of ['Error: x', ['a'], { any: 1 }, null]) {
      expect(() => parseOne(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]), { ...base, toolUseResult })).not.toThrow();
    }
  });

  it('<synthetic> no cambia el modelo ni cuenta como mensaje, pero el error de API se conserva', () => {
    const state = reduce(
      parseOne(
        assistant('m1', [{ type: 'text', text: 'ok' }]),
        {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:05.000Z',
          isApiErrorMessage: true,
          apiErrorStatus: 529,
          message: { id: 'syn', model: '<synthetic>', content: [{ type: 'text', text: 'Overloaded\nmás' }], stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } },
        },
      ),
    );
    expect(state.mainModel).toBe('claude-haiku-5-5');
    expect(state.messages).toBe(1);
    expect(state.apiErrors).toBe(1);
  });

  it('compactación: se cuenta el límite y el resumen no es un prompt', () => {
    const state = reduce(
      parseOne(
        { type: 'system', subtype: 'compact_boundary', timestamp: '2026-01-01T00:00:01.000Z', compactMetadata: { preTokens: 900, postTokens: 20 } },
        { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Resumen de la conversación' } },
      ),
    );
    expect(state.compactions).toBe(1);
    expect(state.prompts).toBe(0);
  });

  it('solo cuentan los prompts reales del usuario', () => {
    const state = reduce(
      parseOne(
        { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } },
        { type: 'user', message: { role: 'user', content: '<command-name>/foo</command-name>' } },
        { type: 'user', message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout>' } },
        { type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'pregunta real' } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'en bloques' }] } },
      ),
    );
    expect(state.prompts).toBe(2);
  });

  it('el modelo se lee de message.model y puede cambiar', () => {
    const state = reduce(parseOne(assistant('m1', []), assistant('m2', [], { model: 'claude-sonnet-5-5' })));
    expect(state.mainModel).toBe('claude-sonnet-5-5');
  });

  it('tipos y bloques desconocidos se ignoran', () => {
    const parser = createParser();
    expect(parser.feed(JSON.stringify({ type: 'tipo-nuevo', a: 1 })).map((e) => e.type)).toEqual(['session_start']);
    expect(parser.feed(JSON.stringify({ type: 'tipo-nuevo-2', timestamp: 'no es fecha' }))).toEqual([]);
    expect(parser.feed(JSON.stringify(assistant('m1', [{ type: 'bloque_futuro', x: 1 }])))).not.toEqual([]);
    expect(parser.feed(JSON.stringify({ type: 'assistant', message: 'raro' }))).toEqual([]);
    expect(parser.feed(JSON.stringify({ type: 'user' }))).toEqual([]);
    expect(parser.invalidLines).toBe(0);
  });

  it('líneas inválidas no fallan y se cuentan', () => {
    const parser = createParser();
    expect(parser.feed('{"type":"assist')).toEqual([]);
    expect(parser.feed('no es json')).toEqual([]);
    expect(parser.feed('[1,2]')).toEqual([]);
    expect(parser.feed('   ')).toEqual([]);
    expect(parser.invalidLines).toBe(3);
  });

  it('session_start sale de la primera línea, sea del tipo que sea', () => {
    const events = parseOne({ type: 'session-owner', sessionId: 'abc' }, { type: 'mode', mode: 'normal', sessionId: 'abc' });
    expect(events[0]).toMatchObject({ type: 'session_start', sessionId: 'abc' });
    expect(ofType(events, 'session_start')).toHaveLength(1);
  });

  it('una línea sin timestamp hereda la hora anterior de su fuente', () => {
    const events = parseOne(assistant('m1', [{ type: 'text', text: 'a' }]), { type: 'cost-state', totalCostUSD: 1 });
    expect(ofType(events, 'session_end')[0]?.t).toBe(Date.parse('2026-01-01T00:00:01.000Z'));
  });

  it('una sesión reanudada después de cost-state deja de estar terminada', () => {
    const state = reduce(parseOne({ type: 'cost-state', totalCostUSD: 1 }, { type: 'api-request', timestamp: '2026-01-01T00:00:03.000Z', params: { model: 'x' } }));
    expect(state.ended).toBe(false);
    expect(state.status).toBe('working');
  });

  it('resultado antes que su tool_use: el error se cuenta igual', () => {
    const state = reduce(parseOne(toolResult('t1', true), assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }])));
    expect(state.tools.Read).toEqual({ count: 1, errors: 1 });
    expect(state.toolErrors).toBe(1);
    expect(state.status).not.toBe('tool');
  });
});

describe('subagentes: casos no observados', () => {
  const launch = (id: string, prompt: string): object => assistant('m', [{ type: 'tool_use', id, name: 'Agent', input: { prompt, description: `desc ${id}`, subagent_type: 'general-purpose' } }]);
  const firstLine = (prompt: string): string => JSON.stringify({ type: 'user', parentUuid: null, isSidechain: true, agentId: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: prompt } });

  it('prompt modificado por el arnés: se enlaza si uno contiene al otro', () => {
    const parser = createParser();
    const events = [...parser.feed(JSON.stringify(launch('t1', 'haz esto'))), ...parser.feed(firstLine('contexto extra\nhaz esto'), { agentId: 'a1' })];
    expect(reduce(events).subagents[0]).toMatchObject({ description: 'desc t1', readOnly: false });
  });

  it('prompt sin relación: no se cruza con otro lanzamiento y el resultado lo enlaza', () => {
    const parser = createParser();
    const events = [
      ...parser.feed(JSON.stringify(launch('t1', 'tarea uno'))),
      ...parser.feed(firstLine('algo distinto'), { agentId: 'a1' }),
    ];
    expect(reduce(events).subagents[0]?.description).toBeUndefined();
    events.push(...parser.feed(JSON.stringify({ ...toolResult('t1'), toolUseResult: { status: 'completed', agentId: 'a1', totalToolUseCount: 0 } })));
    expect(reduce(events).subagents[0]).toMatchObject({ description: 'desc t1', running: false, finalized: true });
  });

  it('sin final del subagente, solo con el resultado, la tarjeta se cierra', () => {
    const state = reduce(parseOne(launch('t1', 'p'), { ...toolResult('t1'), toolUseResult: { status: 'completed', agentId: 'a9', totalToolUseCount: 4, totalTokens: 10, totalDurationMs: 5 } }));
    expect(state.subagents[0]).toMatchObject({ id: 'a9', running: false, toolCount: 4, totalTokens: 10, durationMs: 5, description: 'desc t1' });
  });

  it('en segundo plano (forma supuesta): lanzado no se cierra; su end_turn sí', () => {
    const parser = createParser();
    const events = [
      ...parser.feed(JSON.stringify(launch('t1', 'p'))),
      ...parser.feed(JSON.stringify({ ...toolResult('t1'), toolUseResult: { status: 'async_launched', agentId: 'a1' } })),
    ];
    expect(reduce(events).subagents[0]?.running).toBe(true);
    events.push(...parser.feed(JSON.stringify(assistant('s1', [{ type: 'text', text: 'listo' }], { stop_reason: 'end_turn' })), { agentId: 'a1' }));
    expect(reduce(events).subagents[0]).toMatchObject({ running: false, status: 'completed', summary: 'listo' });
  });

  it('error del Agent sin totales cierra el subagente enlazado', () => {
    const parser = createParser();
    const events = [
      ...parser.feed(JSON.stringify(launch('t1', 'tarea'))),
      ...parser.feed(firstLine('tarea'), { agentId: 'a1' }),
      ...parser.feed(JSON.stringify({ ...toolResult('t1', true), toolUseResult: 'Error: abortado' })),
    ];
    expect(reduce(events).subagents[0]).toMatchObject({ running: false, status: 'error' });
  });

  it('error de una herramienta dentro del subagente se le atribuye', () => {
    const parser = createParser();
    const events = [
      ...parser.feed(JSON.stringify(assistant('s1', [{ type: 'tool_use', id: 't5', name: 'Grep', input: {} }])), { agentId: 'a1' }),
      ...parser.feed(JSON.stringify(toolResult('t5', true)), { agentId: 'a1' }),
    ];
    const state = reduce(events);
    expect(state.subagents[0]).toMatchObject({ errors: 1, toolCount: 1 });
    expect(state.toolErrors).toBe(1);
  });

  it('una línea con isSidechain y agentId en el archivo principal se atribuye al subagente', () => {
    const state = reduce(parseOne({ ...assistant('s1', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]), isSidechain: true, agentId: 'a7' }));
    expect(state.subagents[0]?.id).toBe('a7');
    expect(state.messages).toBe(0);
  });
});

describe('resumen de herramientas', () => {
  it('usa datos cortos, sin rutas completas', () => {
    expect(summarizeToolInput('Read', { file_path: 'C:\\a\\b\\c.ts' })).toBe('c.ts');
    expect(summarizeToolInput('Edit', { file_path: '/x/y.md' })).toBe('y.md');
    expect(summarizeToolInput('Grep', { pattern: 'abc' })).toBe('abc');
    expect(summarizeToolInput('Bash', { command: 'ls\nrm' })).toBe('ls');
    expect(summarizeToolInput('Agent', { description: 'd', prompt: 'p' })).toBe('d');
    expect(summarizeToolInput('Otro', 'x')).toBeUndefined();
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(100) })?.length).toBe(60);
  });
});

describe('memoria', () => {
  it('clasifica las rutas de memoria, en ambos separadores', () => {
    expect(memoryScopeOf('C:\\Users\\x\\proyecto\\CLAUDE.md')).toBe('project');
    expect(memoryScopeOf('/home/x/proyecto/CLAUDE.local.md')).toBe('project');
    expect(memoryScopeOf('/home/x/proyecto/.claude/agent-memory/builder/MEMORY.md')).toBe('agent');
    expect(memoryScopeOf('.claude/agent-memory/builder/notas.md')).toBe('agent');
    expect(memoryScopeOf('C:\\Users\\x\\.claude\\projects\\p\\memory\\nota.md')).toBe('auto');
    expect(memoryScopeOf('/home/x/.claude/projects/p/memory/MEMORY.md')).toBe('auto');
    expect(memoryScopeOf('/home/x/proyecto/src/memory.ts')).toBeUndefined();
    expect(memoryScopeOf('/home/x/proyecto/README.md')).toBeUndefined();
    expect(memoryScopeOf('/home/x/memory/notas.md')).toBeUndefined();
  });

  it('distingue lectura de escritura y solo mira herramientas de archivos', () => {
    const path = { file_path: '/p/CLAUDE.md' };
    expect(memoryTouchOf('Read', path)).toEqual({ file: 'CLAUDE.md', scope: 'project', op: 'read' });
    expect(memoryTouchOf('Edit', path)?.op).toBe('write');
    expect(memoryTouchOf('Write', path)?.op).toBe('write');
    expect(memoryTouchOf('Grep', { path: '/p/CLAUDE.md', pattern: 'x' })?.op).toBe('read');
    expect(memoryTouchOf('Bash', { command: 'cat CLAUDE.md' })).toBeUndefined();
    expect(memoryTouchOf('Read', { file_path: '/p/otro.md' })).toBeUndefined();
    expect(memoryTouchOf('Read', 'no es un objeto')).toBeUndefined();
  });

  it('el evento de la herramienta lleva qué tocó, también dentro de un subagente', () => {
    const line = assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/.claude/agent-memory/builder/MEMORY.md' } }]);
    const parser = createParser();
    const call = parser.feed(JSON.stringify(line), { agentId: 'a' }).find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ agentId: 'a', memory: { file: 'MEMORY.md', scope: 'agent', op: 'read' } });
    const plain = parseOne(assistant('m2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/p/a.ts' } }])).find((e) => e.type === 'tool_call');
    expect(plain && 'memory' in plain).toBe(false);
  });

  it('el adjunto de instrucciones avisa una vez por archivo y expone solo su nombre', () => {
    const attachment = (paths: string[]): object => ({ type: 'attachment', timestamp: '2026-11-05T10:00:00.000Z', attachment: { type: 'instructions', files: paths.map((path) => ({ path, type: 'Project', content: 'secreto' })) } });
    const events = parseOne(attachment(['/home/x/p/CLAUDE.md', '/home/x/p/src/otro.md']), attachment(['/home/x/p/CLAUDE.md']), attachment(['/home/x/.claude/projects/p/memory/MEMORY.md']));
    const loads = events.filter((e) => e.type === 'memory_load');
    expect(loads).toHaveLength(2);
    expect(loads[0]).toMatchObject({ files: [{ file: 'CLAUDE.md', scope: 'project' }] });
    expect(loads[1]).toMatchObject({ files: [{ file: 'MEMORY.md', scope: 'auto' }] });
    expect(JSON.stringify(loads)).not.toContain('secreto');
    expect(JSON.stringify(loads)).not.toContain('home');
    const state = reduce(events);
    expect(state.memory.loaded.map((l) => l.file)).toEqual(['CLAUDE.md', 'MEMORY.md']);
  });

  it('un adjunto sin archivos, como en los fixtures sanitizados, no falla', () => {
    const loads = (attachment: object): SinapsisEvent[] => parseOne({ type: 'attachment', attachment }).filter((e) => e.type === 'memory_load');
    expect(loads({ type: 'instructions' })).toEqual([]);
    expect(loads({ type: 'instructions', files: 'x' })).toEqual([]);
  });

  it('el hito inferido sigue las reglas, en cualquier orden de llegada', () => {
    const touch = (t: number): SinapsisEvent => ({ type: 'tool_call', t, id: `m${t}`, name: 'Read', memory: { file: 'CLAUDE.md', scope: 'project', op: 'read' } });
    const events: SinapsisEvent[] = [
      { type: 'user_prompt', t: 100, text: 'uno' },
      touch(110),
      { type: 'tool_call', t: 120, id: 'x', name: 'Bash' },
      { type: 'tool_result', t: 130, id: 'x', isError: true },
      touch(140),
      { type: 'user_prompt', t: 200, text: 'dos' },
      touch(210),
      { type: 'subagent_start', t: 215, subagentId: 'a' },
      { type: 'subagent_result', t: 220, subagentId: 'a', status: 'completed' },
      touch(230),
    ];
    const expected = [0, 1, 0, 2];
    const forward = reduce(events);
    expect(forward.memory.touches.map((t) => memoryMilestone(forward, t))).toEqual(expected);
    expect(forward.memory.touches.map((t) => memoryLabel(forward, t))).toEqual(['recall', 'check', 'recall', 'recall']);
    const backward = reduce([...events].reverse());
    expect(backward.memory.touches.map((t) => t.t)).toEqual(forward.memory.touches.map((t) => t.t));
    expect(backward.memory.touches.map((t) => memoryMilestone(backward, t))).toEqual(expected);
  });

  it('el fixture real detecta su lectura de CLAUDE.md en el subagente que la hizo', () => {
    const events = feedAll([...haikuLines().values()].flat());
    const state = reduce(events);
    expect(state.memory.touches.map((t) => t.file)).toEqual(['CLAUDE.md']);
    expect(state.memory.touches[0]?.agentId).toBeDefined();
    expect(state.memory.touches[0]?.op).toBe('read');
  });
});
