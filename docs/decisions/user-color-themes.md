---
status: current
subject: Named color themes layered on the shipped design tokens, Station unchanged by default
decided: 2026-10-20
evidence:
  - kind: commit
    ref: 26fa8748790
  - kind: commit
    ref: d12b32b0732
  - kind: doc
    ref: src-ui/src/lib/color-theme-catalog.ts
  - kind: doc
    ref: src-ui/src/lib/color-theme-css.ts
  - kind: doc
    ref: src-ui/src/lib/appearance-cache.ts
  - kind: doc
    ref: docs/guides/theming.md
---

# User color themes

A person can choose a named palette on top of light and dark: Catppuccin,
Rosé Pine, Gruvbox, Nord or Tokyo Night. `station`, the default, is today's
look: it sets no attribute, loads no theme stylesheet and adds no
`theme-color`. This sits on `@kontourai/ui`'s shipped `--k-*` roles
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

Values come from device storage, imports, other tabs, the account server and
the appearance cache, any of which can be older or newer than the client. The
UI resolves them (`color-theme-selection.ts`): an unknown family is `station`,
an unknown flavor or accent is the family default, and nothing throws. Ids
share one shape, `COLOR_THEME_ID_PATTERN` in the contracts: the server parses
with it, and the device registry imports flavor and accent under it, so an
import cannot produce a value the server refuses (a refused field fails the
whole patch). The server stores ids, not today's family list, so a newer
client's family is kept.

### Older servers

Downgrades are supported (rollback installs, a launcher's trial rollback, and
deliberately shared homes; see the release-rings and release-channel-ports
guides). A server from before color themes parses its account document
strictly, so the three keys are stored in a sibling `<key>.appearance.json`
that such a server never opens; a test parses what this server writes with
the previous schema verbatim. This server now keeps unknown stored keys on
write and leaves them out of what it serves, so later additions need no
sibling. Its patch schema stays strict: a key it cannot validate is refused,
not silently dropped.

The two documents are written separately, each under its own lock, so a
patch naming keys in both is not atomic across them: if the second write
fails, the first stays. The fields are independent preferences, so a partial
write leaves no inconsistent pair; the client reports the failure as for any
failed save.

An older server still refuses a patch that contains these keys, so the client
shows its existing save-failure notice and keeps the server's value. "Import
previous preferences" sends one patch, so against such a server it fails whole
while this device holds a color theme.

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

`npm run gen:color-themes` renders the catalog into checked-in artifacts, and
a drift test fails when any differs:

- one stylesheet per family, `public/color-themes/<family>.css`, served as a
  static file and loaded only when that family is selected. Nothing themed is
  in the entry bundle, so default users pay for none of it: entry CSS is
  51858 gzip bytes at the base commit and 52486 with this change (the splash
  subset), against 62698 when every theme sat in the entry sheet;
- the splash subset (surfaces, text and focus for every flavor), imported by
  the splash stylesheet and scoped to the splash element, so the first paint
  is themed while the family sheet loads and the app itself is never
  part-themed;
- a small runtime index the startup path resolves against, so the full
  catalog (about 7.5 KB gzip) loads only with the picker;
- an index block in `public/startup-theme.js`.

The startup script runs before any stylesheet. It validates the selection,
sets `data-color-theme`, `data-color-theme-flavor` and
`data-color-theme-accent` on `<html>`, inserts the family's sheet and a
`<meta name="theme-color">` with the effective canvas. A script-inserted sheet
does not block rendering, so `main.tsx` waits for it (at most three seconds)
before the first render: the splash is themed from the subset, and on the
normal path the app never appears in Station's colours after it. The app has
one rule: it is wholly Station until the family sheet has loaded, and wholly
themed after, never theme surfaces with Station's accent. A sheet slower than
the cap therefore shows the app in Station's colours until it arrives, while
the attributes and `theme-color` already name the theme and a white-label
brand is rated against the theme's surfaces. With no theme it renders
synchronously as before. The deferred first render is part of what `boot.ts`
waits for, so if creating or rendering the React root throws after that wait
(for example, a missing `#root`), the page shows the same "could not finish
loading" recovery as a failed module load. Errors inside React components
surface through React, not this path. The wiring is
`renderWhenColorThemeSettled`, which a unit test covers; the one line in
`main.tsx` that exports its promise is not imported by any unit test.

