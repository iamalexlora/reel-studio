# Reel Studio

Editor de reels que corre en tu Mac. Subes un video en crudo, Reel Studio lo transcribe, quita
silencios, muletillas y tomas repetidas, y tú ajustas el resto tachando palabras. Exporta en
vertical 1080×1920 con subtítulos animados.

## Instalar (una sola vez)

1. Descomprime la carpeta donde quieras (por ejemplo, en Descargas).
2. Haz **clic derecho → Abrir** sobre `instalar.command`. La primera vez macOS pregunta si
   confías en el archivo: elige **Abrir**.
3. Si no tienes Homebrew, te pedirá la contraseña de tu Mac (no se ve mientras escribes).
4. Al final se abre Reel Studio en el navegador. Tarda unos 10–15 minutos la primera vez, porque
   descarga el modelo de voz (≈1,6 GB).

Todo queda en `~/ReelStudio`. Tus proyectos están en `~/ReelStudio/proyectos`.

## Usar

- Abre la app **Reel Studio** (Launchpad o Spotlight), o pídeselo a Claude.
- Arrastra tu video. Cuando termine de transcribir:
  - **Clic** en una palabra: el video salta ahí.
  - **Arrastrar** o **Shift + clic**: seleccionar varias. **⌫** las quita o las restaura.
  - **Doble clic**: corregir cómo se escribe en el subtítulo.
  - **Espacio**: reproducir / pausar (la vista previa ya salta los cortes). **⌘Z**: deshacer.
- Pestaña **Subtítulos**: estilo, letra, colores, posición.
- Pestaña **Ritmo**: qué tan largas pueden ser las pausas.
- Pestaña **Formato**: vertical 9:16 (Reels/TikTok), horizontal 16:9 (YouTube), 4:5 o 1:1. Si tu
  video tiene otra forma, eliges recortar (y mover el encuadre) o fondo difuminado.
- **Exportar**: 24, 30 o 60 fps; 1080p o 4K (si el original es 4K); calidad Máxima, Alta o Liviana;
  MP4 para redes o ProRes 422 HQ para seguir editando. Los videos HDR del iPhone se conservan en HDR.
  El volumen se iguala a −14 LUFS (el estándar de Instagram y YouTube).

## Con Claude

Este paquete también es un plugin de Claude (`.claude-plugin/` y `skills/editar-reels`). Con la
app de Claude en tu Mac puedes decir cosas como:

> «Edita mi último reel en Reel Studio: quita las tomas repetidas y corrige los nombres de marcas»

Claude lee la transcripción, hace los cortes finos y sus cambios aparecen en la interfaz.

## Problemas

- **No abre**: ejecuta `~/ReelStudio/start.sh` en Terminal y mira `~/ReelStudio/logs/servidor.log`.
- **Apagarlo**: `~/ReelStudio/stop.sh`.
- **Reinstalar o actualizar**: vuelve a abrir `instalar.command`; tus proyectos no se tocan.
