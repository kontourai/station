---
status: current
subject: Named color themes layered on the shipped design tokens, Station unchanged by default
decided: 2026-10-20
evidence:
  - kind: commit
    ref: 26fa8748790
  - kind: doc
    ref: src-ui/src/lib/color-theme-catalog.ts
  - kind: doc
    ref: src-ui/src/lib/color-theme-css.ts
  - kind: doc
    ref: docs/guides/theming.md
---

# User color themes

A person can choose a named palette on top of light and dark: Catppuccin,
Rosé Pine, Gruvbox, Nord or Tokyo Night. `station`, the default, is today's
look and sets nothing. This sits on `@kontourai/ui`'s shipped `--k-*` roles
(DESIGN.md "Colors", "White-label overrides", "Modes" and "Theme and mode
scoping") without changing any shipped token or product theme. It is a Station
preference, not a new `.theme-*` product theme.

## Settings

Three account-scope settings, like `theme` and `accentColor`:

- `colorTheme`: the family id, default `station`.
- `colorThemeFlavor`: the family's DARK flavor, `null` for the family default.
  Light mode always uses the family's single light flavor.
- `colorThemeAccent`: a named accent from the family's list, `null` for the
  family default. A custom hex `accentColor` still wins on Station's accent.

Values come from device storage, imports, other tabs and the account server,
any of which can be older or newer than the client. The UI resolves them
(`resolveColorThemeSelection`): an unknown family is `station`, an unknown
flavor or accent is the family default, and nothing throws. The server stores
them as parsed ids (`^[a-z][a-z0-9-]{0,47}$`), not today's family list, so a
newer client's family is kept rather than failing the whole patch. A server
from before this change refuses a patch that contains these keys (its patch
schema is strict), so the client shows its existing save-failure notice and
keeps the server's value; other preferences in a separate patch are
unaffected. "Import previous preferences" sends one patch, so against such a
server it fails whole while this device holds a color theme.

## Catalog and contrast

`src-ui/src/lib/color-theme-catalog.ts` is the single source: per family, its
light flavor and dark flavors, each a full map onto the `--k-*` roles and onto
Station's literal functional colours in `index.css`, plus named accents and
per-flavor Dev, Beta and Nightly brand colours. Each family cites the source of
its published values. Trust-state tokens are left alone: each trust chip paints
its own fill.

Published values are kept unless they fail a contrast rule. The rules are
`@kontourai/ui`'s (`check:contrast`, `validateBrandOverride`), Station's
`STATION_SURFACE_TEXT_RULES`, and the floors `index.css` documents for its
functional colours. A failing value is recorded as `[adjusted, official]` with
only its OKLCH lightness moved (chroma only where sRGB requires it), the rule
DESIGN.md "Product themes" applies to Station's and Flow's accents. Light
flavors need the most adjustment: pastel accents and status hues cannot carry
text on a light canvas. `color-theme-contrast.test.ts` rates every family ×
flavor × accent and proves each adjustment was needed and kept its hue.

## Application before first paint

`npm run gen:color-themes` renders the catalog into checked-in artifacts: the
app stylesheet `color-themes.generated.css`, the splash subset, and an index
block in `public/startup-theme.js`. The startup script runs before any
stylesheet, validates the stored selection, sets `data-color-theme`,
`data-color-theme-flavor` and `data-color-theme-accent` on `<html>`, and adds
`<meta name="theme-color">` with the effective canvas. After load,
`bindColorThemeToSettings` keeps them in step with the settings store.
`color-scheme` is already set per mode by the tokens. A drift test fails when
an artifact differs from what the catalog renders.

Pre-paint reads device storage only. For a signed-in person the account value
applies once account preferences load, exactly as for `theme` today: account
values are never written to device storage.

## Precedence

- White-label branding (inline style on `<html>`) wins on every brand slot.
- A Dev, Beta or Nightly build keeps its identity on `--k-brand`, using the
  catalog's per-flavor shade of the channel colour because the channel's own
  colour fails as text on several theme surfaces. The theme owns action and
  focus.
- A custom `accentColor` still wins on `--accent-primary`.
- An element with its own `data-theme` below the root resolves the theme's
  flavor for that mode. Station has no such islands today; the rules cover
  them so a future one does not fall back to Station's colours.
