# Estado del proyecto

Bitácora para retomar el trabajo solo con este archivo. Ver `CLAUDE.md` para el acuerdo.

## Fase actual

**Retoque visual funcional (2026-11-05), fusionado en `main` con la aprobación del usuario.** Probado por el usuario con subagentes reales en su terminal, con `replay`. Tras las correcciones posteriores (ver la sección siguiente) confirmó que "funciona perfecto", sin precisar si probó también el seguimiento en vivo con subagentes. No se creó tag: `v0.1.0` sigue apuntando al diseño anterior y `package.json` dice `0.1.0`. Se eliminaron todos los adornos de las imágenes de referencia que no tenían respaldo funcional (barra falsa de ventana con botones de colores, separador grueso, textos fijos de `PROJECT MEMORY`, filas vacías `—`, barra que rebota sin dato, `integrate + verify`, prompt falso con cursor parpadeante y estados repetidos en la línea inferior) y se sacó `AGENT MEMORY` del camino del tronco de delegación. Según informó el usuario, lo hizo con Gemini, así que no consta que pasara por `builder` ni `reviewer`. 309 tests comprobados de forma independiente con Claude Code.

## Retoque visual funcional (2026-11-05)

El usuario pidió revisar la interfaz de arriba a abajo y quitar o reemplazar todo lo que no tuviera una función o un dato real, aprobando los 22 puntos propuestos en la rama nueva `rediseno-funcional`:

- **Quitado por no tener función real:** barra falsa de ventana con botones rojo/amarillo/verde (1), separador grueso bajo el encabezado (3, su fila pasó al `session log`), textos fijos de `PROJECT MEMORY` (`saved findings…`, `per-agent notes…`, `build then debug…`) (5), rótulo suelto `read so far` (7), filas vacías `—` en `AGENT MEMORY` (14), `integrate + verify` en `back to lead` (19) y el prompt falso con comando reconstruido y cursor parpadeante (21).
- **Reubicado por lógica de datos:** `AGENT MEMORY` pasó a la izquierda del tronco (`26..55` en full), de modo que el tronco baja directo de la sesión principal al bus de las tarjetas sin atravesar el panel de memoria (13), y la fila de delegación muestra `N delegated · M done` a la derecha del tronco (`spine + 2`) sin interrumpir la línea `│` (16).
- **Datos reales en lugar de adornos:** encabezado con identidad de sesión `SINAPSIS · <carpeta> · <modo>` (2), leyenda con `agent memory` y `project memory` (4), hitos de `PROJECT MEMORY` con hora del primer disparo (6), bloque `totals` con `errors` siempre visible (8), lista real de archivos de memoria tocados con hora, agente y operación (9), advisor con capitalización normal, sufijo `tok` y borde punteado en `silent` / sólido en `replaying` (11, 12), pie de `AGENT MEMORY` en `dim` (15), barra de tarjetas en curso por `toolCount` real (`countBar`, 1 celda por herramienta) en vez de barra indeterminada (17), `waiting for N summaries` / `no summaries yet` en `back to lead` (19), línea de teclas reales `q quit · space pause · +/- speed` (21) y línea de estado con `elapsed`, `cost`, último evento y cola (22, lo que también resuelve el corte del grupo `advisor` a 90 columnas).
- **Correcciones tras la auditoría de `reviewer`:** hora de los hitos `repeat failure` y `before sign-off` en la fila inferior cuando no caben en la misma línea, hora compacta `m:ss` para `before work` en layout compacto (`80x30`, `120x30`), esquina `┐` de `AGENT MEMORY` preservada en compacto, reserva de espacio para los cuadros `■` de la cola en `drawStatus` aunque `last` sea largo (y sin duplicar el costo), y las 4 filas de totales visibles entre `repeat failure` y `before sign-off` en compacto de 30 filas.

## Prueba con subagentes reales y panel de memoria (2026-11-05)

Corrida de solo lectura con `builder`, `debugger` y `reviewer` en segundo plano, vista por el usuario en su terminal con `replay` (capturas locales en `referencia/pruebas/`, sin subir). El usuario la da por buena, y las tarjetas (7, 6 y 9 herramientas, `done`), `3 delegated · 3 done`, `back to lead 3/3` y la consulta del advisor coinciden con el transcript.

