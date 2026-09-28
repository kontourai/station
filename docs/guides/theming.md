# Station theming

Kontour UI owns its public base tokens, product-theme classes and primitive
styles. Use the [consumer guide](https://github.com/kontourai/ui/blob/main/docs/consumer-guide.md#explorer)
and [explorer manifest](https://github.com/kontourai/ui/blob/main/docs/explorer-manifest.json)
for that package's contract, and its installed public exports for the version
Station actually consumes. Upstream documentation is not proof of Station-wide
adoption.

At the shared package boundary, Station owns only adopter behavior: selecting
public exports and composing them with Station's domain and channel identity.
That rule does not mean every existing Station component already uses a shared
primitive; the current adoption boundary is described below.

## Current cascade

[Station's entry stylesheet](../../src-ui/src/index.css) imports local fonts and
layout/motion tokens, then the package's fonts, token entry and React styles.
Core chrome aliases such as `--bg-primary`, `--text-primary`, `--border-primary`
and `--accent-primary` derive from `--k-*`; intermediate text/surface colors use
local mixes. Functional status colors and layout, layer and motion tokens also
remain Station-owned. New UI styles use the shared `--k-*` tokens under the
[canonical design and product-copy rules](https://github.com/kontourai/ui/blob/main/DESIGN.md).
Keep its OPEN decisions unresolved. The aliases above remain useful when
reading existing Station components; this guidance does not claim their
migration is complete.

Station does not currently select a package `theme-console`/`theme-flow`/
`theme-survey`/`theme-surface` class. It consumes the base dark/light skin and
applies local adoption rules. `:root.is-dev-build` and `data-app-channel`
selectors override the brand/contrast pair and select channel logo assets.
These are existing Station channel overrides, not new shared product themes.
Do not copy the package's theme or primitive styles into a feature; propose a
shared value upstream when it belongs to the public design system.

## Device preference and accents

[main.tsx](../../src-ui/src/main.tsx) resolves the saved device theme before
render and sets `data-theme` on the document element.
[ThemeToggle](../../src-ui/src/components/header/ThemeToggle.tsx) keeps it in
sync with the device-settings store. The selected light/dark preference belongs
to the Device; changing a server or Project is not a separate theme choice.

The [accent helper](../../src-ui/src/lib/accent-contrast.ts) applies a custom
accent together with its foreground contrast partner and hover treatment.
Use that owner rather than setting only `--accent-primary`; clearing the
preference must clear its companion overrides too. Do not infer legibility for
every tinted background from a foreground-on-solid-accent calculation.

## Components and evidence

Shared package primitives are used in surfaces such as Trust, Readiness and
Flow views. Other components remain local: Station's `Button`, `Toggle`,
`Dialog` and responsive shell are not all replaced by package components.
Follow [responsive UI contracts](responsive-ui.md) for local dialog composition,
focus and viewport behavior; never mix the package's `.dialog` classes with
Station's `station-dialog__*` chrome.

The theme-toggle, token-cascade and contrast tests cover their named owners and
selected token combinations. They do not prove every component's computed
contrast, rendered fonts, native appearance or accessibility. Verify the changed
surface in light and dark, with its actual background, focus state, disabled
state, channel branding and any custom accent. Keep unrun platform or visual
checks explicitly NOT_VERIFIED.
