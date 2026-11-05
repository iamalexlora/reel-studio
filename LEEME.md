# Reel Studio

Editor de reels que corre en tu Mac. Subes un video en crudo, Reel Studio lo transcribe, quita
silencios, muletillas y tomas repetidas, y tú ajustas el resto tachando palabras. Exporta en
vertical 1080×1920 con subtítulos animados.

## Instalar (una sola vez)

**App para Mac (recomendado):**
1. En GitHub, entra a tu repositorio → **Releases** → **Reel Studio para Mac** y descarga `ReelStudio.dmg`.
2. Ábrelo y arrastra **Reel Studio** a **Aplicaciones**.
3. La primera vez macOS la bloquea porque no está firmada por Apple: ábrela, toca **OK**, ve a
   **Ajustes del Sistema → Privacidad y seguridad**, baja hasta «Reel Studio» y toca **Abrir de todos modos**.
4. Al abrirla te pide tu token de GitHub (solo lectura) para las actualizaciones automáticas.
5. Si es una Mac nueva, se abre la Terminal para instalar ffmpeg y el modelo de voz (≈1,6 GB, 10–15 min).

**Sin la app (alternativa):** descomprime el paquete y haz clic derecho → Abrir sobre `instalar.command`.

Todo queda en `~/ReelStudio`. Tus proyectos están en `~/ReelStudio/proyectos`.

## Actualizaciones

Reel Studio se actualiza solo desde GitHub cada vez que lo abres. Si ya estaba abierto, aparece el
botón **«Actualización disponible»** arriba, o usa el menú **Reel Studio → Buscar actualizaciones…**.
Tus proyectos nunca se tocan.

## Usar

- Abre **Reel Studio** desde Aplicaciones, Launchpad o Spotlight (se abre en su propia ventana), o pídeselo a Claude.
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
