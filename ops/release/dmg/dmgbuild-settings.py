# dmgbuild settings for the macOS installer disk image.
#
# ops/release/macos-notarized-artifacts.mjs passes every input explicitly:
#   dmgbuild -s <this file> -D app=<sealed .app> -D background=<background.tiff> \
#     --no-hidpi Station <output.dmg>
# Geometry matches ops/release/dmg/render-background.swift (660x400 window,
# app icon centered at (170, 210), Applications at (490, 210)).
import os.path
import subprocess

application = defines["app"]  # noqa: F821 (provided by dmgbuild)
appname = os.path.basename(application)

format = "UDZO"
files = [application]
symlinks = {"Applications": "/Applications"}
# No hide_extensions: dmgbuild implements it with SetFile on the copied,
# already-signed bundle. Finder already hides an application's ".app" unless
# the user shows all filename extensions.

background = defines["background"]  # noqa: F821
window_rect = ((200, 120), (660, 400))
default_view = "icon-view"
show_toolbar = False
show_status_bar = False
show_tab_view = False
show_pathbar = False
show_sidebar = False
icon_size = 128
text_size = 13
arrange_by = None
icon_locations = {appname: (170, 210), "Applications": (490, 210)}


def verify_copied_app(mount_point, options):
    """Fail the build before signing if dmgbuild's unchecked ditto copy broke the app.

    dmgbuild ignores ditto's exit status. Raising here makes dmgbuild detach
    the image and exit nonzero, so a bad copy never reaches notarization.
    """
    subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict",
         os.path.join(mount_point, appname)],
        check=True,
        timeout=600,
    )


create_hook = verify_copied_app
