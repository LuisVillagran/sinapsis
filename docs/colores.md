# Paleta

Valores de `src/scene/theme.ts`. Los muestreados salen de `npx tsx tools/sample-colors.ts`, que necesita la
imagen de referencia local; esa imagen no se publica.

| Token | Valor | Cómo se obtuvo |
| --- | --- | --- |
| `bgEdge` | `#13182d` | Mediana de zonas sin texto en dos esquinas (`#13182e`, `#13182b`) |
| `bgCenter` | `#232b4e` | Mediana entre las tarjetas (`#2a3557`), oscurecida a ojo: esa zona incluye el brillo de las tarjetas |
| `panel` | `#0f1225` | Mediana del interior de la sesión principal y de una tarjeta (`#111327`, `#0d1224`) |
| `chip` | `#161d32` | Mediana del fondo de la línea de estado de la sesión |
| `main` | `#7ec2ed` | Cuadro sólido de la leyenda |
| `advisor` | `#adacfa` | Cuadro sólido de la leyenda |
| `metrics` | `#75c8a6` | Cuadro sólido de la leyenda |
| `sub` | `#afd5ff` | Píxel más brillante del borde de una tarjeta |
| `subBright` | `#e6ffff` | Píxel más brillante del borde de "back to lead" |
| `barGood` | `#34977a` | Píxel más saturado de la barra verde |
| `barAlert` | `#bb763d` | Píxel más saturado de la barra naranja |
| `barSub` | `#5797c8` | Píxel más saturado de la barra de tarjeta |
| `barTrack` | `#253352` | Mediana del riel de la barra de tarjeta |
| `text` | `#eaefff` | Píxel más brillante del título |
| `faint` | `#4c5164` | Píxel más brillante de la hora del log |

Los bordes de los paneles del advisor, la sesión y las métricas se dibujan un 20 % más cerca del fondo que su
token, porque en la imagen son más tenues que los cuadros de la leyenda.

Sin muestrear:

| Token | Valor | Por qué |
| --- | --- | --- |
| `alert` | `#e08a4f` | Valor base de `CLAUDE.md`. El texto naranjo de la imagen es demasiado fino: las muestras salían contaminadas |
| `dim` | `#7c88a8` | Valor base de `CLAUDE.md`. El muestreado (`#636677`) resultaba poco legible |
| `windowBar` | `#0f1426` | Elegido: el título de la barra contamina la muestra |
| `dot*` | Colores habituales de una barra de ventana | Decorativos |
