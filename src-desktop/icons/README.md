# App Icons

These are committed build prerequisites. A normal checkout must build without
running an icon generator; `npm run verify:desktop-clean-checkout` enforces
that every icon referenced by `tauri.conf.json` exists and is tracked by Git.

See [the desktop build guide](../../docs/guides/desktop-build.md) for the
authoritative clean-checkout command and committed-input policy.

## Updating the icon set

The source artwork is vector: `scripts/lib/station-icon.mjs` builds the icon
as SVG — a square map tile carved by the canonical River S, contours offset
from the river, a gold compass and a stacked base layer — on the geometry in
`scripts/lib/station-icon-geometry.mjs`. `scripts/generate-app-icons.mjs`
rasterizes every surface from it, including the platform fan-out (it runs
`tauri icon` itself): the macOS-grid master (inset with a drop shadow) for
the `.icns` only; a tighter rounded master with no shadow for `icon.ico`, the
32/64/128 PNGs and `icon.png` (Windows, Linux and the tray, which
`src-desktop/src/tray.rs` embeds), where the grid inset would leave the tile a
few pixels wide; the full-bleed opaque square master for iOS and Windows
tiles (iOS rejects alpha) and the iOS Live Activity's `StationAppIcon`; an
Android master with the tile scaled into the adaptive-icon safe zone (the
launcher and Android 12 splash masks crop well inside the edges); the
transparent in-app mark; the monochrome Android status-bar mark
(`agent_activity_mark.xml`); and per-channel sets. Each channel has an
explicit water palette in `station-icon.mjs` while parchment and gold stay
fixed: stable blue, green for Beta, rose for Nightly and amber for Dev.
`scripts/__tests__/station-icon.test.ts` keeps the icon palettes and the
Android accents and tints at least 30° of hue from the Station brand purple;
the in-app channel theme tokens in `src-ui/src/index.css` are not covered.
`assets/brand/station-icon-manifest.json` records the sha256 of every SVG the
source builds and of every committed file the generator writes, including the
`tauri icon` fan-out (ico, icns, PNGs, Android mipmaps and iOS app-icon sets;
not the tray state icons, which it does not generate), and the same
test rebuilds the SVG and rereads those files against it, so a source edit
without a regeneration, or a stale or hand-edited raster, fails. Desktop overlays use the corresponding
`icons/<channel>/` set. Android builds call
`scripts/apply-android-channel-icons.mjs` after `tauri android init`, applying
the selected `icons/<channel>/android` set to both `main` and `debug` so source
set precedence cannot mask the release identity. Android 13+ gets an API-33
adaptive-icon override with a monochrome River mask inside the safe area;
the launcher chooses its tint when themed icons are enabled. Older launchers
keep the API-26 colour layers. The generator commits the same resources in
the channel sets and generated-project seed.
The TestFlight delivery
workflow (`testflight-delivery.yml`) deletes `gen/apple` and runs
`tauri ios init`, which renders `Assets.xcassets/AppIcon.appiconset` from
Tauri's template with Tauri's own default PNGs, so it calls
`node scripts/ios-channel-icons.mjs apply <channel>` after each init to copy the
committed `icons/<channel>/ios/AppIcon-*.png` set (stable, beta, nightly and
the local Dev simulator; from
the square master, because iOS rejects alpha and the generator refuses any
translucent pixel) over it. `ios-channel-icons.mjs verify` compares every PNG
referenced by the source catalog with that set, then compares the shipped
`AppIcon60x60@2x.png` pixels with the corresponding input. It does not inspect
every rendition in the compiled asset catalog. It amends the channel-icon receipt the
overlay step created (its `desktopBundleIcon*` fields name the desktop master
from `bundle.icon`, not the shipped icon). `write-ios-build-manifest.mjs` also
restores the icon set for the active Tauri configuration, so local
development, CI and release simulator builds do not rely on init preserving
the committed catalog. Applying the set checks its files against the generated
manifest before replacing catalog PNGs; repeat application of a valid set is
allowed. Pass `--config <overlay>` when the build uses a channel overlay;
without it, staging uses the base Stable configuration. Tauri can preserve
an old `project.yml` during init, so its identifier is not the selection authority.
CI, release and local development simulator completion compare the
shipped loose icon too. An alternate build must run these staging and
verification steps. Stable keeps the approved
default artwork; `favicon-dev.png` is swapped into Dev by `is-dev-build` in
`src-ui/src/index.css`.
Mobile startup uses the same committed artwork: the channel's transparent
mark (`src-ui/public/favicon*.png`, the tile cut out with a faint outline so
its edge holds on a light background). The web splash in `index.html` paints
before the host reports the channel, so `public/startup-theme.js` picks the
mark this install last reported (stored by `PlatformProfileContext`); a first
launch shows the stable mark until the report arrives. Android channel staging writes
light/dark splash backgrounds alongside its API-31 theme overlays, while
preserving the channel-specific launcher background. It also stages a centered
mark as the window background. The Android bootstrap keeps the WebView
transparent until its content paints, so this native mark fills the launch gap.
`scripts/write-ios-build-manifest.mjs` restores the maintained
`scripts/templates/ios/LaunchScreen.storyboard` after init and stages the
favicon and light/dark background in the asset catalog. These are build inputs;
a packaged launch must still be checked on the target platform.

Generate icons only when deliberately changing the artwork:

1. Edit `scripts/lib/station-icon.mjs` (artwork or a channel palette), then:
   ```bash
   node scripts/generate-app-icons.mjs
   ```
   This also rewrites `src-ui/src/lib/startup-mark-geometry.ts`, where the
   startup animation finds the river in the mark. Rasterization runs in
   Playwright's Chromium; regenerate the whole set in one run so every
   surface comes from the same renderer.
2. Verify the Tauri app:
   ```bash
   npm run verify:desktop-clean-checkout
   ```

## Manual Setup

If a pinned Dock shortcut still shows the old icon after a macOS update, first
check `CFBundleIconFile` in the installed app's `Contents/Info.plist` and compare
the corresponding file under `Contents/Resources` with the channel's `.icns`.
Quit and reopen the app. If the shortcut still shows the old artwork, remove
that shortcut and drag the updated app from Applications back into the Dock.
Stable, Beta and Nightly are separate installations and update separately.

Generated-file hashes and packaged-icon comparisons do not prove that Finder,
Dock, Windows taskbar or a Linux desktop refreshed its cached icon. Verify
fresh installation and an update over the old artwork separately on each OS.

If you prefer to manually create icons:

### macOS
- `icon.icns` - macOS app bundle icon
- `32x32.png`, `128x128.png`, `128x128@2x.png` - Various sizes

### Windows
- `icon.ico` - Windows executable icon

### Linux
- `icon.png` - 1024x1024 source
- `128x128.png` - Standard size

## Icon Design Tips

- Use a simple, recognizable symbol
- Ensure good contrast at small sizes (32x32)
- Use the rounded desktop master where alpha is supported; keep the iOS,
  Android and Windows tile master opaque and square.
- Test on both light and dark backgrounds