On a live switch the applier changes the attributes only once the new
family's sheet has loaded. A sheet that fails is not claimed: on a live switch
the previous selection stays in force, and a failed startup request un-claims
the theme. The startup script's request gets one automatic retry: if it fails
while the app is running, the applier requests it once more. Otherwise a
failed selection is requested again only when the color-theme selection
(family, flavor or accent) changes or on `retryColorTheme()`; re-applies for
unrelated settings (a mode toggle, a background preference save) keep what is
in force. So a sheet that keeps failing cannot loop, and the failure mark does
not flicker. While the
most recent request for a family has failed, the root carries
`data-color-theme-failed="<family>"`. It is removed when a new request for
that family starts (retrying is not failed; it is set again only if that
request fails), when a later apply loads it, or when the selection changes.
It is exposed for an Appearance page to offer a retry; nothing on this branch
reads it.
`color-scheme` is already set per mode by the tokens.

### Signed-in people

Account values never enter the device-settings envelope. So the color-theme
applier records what it rendered, mode and color theme, and whether the
account supplied it, in `station-appearance-v1` (`lib/appearance-cache.ts`). It
is a cache of what was rendered, not a copy of account values into device
settings: nothing edits it and it decides nothing once the account answers.
Precedence, the same in the startup script, `resolveBootTheme` and the
settings store's boot snapshot:

1. An account-sourced cache wins until the page knows whose appearance
   applies: the account's values arrive, the device's own appearance is
   chosen, or the page gets a definite "no person". The definite answers:
   - the session gate's direct access check answering no session (the
     signed-out connect screen, where the account boundary never mounts);
   - on a relay route, the account scope settling with no account (none
     selected, or signed out), or a completed identity check that the Station
     refused (`authentication-failed`). An unreachable, timed-out, mismatched
     or otherwise failed check is not a refusal;
   - an explicit sign-out: the account entry's sign-out, and the native relay
     route's sign-out or local account retirement (the native logout retires
     the local session whether or not remote revocation is confirmed);
   - the account boundary seeing a refused credential (401) or a verified
     principal that is not a person.

   States still resolving keep the cache: the relay connect screen shown
   while the account is being checked, no connection yet, a native relay
   account not ready, and an unverified authority (offline, an older server).
   A 403 `insufficient_scope` from the authority observation also keeps it
   (accepted, conservative). On release the applier rewrites the cache as
   device-sourced.

   Known gaps, accepted:
   - The relay probe reports a reason, not a status or code, and
     `authentication-failed` covers more than a refusal of this person: a 403
     `insufficient_scope`, a 429 authentication rate limit, and the local
     `station_application_authority_required` / `_invalid` failures (a stale
     or missing authority record, an expired continuation, a thumbprint
     mismatch). All of those release on a relay route. Follow-up: expose probe
     status.
   - A relay authority storage read error publishes a settled scope with no
     account, which reads as a definite no-account and releases.

   The same hold applies inside a session: when the account boundary unmounts
   (an authority re-check after a dropped connection, a switch, a sign-out)
   the account's last mode and color theme stay in force until one of the
   answers above arrives, so a network blip no longer shows the page in the
   device's appearance while the account reconnects. The hold belongs to the
   account that set it: a binding for a different account releases it, and
   that account sees the device's own appearance until its preferences
   arrive. A definite no-person answer while the boundary is still mounted
   (an in-app sign-out) also means its unmount holds nothing, including
   across the boundary re-binding in the same task. The mode half of that blip is inherited from main, where ending
   the binding resolved the device's own light/dark until the preferences
   returned.
2. Otherwise the device envelope, then the legacy `theme` key, as before. A
   device-sourced cache is never read; the envelope is its source.

So a signed-in person's last appearance is in force before first paint on a
device that has rendered it once. A first visit, or a change made on another
device since, still shows the previous appearance until the account answers.

The cache is per origin, not per person or Station: a device shared by two
people, or one origin used for several Stations, paints whichever account's
appearance was rendered last until the account boundary resolves. It holds
only a mode and palette ids, never account data.

## Precedence

- White-label branding (inline style on `<html>`) wins on every brand slot,
  but it was validated against Station's own surfaces. Under a named theme
  each slot group (brand and its text, action and its text, focus) is rated
  again on the theme's page, panel and raised panel with the same thresholds;
  a group that fails is left to the theme's value and reported like any
  branding rejection. The rating reruns when the mode, theme or channel
  changes.
- A Dev, Beta or Nightly build keeps its identity on `--k-brand`, using the
  catalog's per-flavor shade of the channel colour because the channel's own
  colour fails as text on several theme surfaces. The theme owns action and
  focus.
- A custom `accentColor` still wins on `--accent-primary`.
- Only the root is themed. An element with its own `data-theme` below it (an
  island) keeps Station's tokens. Station has none today, and rules for them
  doubled every sheet; a future island needs its own decision.
