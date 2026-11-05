# Estado del proyecto

Bitácora para retomar el trabajo solo con este archivo. Ver `CLAUDE.md` para el acuerdo.

## Fase actual

**Fase 6 — Publicación.** Fases 0 a 5 cerradas.

## Hecho

- **Fase 5:** `tools/live-run.ts` lanza la TUI, luego una sesión real de `claude -p` (`--max-budget-usd 2`), y compara
  la pantalla final con un conteo independiente del transcript. Última corrida: 5 herramientas, 2 consultas, 94,3k
  tokens leídos, 1 error marcado, salida con código 0 y terminal restaurada. Capturas `docs/capturas/vivo-*.png`.
  Se usaron tres sesiones reales de 2 USD de tope: la primera, de 0,59 USD, para la Fase 0, y dos de 0,63 y 0,45 USD en
  esta fase. Encontró y corrigió: el proceso no terminaba con stdin en pausa; el fin de turno separaba la consulta
  de su respuesta; y un error de la propia herramienta de medición, que contaba líneas `api-request-blob`.

  **Sin verificar:** una ventana real de terminal. Claude no puede verla en este equipo, y todo se comprobó con
  xterm.js. En Windows, además, no se probó la señal `SIGTERM`, porque ahí `kill()` no ejecuta manejadores.

- **Fase 4:** las nueve animaciones, cola, director y bucle real. Tiras de frames con reloj falso en
  `docs/capturas/anim-*.png`. El director mantiene `truth` y `shown`; un test comprueba que al vaciarse la cola
  coinciden con el reductor.

  Medición con `npx tsx tools/measure.ts`, en Windows 11 con Node 24, y salida hacia un `Writable` sin terminal real:

  | Medida | Resultado | Presupuesto |
  | --- | --- | --- |
  | Frame a 96x48 (p95) | 1,40 ms | menos de 8 ms |
  | Frame a 140x50 (p95) | 1,38 ms | menos de 8 ms |
  | Frame a 80x24 (p95) | 0,70 ms | menos de 8 ms |
  | Frecuencia con animación activa | 66,5 fps | 60 fps |
  | CPU en reposo, siguiendo una sesión | 2,7 % de un núcleo | menos de 5 % |
  | CPU en reposo, sin sesión y buscando en transcripts reales | 1,9 % de un núcleo | menos de 5 % |
  | Bytes durante la demo | 237 KB/s | sin presupuesto |
  | Bytes en reposo | 29 KB/s | sin presupuesto |

  **No medido:** el costo de una terminal real al dibujar esos bytes. La frecuencia baja sola con la contrapresión,
  pero solo se probó con una salida simulada.

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
- **`dist/` versionado y sin `prepare` (desviación de `CLAUDE.md`, a revisar):** con `prepare`, `npm install -g`
  desde git falla: el npm interno que prepara la dependencia hereda el modo global y no instala `tsup`, y npm 11
  además bloquea esos scripts en instalaciones globales (`allow-scripts`). `test/dist.test.ts` falla si `dist/`
  queda atrás: hay que ejecutar `npm run bundle` antes de cada commit que toque `src/`.
  **También sin un script `build`:** npm trata `build`, `prepare`, `prepack` y los de instalación como señal de que una
  dependencia de git necesita preparación. Con `build`, `npm install -g github:...` terminaba sin error, pero dejaba
  la carpeta sin `dist/` ni `package.json`, tanto en npm 11 como en npm 10. Por eso el script se llama `bundle`, y
  `test/dist.test.ts` falla si vuelve alguno de esos nombres.
- **Animaciones 2 y 3 en un solo commit:** la consulta al advisor es el primer uso de los paquetes y comparten el
  mismo código en el director. El resto va con un commit por animación.
- **Ritmo del bucle en Windows:** el temporizador avanza a saltos de unos 15,6 ms, así que `setTimeout(16,7)` daba
  32 fps. El bucle espera por tramos y, solo en Windows, acepta el frame en el salto más cercano.