**`AGENT MEMORY` mostró `no memory` en los tres, y el usuario lo reportó.** Causa: esos subagentes no usaron ninguna herramienta sobre su memoria (0 de 22), en parte porque el prompt de la prueba les pidió no guardar. No es una falla de detección: con la sesión antigua `c390b003`, que sí tiene operaciones reales, el reductor cuenta lo mismo que un conteo independiente de `Read`, `Write`, `Edit` y `Glob` (builder 8, debugger 4, reviewer 6), y el panel dibuja `roles 3 / 3` con barras. Es la primera comprobación con datos reales, sobre el frame final y sin animar. Sigue sin haber un fixture con memoria de agente.

**Decisiones del usuario, ya implementadas:**

- **Memoria sin operaciones:** `indexed` si el subagente recibió un índice `MEMORY.md` con notas, `no memory` si no tiene y `no data` si el transcript no lo dice. Se pactó `index loaded`, pero no cabe en las 9 celdas de esa columna. El parser guarda solo sí o no. Comprobado contra una lectura independiente del prompt en los 23 subagentes reales de este proyecto, sin diferencias. `roles` cuenta `indexed` como memoria y deja fuera a los `no data`, porque sumarlos afirmaría un 0 que no se sabe. Si ningún rol tiene dato, dice `0 / 0`. El pie pasó a `bars · real tool calls`, porque `indexed` no es una herramienta.
- **Barra de tarjetas:** se reinicia antes de llenarse, y llena solo significa `done`.

**También corregido, sin decisión pendiente:**

- Leyenda sin modelo atribuido a `build` sin subagentes, y sin mezclar nombres completos y alias.
- Caja del advisor con consultas y tokens completos, también a 80x30 y 120x30, con el estado sobre el borde.
- De la revisión de `reviewer` sobre el retoque de Gemini: la hora de un hito pisaba `agents` o se perdía en compacto; la lista de archivos recortaba el nombre con horas de sesión; y README, `CLAUDE.md` y `docs/eventos.md` desfasados.

Una revisión acotada de `reviewer` sobre estas correcciones (`336e292`) no encontró defectos nuevos. Verificado: 321 tests y `tsc`, los tests nuevos de esas correcciones fallan con la escena anterior, y capturas y GIF regenerados. El usuario lo confirmó después en su terminal.

**Hallazgos de `reviewer` que se dejaron sin corregir, por menores:**

- Nombres de rol largos en `AGENT MEMORY` (`general-…`), con 9 celdas a 90x46.
- `memories` cuenta nombres de archivo: varios `MEMORY.md` de roles distintos suman 1. La lista tampoco dice de qué rol es cada uno, salvo en la línea de detalle.
- Barras de tarjetas de anchos distintos según `1 tool` o `3 tools`, `LIVE` en gris sin conexión y `elapsed` congelado entre eventos, porque es la hora del último evento y no el reloj.
- A 120x30 o 80x30, con alias que no caben, el modelo del advisor no aparece en ninguna parte.

**Sin decidir:**

- **Bash no se cuenta como memoria:** la sesión antigua tiene 5 comandos `Bash` que mencionan `agent-memory`. Quedan fuera del panel, como dice el README.
- **Fixture de esta corrida:** es la primera grabación real con subagentes en segundo plano y sigue sin entrar a `fixtures/`. El sanitizador borra `systemPrompt`, así que `indexed` seguiría sin poder probarse desde el repositorio.
- **Versión:** el diseño nuevo se instala desde `main` con el número `0.1.0`, igual que el tag anterior. Crear `v0.2.0` queda a decisión del usuario.

## Fase anterior (`rediseno-referencia`)

**Rediseño según las nuevas imágenes de referencia, en la rama `rediseno-referencia`, sin fusionar ni publicar.** Espera
que el usuario lo revise en su terminal. Fases 0 a 6 cerradas antes. Repositorio público:
https://github.com/LuisVillagran/sinapsis (tag `v0.1.0`, con el diseño anterior).

**Equipo de subagentes: Fase A terminada, en la misma rama, con carga y memoria probadas.** Espera que el usuario apruebe los ajustes de abajo
antes de empezar la Fase B.

