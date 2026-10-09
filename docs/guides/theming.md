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
selectors override the brand/contrast pair and the interaction roles
(`--k-action`, `--k-action-contrast`, `--k-focus`), and select channel logo
assets. These are existing Station channel overrides, not new shared product
themes. `--accent-primary` and `--text-on-accent` read the action role. The
installed package defines the roles (equal to the shipped brand), so the
`--k-brand` fallback written beside them does not apply. The focus-visible
outline reads `--k-focus` only where something chose a focus colour: a
white-label theme that sets it for the current mode (the root then carries
`data-brand-focus`) or a Dev, Beta or Nightly build. Everywhere else it reads
`--accent-primary`, so a device accent recolours buttons, links and the focus
ring. The package always defines `--k-focus`, which is why the choice is keyed
on that marker instead of on the property being defined.
[branding-role-cascade.test.ts](../../src-ui/src/__tests__/branding-role-cascade.test.ts)
measures the resolved roles and contrast-checks every channel value in a real
browser against the rules a white-label theme must pass, including the brand
as text. The sidebar channel badge and the package `.eyebrow` paint the brand
as text; interactive text such as the Readiness and Trust panel links reads
the action role. Where a channel's own hue fails as text in a mode, that mode
uses a nearby shade for the brand and the roles.
[channel-text-contrast.test.tsx](../../src-ui/src/__tests__/channel-text-contrast.test.tsx)
renders those surfaces and measures each text colour against the background it
sits on, including the raised panel rows and the sidebar hover fill.
Do not copy the package's theme or primitive styles into a feature; propose a
shared value upstream when it belongs to the public design system.

## Device preference and accents

[startup-theme.js](../../src-ui/public/startup-theme.js) selects the saved
light/dark preference before the entry HTML paints, reading the device-settings
envelope before the legacy theme key and falling back to dark if storage is
unavailable. [main.tsx](../../src-ui/src/main.tsx) applies the canonical theme,
accent and cached branding before React renders. The initial HTML and
[StartupScreen](../../src-ui/src/components/StartupScreen.tsx) share the same
startup surface through platform and authority resolution. The lightweight
[boot entry](../../src-ui/src/boot.ts) starts painting before it imports the full
app. A failed app import releases animation and provides a reload action. The initial HTML loads only splash styles and the published font/token foundations; full app styles retain their original main-entry import order, so mobile layout overrides continue to win. The
bundle budget still counts the immediately loaded app's static JS/CSS closure
through its Vite manifest, in addition to the visible boot assets. The mark begins centered,
then moves left while Fraunces reveals `tation`, using the river as the S. The
selected wordmark uses the Original spacing from the reviewed motion study.
Water falls into a track and spreads across it, then remains an indeterminate
activity signal. It does not claim a percentage or delay a ready app.

[startup-animation.ts](../../src-ui/src/lib/startup-animation.ts) keeps the
intro clock for the document, so a loader remount does not replay it. Pending
platform setup, shared-Project entry and authority observation supply their own
current stage text; labels use Hanken Grotesk and a small entrance transition.
There is no timer-driven sequence of invented loading stages. Reduced motion
uses the completed static lockup and track; hidden windows pause painting, and
unmount removes the frame and observers. Route-level waits still use the state
primitives. The imagery remains the committed Station mark; this splash choice
does not finalize the broader Kontour wordmark decision.

The native OS launch surface follows OS appearance; it cannot read the
WebView's saved device preference. iOS stages a centered mark and appearance-aware
background after Tauri init; Android's channel overlay supplies a dark splash
background in night mode, plus a centered native window mark behind the
initially transparent WebView. A different OS and saved app preference can still
produce a background change at that boundary.
[ThemeToggle](../../src-ui/src/components/header/ThemeToggle.tsx) keeps it in
sync with the device-settings store. The selected light/dark preference belongs
to the Device; changing a server or Project is not a separate theme choice.

The [accent helper](../../src-ui/src/lib/accent-contrast.ts) applies a custom
accent together with its foreground contrast partner and hover treatment.
Use that owner rather than setting only `--accent-primary`; clearing the
preference must clear its companion overrides too. It refuses a value that is
not `#rgb`/`#rrggbb` and clears the override instead. Do not infer legibility
for every tinted background from a foreground-on-solid-accent calculation.

## White-label branding theme

A branding provider's `getTheme()` answer is applied by
[branding-theme.ts](../../src-ui/src/lib/branding-theme.ts) as inline
`--k-brand`, `--k-brand-contrast`, `--k-action`, `--k-action-contrast` and
`--k-focus` on the document element, for the current `data-theme` mode. It is
all or nothing: an unknown key, a non-hex value or a failed contrast check in
either mode keeps the defaults. The check is `validateBrandOverride` from
`@kontourai/ui/contrast`, which rates the brand as text at 4.5:1 on the page,
the panel and the raised panel; Station adds the flat-key input shape and one
stricter text-contrast rule for the action fill. The raised-panel check came
with `@kontourai/ui` 1.18, so an upgrade can reject a theme that was applied
before: a stored theme whose dark brand is under 4.5:1 on the dark raised panel
`#16202d` (relative luminance from about 0.2155 up to 0.2377, such as
`#9364ff`) now falls back to the defaults whole, including its light-mode
colours. The only signal is a `[branding-theme]` line in the browser console of
whoever opens the app; nothing tells the operator or the provider. A mode that
sets only the brand also gets it as its action role, because the installed
tokens define `--k-action` and would otherwise keep buttons and links on the
shipped colour. `main.tsx` applies the last validated copy from
localStorage before the first render, re-validating it, and
[BrandingThemeBridge](../../src-ui/src/components/BrandingThemeBridge.tsx)
replaces it once the branding query answers. A device accent still sets
`--accent-primary` above the theme's action role. The accepted shape and
thresholds are in [examples/custom-branding](../../examples/custom-branding/README.md).

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