- **Modo de prueba:** `SINAPSIS_FORCE_TTY=COLxFIL` dibuja hacia una salida que no es terminal y lee teclas de stdin;
  `SINAPSIS_COLOR=256`, `SINAPSIS_CRASH_AT_FRAME=N` y `SINAPSIS_EXIT_WHEN_DONE=1` sirven para las pruebas. No se
  documentan como uso normal.
- **Tarjetas terminadas:** se atenúan y conservan sus datos en lugar de desaparecer, para no borrar información.
  Un subagente nuevo reemplaza a una tarjeta terminada, y si las tres están activas, espera su turno.
- **`chokidar` 4 en vez de 6:** la versión 6 exige Node 22.22 o superior, y el acuerdo pide Node 20. La API usada es
  la misma.
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
- Fase 4, instalación con `prepare` tolerante: `npm warn allow-scripts sinapsis@0.1.0 (prepare: node scripts/prepare.mjs)`,
  y luego `node:internal/modules/cjs/loader:1520 throw err;` al ejecutar el comando: la carpeta instalada solo tenía
  `.git`. Lo mismo con `git+file://` sin `prepare`. Desde un tarball funciona.
- Fase 4, al aplicar un parche por consola: `/usr/bin/bash: -c: line 154: unexpected EOF while looking for matching`.
  No se ejecutó nada. Se hizo con las herramientas de edición.
- Fase 4, script de medición suelto: `Top-level await is currently not supported with the "cjs" output format`, y luego
  `ERR_UNSUPPORTED_ESM_URL_SCHEME: ... Received protocol 'c:'`. La medición pasó a `tools/measure.ts`.
- Fase 4, tests del comando empaquetado: `Error: Test timed out in 5000ms.` al salir con `q`. Era un defecto real: el
  proceso no terminaba con stdin en pausa. Corregido con una salida explícita.
- Fase 4, bucle: `RangeError: Maximum call stack size exceeded` con una frecuencia alta. Corregido.
- Fase 5, `tools/live-run.ts`: `SyntaxError: The requested module '@xterm/headless' does not provide an export named
  'Terminal'`, antes de lanzar la sesión. Sin gasto.
- Fase 5, comprobación: `FALLA total de herramientas en pantalla: 10` y `FALLA consultas en pantalla: 3`. La pantalla
  estaba bien (5 y 2): la herramienta contaba también las líneas `api-request-blob`.
- Fase 6, `tools/gif.ts`: `SyntaxError: The requested module 'gifenc' does not provide an export named 'GIFEncoder'`.
- Fase 6, instalación real desde GitHub: `Error: Cannot find module '...\node_modules\sinapsis\dist\cli.js'`
  (`MODULE_NOT_FOUND`), con npm terminando sin error. Era el script `build`. Ver Decisiones.
- Durante el desarrollo, varios fallos de tests propios, citados en el momento en la salida de la sesión.

## Bloqueos

Ninguno.

## Revisión de privacidad (Fase 6)

Se revisaron todos los blobs de todo el historial, con términos calculados en la máquina: usuario, correo, cuenta,
carpeta personal y nombres de otros proyectos, además de patrones de secretos. Sin hallazgos: las coincidencias con
carpetas de otros proyectos son palabras comunes del español. El nombre de la cuenta solo aparece en las URL del
repositorio. Las capturas se revisaron a la vista. `referencia/` nunca entró al historial.

## Para revisar al volver

- **Confirmar en una terminal real:** ejecutar `sinapsis demo` en una ventana de al menos 96x48. Es lo único que Claude
  no pudo mirar: fluidez, parpadeo, teclas, redimensionado y que al salir la terminal quede normal.
- **Correo en el historial:** los commits llevan el correo personal configurado en este repositorio, como se acordó.
  Al ser público, ese correo queda visible en cada commit.
- **`dist/` versionado y sin `prepare`:** ver Decisiones. Se aparta de lo que pedía `CLAUDE.md`.
- **Cuenta:** la de `gh` y el nombre de git son distintos. La URL de instalación usa la cuenta de `gh`.
- **Inferencias a validar con el uso:** los motivos de consulta y el agrupamiento en tres hitos del panel.
- **Fuera de alcance, como sugerencia:** comprobar en Linux y macOS, y un modo que muestre todas las consultas.