**Corrección de lo que el usuario vio al probar (2026-11-05), en la misma rama.** Espera que lo confirme en su terminal.

## Para retomar (2026-11-05)

Todo está en `main`. Pendiente, en orden:

1. Confirmar el seguimiento en vivo con subagentes en una terminal real, si el usuario no lo probó ya.
2. Decisiones sin responder: limitar `reviewer` a cambios de código (recomendado) y poner el rol primero también en las cajas.
   El corte de `advisor` a 90 columnas ya se resolvió con la línea de estado del retoque.
3. Fase B, sin aprobar: `SendMessage` real, dos rondas y sanitizador que conserve solo nombres de archivo.

4. Propuesta sin aprobar, para que Sinapsis funcione con cualquier sesión en vez de exigir subagentes: (a) matriz de fixtures y
   tests: sin subagentes, integrados, roles propios, segundo plano y sin advisor, con la versión de Claude Code probada; la
   Fase B puede aportar parte; (b) pantalla útil sin subagentes (`no subagents`), sin revisar aún; (c) preset opcional
   `sinapsis init`. Descartado: un hook que bloquee `Edit` y `Write`. Recomendado: empezar por (a). (b) y (c) requieren aprobación.

`rediseno-referencia` ya está en GitHub, `rediseno-funcional` no; `main` sin cambios. Estos registros no pasaron por `reviewer`, para ahorrar tokens.

## Costo del flujo con subagentes (2026-11-05)

El usuario preguntó si usar subagentes con Opus 5.5 como principal hacía inútil el ahorro. Medido en una sesión real, a precios
de API y suponiendo que escribir en caché cuesta 1,25 veces la entrada: subagentes Sonnet ~$6,36, principal Opus ~$3,72 y
advisor Opus ~$1,77. Los mismos tokens de subagentes en Opus habrían costado ~$9,88. El ahorro total fue de cerca de 23%, no 50%,
porque leer de la caché cuesta igual en ambos modelos. No se midió la calidad ni una sesión igual sin subagentes.

**Decisión del usuario:** delegar en `builder` solo tareas grandes, y consultar al advisor solo para decisiones de diseño,
problemas que no convergen y antes de cerrar. La regla de pedir a `reviewer` que revise antes de terminar no cambió.

## Corrección tras la prueba del usuario (2026-11-05)

El usuario reportó que las tareas quedaban en `0/2` o `0/N`, y que Opus 5.5 aparecía como principal, advisor y lead.

- **Subagentes sin cerrar, corregido:** los de segundo plano terminan con `tool_use` `SubagentHandback`, no con `end_turn`. El
  test anterior suponía otra forma. Ahora se cierran con esa señal, y los totales llegan por `<task-notification>`.
- **Modelos, no era un error de datos:** esa sesión usa Opus 5.5 en ambos roles, según 88 líneas de `model`, `advisorModel` y
  la iteración `advisor_message`. El problema era nombrar por modelo. **Decisión del usuario:** leyenda y línea de estado con
  el rol primero. El encabezado no cambia.
- **`AGENT MEMORY`, decisión del usuario:** una fila por rol con datos reales. `roles` cuenta roles. La demo no cambia.
- **Consulta huérfana, encontrada al verificar:** un `server_tool_use` sin respuesta dejaba `replaying` pegado y contaba de más.
  Ahora se abandona con `advisor_abandoned`. El log lo rotula como inferido.

**Verificado:** 307 tests y `tsc`. Con el transcript real de esta sesión, en replay y con la TUI real en vivo hacia
`@xterm/headless`, durante 45 s a 120x30: `subagents [9/9]`, `advisor [silent]`, `roles 3 / 3`, código de salida 0 y terminal
restaurada. Primer trabajo real de `builder` y `reviewer`, ambos revisados de forma independiente.

**Sin verificar o pendiente:**

- **Ventana real de terminal:** sigue siendo lo que el usuario debe confirmar.
- **`debugger`:** todavía no corrige nada real.
- **Sin fixture:** la forma de segundo plano no está en `fixtures/`, los tests usan líneas sintéticas. La grabación de la Fase B
  debería llenar este vacío, pasando por el sanitizador.
