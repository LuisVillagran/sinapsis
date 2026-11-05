# Fase 0 — Qué registran realmente los transcripts

Reconocimiento hecho el 2026-11-04 sobre 33 transcripts `.jsonl` reales de
`~/.claude/projects/` (Claude Code 2.1.289 a 2.1.318, unas 19.600 líneas).
El formato no está documentado y puede cambiar entre versiones, así que el parser
debe ignorar lo que no conozca.

## Resumen

| Pregunta | Respuesta |
| --- | --- |
| ¿Se detecta una consulta al advisor? | **Sí**, con bloques estructurados |
| ¿Se sabe cuánto duró y cuántos tokens usó? | **Sí** |
| ¿Se conoce el motivo de la consulta? | **No**: `input` viene vacío. Solo se puede inferir |
| ¿Se puede leer el consejo? | **No**: está cifrado y no se guarda en claro |
| ¿Se ve la consulta mientras ocurre? | **No**: consulta y respuesta llegan juntas al terminar (ver [Tiempo real](#tiempo-real)) |
| ¿Cómo aparecen los subagentes? | **No observado**: no hay ningún ejemplo en disco |
| ¿Hay datos de una sesión Haiku + advisor Opus? | **No**: falta grabarla |

### Evidencia disponible

- **Consultas al advisor:** solo las dos de esta sesión de Fase 0
  (Opus 5.5 principal + Opus 5.5 advisor). Ningún transcript anterior tiene una,
  aunque el modo estaba activo.
- **Subagentes:** cero. No hay carpetas `subagents/`, ninguna línea con
  `isSidechain: true` ni llamadas a `Agent` o `Task`.
- Todo lo que dependa de esos dos puntos queda marcado como no observado o
  con una sola muestra.

## Estructura general

Cada línea es un objeto JSON con un `type`. Los que importan al visor:

| `type` | Para qué sirve | Campos útiles |
| --- | --- | --- |
| `assistant` | Salida del modelo, **un bloque por línea** | `message.{id,model,content,stop_reason,usage}`, `advisorModel`, `effort`, `timestamp` |
| `user` | Prompts y resultados de herramientas | `message.content`, `toolUseResult`, `sourceToolAssistantUUID`, `turnOrigin`, `timestamp` |
| `system` | Eventos del arnés, según `subtype` | `turn_duration` (`durationMs`, `messageCount`), `compact_boundary`, `away_summary`, `informational`, `local_command` |
| `attachment` | Contexto inyectado, según `attachment.type` | `advisor_tool`, `model` |
| `api-request` | Parámetros de cada petición | `params.model`, `params.output_config.effort`, `querySource` |
| `ai-title` | Título de la sesión | `aiTitle` |
| `last-prompt` | Último prompt del usuario | `lastPrompt` |
| `cost-state` | Totales acumulados | `totalCostUSD`, `totalLinesAdded`, `totalLinesRemoved`, `modelUsage` |
| `mode` | Primera línea de todo archivo (33 de 33) | `mode`, `sessionId` |

Tipos que el visor puede ignorar: `permission-mode`, `session-owner`, `atis-latch`,
`file-history-*`, `queue-operation`, `tools-used`, `agent-name`, `frame-link`,
`api-request-blob`, `api-request-shape`.

## Cómo se detecta cada evento

| Evento | Fuente | Confianza |
| --- | --- | --- |
| `session_start` | Archivo nuevo. Su primera línea es `mode`, sin `timestamp` | Observado |
| `tool_call` | Bloque `tool_use` (`id`, `name`, `input`) en una línea `assistant` | Observado (~6.000) |
| `tool_result` | Bloque `tool_result` (`tool_use_id`, `content`, `is_error`) en una línea `user` | Observado (~4.600) |
| `advisor_consult` | Bloque `server_tool_use` con `name: "advisor"` en una línea `assistant` | Observado (2 muestras), siempre a posteriori |
| `advisor_reply` | Bloque `advisor_tool_result` en una línea `assistant` | Observado (2 muestras), siempre a posteriori |
| `subagent_start` | Sin datos | **No observado** |
| `subagent_end` | Sin datos | **No observado** |
| `session_end` | `cost-state` es la última línea en 30 de 33 archivos | **Inferido**: una sesión puede reanudarse |

El fin de turno sí es detectable: `stop_reason: "end_turn"` y la línea
`system` con `subtype: "turn_duration"`.

## La consulta al advisor

Forma real, con los valores largos recortados. Ambos bloques van dentro del
**mismo mensaje** (`message.id`), en líneas `assistant` separadas:

```jsonc
// Consulta (timestamp 23:58:11.514)
{ "type": "server_tool_use", "id": "srvtoolu_01VT8…", "name": "advisor", "input": {} }

// Respuesta (timestamp 23:58:54.043)
{
  "type": "advisor_tool_result",
  "tool_use_id": "srvtoolu_01VT8…",
  "content": { "type": "advisor_redacted_result", "encrypted_content": "Ep0Y…" }
}
```

Los tokens están en `message.usage.iterations`:

```jsonc
"iterations": [
  { "type": "message",         "input_tokens": 2,     "output_tokens": 535  },
  { "type": "advisor_message", "input_tokens": 64726, "output_tokens": 3971, "model": "claude-opus-5-5" },
  { "type": "message",         "input_tokens": 2,     "output_tokens": 2191 }
]
```

De ahí salen tres datos reales:

- **Duración:** diferencia de `timestamp` entre ambos bloques (42,5 s y 171,6 s en las muestras).
- **Tokens leídos y escritos:** iteraciones con `type: "advisor_message"`.
- **Modelo del advisor:** el campo `model` de esa iteración.

### Lo que no existe

- **Motivo:** `input` siempre es `{}`. El transcript no dice por qué se consultó.
- **Consejo:** `encrypted_content` es opaco. Se buscaron frases del consejo real
  en el transcript y no aparece en ninguna línea.
- **Otras variantes de resultado:** solo se vio `advisor_redacted_result`. El parser
  debe tolerar otros `content.type`, por ejemplo errores.

### `advisorModel` no significa que hubo consulta

Aparece en todas las líneas `assistant` con sesión normal (~9.200) aunque nunca
se consultara. Indica que el advisor está **configurado**. La activación también
se ve en un adjunto:

```json
{ "type": "advisor_tool", "available": true, "model": "claude-opus-5-5", "toolChange": "add" }
```

## Trampas para el parser

1. **Tokens duplicados.** Cada bloque es una línea y todas repiten el `usage` completo:
   9.249 líneas `assistant` para 3.786 `message.id` únicos. Hay que deduplicar por
   `message.id` o los tokens salen inflados.
2. **`usage` no incluye al advisor.** Los totales de nivel superior suman solo las
   iteraciones `message` (en la muestra, `output_tokens` 2.726 = 535 + 2.191).
3. **`is_error` es opcional.** Falta en 1.811 de 4.642 resultados. Ausente equivale a `false`.
4. **`toolUseResult` no tiene forma fija.** Es un objeto que varía por herramienta,
   un string en los errores (120 de 120) o un arreglo en algunos casos.
5. **`message.content` puede ser string** en líneas `user`, no siempre un arreglo.
6. **Hay prompts que no son del usuario.** Filtrar con `isMeta`, `isCompactSummary` y
   `turnOrigin`, y descartar comandos locales como `<command-name>`.
7. **Muchas líneas no tienen `timestamp`.** Ocurre en las de metadatos.
8. **El modelo principal hay que leerlo de `message.model`.**
   - Puede cambiar a mitad de sesión (68 líneas en Sonnet dentro de sesiones Opus).
   - Hay que ignorar `<synthetic>`.
   - `cost-state.modelUsage` **no sirve** para esto: lista Haiku con unos 1.180 tokens
     de entrada en sesiones sin ningún mensaje Haiku. Probablemente sea la generación
     del título (`ai-title`), aunque eso no está verificado.
9. **Compactación.** `system/compact_boundary` marca que el contexto se resumió. El
   mensaje de resumen trae `isCompactSummary` y no debe contarse como turno.

## Tiempo real

Medido con un proceso que sigue el archivo cada 100 ms, comparando el momento de
detección con el `timestamp` de cada línea:

| Línea | Retraso observado |
| --- | --- |
| `api-request` (inicio de cada petición) | 67 a 175 ms |
| `tool_result` | 90 a 220 ms |
| `tool_use` | Depende del mensaje: 166 ms a unos pocos segundos |
| `thinking` de un mensaje largo | 47,5 s |
| **`server_tool_use` del advisor** | **174,4 s** |
| `advisor_tool_result` | 2,8 s |

### La consulta al advisor solo se ve después

Medición directa de la segunda consulta:

| Momento | Hora |
| --- | --- |
| `timestamp` de `server_tool_use` | 00:05:28,698 |
| `timestamp` de `advisor_tool_result` | 00:08:20,336 |
| **Ambas líneas aparecen en disco** | **00:08:23,130** |

Durante esos 171,6 s no llegó ninguna línea nueva al archivo. La primera consulta
coincide: su línea con `timestamp` 23:58:11 ya traía tokens generados después de la
respuesta, lo que es imposible si se hubiera escrito en ese momento.

La causa probable es que los bloques se escriben al terminar el mensaje de la API, y la
consulta ocurre dentro de ese mismo mensaje porque es una herramienta de servidor.

### Qué implica para el visor

- **En vivo:** `api-request` avisa unos 100 ms después de que empieza cada petición.
  Eso permite mostrar "el modelo está trabajando", pero no distingue si está
  generando texto o consultando al advisor.
- **A posteriori:** consulta y respuesta llegan juntas, con sus `timestamp` reales. La
  animación de ida y vuelta se puede reproducir con la duración real, pero siempre
  después de ocurrida.
- **Herramientas:** una herramienta lenta sí se ve mientras corre, porque su `tool_use`
  llega al terminar el mensaje y antes de ejecutarse el comando (166 ms en la prueba
  de 25 s).
- **Mensajes largos:** todos sus bloques llegan juntos, con retrasos de decenas de
  segundos. La cola de animación debe absorber esos lotes.

Los hooks quedan por probar en la Fase 2. No se sabe si ven esta herramienta de servidor.

## Elementos de la imagen frente a datos reales

Referencia: `referencia/diseño.png`.

| Elemento de la imagen | Fuente real | Estado |
| --- | --- | --- |
| Título con modelos | `message.model`, `advisorModel` | Real |
| Leyenda main / subagents / advisor | Modelos anteriores | Real, subagentes sin confirmar |
| `jev · forks` y panel "fork layer" | No existe | **Reemplazar** por distribución de herramientas (`tool_use.name`) |
| Caja principal: modelo y effort | `message.model`, `assistant.effort` | Real |
| Medidor de effort `▮▮▮▮` | `assistant.effort` | Real, con niveles sin confirmar: solo se observó `high` |
| Caja principal: tarea | `ai-title` o `last-prompt` | Real |
| "waiting on advisor" | Bloque `server_tool_use` | **Solo a posteriori**: en vivo solo se sabe "working" |
| Línea de tiempo: motivos | No existe | **Inferir** (ver abajo) |
| "last advice" | Cifrado | **Reemplazar** (ver abajo) |
| calls | Bloques `server_tool_use` de advisor | Real |
| tokens read | `advisor_message.input_tokens` | Real |
| routine turns | Mensajes sin iteración de advisor | Real |
| Caja model / mode | `advisorModel`, adjunto `advisor_tool` | Real |
| Caja state | Derivado de consulta abierta o cerrada | **Solo a posteriori** |
| Tarjetas de subagente | Sin datos | **No observado** |
| Barra de avance con % | Probablemente no exista | **No inventar**: decidir al ver datos reales |
| "files: 156", "call sites: 15" | Sin fuente conocida | **No inventar** |
| Caja "back to lead" | Sin datos | **No observado** |
| Session log | `timestamp`, modelo y evento | Real |
| Línea de prompt `claude --model…` | Los flags no se registran | **Reconstruir** desde los modelos y `cwd`, sin presentarlo como literal |
| Barra `~/app — zsh` | `cwd` | Real, decorativa |
| Línea inferior `# [07/07] …` y cuadros de pasos | No hay total de pasos | **Reemplazar** por último evento y eventos en cola |
| `X: @skunzu` | Crédito del autor de la imagen | **No copiar** |

### Alternativas honestas propuestas

**Motivo de la consulta.** Inferirlo con reglas y mostrarlo como inferido:

| Etiqueta | Regla |
| --- | --- |
| `before a plan` | Primera consulta del turno, sin `Edit` ni `Write` previos |
| `after errors` | Resultados recientes con `is_error: true` |
| `before done` | El mensaje termina con `end_turn` sin más herramientas |
| `check-in` | Cualquier otro caso |

**Último consejo.** Mostrar lo que sí se sabe: `sealed · 42 s · 64.7k read · 4.0k written`.
Debajo se puede citar el texto con el que sigue el modelo principal, rotulado con su
nombre para no presentarlo como el consejo del advisor. En la muestra, ese texto fue
*"Sigo ese plan: primero inspecciono…"*.

## Fixtures

| Archivo | Contenido | Limitaciones |
| --- | --- | --- |
| `fixtures/sesion-opus-advisor-opus.jsonl` | Esta sesión de Fase 0, con 2 consultas reales | Opus + Opus, sin subagentes |

Se generan con `scripts/sanitize-fixture.mjs`, que conserva la estructura y quita
prompts de sistema, contenido largo, rutas, correos, identificadores de cuenta y
nombres de otros proyectos. Los transcripts sin sanitizar no deben entrar al repositorio;
`fixtures/raw/` está en `.gitignore` por eso.

## Pendiente para cerrar la Fase 0

Grabar una sesión real con el escenario objetivo:

```powershell
claude --model haiku --advisor opus
```

`--advisor` no aparece en `claude --help` (2.1.318), pero el CLI lo acepta. El prompt
debe pedir subagentes y consultas de forma explícita, porque el modelo no suele
usarlos por iniciativa propia:

```text
Analiza este repositorio sin modificar ningún archivo. Antes de planificar, consulta
al advisor. Después lanza 3 subagentes en paralelo, todos de solo lectura: uno que
describa la estructura del repositorio, otro que busque los usos de "advisor" en
scripts/ y docs/, y otro que resuma docs/eventos.md. Reúne sus resúmenes, consulta
al advisor otra vez antes de terminar y dame un informe de 5 líneas.
```

Al terminar, salir con `/exit` para registrar también el cierre de la sesión.

Esa sesión debe confirmar:

- cómo aparecen los subagentes (archivos, `isSidechain`, herramienta usada);
- si Haiku consulta al advisor igual que Opus;
- si hay algo parecido a un avance dentro de un subagente;
- si `cost-state` marca de verdad el cierre de la sesión.
