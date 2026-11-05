# Proyecto: Sinapsis — visor animado en vivo del modo advisor de Claude Code

## Objetivo
Construir una herramienta que muestre en tiempo real qué está haciendo cada
modelo en una sesión de Claude Code con advisor activo (p. ej. `claude --model
haiku --advisor opus`): el modelo principal ejecutando herramientas, los
subagentes trabajando y las consultas al advisor. La interfaz debe replicar lo
más fielmente posible la imagen adjunta, y la PRIORIDAD es que las animaciones
sean fluidas y vistosas. La fidelidad visual y la animación importan más que
agregar funciones.

## Tecnologías
- Backend (colector de eventos): Node.js + TypeScript
  - chokidar para seguir en vivo los transcripts .jsonl en ~/.claude/projects/
  - ws (WebSocket) para emitir eventos normalizados al frontend
  - Endpoint opcional para recibir eventos desde hooks de Claude Code
    (PreToolUse, PostToolUse, SubagentStop, Stop)
- Frontend: Vite + React + TypeScript
  - Motion (Framer Motion) para animaciones de componentes y layout
  - SVG para los conectores entre paneles (trazos animados con stroke-dashoffset
    y "paquetes" que viajan por las líneas)
  - Tailwind CSS con tokens de color propios
  - Tipografía monoespaciada: JetBrains Mono (Google Fonts)
- Opcional al final: Tauri para empaquetarla como ventana de escritorio sin
  marco, con la barra falsa "~/app — zsh"
- Tests: Vitest para el parser y el modelo de eventos

## Diseño (replicar la imagen adjunta)
- Fondo azul marino muy oscuro, bordes cian/turquesa con resplandor (glow),
  morado/magenta para todo lo del advisor (Opus), verde para barras de avance,
  naranjo para alertas o reintentos.
- Encabezado: "CLAUDE CODE ADVISOR · <MODELO PRINCIPAL> BUILDS · <ADVISOR> THINKS",
  con los nombres de modelo tomados de los datos reales.
- Fila de leyenda con cuadros de color: main, subagents, advisor.
- Columna izquierda: panel del advisor "on call" con una línea de tiempo
  vertical de consultas (motivo de cada una: antes de un plan, error repetido,
  antes de terminar…) y estadísticas abajo (consultas, tokens, turnos rutinarios).
- Centro arriba: caja de la sesión principal (modelo, tarea actual, effort,
  herramienta en ejecución).
- Centro medio: panel de métricas con barras horizontales. En la imagen es una
  "fork layer" que no es un concepto real de Claude Code; reemplazarlo por datos
  reales con la misma estética (p. ej. distribución de herramientas usadas:
  Read, Edit, Bash, Grep…).
- Fila "delegate to subagents": tarjetas por subagente (nombre, modelo,
  read-only, barra de avance, resultado).
- Caja inferior "back to <modelo> · lead" que recibe los resúmenes.
- Columna derecha: caja punteada pequeña con model / mode / state del advisor.
- Abajo: "session log" con hora y modelo en cada línea, y una línea de prompt
  con cursor parpadeante.

## Animaciones (lo más importante)
- Secuencia de arranque: los bordes de los paneles se dibujan solos, el
  encabezado aparece con efecto máquina de escribir.
- Cada evento recorre visualmente su camino: un paquete de luz viaja por el
  conector SVG desde el panel que lo origina hasta el que lo recibe.
- Consulta al advisor: el panel de Opus se ilumina con pulso de glow, un paquete
  viaja de ida y otro de vuelta, y el motivo se agrega a la línea de tiempo.
- Subagentes: las tarjetas aparecen con escala + fade, sus barras se llenan,
  y al terminar se desvanecen mandando su resumen a la caja "back to lead".
- Contadores que suben número a número; barras que crecen con easing.
- Líneas del log que entran deslizándose; texto con efecto máquina de escribir.
- Estado inactivo: "respiración" sutil de los bordes para que nunca se vea muerto.
- Cola de animación: los eventos llegan en ráfagas, así que deben encolarse con
  una duración mínima visible cada uno, para que todos se alcancen a ver pasar
  sin superponerse de forma caótica.
- Rendimiento: 60 fps, animar solo transform y opacity, sin re-renders
  innecesarios.

## Metodología
Desarrollo incremental por fases. No avanzar a la siguiente fase hasta que la
anterior esté verificada y yo la apruebe. Al cerrar cada fase, mostrar qué se
hizo y cómo probarlo.

Fase 0 — Reconocimiento de datos. Antes de escribir código de la app, inspeccionar
transcripts .jsonl reales de una sesión con advisor y documentar en
docs/eventos.md qué campos existen: modelo por mensaje, llamadas a
herramientas, subagentes y, sobre todo, cómo aparecen las consultas al advisor.
No asumir formatos: si algo no se puede detectar, decirlo. Guardar transcripts
de ejemplo en fixtures/.

Fase 1 — Parser y modelo de eventos. Convertir líneas del transcript en eventos
normalizados (session_start, tool_call, tool_result, subagent_start,
subagent_end, advisor_consult, advisor_reply, session_end), con tests sobre los
fixtures.

Fase 2 — Servidor de eventos. Seguir el archivo en vivo y emitir por WebSocket.
Incluir un MODO REPLAY que reproduce un transcript guardado a velocidad
configurable: sirve para desarrollar las animaciones sin correr sesiones reales
y para hacer demos.

Fase 3 — Maqueta estática. Construir el layout completo con datos fijos y
compararlo con la imagen hasta que se vea prácticamente igual. Sin animaciones aún.

Fase 4 — Animaciones. Agregar una por una, usando el modo replay, y ajustar
tiempos y easing hasta que se vea fluido.

Fase 5 — Integración en vivo. Conectar a una sesión real de Claude Code con
advisor y corregir lo que no calce.

Fase 6 — Pulido. Opcionalmente empaquetar con Tauri, y escribir el README con
capturas y GIF de demo para portafolio.

## Reglas
- Commits pequeños y descriptivos por cada avance.
- Código y comentarios claros; README en español.
- Si un detalle visual de la imagen no tiene equivalente en datos reales,
  proponer una alternativa honesta en vez de inventar datos.