- **Falla intermitente sin identificar:** una corrida de tests dio 286 de 287 en 389 s, cuando lo normal son 56 s. La salida se
  recortó y no se sabe cuál falló. No se repitió en las tres corridas posteriores que se comprobaron. Si reaparece, delegar en `debugger`.
- **Línea de estado a 90 columnas:** el grupo `advisor` no cabe en estados comunes, por ejemplo con `lead [working]`, `subagents
  [11/11]`, `memories [agent]` y `build [idle]`, aunque `CLAUDE.md` lo incluye. Ya pasaba antes y la caja del advisor sigue
  mostrando su estado. Una opción es no reservar lugar para `N queued` con la cola vacía. Lo decide el usuario.
- **Última ronda de correcciones:** las cuatro correcciones tras la revisión de `reviewer` se comprobaron con tests y a mano, sin
  una segunda revisión suya.
- **Subagente reanudado:** con `SendMessage`, uno cerrado no se reabre. Hay que resolverlo en las fases B o C.
- **Capturas y GIF de `docs/` y del README:** muestran los rótulos anteriores. Regenerarlos antes de publicar.
- **`reviewer` escribió un archivo:** creó y borró un test temporal en `test/`, pese a la orden de no modificar archivos. Lo
  declaró y no quedó rastro. Bloquear `Edit` y `Write` no evitaría esto del todo, porque también tiene `Bash`. Lo decide el usuario.

## Equipo de subagentes (2026-11-05)

El usuario pidió trabajar con `builder`, `debugger` y `reviewer`, y que Sinapsis los muestre por su rol, en tres fases con
aprobación. Quiere **ver cómo se comunican**.

**Orden real del trabajo:** primero el rediseño, que adelantó parte de la Fase C (C1, C3 y C4). Después la Fase A. Faltan la
Fase B y el resto de la Fase C.

**Fase A, hecha:** `.claude/agents/`, sección de flujo en `CLAUDE.md`.

**Verificado tras reiniciar, en dos rondas de ejecuciones reales:**

- Los tres cargan y completan una tarea corta de solo lectura. `reviewer` encontró hallazgos reales en el último commit.
- Ninguno reporta herramientas `mcp__*`, y la lista de agentes tampoco las muestra.
- Los tres guardan notas en `.claude/agent-memory/<rol>/`, que git ignora, y las recuperan en una ejecución nueva. El índice
  `MEMORY.md` llega en el prompt de sistema, sin llamar a una herramienta. La nota se leyó con `Read`.
- El rol queda en `subagents/agent-*.meta.json`, como `agentType`.
- Las notas de prueba se borraron después. Las carpetas de memoria quedaron vacías.

**Sin verificar:** implementación o corrección reales con `builder` y `debugger`, y `SendMessage` entre subagentes.

**A tener en cuenta:** según sus reportes, los tres tienen `Bash`, `Edit`, `Write`, `Agent` y `Artifact`. En `reviewer`, no
modificar código depende solo de sus instrucciones.

Agregados al prompt original: `disallowedTools: mcp__*`, para que no hereden Gmail ni otros conectores;
`.claude/agent-memory/` en `.gitignore`, porque el repositorio es público; la orden de completar la tarea antes de guardar
memoria, por el problema reportado en anthropics/claude-code#55648; `npm run bundle` en builder y debugger; y una nota de
que el modo autónomo de la sección 1 no impide detenerse por fases.

**Ajustes propuestos para las fases B y C, sin aprobar:**

- **Fase B, comunicación:** incluir un `SendMessage` real entre subagentes y documentar cómo queda en el transcript. Según
  la documentación, se puede. Sin observarlo no se puede mostrar.
- **Fase B, recuperar memoria:** hacer dos rondas. La primera no tiene notas que leer. Además, `MEMORY.md` se inyecta en
  el prompt de sistema (ya observado), así que lo que un agente sepa solo por el índice no aparece como herramienta.
- **Fase B, fixture:** el sanitizador borra el adjunto `instructions`. Decidir si conserva solo nombres de archivo.
- **Fase C, adelantado en el rediseño:** nombres por rol y modelo real (C1), panel `AGENT MEMORY` (C3) y rol en el log (C4).
  Falta probarlos con datos reales, que recién entrega la Fase B.
