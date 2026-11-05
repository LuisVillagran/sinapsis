# Sinapsis — visor animado de consola para el modo advisor de Claude Code

Sinapsis es una **aplicación de consola (TUI)** que muestra qué hace cada modelo en una
sesión de Claude Code con advisor: el modelo principal ejecutando herramientas, los
subagentes trabajando y las consultas al advisor. Se instala desde el repositorio público
de GitHub.

**La prioridad es que se vea muy animada y fluida.** La fidelidad visual y la animación
importan más que agregar funciones.

---

## 1. Modo de trabajo: autónomo

> **Aviso:** esta sección describe el desarrollo inicial, ya terminado. Antes de aplicarla, leer
> [Vigencia de la sección 1](#vigencia-de-la-sección-1), al final de este documento.

El usuario no estará disponible durante el desarrollo y no podrá aceptar permisos ni
responder preguntas. Este documento es el acuerdo completo y reemplaza a cualquier
versión anterior.

- **Trabajar de corrido hasta terminar la Fase 6.** No detenerse a pedir aprobación ni
  terminar el turno entre fases. Cerrar una fase es verificar sus criterios y seguir.
- **No hacer preguntas.** Si surge una duda, elegir la opción más simple y reversible
  que respete este documento, y registrarla en `docs/estado.md`.
- **Las aprobaciones se reemplazan por criterios objetivos.** Cada fase tiene criterios
  de cierre (sección 8). Una fase no se cierra si alguno falla.
- **`docs/estado.md` es la bitácora.** Actualizarlo y hacer commit al cerrar cada fase y
  antes de cualquier tarea larga, de modo que una sesión nueva pueda retomar solo con este
  archivo. Contiene: fase actual, qué está hecho, decisiones tomadas, bloqueos y qué
  debe revisar el usuario al volver.
- **Si algo bloquea una parte:** intentar una alternativa razonable, registrarlo y seguir
  con lo demás. Nunca fingir que algo funciona: lo no verificado se declara como tal.
- **Consultar al advisor** solo para decisiones de diseño, cuando un problema no converge y
  antes de cerrar una fase o una tarea larga. No como rutina ni en tareas cortas.

### Qué está autorizado sin preguntar

- Crear, editar y borrar archivos dentro de este repositorio.
- Instalar dependencias del proyecto con npm.
- Crear ramas, hacer commits y fusionar en `main`.
- Leer los transcripts de `~/.claude/projects/` para fixtures y pruebas.
- Lanzar sesiones reales y cortas de Claude Code (`claude -p`) para obtener datos y
  probar. El usuario no fijó un tope de gasto; aun así, deben ser pocas y de solo lectura
  sobre este repositorio, cada una con `--max-budget-usd 2` o menos.
- Crear el repositorio público `sinapsis` en la cuenta de GitHub con sesión iniciada en
  `gh`, hacer push y crear tags y releases.

### Qué no se debe hacer

- Modificar `~/.claude/settings.json`, la configuración global de git o cualquier
  configuración del sistema. Para probar hooks, usar `claude --settings <archivo-temporal>`.
- Instalar software a nivel de sistema, como Rust, o usar `npm install -g` sin `--prefix`
  hacia una carpeta temporal.
- `npm publish`, borrar repositorios o forzar push después del primer push.
- Tocar otros proyectos o sus archivos.
- Subir datos privados (ver sección 9).

---

## 2. Decisiones pactadas

| Tema | Decisión |
| --- | --- |
| Tipo de producto | App de consola. **Se descartan** React, Motion, SVG, Tailwind, Vite, WebSocket y Tauri |
| Distribución | `npm install -g github:<usuario>/sinapsis`, comando `sinapsis`. Sin publicar en npm |
| Consultas al advisor | Replay honesto más investigación de hooks (sección 3) |
| Motivo de la consulta | Inferido con reglas y marcado como inferido |
| Último consejo | Está cifrado. Se muestran duración y tokens (sección 3) |
| Datos sin fuente real | No se inventan. Se reemplazan o se omiten |
| Sesiones reales | Las lanza Claude de forma autónoma con `claude -p` |
| Identidad de git | Configurada solo en este repositorio, con el correo personal del usuario |
| Imágenes de referencia | `referencia/Referencia (1..4).jpeg` son frames de una misma animación, de autoría sin confirmar: no se suben al repositorio. El README da crédito a `@skunzu` en X por la primera inspiración |
| Advisor frente a la referencia | La referencia no lo incluye. Se conserva en una caja junto a la sesión principal, decidido por el usuario |
| Datos sin fuente en la referencia | `%` de las tarjetas y actividad de `AGENT MEMORY`: reales en vivo y en replay. Solo `sinapsis demo` muestra valores de ejemplo, rotulados como ilustrativos, decidido por el usuario |
| Licencia | MIT |
| Rama principal | `main`, con una rama por fase fusionada al cerrarla |

---

## 3. Qué dicen los datos reales

El detalle está en `docs/eventos.md`. Esto condiciona todo el diseño:

- **Detectable:** consultas al advisor (`server_tool_use` con `name: "advisor"`, y
  `advisor_tool_result`), su duración, sus tokens (`usage.iterations` con
  `type: "advisor_message"`), herramientas, errores, modelos y effort.
- **No existe:** el motivo de la consulta (`input` vacío) y el texto del consejo
  (`advisor_redacted_result` cifrado).
- **Sin observar todavía:** subagentes (se resuelve al cerrar la Fase 0).
- **Sin avance real conocido:** el porcentaje y los contadores de las tarjetas de subagente.

### Tiempo real: la consulta solo se conoce después

Las líneas de un mensaje se escriben al terminar ese mensaje de la API. Una consulta de
171,6 s llegó a disco 174 s tarde, junto con su respuesta. Por lo tanto:

- **En vivo:** `api-request` llega en unos 100 ms y permite mostrar `working`, pero no
  distingue si el modelo genera texto o consulta al advisor. **No mostrar
  "waiting on advisor" en vivo salvo que los hooks den una señal real.**
- **Al llegar el lote:** se reproduce la ida y vuelta del advisor. La animación se
  **comprime** a entre 1,5 y 5 s, y la duración real se muestra como dato (`171 s`).
  Reproducirla a tiempo real bloquearía la cola durante minutos.
- **Hooks:** se investigan en la Fase 0. Solo se usan si aportan una señal real.

---

## 4. Producto

### Comandos

```text
sinapsis                         Sigue la sesión activa más reciente
sinapsis --session <id>          Sigue una sesión concreta
sinapsis --project <carpeta>     Sigue la sesión más reciente de esa carpeta
sinapsis replay <archivo> [--speed N]   Reproduce un transcript guardado
sinapsis demo                    Reproduce el fixture incluido
sinapsis hooks install|uninstall Solo si la Fase 0 demuestra que los hooks aportan
sinapsis --help | --version
```

Teclas: `q` o `Ctrl+C` para salir; en replay, `espacio` pausa y `+` / `-` cambian la velocidad.

### Comportamiento en la terminal

- Usa la pantalla alternativa, oculta el cursor y **siempre restaura la terminal** al salir,
  también ante errores y señales.
- Se adapta al redimensionar.
- **Layout completo desde 90x46**, con la barra falsa de ventana si hay una fila más.
- **Layout compacto desde 80x30:** los mismos apartados, conexiones y paquetes, en menos filas. Es el que se ve en una
  ventana normal, de unas 120x30.
- Entre 80x24 y 80x30, un resumen en texto que avisa cómo ver la escena completa. Por debajo, un mensaje pidiendo
  agrandar la ventana.
- Color truecolor con caída a 256 colores. Si la salida no es una TTY, termina con un mensaje claro.
- Sin sesión activa, muestra el panel en reposo y espera, sin fallar.

---

## 5. Arquitectura

Un solo proceso, sin servidor ni navegador:

```text
transcript .jsonl ─► fuente (tail / replay) ─┐
hooks (opcional)  ─► fuente HTTP local ──────┤
                                             ▼
            parser ─► eventos normalizados ─► estado de sesión
                                             ▼
                              cola de animación ─► escena ─► buffer de celdas
                                                                  ▼
                                                     diff ANSI ─► terminal
```

| Parte | Tecnología |
| --- | --- |
| Lenguaje | TypeScript, ESM, Node 20 o superior |
| Empaquetado | `tsup` a `dist/`, con `prepare` para instalar desde git |
| Seguimiento de archivos | `chokidar`, leyendo por offset y tolerando líneas parciales |
| Render | **Motor propio de buffer de celdas.** Se descarta Ink: su ciclo de layout y re-render no sirve para animar celda por celda |
| Tests | Vitest |
| Verificación visual (solo desarrollo) | `@xterm/headless` y `xterm` en Chrome instalado vía Playwright (`channel: 'chrome'`) |
| GIF de demo (solo desarrollo) | `gifenc` |

Dependencias de ejecución al mínimo: no agregar nada que no sea necesario.

```text
src/
  cli.ts              Argumentos y arranque
  core/               Parser, eventos, estado de sesión. Sin E/S
  sources/            tail, replay, descubrimiento de sesiones, hooks
  engine/             Reloj, cola, easing, tweens
  tui/                Buffer, color, diff ANSI, terminal
  scene/              Layout y paneles
tools/                Capturas PNG y GIF (no se distribuyen)
test/
fixtures/
docs/
```

**Reglas de diseño del código:**

- `core/` y `engine/` son puros y testeables.
- El reloj es inyectable: cada frame debe poder reproducirse de forma determinista para
  capturas y tests.
- Solo el diff ANSI escribe a la terminal.

---

## 6. Diseño visual

`referencia/Referencia (1..4).jpeg` es la referencia: frames de una animación en una terminal de **90x46**, con la barra
de ventana aparte. Consultarla y compararla en cada iteración.

### Limitaciones de una terminal

No se puede imponer la fuente ni crear un glow real, y la unidad mínima es la celda.

| En la imagen | En la terminal |
| --- | --- |
| Glow de un panel encendido | Borde brillante más halo: celdas vecinas con fondo tintado tenue |
| Trazos finos | `─ │ ┌ ┐ └ ┘ ┼` |
| Línea punteada | `┄ ╎ ╌` |
| Fondo | Plano, sin viñeta |
| Fade | Interpolar el color hacia el fondo |
| Escala | Caja que crece desde su centro, celda a celda |
| Riel de una barra | `░` tenue |
| JetBrains Mono | Recomendada en el README, no se puede imponer |

### Colores

Valores en `docs/colores.md`, muestreados con `tools/sample-colors.ts`.

| Token | Uso | Valor |
| --- | --- | --- |
| `bg` | Fondo y paneles | `#191e24` |
| `main` | Modelo principal, sesión y lead | `#e38d63` |
| `sub` | Subagentes y sus barras | `#81b0f6` |
| `metrics` | Memoria de agentes | `#77ce9b` |
| `notes` | Memoria de proyecto | `#af9eec` |
| `advisor` | Advisor, que no está en la referencia | `#e59ad8` |
| `alert` | Errores y reintentos | `#f0695a` |
| `text` / `dim` | Texto / secundario | `#dfe3ea` / `#8b909b` |

### Geometría del layout completo (columna, fila; desde 0)

Medida sobre las imágenes, a 8 px por columna y 18,36 px por fila, contando desde el encabezado. La verifica
`test/layout.test.ts`.

| Elemento | Columnas | Filas |
| --- | --- | --- |
| Barra falsa de ventana, si cabe | todas | -1 |
| Encabezado | centrado | 0 |
| Separador | 3–87 | 1 |
| Leyenda | repartida | 2 |
| Project memory | 3–23 | 3–36 |
| Sesión principal | 44–70 | 3–8 |
| Advisor (punteado) | 74–87 | 3–8 |
| Agent memory | 36–78 | 11–17 |
| Texto "delegate to subagents" | centrado en 57 | 19 |
| Bus hacia las tarjetas, y flechas | 36–78 | 21 y 22 |
| Tarjetas de subagente | 26–45, 47–66, 68–87 | 23–29 |
| Bus de regreso, y flecha | 36–78 | 31 y 32 |
| Back to lead | 41–73 | 33–36 |
| Session log | 3–87 | 38–43 |
| Línea de prompt | 0–89 | 44 |
| Línea de estado | 0–89 | 45 |

### Contenido de cada elemento

| Elemento | Contenido |
| --- | --- |
| Encabezado | `CLAUDE CODE ADVISOR · <PRINCIPAL> LEADS · <SUBAGENTES> BUILDS`, con modelos reales |
| Leyenda | Cuadros de color: lead, build, memories, notes, advisor |
| Project memory | Alcance real, hitos `before work`, `repeat failure` y `before sign-off` con flechas a la sesión, a la primera tarjeta y al lead, último agente y archivo, y totales de agentes, memorias, herramientas y errores |
| Sesión principal | Modelo, tarea (`ai-title` o último prompt), medidor de effort y actividad con spinner, o `--model` en reposo |
| Advisor | Modelo, estado (`silent` o `replaying`), consultas y tokens leídos |
| Agent memory | `roles` con memoria sobre el total, y una fila por rol: nombre, barra según sus operaciones y `recall`, `check` o `save`. Pie `memory · real tool calls`, o `illustrative activity` en la demo |
| Tarjetas | Nombre, modelo, `read-only` si corresponde, barra con contador de herramientas, descripción y estado. **Sin porcentaje inventado:** barra indeterminada en vivo |
| Back to lead | `back to <modelo> · lead` y resúmenes recibidos |
| Session log | Tiempo desde el inicio, agente, evento |
| Prompt | Comando reconstruido desde los modelos reales, con cursor parpadeante. No se presenta como literal |
| Línea de estado | Cada rol con su estado entre corchetes (`lead`, `subagents`, `memories`, `build` y `advisor`), y eventos en cola con cuadros de color |

**No copiar** valores de ejemplo de las imágenes: `~/app`, `SUBAGENT TIP`, `builder`, `Sonnet 5.5`, `integrate + verify`
como dato, tiempos del log. Los nombres de agentes y modelos salen de cada sesión.

---

## 7. Animaciones (lo más importante)

Implementarlas una por una, en este orden:

1. **Arranque:** los bordes se dibujan solos recorriendo cada panel; el encabezado aparece
   como máquina de escribir; los paneles entran en cascada.
2. **Paquetes:** cada evento recorre su camino por los conectores. Un punto brillante con estela
   que se desvanece, avanzando con precisión de subcelda donde sea posible.
3. **Consulta al advisor:** la caja se ilumina con pulso, un paquete de ida y otro de vuelta,
   y el motivo inferido se escribe en el log. Una lectura de memoria dispara el paquete de su hito y enciende su fila,
   y si fue un subagente, también su tarjeta.
4. **Subagentes:** las tarjetas crecen desde su centro con fade, sus barras se llenan y al
   terminar se desvanecen enviando su resumen a "back to lead", con el conector encendido.
5. **Contadores** que suben número a número; **barras** que crecen con easing.
6. **Log:** las líneas entran deslizándose, con texto de máquina de escribir.
7. **Spinners** en cada elemento activo y cursor parpadeante.
8. **Reposo:** respiración sutil de los bordes para que nunca se vea muerto.
9. **Errores:** destello naranjo en el panel y el log.

### Cola de animación

- Los eventos llegan en lotes, con retrasos de hasta minutos. Se encolan y cada uno tiene una
  **duración mínima visible** (punto de partida: 350 ms; paquete: 400 a 700 ms).
- Si la cola crece, se acelera de forma gradual y se agrupan herramientas consecutivas.
- **Nunca se descartan** consultas al advisor, subagentes ni errores.
- Las animaciones no se superponen de forma caótica en un mismo conector.

### Rendimiento

- El bucle apunta a **60 fps** y baja de forma adaptativa, hasta 30, si la terminal no da abasto
  (`stdout` con contrapresión). `--fps` permite fijarlo.
- Se escriben solo las celdas que cambian, con actualización sincronizada (`CSI ? 2026`) para evitar parpadeo.
- Presupuesto: calcular un frame en **menos de 8 ms (p95)** a 90x46.
- En reposo, consumir poca CPU: menos del 5 % de un núcleo como meta.

---

## 8. Fases y criterios de cierre

Cada fase va en su rama, con commits pequeños, y se fusiona a `main` al cumplir sus criterios.

### Fase 0 — Cerrar el reconocimiento

Ya hecho: `docs/eventos.md`, sanitizador y primer fixture. Falta:

1. Lanzar una sesión real con el prompt de `docs/eventos.md`. Con `claude -p`, `--model haiku`,
   `--advisor opus`, `--max-budget-usd 2` y solo herramientas de lectura más `Agent`.
2. En esa misma sesión u otra, usar `--settings` con un archivo temporal para registrar todos
   los hooks relevantes (`PreToolUse`, `PostToolUse`, `PostToolBatch`, `SubagentStart`,
   `SubagentStop`, `Stop`, `SessionEnd`) y comprobar si alguno ve al advisor.

**Criterios:**

- `fixtures/sesion-haiku-advisor-opus.jsonl` sanitizado y sin datos privados.
- `docs/eventos.md` responde cómo aparecen los subagentes, si Haiku consulta igual que Opus,
  si hay algún dato de avance y si los hooks detectan al advisor.
- Lo que siga sin observarse queda declarado.

### Fase 1 — Parser y modelo de eventos

Convierte líneas en eventos normalizados: `session_start`, `request_start` (de `api-request`),
`tool_call`, `tool_result`, `subagent_start`, `subagent_end`, `advisor_consult`, `advisor_reply`,
`turn_end`, `session_end`. Más un reductor que calcula el estado de sesión.

**Criterios:**

- Tests de Vitest pasan sobre todos los fixtures.
- Cubren las trampas de `docs/eventos.md`: tokens por `message.id`, `is_error` opcional,
  `<synthetic>`, compactación, tipos desconocidos ignorados y líneas inválidas sin fallar.
- Los totales del reductor coinciden con un conteo independiente del fixture.
- Motivo inferido testeado para cada regla.

### Fase 2 — Fuentes de eventos

Seguimiento en vivo, descubrimiento de sesiones, replay con velocidad configurable y hooks
solo si la Fase 0 los justifica. Incluye un modo sin interfaz que imprime eventos.

**Criterios:**

- Test de extremo a extremo: agregar líneas, incluso partidas, a un archivo temporal emite los
  eventos correctos, sin duplicados ni pérdidas.
- Aclarar si el retraso observado en Windows depende de `stat`, y dejarlo documentado.
- Replay respeta el orden y la velocidad configurada, con reloj falso.

### Fase 3 — Maqueta estática

Todo el layout con datos fijos, sin animación. Herramienta `tools/snapshot` que renderiza un
frame a PNG a través de xterm con JetBrains Mono.

**Criterios:**

- Capturas en `docs/capturas/`, comparadas visualmente con la referencia leyendo ambas imágenes.
- Geometría dentro de la tolerancia, verificada por test sobre el buffer.
- Colores muestreados de la imagen.
- Al menos tres iteraciones de comparación y ajuste. Registrar las diferencias que queden y por qué.
- Layout reducido y mensaje de ventana pequeña verificados con capturas a 80x24 y 60x20.

### Fase 4 — Animaciones

Una por una según la sección 7, con un commit por animación, usando replay.

**Criterios:**

- Secuencias de capturas con reloj falso muestran cada animación en sus etapas.
- Tests de easing, tweens y cola: duración mínima, aceleración con cola larga, nada importante se descarta.
- Medición registrada en `docs/estado.md`: tiempo por frame (p95), bytes por segundo y CPU en reposo.
- Cumple los presupuestos de la sección 7, o queda documentado por qué no.
- Ninguna animación borra datos: el estado final coincide con el del reductor.

### Fase 5 — Integración en vivo

Conectar a una sesión real de `claude -p` lanzada de forma autónoma, ejecutando la TUI con su
salida conectada a `@xterm/headless`.

**Criterios:**

- La sesión real se ve de principio a fin en la TUI, sin errores, y se guardan capturas.
- Los eventos coinciden con el transcript resultante.
- La terminal queda restaurada al salir: comprobar secuencias de salida, también con errores forzados.
- Corregir lo que no calce y agregar el caso a los tests.

**Límite conocido:** Claude no puede mirar una ventana real de terminal en este equipo. Declarar en
`docs/estado.md` que el usuario debe confirmarlo en su terminal al volver.

### Fase 6 — Publicación

1. `package.json` con `bin`, `engines`, `files` y `prepare`. `sinapsis demo` debe funcionar
   instalado, así que su fixture se incluye en el paquete.
2. `LICENSE` MIT y README en español: qué es, instalación, uso, cómo se obtienen los datos,
   limitaciones honestas, capturas, GIF y crédito de la inspiración.
3. Revisión de privacidad de todo lo que se va a publicar, **incluido el historial de git**.
4. Crear el repositorio público, hacer push de `main` y crear el tag `v0.1.0`.

**Criterios:**

- `npm test` y el build pasan en un clon limpio.
- Instalación real **desde GitHub** en una carpeta temporal con `npm install -g --prefix <tmp>
  github:<usuario>/sinapsis`; `sinapsis --version` y `sinapsis demo` funcionan, usando la salida
  hacia xterm headless. Limpiar después.
- El README se corresponde con lo que existe.

**Si no se puede publicar** (por ejemplo, `gh` sin sesión): dejar todo listo y escribir en
`docs/estado.md` los comandos exactos para que el usuario lo haga.

### Fin del proyecto

Consultar al advisor, actualizar `docs/estado.md` y terminar con un informe:
qué se hizo, enlace al repositorio, cómo probar, qué quedó sin verificar y qué decisiones debe
revisar el usuario.

---

## 9. Reglas

- Commits pequeños y descriptivos por cada avance, en español. Código y comentarios claros;
  README en español.
- **Honestidad de datos:** si un detalle visual no tiene dato real, proponer una alternativa
  honesta en vez de inventarlo. Lo inferido se rotula como inferido.
- **Privacidad:** el repositorio es público.
  - Todo transcript pasa por `scripts/sanitize-fixture.mjs` antes de entrar a `fixtures/`, y luego
    se busca manualmente si quedó algo privado. `fixtures/raw/` nunca se sube.
  - No escribir en el repositorio datos personales: correos, rutas personales, nombres de otros
    proyectos, identificadores de cuenta.
  - `.claude/settings.local.json` y `referencia/` no se suben.
- **Formato de transcripts sin documentar:** ignorar tipos y campos desconocidos sin fallar.
- **Alcance:** no agregar funciones fuera de este documento. Si una idea parece valiosa, anotarla en
  `docs/estado.md` como sugerencia.

---

## Flujo de trabajo con subagentes

- Planifica y divide la tarea. Delega en builder solo las tareas grandes, las que requieren investigar o iterar con tests.
  Un cambio pequeño y ya definido lo hace directamente el modelo principal.
- Consulta al advisor según la sección 1: solo para decisiones de diseño, cuando un problema no converge y antes de cerrar
  una fase o una tarea larga.
- Si un error se repite o un test falla dos veces, delega en debugger.
- Antes de dar una tarea por terminada, pide a reviewer que revise el diff.
- Integra los resultados y verifica antes de cerrar.

## Vigencia de la sección 1

El modo autónomo de la sección 1 rigió el desarrollo inicial, ya terminado. Si el usuario está presente y pide trabajar
por fases con su aprobación, se detiene al final de cada fase y se le pregunta lo que le corresponda decidir. Lo demás
de la sección 1 sigue vigente: la bitácora, lo autorizado y lo prohibido.
