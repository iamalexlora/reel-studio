# Configuración de dmgbuild: ventana con fondo, flecha e instrucciones.
app = defines["app"]  # noqa: F821
background = defines["bg"]  # noqa: F821
volume_name = "Reel Studio"
format = "UDZO"
files = [app]
symlinks = {"Aplicaciones": "/Applications"}
icon_locations = {"Reel Studio.app": (170, 165), "Aplicaciones": (490, 165)}
window_rect = ((200, 140), (660, 440))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 104
text_size = 13
arrange_by = None
