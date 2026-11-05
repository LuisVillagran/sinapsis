# Estado del proyecto

Bitácora para retomar el trabajo solo con este archivo. Ver `CLAUDE.md` para el acuerdo.

## Fase actual

**Fase 2 — Fuentes de eventos.** Fases 0 y 1 cerradas.

## Hecho

- **Fase 1:** `src/core/` con parser y reductor. 41 tests: totales frente a un conteo independiente, trampas
  de `docs/eventos.md`, reglas de motivo y estado final igual en orden de archivo, de timestamp y de llegada
  real (`fixtures/sesion-haiku-advisor-opus/orden-llegada.json`).
- **Fase 0:** `docs/eventos.md` responde cómo aparecen los subagentes, si Haiku consulta igual que Opus,
  si hay datos de avance y si los hooks ven al advisor. Fixture
  `fixtures/sesion-haiku-advisor-opus.jsonl` con su carpeta `subagents/`.

## Decisiones

- Mensaje del usuario al iniciar la sesión autónoma: «si algún comando da error, pégame el
  mensaje antes de seguir». Como el acuerdo prohíbe detenerse a preguntar, se interpreta así:
  cada error se cita textual en la salida visible y aquí, y el trabajo continúa.
- **No se implementan hooks ni `sinapsis hooks`.** No ven al advisor (0 eventos en dos consultas, con 36
  eventos de control) y seguir `subagents/` da casi la misma señal sin tocar la configuración del usuario.
- **Tarjetas de subagente:** barra indeterminada, contador real de herramientas y herramienta actual. Al
  terminar, duración y tokens de `toolUseResult`. Nunca porcentaje.
- **Motivo inferido:** se agregó `after subagents` y se priorizan reglas que solo miran el pasado y el propio
  mensaje. La regla `before done` del documento original no coincidía con ninguna consulta real.
- **Errores de API (`<synthetic>` con `isApiErrorMessage`):** no cambian el modelo ni cuentan como mensaje, pero
  generan el evento `api_error`, que se trata como error visible (destello naranjo).
- **Eventos adicionales a los de la sección 8:** `session_info`, `user_prompt`, `message_usage`,
  `assistant_text`, `subagent_info`, `subagent_result`, `api_error` y `compaction`. Los pide el reductor.
- **Resumen de un subagente:** último bloque de `toolUseResult.content`. El texto del `tool_result` trae
  envoltorios del arnés.
- **Privacidad:** el fixture antiguo traía en una línea la salida de una revisión anterior, con fragmentos
  de nombres de otros proyectos. Se limpió también en el historial local con `git filter-branch`, antes del
  primer push. Por eso los hashes de la Fase 0 cambiaron.

## Errores de comandos

- Fase 1, al escribir `src/core/`: `The server-side auto mode classifier gave no verdict (the response ended
  before its verdict arrived), so auto mode cannot determine the safety of Write.` Fallo transitorio del
  verificador de permisos. Se reintentó una vez y funcionó.

## Bloqueos

Ninguno.

## Para revisar al volver

- Cuenta de GitHub en `gh` y nombre de git son distintos. La URL de instalación usa la cuenta de `gh`.