- **Fase C, eventos:** hoy la memoria viaja como `tool_call.memory`. Emitir además `memory_recall` y `memory_save` duplicaría
  animaciones si no se reemplaza ese campo.
- **Fase C, faltante:** el prompt no pide mostrar la comunicación. Agregar paquetes entre agentes para `SendMessage`.
- **Fase C, error falso:** leer un `MEMORY.md` que aún no existe da error y activaría `repeat failure`. Excluirlo.

## Rediseño (2026-11-05)

El usuario entregó `referencia/Referencia (1..4).jpeg` y pidió apegarse a su estilo y tener todos los apartados
conectados, con animación en los caminos. La parte de abajo no le aparecía porque el diseño completo exigía 48 filas, y
una ventana más baja caía en un layout reducido sin conectores. **Esto reemplaza lo que este archivo dice más abajo sobre
el panel del advisor, las métricas y la geometría.** La sección 6 de `CLAUDE.md` ya está actualizada.

**Decisiones del usuario, tomadas con preguntas directas:**

- Dos tamaños: fiel desde 90x46, y compacto con todos los apartados desde 80x30.
- Advisor en una caja junto a la sesión principal: la referencia no lo incluye.
- Datos reales en vivo y en replay. Solo `sinapsis demo` muestra `%` y actividad de memoria de ejemplo, rotulados.
- **Sin grabar una sesión nueva con `builder`, `debugger` y `reviewer`:** primero aceptó y luego lo cambió. No se gastó
  dinero. La demo sigue mostrando subagentes `Explore`, y los nombres de la imagen solo aparecen si una sesión los usa.

**Decisiones propias, para revisar:**

- **Se quitó el panel de distribución de herramientas**, porque la referencia no lo tiene. Quedan el total en
  `PROJECT MEMORY`, el contador por tarjeta y el log. También salieron de pantalla `routine turns` y el texto que seguía
  al consejo, y la línea de tiempo de motivos pasó al log.
- **La demo corre en bucle**, con 9 s de pausa al final, en que la actividad de ejemplo se detiene. No estaba pedido, pero sin esto queda quieta tras unos 35 s.
- **Los tres hitos son inferidos**, con reglas en `docs/eventos.md`. `repeat failure` se activa con un solo error, no
  con uno repetido.
- **Textos fijos de la imagen en `PROJECT MEMORY`** ("saved findings…", "build then debug…"): son una explicación general
  de la memoria y no datos de la sesión, igual que antes "reads the whole session". `build then debug` describe un flujo
  que una sesión real puede no seguir.
- **`integrate + verify`** se muestra en el lead mientras no vuelve ningún resumen, como descripción de lo que hará.
- **El advisor lleva un color propio** (`#e59ad8`) y los errores van más al rojo (`#f0695a`), porque en la referencia el
  naranjo es del modelo principal y el púrpura, de la memoria.

**Verificado:**

- 260 tests. La geometría del layout completo coincide con lo medido en las imágenes, en `test/layout.test.ts`.
- En 370 tamaños entre 80x30 y 240x70, los paneles no se pisan, caben, y cada camino parte y llega a su panel.
- **Sesión interactiva real, seguida a 120x30** con la salida en un emulador: fue esta misma sesión de trabajo. Mostró
  todos los apartados, detectó el `CLAUDE.md` cargado al iniciar, 166 herramientas y 1 error, y salió con código 0. Es la
  primera vez que se prueba con una sesión interactiva.
- El fixture real detecta la lectura de `CLAUDE.md` en el subagente que la hizo.

**Sin verificar:**

- Una ventana real de terminal. Sigue pendiente, y es lo que el usuario debe confirmar.
- `.claude/agent-memory/`: ningún fixture la usa. La regla de Sinapsis se probó solo con líneas de prueba, aunque las
  pruebas de la Fase A ya generaron transcripts reales que la usan.
- El adjunto `instructions` no llega a los fixtures, porque el sanitizador lo borra: se probó con líneas de prueba y con
  la sesión real de arriba.
- `tools/live-run.ts`: se adaptó a la pantalla nueva, pero no se ejecutó porque lanza `claude -p`, con costo. Por eso se
  borraron las capturas `vivo-*`, que mostraban el diseño anterior.

