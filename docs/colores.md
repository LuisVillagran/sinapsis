# Paleta

Valores de `src/scene/theme.ts`. Los muestreados salen de `npx tsx tools/sample-colors.ts`, que necesita las imágenes
de `referencia/`; esas imágenes no se publican.

Son fotos JPEG de una pantalla, así que un borde de un píxel se mezcla con el fondo. Por eso los colores sólidos salen
de un promedio de 5x5 px, y los trazos finos, del píxel más saturado de una ventana de 9x9 px.

| Token | Valor | Cómo se obtuvo |
| --- | --- | --- |
| `bg`, `panel` | `#191e24` | Promedio del fondo, igual en dos zonas y dentro de los paneles |
| `windowBar` | `#242831` | Promedio de la barra de ventana |
| `main` | `#e38d63` | Cuadro sólido de la leyenda, píxel vivo |
| `sub` | `#81b0f6` | Cuadro sólido de la leyenda, píxel vivo |
| `metrics` | `#77ce9b` | Cuadro sólido de la leyenda, píxel vivo |
| `notes` | `#af9eec` | Cuadro sólido de la leyenda, píxel vivo |
| `barSub` | `#8cc0ff` | Barra de una tarjeta, píxel vivo |
| `barGood` | `#76d099` | Barra de memoria, píxel vivo |

Sin muestrear:

| Token | Valor | Por qué |
| --- | --- | --- |
| `advisor` | `#e59ad8` | El advisor no está en la referencia: lleva un tono propio para no confundirse con la memoria |
| `alert` | `#f0695a` | En la referencia, el naranjo es del modelo principal: los errores van más hacia el rojo |
| `caption` | `#e8b56e` | Elegido a ojo: el pie del panel de memoria es texto fino y la muestra sale contaminada |
| `text`, `dim`, `faint` | `#dfe3ea`, `#8b909b`, `#50555f` | Elegidos a ojo sobre capturas: el texto fino también contamina la muestra |
| `line`, `barTrack`, `chip` | `#4a505c`, `#3a404b`, `#262c36` | Elegidos a ojo, partiendo del borde del log (`#3e424b`) |
| `subBright` | `#f2f6ff` | Paquetes de regreso, que en la imagen se ven casi blancos |
| `dot*` | Colores habituales de una barra de ventana | Decorativos |

Los bordes de los paneles se dibujan un 12 % más cerca del fondo que su token, porque en la imagen son más tenues que
los cuadros de la leyenda.

En 256 colores, los tintes pequeños y los halos se apagan, porque saltarían a otro gris.
