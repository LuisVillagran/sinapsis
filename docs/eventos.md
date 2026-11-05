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
| ¿Cómo aparecen los subagentes? | **Archivo propio** en `<sesión>/subagents/`, escrito en vivo (ver [Subagentes](#subagentes)) |
| ¿Haiku consulta igual que Opus? | **Sí**: mismos bloques, mismo resultado cifrado, mismas iteraciones |
| ¿Hay datos de avance de un subagente? | **Sin porcentaje.** Sí hay un contador real: sus herramientas llegan en vivo |
| ¿Los hooks ven al advisor? | **No** (ver [Hooks](#hooks)). No se implementan |

### Evidencia disponible

- **Consultas al advisor:** cuatro. Dos en Opus 5.5 + advisor Opus 5.5 y dos en
  Haiku 5.5 + advisor Opus 5.5. Ningún transcript anterior tiene una, aunque el modo
  estaba activo.
- **Subagentes:** tres `Explore` en primer plano de una misma sesión (`claude -p`, Claude Code 2.1.318) y siete
  en segundo plano de otra (ver [Subagentes en segundo plano](#subagentes-en-segundo-plano)). No se observaron
  subagentes anidados ni fallidos.

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
| `mode` | Primera línea en los 33 transcripts interactivos. **No existe** con `claude -p` | `mode`, `sessionId` |

Tipos que el visor puede ignorar: `permission-mode`, `session-owner`, `atis-latch`,
`file-history-*`, `queue-operation`, `tools-used`, `agent-name`, `frame-link`,
`api-request-blob`, `api-request-shape`.

## Cómo se detecta cada evento

| Evento | Fuente | Confianza |
| --- | --- | --- |
| `session_start` | Primera línea de un archivo principal nuevo, sea del tipo que sea (`mode`, `session-owner`). Puede no tener `timestamp` | Observado |
| `tool_call` | Bloque `tool_use` (`id`, `name`, `input`) en una línea `assistant` | Observado (~6.000) |
| `tool_result` | Bloque `tool_result` (`tool_use_id`, `content`, `is_error`) en una línea `user` | Observado (~4.600) |
| `advisor_consult` | Bloque `server_tool_use` con `name: "advisor"` en una línea `assistant` | Observado (4 muestras), siempre a posteriori |
| `advisor_reply` | Bloque `advisor_tool_result` en una línea `assistant` | Observado (4 muestras), siempre a posteriori |
| `subagent_start` | Aparece `subagents/agent-<id>.jsonl`, con `agentId` e `isSidechain: true` | Observado (3 muestras), en vivo |
| `subagent_end` | `toolUseResult` con `agentId` en la línea `user` del proceso principal | Observado (3 muestras), en vivo |
| `session_end` | `cost-state` como última línea | **Inferido**: una sesión puede reanudarse. En la sesión con hooks llegó 24 ms antes que `SessionEnd` |

El fin de turno se detecta con `stop_reason: "end_turn"`. La línea `system` con
`subtype: "turn_duration"` **no siempre existe**: la sesión con `claude -p` no la tiene y
trae `stop_hook_summary`. Esa sesión tampoco tiene `ai-title`, así que la tarea debe caer a
`last-prompt`, que además se repite (5 líneas).

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

### Una consulta sin respuesta que se reintenta

Observado **una sola vez**, en el archivo del proceso principal. La consulta normal comparte `message.id` con su
resultado; esta vez no fue así:

| Mensaje | Línea | Bloques | `usage.iterations` |
| --- | --- | --- | --- |
| A | `assistant`, `stop_reason: tool_use` | `server_tool_use` `advisor`, id X | solo `message`, sin `advisor_message` |
| B (33 s después, otro `message.id`) | `assistant`, `stop_reason: tool_use` | `server_tool_use` `advisor`, id Y | `message`, `advisor_message`, `message` |
| B (98 s después) | `assistant` | `advisor_tool_result` con `tool_use_id` Y | la misma |

No hay ningún `advisor_tool_result` para X: la consulta se reintentó en otro mensaje, y los tokens del advisor son los de
Y. El parser lo trata así, por fuente (el principal y cada subagente por separado):

- Recuerda las consultas sin respuesta con su `message.id`. Cuando la misma fuente escribe una línea `assistant` real de
  **otro** `message.id` nuevo (no `<synthetic>`), emite `advisor_abandoned` por cada consulta pendiente del mensaje
  anterior. El mensaje nuevo se procesa después, así que un reintento dentro de él no se cancela a sí mismo.
- El estado quita la consulta y baja `advisor.calls` en 1. El reintento infiere el mismo motivo, porque se devuelven los
  errores y resultados de subagentes que la consulta abandonada había consumido.
- Si el resultado de una consulta ya abandonada llegara después, la consulta vuelve a existir como respondida.
  Esto último **no se observó**: es una defensa.
- En el log queda la línea de la consulta ya mostrada y una nueva, `consult dropped · no reply (inferred)`.

La regla es **más amplia que lo observado**: solo se vio un reintento, pero el parser abandona la consulta ante cualquier
mensaje nuevo de la misma fuente, haya o no reintento (por ejemplo, una interrupción con Esc). Por eso el log no dice
"reintentada" y rotula la línea como inferida.

### `advisorModel` no significa que hubo consulta

Aparece en todas las líneas `assistant` con sesión normal (~9.200) aunque nunca
se consultara. Indica que el advisor está **configurado**. La activación también
se ve en un adjunto:

```json
{ "type": "advisor_tool", "available": true, "model": "claude-opus-5-5", "toolChange": "add" }
```

## Subagentes

Observado en `fixtures/sesion-haiku-advisor-opus/`. Cada subagente tiene su propio archivo:

```text
<sesión>.jsonl
<sesión>/subagents/agent-<agentId>.jsonl       Se crea al empezar y crece en vivo
<sesión>/subagents/agent-<agentId>.meta.json   Se crea AL TERMINAR (agentType, description, toolUseId, finished)
```

En el proceso principal se ve como una herramienta más, `tool_use` con `name: "Agent"`:

```jsonc
{ "description": "Estructura del repositorio", "subagent_type": "Explore", "run_in_background": false, "prompt": "…" }
```

Y al terminar, su línea `user` trae en `toolUseResult` los totales reales:

```jsonc
{ "status": "completed", "agentId": "ae5f…", "agentType": "Explore", "resolvedModel": "claude-haiku-5-5",
  "totalDurationMs": 7686, "totalTokens": 63260, "totalToolUseCount": 1, "toolsUsed": ["Read"],
  "toolStats": { "readCount": 1, "searchCount": 0, "bashCount": 0, "editFileCount": 0, "linesAdded": 0 },
  "content": [ { "type": "text" } ] }
```

Dentro del archivo del subagente las líneas son iguales a las de la sesión principal:
`api-request`, `assistant` con `tool_use`, `user` con `tool_result`. Las líneas de contenido llevan
`isSidechain: true` y todas llevan `agentId`. La primera es `user` y su contenido es el prompt.

### El orden real de llegada confunde

El `tool_use` del `Agent` pertenece a un mensaje del proceso principal, así que se escribe **cuando ese
mensaje termina**. Con tres subagentes en paralelo, esto fue lo que llegó a disco:

| Hora | Qué llegó |
| --- | --- |
| 00:35:09,15 | Primera línea del subagente 1 |
| 00:35:10,39 | Primera línea del subagente 2 |
| 00:35:11,52 | Los tres `tool_use` de `Agent`, junto con la consulta al advisor anterior a ellos |
| 00:35:11,75 | Primera línea del subagente 3 |

Por lo tanto, un archivo de subagente puede aparecer **antes** que el `tool_use` que lo lanzó. El nombre
de la tarjeta (`description`) se obtiene emparejando el `input.prompt` del `tool_use` con la primera línea
del subagente. El enlace definitivo es `toolUseResult.agentId` con `tool_use_id`. **`.meta.json` no sirve
en vivo**, porque solo existe al final.

### Subagentes en segundo plano

Observados en 7 subagentes de una sesión de Claude Code 2.1.318 (lanzados con `Agent`, en segundo plano). **No
terminan con `stop_reason: end_turn`**, que es lo único que cierra a uno en primer plano. La forma se observó en una
sesión real, pero **todavía no hay fixture** que la contenga: los tests usan líneas sintéticas. Hay dos señales reales:

1. **`SubagentHandback`, en el archivo del subagente.** Su último mensaje de asistente es un `tool_use` con
   `name: "SubagentHandback"`, `stop_reason: "tool_use"` e `input: { "message": "<informe>" }`, seguido de su
   `tool_result`. El `message` es el informe real y es la señal más temprana del fin (7 de 7).
2. **`<task-notification>`, en el proceso principal.** El `tool_result` del `Agent` solo trae el lanzamiento:

   ```jsonc
   { "isAsync": true, "status": "async_launched", "agentId": "…", "resolvedModel": "…" }
   ```

   El fin llega después como un aviso de texto, siempre con esta estructura:

   ```text
   <task-notification>
   <task-id>…</task-id>                  Es el agentId
   <tool-use-id>toolu_…</tool-use-id>    El tool_use del Agent (o de un Bash en segundo plano)
   <output-file>…</output-file>
   <status>completed</status>
   <summary>Agent "…" finished</summary>
   <note>…</note>                        Puede variar
   <result>…</result>                    Con SubagentHandback: "…delivered to you as a message… not repeated here."
   <usage><subagent_tokens>…</subagent_tokens><tool_uses>…</tool_uses><duration_ms>…</duration_ms></usage>
   </task-notification>
   ```

   El mismo texto viaja por **tres portadores**, y un aviso aparece en varios: una línea
   `{ "type": "queue-operation", "operation": "enqueue", "content": "<texto>" }` (la más temprana, 7 de 7), una
   línea `user` con `origin: { "kind": "task-notification" }` (4 de 7) y un adjunto
   `{ "type": "attachment", "attachment": { "type": "queued_command", "prompt": "<texto>" } }` (3 de 7). Las
   líneas `queue-operation` con `operation: "remove"` repiten el texto y no cuentan.

Lo que hace el parser (`src/core/parser.ts`):

- `SubagentHandback` emite `subagent_end` con `summary` igual al `message` y la marca `handback`.
- El aviso emite `subagent_end`, si faltaba, y `subagent_result` con `status`, `durationMs`, `totalTokens` y `toolCount`.
  Solo cuenta si el texto empieza con `<task-notification>` (en la línea `user`, además, con `origin.kind` igual a
  `task-notification`) y su `tool-use-id` es un lanzamiento de `Agent` o `Task`:
  los `Bash` en segundo plano también avisan y se ignoran.
- Estado e identificadores se leen antes de `<result>` y el uso después del último `</result>`, porque un informe
  podría contener etiquetas parecidas. El texto de `<result>` solo es resumen si no dice que el informe se entregó aparte.
- El mismo aviso por varios portadores produce un solo resultado.
- El informe del subagente prevalece como resumen y el estado final es el mismo llegue antes el informe o el aviso.
- Un estado distinto de `completed` se ve como fallido. Los de lanzamiento (`async_launched`, `running`…) no cierran nada.
- Un subagente reanudado que vuelve a trabajar después de cerrarse **no se reabre**: se trata más adelante.
- **Limitación conocida:** si un aviso con estado distinto de `completed` llega después de `SubagentHandback`, el estado
  final queda como fallido, pero el log conserva la línea de entrega del informe.

### Avance

No hay porcentaje ni total de pasos. Lo real para una tarjeta en vivo:

- **Barra:** indeterminada.
- **Contador de herramientas:** sus `tool_use` llegan con 136 a 970 ms de retraso.
- **Herramienta actual:** el último `tool_use` sin resultado.
- **Al terminar:** duración, tokens y herramientas desde `toolUseResult`.
- **`read-only`:** solo inferible del tipo (`Explore`). Se rotula por `agentType`, no por el contenido del prompt.
- **Resumen para "back to lead":** el texto del `tool_result` del `Agent`.

Los subagentes llevan `advisorModel`, pero ninguno consultó al advisor (0 de 3). No se sabe si pueden hacerlo.

## Memoria

Reconocimiento del 2026-11-05 sobre 47 transcripts locales (42.862 líneas), contando solo tipos y nombres de archivo.

| Señal | Fuente | Estado |
| --- | --- | --- |
| Archivos cargados al iniciar | Adjunto `instructions`, con `files: [{ path, type, content }]`. `CLAUDE.md` 46 veces y `MEMORY.md` 5 | **Observado**, pero el sanitizador lo borra de los fixtures. Probado con líneas de prueba |
| Lectura de `CLAUDE.md` por el principal o un subagente | `tool_use` de `Read` o `Grep` | **Observado** (22 veces, una en un subagente y en el fixture) |
| Escritura de `CLAUDE.md` | `tool_use` de `Edit` o `Write` | **Observado** (71 veces) |
| Escritura de la memoria automática | `tool_use` de `Write` en `~/.claude/projects/<proyecto>/memory/` | **Observado** (6 veces) |
| Memoria por agente | `tool_use` en `.claude/agent-memory/<agente>/` | **Sin observar**: 0 apariciones. La regla usa la ruta esperada |

Los subagentes tocaron archivos de memoria una sola vez en esos 47 transcripts, así que en una sesión normal el panel
`AGENT MEMORY` estará casi siempre quieto.

No se detecta: un archivo de memoria leído con un comando de `Bash`, ni la razón de una consulta.

### Hitos inferidos

El transcript no dice por qué se tocó la memoria. Cada operación se asigna a un hito mirando lo ocurrido antes en el
mismo turno, y por eso el resultado no cambia con lo que llegue después ni con el orden de llegada:

| Hito | Regla, en orden de prioridad | Etiqueta del agente |
| --- | --- | --- |
| `repeat failure` | Hubo un error de herramienta antes en el turno. Basta con uno: no se comprueba que el fallo se repita | `check`, si es una lectura |
| `before sign-off` | Un subagente terminó antes en el turno | `recall` |
| `before work` | Cualquier otro caso, y los archivos cargados al iniciar | `recall` |

Una escritura siempre lleva la etiqueta `save`.

## Hooks

Sesión real con `--settings` temporal, registrando `PreToolUse`, `PostToolUse`, `PostToolBatch`,
`SubagentStart`, `SubagentStop`, `Stop` y `SessionEnd`. Llegaron 36 eventos, así que la configuración funciona.

| Ventana del advisor (timestamps) | Hooks recibidos dentro |
| --- | --- |
| 00:34:47,738 a 00:35:07,162 (19,4 s) | **0** |
| 00:35:26,346 a 00:36:05,631 (39,3 s) | **0** |

Ningún hook menciona al advisor. Es una herramienta de servidor y el cliente no ejecuta nada.

**Decisión: no se implementan hooks ni `sinapsis hooks`.** Lo único que adelantan es el inicio de un subagente:

| Señal | Primer subagente |
| --- | --- |
| `PreToolUse` de `Agent` | 00:35:08,837 |
| `SubagentStart` | 00:35:08,963 |
| Línea en el archivo del subagente | 00:35:09,15 |
| `tool_use` en la sesión principal | 00:35:11,52 |

Seguir la carpeta `subagents/` da casi lo mismo (unos 300 ms) y no obliga al usuario a tocar su configuración.

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

### El retraso no depende de `stat`, pero los avisos del sistema sí fallan

Medición en Windows 11 con NTFS y Node 24, en procesos separados: 25 líneas, una cada 150 ms, midiendo un
método por corrida para que abrir el archivo no refresque los metadatos de otro. Latencia en ms hasta detectar
cada línea:

| Método | Escritor abre y cierra (p50 / p95) | Escritor deja el descriptor abierto (p50 / p95) |
| --- | --- | --- |
| `stat` cada 10 ms | 16 / 16 | 0 / 16 |
| Abrir y leer cada 10 ms | 16 / 16 | 0 / 1 |
| `fs.watch` | 0 / 1 | **3.394 / 5.114** (1 aviso en toda la corrida) |
| `chokidar` | 1 / 2 | **3.387 / 5.106** (1 aviso en toda la corrida) |

Conclusiones:

- **`stat` ve el tamaño correcto de inmediato** en ambos casos: no causa retraso en este equipo. Lo que se
  atrasa en vivo es la escritura de Claude Code, que guarda los bloques al terminar cada mensaje.
- **Los avisos del sistema no bastan:** si el escritor mantiene el archivo abierto, `fs.watch` y `chokidar`
  no avisan hasta el cierre.
- **Por eso `src/sources/live.ts` usa ambos:** `chokidar` despierta la lectura al instante y un sondeo con
  `stat` cada 100 ms garantiza que nada se quede esperando.

No se comprobó en otros sistemas de archivos, ni en Linux o macOS.

### Qué implica para el visor

- **En vivo:** `api-request` avisa unos 100 ms después de que empieza cada petición.
  Eso permite mostrar "el modelo está trabajando", pero no distingue si está
  generando texto o consultando al advisor.
- **A posteriori:** consulta y respuesta llegan juntas, con sus `timestamp` reales. La
  animación de ida y vuelta se puede reproducir con la duración real, pero siempre
  después de ocurrida.
- **Herramientas:** en un mensaje con una sola herramienta lenta, su `tool_use` llegó antes de
  terminar el comando (166 ms en la prueba de 25 s). **No es una garantía:** en un mensaje con varias
  herramientas, estas empiezan a correr mientras el mensaje sigue generándose, y el disco se atrasa
  respecto de la ejecución. El primer `Agent` de la sesión Haiku se ejecutó en 00:35:08,8 y su `tool_use`
  llegó en 00:35:11,5.
- **Mensajes largos:** todos sus bloques llegan juntos, con retrasos de decenas de
  segundos. La cola de animación debe absorber esos lotes.

La sesión Haiku lo confirma con otros dos casos: las consultas de 19,4 s y 39,3 s llegaron a disco con
23,8 s y 39,6 s de retraso. Los hooks tampoco ayudan (ver [Hooks](#hooks)).

## Elementos de la imagen frente a datos reales

Esta tabla corresponde a la primera referencia, que ya no se usa. El diseño vigente está en la sección 6 de `CLAUDE.md`.

| Elemento de la imagen | Fuente real | Estado |
| --- | --- | --- |
| Título con modelos | `message.model`, `advisorModel` | Real |
| Leyenda main / subagents / advisor | Modelos anteriores y `resolvedModel` o `message.model` del subagente | Real |
| `jev · forks` y panel "fork layer" | No existe | **Reemplazar** por distribución de herramientas (`tool_use.name`) |
| Caja principal: modelo y effort | `message.model`, `assistant.effort` | Real |
| Medidor de effort `▮▮▮▮` | `assistant.effort` | Real. Se observaron `high` y `medium`; el resto sin confirmar |
| Caja principal: tarea | `ai-title` o `last-prompt` | Real |
| "waiting on advisor" | Bloque `server_tool_use` | **Solo a posteriori**: en vivo solo se sabe "working" |
| Línea de tiempo: motivos | No existe | **Inferir** (ver abajo) |
| "last advice" | Cifrado | **Reemplazar** (ver abajo) |
| calls | Bloques `server_tool_use` de advisor | Real |
| tokens read | `advisor_message.input_tokens` | Real |
| routine turns | Mensajes sin iteración de advisor | Real |
| Caja model / mode | `advisorModel`, adjunto `advisor_tool` | Real |
| Caja state | Derivado de consulta abierta o cerrada | **Solo a posteriori** |
| Tarjetas de subagente | `subagents/agent-*.jsonl`, `tool_use` de `Agent` | Real |
| Barra de avance con % | No existe | **Reemplazar** por barra indeterminada y contador real de herramientas |
| "files: 156", "call sites: 15" | No existen | **Reemplazar** por `tools: N` y, al terminar, duración y tokens |
| Caja "back to lead" | `tool_result` del `Agent` | Real |
| Session log | `timestamp`, modelo y evento | Real |
| Línea de prompt `claude --model…` | Los flags no se registran | **Reconstruir** desde los modelos y `cwd`, sin presentarlo como literal |
| Barra `~/app — zsh` | `cwd` | Real, decorativa |
| Línea inferior `# [07/07] …` y cuadros de pasos | No hay total de pasos | **Reemplazar** por último evento y eventos en cola |
| `X: @skunzu` | Crédito del autor de la imagen | **No copiar** |

### Alternativas honestas propuestas

**Motivo de la consulta.** Inferirlo con reglas y mostrarlo como inferido:

| Etiqueta | Regla, en orden de prioridad |
| --- | --- |
| `after errors` | Hubo resultados con `is_error: true` desde la consulta anterior del turno |
| `after subagents` | Volvieron resultados de `Agent` desde la consulta anterior del turno |
| `before done` | El propio mensaje de la consulta termina con `end_turn` |
| `before a plan` | Primera consulta del turno, sin `Edit` ni `Write` previos |
| `check-in` | Cualquier otro caso |

Las reglas solo miran el pasado y el propio mensaje, que ya trae su `stop_reason` en cada línea. Así la
etiqueta se decide al llegar la consulta y no se reescribe después. En los datos reales, `before done` no
coincide con ninguna de las 4 consultas: incluso la pedida justo antes de terminar va seguida de una
herramienta. Las 4 quedan como `check-in`, `after errors`, `before a plan` y `after subagents`.

**Último consejo.** Mostrar lo que sí se sabe: `sealed · 42 s · 64.7k read · 4.0k written`.
Debajo se puede citar el texto con el que sigue el modelo principal, rotulado con su
nombre para no presentarlo como el consejo del advisor. En la muestra, ese texto fue
*"Sigo ese plan: primero inspecciono…"*.

## Fixtures

| Archivo | Contenido | Limitaciones |
| --- | --- | --- |
| `fixtures/sesion-opus-advisor-opus.jsonl` | Sesión de Fase 0, con 2 consultas reales | Opus + Opus, sin subagentes |
| `fixtures/sesion-haiku-advisor-opus.jsonl` y carpeta homónima | `claude -p` con 2 consultas y 3 subagentes (0,59 USD) | Sin errores de herramientas, sin compactación ni `ai-title` |
| `fixtures/sesion-haiku-con-error.jsonl` y carpeta homónima | Sesión de la Fase 5: 2 consultas, 2 subagentes y una lectura que falla a propósito (0,45 USD) | Sin compactación ni `ai-title` |

Se generan con `scripts/sanitize-fixture.mjs`, que conserva la estructura y quita
prompts de sistema, contenido largo, rutas, correos, identificadores de cuenta y
nombres de otros proyectos. Los transcripts sin sanitizar no deben entrar al repositorio;
`fixtures/raw/` está en `.gitignore` por eso.

## Cómo se grabó la sesión Haiku

```text
claude -p --model haiku --advisor opus --max-budget-usd 2 --session-id <uuid>
  --settings <hooks-temporal> --tools Read Glob Grep Agent --allowedTools Read Glob Grep Agent
```

`--advisor` no aparece en `claude --help` (2.1.318), pero el CLI lo acepta: lo confirman el adjunto
`advisor_tool` y las consultas. El prompt pidió consultas y subagentes de forma explícita, porque el modelo
no suele usarlos por iniciativa propia. Coste total: 0,59 USD.

## Trampas encontradas en la Fase 5

- **`api-request-blob` repite los mensajes.** Sus líneas traen `message.content` con los mismos bloques, así que
  un conteo que no filtre por `type` duplica herramientas y consultas. El parser no las lee.
- **`stop_reason` llega antes que la respuesta del advisor.** Cada línea del mensaje trae el valor final, así que
  `end_turn` aparece en la línea de la consulta, antes de `advisor_tool_result`. La cola une ambas igualmente.

## Sin observar todavía

- Memoria por agente (`.claude/agent-memory/`), en ninguna sesión.
- Otras variantes de `advisor_tool_result`, como errores.
- Subagentes anidados, fallidos o con otro `agentType`, y un subagente en segundo plano reanudado que vuelve a trabajar
  tras cerrarse (el aviso dice que puede notificar más de una vez).
- Si un subagente puede consultar al advisor.
- `cost-state` con una sesión reanudada, y `SessionEnd` con una salida interactiva (`/exit`).
- Niveles de effort aparte de `high` y `medium`.