Medición con `npx tsx tools/measure.ts`, en Windows 11 con Node 24, y salida hacia un `Writable`. Los bytes bajan porque
el fondo plano evita los cambios de color por celda:

| Medida | Resultado | Presupuesto |
| --- | --- | --- |
| Frame a 90x47 (p95) | 0,89 ms | menos de 8 ms |
| Frame a 140x50 (p95) | 0,85 ms | menos de 8 ms |
| Frame a 80x24 (p95) | 0,44 ms | menos de 8 ms |
| Frecuencia con animación activa | 63,2 fps | 60 fps |
| CPU en reposo, siguiendo una sesión | 2,1 % de un núcleo | menos de 5 % |
| CPU en reposo, sin sesión | 1,2 % de un núcleo | menos de 5 % |
| Bytes en replay a 90x47 | 42,6 KB/s | sin presupuesto |
| Bytes en reposo | 5,8 KB/s | sin presupuesto |

Diferencias que quedan frente a la referencia, y por qué:

- **Barra de ventana:** la imagen la tiene aparte de sus 46 filas. Aquí se dibuja solo si hay una fila 47.
- **Sin `%` fuera de la demo, y otros nombres y modelos:** son datos de cada sesión.
- **Caja del advisor:** agregada en el espacio vacío a la derecha de la sesión principal.
- **Una fila de memoria parada:** en sesiones reales, `AGENT MEMORY` casi no se mueve.
- **Sin brillo real:** los paneles encendidos llevan un halo de fondos tintados.
- **Layout compacto:** con menos filas, los títulos de los paneles van sobre su borde y las tarjetas juntan nombre y
  modelo en una línea.

Iteraciones de comparación con la referencia: cuatro. Corrigieron la columna de hitos, los cuadros de fondo de los
paquetes, los halos excesivos, la leyenda apretada, los recortes en 80x30 y la barra vacía de las tarjetas terminadas.

Sugerencias, fuera de lo pedido: grabar la sesión con esos tres agentes si se quiere verlos en la demo, y conservar la
distribución de herramientas en algún espacio libre si se echa de menos.

## Hecho antes del rediseño

- **Fase 6:** README, licencia MIT, GIF de demo y revisión de privacidad del historial. Verificado: clon limpio desde
  GitHub con `npm ci`, `npm test` y build; instalación con `npm install -g --prefix <tmp> github:LuisVillagran/sinapsis`
  en npm 11 y npm 10; el comando instalado responde a `--version` y su `demo` llega al estado real a través de un
  emulador, y termina restaurando la terminal. Node 20.20 comprobado sin instalarlo en el sistema, con `npx -p node@20`.

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
repositorio. Las capturas se revisaron a la vista. `referencia/` nunca entró al historial. La identidad global de git,
distinta de la local, tampoco aparece: 0 coincidencias en 203 blobs de texto y binarios omitidos.

## Para revisar al volver

- **Terminal real:** el usuario confirmó el rediseño en Git Bash, en Windows 11. Claude no puede mirar esa ventana, así
  que fluidez, parpadeo, teclas y redimensionado dependen de esa confirmación.
- **Autor de las imágenes nuevas:** el README lo declara sin confirmar. Corregir el crédito si se conoce.
- **Correo en el historial:** los commits llevan el correo personal configurado en este repositorio, como se acordó.
  Al ser público, ese correo queda visible en cada commit.
- **`dist/` versionado y sin `prepare`:** ver Decisiones. Se aparta de lo que pedía `CLAUDE.md`.
- **Cuenta:** la de `gh` y el nombre de git son distintos. La URL de instalación usa la cuenta de `gh`.
- **Detalle cosmético conocido:** durante los primeros 1,6 s de `demo`, la barra de ventana dice `no session`. El
  encabezado ya muestra los modelos.
- **Sin verificar además:** teclas en modo raw de una terminal real, y Node 20 anterior a 20.20.
- **Inferencias a validar con el uso:** los motivos de consulta y el agrupamiento en tres hitos del panel.
- **Fuera de alcance, como sugerencia:** comprobar en Linux y macOS, y un modo que muestre todas las consultas.
