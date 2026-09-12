# App Icons

These are committed build prerequisites. A normal checkout must build without
running an icon generator; `npm run verify:desktop-clean-checkout` enforces
that every icon referenced by `tauri.conf.json` exists and is tracked by Git.

See [the desktop build guide](../../docs/guides/desktop-build.md) for the
authoritative clean-checkout command and committed-input policy.

## Updating the icon set

The source artwork is `assets/brand/reference.jpg`;
`scripts/generate-app-icons.mjs` renders every surface from it, including the
platform fan-out (it runs `tauri icon` itself): the rounded desktop master,
the full-bleed square master for iOS/Android/Windows tiles (those platforms
mask or reject alpha themselves), the transparent in-app favicon, and the per-channel shades — a selective
water-hue shift that leaves parchment and gold untouched: amber for Dev,
indigo for Beta, and violet for Nightly. Desktop overlays use the corresponding
`icons/<channel>/` set. Android builds call
`scripts/apply-android-channel-icons.mjs` after `tauri android init`, applying
the selected `icons/<channel>/android` set to both `main` and `debug` so source
set precedence cannot mask the release identity. The TestFlight delivery
workflow (`testflight-delivery.yml`) deletes `gen/apple` and runs
`tauri ios init`, which renders `Assets.xcassets/AppIcon.appiconset` from
Tauri's template with Tauri's own default PNGs, so it calls
`scripts/ios-channel-icons.mjs apply <channel>` after each init to copy the
committed `icons/<channel>/ios/AppIcon-*.png` set (stable, beta, nightly; from
the square master, because iOS rejects alpha and the generator refuses any
translucent pixel) over it, and `ios-channel-icons.mjs verify` proves the built
catalog and the IPA's icon are that set, amending the channel-icon receipt the
overlay step created (its `desktopBundleIcon*` fields name the desktop master
from `bundle.icon`, not the shipped icon). Every other iOS build (`build-ios.yml`, the release
simulator job, local builds) runs init with `gen/apple` present and consumes
the committed catalog, which is the stable set. Stable keeps the approved
default artwork; `favicon-dev.png` is swapped into Dev by `is-dev-build` in
`src-ui/src/index.css`.
Generate icons only when deliberately changing the artwork:

1. Replace `assets/brand/reference.jpg`, then:
   ```bash
   node scripts/generate-app-icons.mjs
   ```
2. Verify the Tauri app:
   ```bash
   npm run verify:desktop-clean-checkout
   ```

## Manual Setup

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
- Include transparency for rounded corners
- Test on both light and dark backgrounds
