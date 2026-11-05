# Estado del proyecto

Bitácora para retomar el trabajo solo con este archivo. Ver `CLAUDE.md` para el acuerdo.

## Fase actual

**Fase 4 — Animaciones.** Fases 0 a 3 cerradas.

## Hecho

- **Fase 3:** motor de buffer de celdas, diff ANSI, escena completa y reducida, `tools/snapshot.ts`,
  `tools/sample-colors.ts`, `docs/colores.md` y capturas en `docs/capturas/`. Cuatro iteraciones de comparación.
  Geometría verificada escaneando el buffer. Los bytes reales se comprueban contra `@xterm/headless`.

  Diferencias que quedan frente a la referencia, y por qué:
  - **Letra más grande en proporción:** la imagen usa unos 6 px por carácter sobre una rejilla nominal de
    8,875 px, algo imposible en una terminal real. Por eso el modelo y `read-only` van en filas separadas en las
    tarjetas, y varios títulos se recortan.
  - **Sin brillo real:** el halo son fondos tintados por celda y se ven escalones suaves.
  - **Barras de métricas a media celda:** con media altura para separar filas consecutivas, no caben octavos.
  - **Sin punto de cometa:** llega con la animación de paquetes.
  - **Reemplazos acordados:** panel de herramientas, consultas agrupadas por motivo inferido, sin porcentajes.
  - **Hitos del advisor:** las consultas se agrupan en los tres hitos de la imagen. El historial completo está
    en el log.
  - **Altura de celda:** las capturas imitan la celda alta de la referencia (unos 9x23 px). En una terminal común
    la escena se ve más baja, sin problemas (comprobado con una captura a alto normal).

- **Fase 2:** `src/sources/`: seguimiento por offset con líneas partidas, descubrimiento, cambio de sesión,
  replay determinista y `--print-events`. El retraso en Windows no depende de `stat` (ver `docs/eventos.md`).

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
- **Sesión activa:** la modificada hace menos de 24 h. Otra sesión la reemplaza si es al menos 5 s más reciente.
- **Replay:** las líneas de un mensaje llegan juntas, a la hora de la última, como en vivo. Los tiempos muertos
  se acortan a 8 s de sesión.
- **Modo sin interfaz:** opción `--print-events`, aplicable a cualquier comando.
- **Mensaje suelto «23» del usuario durante la sesión:** sin relación con el trabajo. Se trató como envío
  accidental y se avisó en la respuesta.
- **256 colores:** fondo plano, porque la viñeta se veía como anillos.
- **Interfaz en inglés, mensajes de la línea de comandos en español:** la interfaz sigue los rótulos de la
  imagen de referencia y `CLAUDE.md`.
- **`dist/` versionado (desviación de `CLAUDE.md`, a revisar):** `npm install -g` desde git fallaba porque el npm
  interno que prepara la dependencia hereda el modo global y no instala `tsup`. `prepare` ahora compila si `tsup`
  existe y, si no, usa `dist/`. `test/dist.test.ts` falla si `dist/` queda atrás: hay que ejecutar `npm run build`
  antes de cada commit que toque `src/`.
- **Privacidad:** el fixture antiguo traía en una línea la salida de una revisión anterior, con fragmentos
  de nombres de otros proyectos. Se limpió también en el historial local con `git filter-branch`, antes del
  primer push. Por eso los hashes de la Fase 0 cambiaron.

## Errores de comandos

- Fase 1, al escribir `src/core/`: `The server-side auto mode classifier gave no verdict (the response ended
  before its verdict arrived), so auto mode cannot determine the safety of Write.` Fallo transitorio del
  verificador de permisos. Se reintentó una vez y funcionó.
- Fase 3, primera captura: Chrome dejó caer la pestaña con `--use-gl=swiftshader`, y además generó un PNG válido
  del icono de error. Se cambió a `--use-angle=swiftshader` y la herramienta ahora termina con error si la pestaña
  se cae. Con `deviceScaleFactor: 2`, WebGL mostraba un solo cuadrante, así que se captura a escala 1.
- Fase 4, prueba de instalación desde git: `"tsup" no se reconoce como un comando interno o externo`, durante
  `git dep preparation failed`. Ver la decisión sobre `dist/` versionado.

## Bloqueos

Ninguno.

## Para revisar al volver

- Cuenta de GitHub en `gh` y nombre de git son distintos. La URL de instalación usa la cuenta de `gh`.
