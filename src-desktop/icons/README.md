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
set precedence cannot mask the release identity. Stable keeps the approved
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
