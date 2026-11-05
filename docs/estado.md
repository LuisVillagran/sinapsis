# Estado del proyecto

Bitácora para retomar el trabajo solo con este archivo. Ver `CLAUDE.md` para el acuerdo.

## Fase actual

**Fase 1 — Parser y modelo de eventos.** Fase 0 cerrada.

## Hecho

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
- **Privacidad:** el fixture antiguo traía en una línea la salida de una revisión anterior, con fragmentos
  de nombres de otros proyectos. Se limpió también en el historial local con `git filter-branch`, antes del
  primer push. Por eso los hashes de la Fase 0 cambiaron.

## Errores de comandos

Ninguno todavía.

## Bloqueos

Ninguno.

## Para revisar al volver

- Cuenta de GitHub en `gh` y nombre de git son distintos. La URL de instalación usa la cuenta de `gh`.
