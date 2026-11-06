---
name: editar-reels
description: Edita reels de video con Reel Studio en la Mac del usuario — quitar silencios, muletillas y tomas repetidas, corregir subtítulos, cambiar el estilo y exportar en vertical u horizontal, a 30 o 60 fps. Úsala cuando el usuario pida editar, limpiar, cortar, subtitular o exportar un video o reel, o mencione Reel Studio.
---

# Editar reels con Reel Studio

Reel Studio vive en la Mac del usuario, en `~/ReelStudio`. Tiene una interfaz web local
(http://localhost:8765) y una línea de comandos, `reel.py`, que edita **el mismo proyecto**:
lo que cambies aparece solo en la interfaz abierta en unos 2 segundos.

## Dónde corren los comandos

Todos los comandos se ejecutan **en la Mac del usuario**:
- Si esta sesión tiene un shell de la computadora del usuario (por ejemplo, la herramienta de
  bash del dispositivo enlazado), úsalo.
- Si estás corriendo localmente en la Mac (Claude Code), usa tu shell normal.
- Si no tienes acceso a la Mac, dile al usuario que abra la app de Claude en su Mac y
  enlace esta conversación a su computadora.

Atajo para todos los comandos:

```bash
R="$HOME/ReelStudio/.venv/bin/python $HOME/ReelStudio/app/reel.py"
```

Si `~/ReelStudio` no existe, Reel Studio no está instalado: pídele al usuario que haga doble
clic en `instalar.command` (la instalación necesita su contraseña para Homebrew).

## Flujo

1. **Arrancar**: `~/ReelStudio/start.sh` (abre el navegador; usa `--sin-navegador` si el
   usuario no quiere que se abra). `$R estado` confirma que está corriendo.
2. **Proyecto**:
   - Si el usuario ya subió el video en la interfaz: `$R lista` y toma el id.
   - Si te da una ruta: `$R nuevo "/ruta/al/video.mov" --nombre "Nombre"`, luego `$R esperar ID`.
   Los comandos largos pueden pasar el límite de tiempo del shell remoto: en ese caso
   lánzalos con `nohup … > /tmp/reel.log 2>&1 &` y revisa el log.
3. **Leer**: `$R texto ID`. Muestra la transcripción por frases con índices `[n]palabra`.
   `~~palabra~~(motivo)` = ya cortada; `?palabra` = posible muletilla (decide tú).
   La limpieza automática ya quitó silencios, "eh/mmm" y repeticiones obvias.
4. **Editar con criterio** (esto es lo que la limpieza automática no sabe hacer):
   - **Tomas repetidas**: cuando la persona dice algo, se equivoca y lo repite, conserva la
     **última** versión completa y corta las anteriores. `$R cortar ID 40-58 --motivo "toma repetida"`
   - **Arranques en falso** y frases abandonadas a la mitad.
   - **Muletillas dudosas** (`?este`, `?o sea`, `?bueno`, `?tipo`): córtalas solo si no aportan
     sentido. Si una palabra debe quedarse aunque la limpieza la marque: `$R mantener ID 12`.
   - **Errores de transcripción** que saldrían mal en el subtítulo (marcas, nombres, "Cloud"
     por "Claude"): `$R corregir ID 15 "Claude"`. Solo cambia el texto en pantalla.
   - No cortes contenido con sentido solo para acortar, salvo que el usuario lo pida.
   - Al terminar, revisa solo las frases que tocaste (no vuelvas a leer todo el texto).
5. **Estilo** (si el usuario lo pide): presets `impacto` (mayúsculas, palabra resaltada),
   `limpio` (caja oscura, frase progresiva), `titular` (1–2 palabras gigantes al centro).
   `$R estilo ID --preset impacto --resaltado "#FFD400" --posicion abajo --palabras 3`
   Otras opciones: `--fuente`, `--tamano`, `--color`, `--borde`, `--mayusculas si|no`, `--caja si|no`.
   Ritmo: `$R ajustes ID --pausa 0.3 --margen 0.06` (pausa más corta = ritmo más rápido).
   Formato: `$R ajustes ID --formato vertical|horizontal|4:5|cuadrado`. Si el video original no
   tiene esa forma: `--encuadre llenar` (recorta; mueve el recorte con `--posx 0..1` / `--posy 0..1`
   para que la persona quede bien encuadrada) o `--encuadre difuminado` (video completo sobre fondo borroso).
6. **Avisar**: `$R nota ID "Quité 3 tomas repetidas y corregí 2 nombres"` deja el resumen
   visible en la pestaña Actividad. Dile al usuario que revise en la interfaz y que puede
   restaurar cualquier palabra haciendo clic en ella.
7. **Exportar** solo cuando el usuario lo apruebe:
   `$R exportar ID [--formato horizontal] [--fps 30|60] [--calidad maxima|alta|liviana] [--4k] [--prores] [--srt]`
   - `--fps`: por defecto usa el del original. 60 solo tiene sentido si se grabó a 60.
   - `--calidad maxima` para el resultado final; `liviana` para revisiones rápidas.
   - `--4k` solo si el original es 4K. `--prores` = .mov ProRes 422 HQ para seguir editando.
   - Si el original es HDR (iPhone), sale en HEVC 10-bit HDR automáticamente.
   El archivo queda en `~/ReelStudio/proyectos/ID/exports/`. Puedes mostrarlo con `open -R "<ruta>"`.
   El render puede durar varios minutos: lánzalo con `nohup` si el shell tiene límite de tiempo.

## Pedidos del usuario (v2)

- `$R pedidos` lista lo que el usuario escribió en la app. Los que empiezan con «[Armar con la
  referencia]» piden armar el video siguiendo la referencia: lee `$R referencia ID` (números) y,
  si hace falta, mira la hoja de fotogramas que indica; luego usa `$R clips ID`, `armar`, `orden`,
  `recorte`, `apoyo`, `transicion`, `color`, `musica`, `marca` y `silenciar`.
- Al terminar cada pedido: `$R hecho ID PEDIDO "qué hiciste, en una frase"`.

## Gastar pocos créditos

- No mires el video ni sus fotogramas: todo se decide con `$R texto ID`, que es texto compacto.
- Lee la transcripción una vez, decide todos los cortes y aplícalos en pocos comandos
  (varios rangos por comando: `$R cortar ID 12-18 40-58 77 --motivo "toma repetida"`).
- Deja que la limpieza automática haga lo obvio; tú solo lo que requiere criterio.
- No repitas el texto completo para verificar: basta con revisar las frases que tocaste.

## Reglas

- Nunca borres proyectos ni archivos del usuario.
- Los índices de palabras son estables mientras no se vuelva a transcribir.
- Si el usuario está editando en la interfaz al mismo tiempo, la interfaz recarga tus cambios;
  si choca con una edición suya, se queda con la tuya y le avisa.
- Responde en español y en lenguaje simple; el usuario no necesita ver los comandos.
