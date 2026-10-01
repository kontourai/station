# Responsive UI contracts

New Station surfaces should reuse the shared layout and interaction owners
below. These are contributor requirements and current implementation boundaries,
not a claim that every existing screen has passed a phone or accessibility
journey. The inventories record both covered cases and remaining adoption work.

## Shared package and Station responsibilities

Kontour UI owns its public `--k-*` tokens, product themes and primitive contracts.
Consult the [consumer guide](https://github.com/kontourai/ui/blob/main/docs/consumer-guide.md)
and [explorer manifest](https://github.com/kontourai/ui/blob/main/docs/explorer-manifest.json).
Use the installed package's public exports when implementing against Station's
pinned dependency; upstream `main` can describe a different version.

At that public package boundary, Station owns only adopter behavior. Shared
tokens and primitive accessibility contracts stay with Kontour UI; the local
shell responsibilities and remaining adoption work below stay with Station.

Station composes those tokens and selected primitives with its own shell,
navigation, responsive geometry and domain behavior. Adoption is partial:
Station's [Dialog](../../src-ui/src/components/Dialog.tsx) and
[ResponsiveDialogSurface](../../src-ui/src/components/ResponsiveDialogSurface.tsx)
are local owners, not aliases for the package's native-dialog primitive. Do not
copy package CSS or accessibility implementations into a feature. Extend the
owning primitive when it needs shared behavior; keep Station-specific routing,
history and viewport integration at the Station boundary. See [theming](theming.md)
for the actual token cascade and channel overrides.

## Dialogs and sheets

Use `Dialog` for standard Station dialog chrome: labelled title, close action,
scrollable body and footer. It composes `ResponsiveDialogSurface`. Use the lower
level component for a surface with custom chrome; that consumer must supply its
own overlay positioning/background and panel colors. The shared markers do not
by themselves produce a complete visual dialog.

`ResponsiveDialogSurface` currently owns:

- a portal to `document.body`, avoiding the dock's stacking context;
- Visual Viewport height/offset variables and mobile containment styles;
- initial focus (`panel` by default; `desktop` or `always` only when justified),
  Tab-boundary handling and return-focus restoration;
- Escape and backdrop-pointer dismissal when `dismissible` permits it;
- dialog-history registration when a history host is present and
  `historyMode="entry"` applies;
- the `responsive-surface-overlay` and `responsive-surface-panel` markers.

Give the surface an accessible name. Do not add a second document Escape
listener, backdrop handler, focus trap or mount-time input focus. On a phone,
automatic input focus should follow an explicit request to type, rather than
summoning the keyboard when a person opened a chooser. `dismissible={false}`
suppresses the shared dismissal paths; the feature still owns a meaningful
completion/recovery path.

Wrap custom footer controls in `ResponsiveSurfaceActions`; `Dialog` already
does this for its footer. Feature classes own desktop layout and colors. The
shared mobile rules permit wrapping, add bottom safe-area padding, and give
matching direct-child controls a 44px minimum. Nested controls and overflowing
content still need their own caller test.

Every `ResponsiveDialogSurface` declares `layer="dialog"`, `"popover"` or
`"system"`. [The token scale](../../src-ui/src/tokens.css) includes dock,
anchored surface-popover, navigation, notification and palette tiers as well as
sticky/dialog/system. A surface popover stays above the dock but below navigation and notification
chrome; a modal dialog supersedes notification chrome.
Do not use feature-local large z-index values to compensate for a wrong owner
or stacking context. A blocking system surface must explicitly choose the
system layer. Test stacked dialogs and notices together, not only in isolation.

Package-owned surfaces such as Station Connect retain their package boundary.
They need their own behavior evidence; similar class names are not proof that
they use Station's local component or inherit all of its behavior.

## Viewport and full-height workspaces

Use [useIsMobile](../../src-ui/src/hooks/useIsMobile.ts) for JavaScript layout
choices. Its current query covers widths up to 768px **or** a coarse-pointer
viewport up to 540px tall, so landscape phones retain mobile behavior. Keep
corresponding CSS conditions aligned. The documentation token `--bp-mobile`
cannot be substituted into a CSS media query. Dock placement has a different
policy: a wide coarse-pointer device can be bottom-only without being mobile.

Use [useMobileVisualViewport](../../src-ui/src/hooks/useMobileVisualViewport.ts)
at the surface or workspace boundary that needs geometry, then size descendants
from `--responsive-visual-viewport-height`. It combines Visual Viewport readings
with the Android inset projection and falls back to window dimensions. The
separate document publisher, installed by `main.tsx`, exposes
`--visual-viewport-bottom-inset` for fixed siblings. The hook is not a global
singleton: do not add redundant subscriptions in every nested panel.

Use flex/grid with `min-width: 0` and `min-height: 0` where content must shrink.
Keep one bounded scroll owner per region; use overscroll containment where a
sheet should not scroll the page behind it. Apply safe-area values at the owning
boundary, accounting for nested surfaces rather than adding the same inset to
every child. Terminal/editor phone controls should stay in one horizontally
scrollable row; their input font must avoid mobile browser zoom. Test the real
terminal/editor caller instead of assuming a CSS declaration proves this.

## Controls and enforcement

Use `.tap-target` for compact interactive controls; the local floor is 44 by
44 CSS pixels. Preserve visible keyboard focus. These CSS rules do not prove
actual hit area after transforms, overlays or clipping.

Record discovered modal-like surfaces in
[responsive-surfaces.json](../ui/responsive-surfaces.json) and action surfaces in
[responsive-action-surfaces.txt](../ui/responsive-action-surfaces.txt). New
Station dialogs must adopt the shared owner; do not introduce Station modal
exceptions. Package exceptions require a boundary rationale and evidence.

The [responsive ratchet](../../scripts/responsive-surface-ratchet.mjs) discovers
specific Modal/Drawer/Popover/Sheet filenames and action-class spellings. It
checks inventory coverage, evidence text and declared component adoption; it
does not execute those evidence files or discover every possible dialog name.
Action inventories allow explicit deferred cases. The
[mobile CSS ratchet](../../scripts/mobile-css-ratchet.mjs) separately limits
named page-local responsive rules. A green ratchet is structural evidence,
not a universal accessibility, keyboard or device certificate.

### Action rows

A header, toolbar or action row shows at most two labelled actions. Further
actions go into an overflow menu; an icon-only button with an accessible name
does not count.

Write a row with [`ActionRow`](../../src-ui/src/components/ActionRow.tsx). It
takes a `primary` action, a `secondary` action and `overflow` items, so there
is no slot for a third labelled button. `overflowLabel` names the `⋯` trigger
and its menu. An overflow item marked `tone: 'danger'` is painted as
destructive and moved last, behind a separator; a disabled item can carry a
`disabledReason`, shown under its label. The row's buttons and the trigger
have an always-on 44px hit area, so a row needs no page-local responsive rule
for its touch targets. The menu is
[`ActionOverflowMenu`](../../src-ui/src/components/ActionOverflowMenu.tsx),
which the dock header's More menu also uses.

The [button-cap ratchet](../../scripts/button-cap-ratchet.mjs)
(`npm run button-cap:ratchet`) holds the same line for rows written without
`ActionRow`. It parses every UI `.tsx` file and fails when a JSX element holds
an unbroken run of more than two labelled `Button` or `button` siblings that
[its baseline](../../scripts/button-cap-baseline.json) does not record, or
when a recorded row gains one. Rows are identified by file, enclosing
component and element, never by line. A recorded row that shrinks only prints
a note; `--record` lowers the baseline and refuses to raise it or add a row.
`--report` lists every row over the cap with its labels. A baseline entry
with a `reason` is one the scan misreads; one without is a row still to fold.

The scan reads source structure, not layout. It does not see actions assembled
from an array or split across components, anchors styled as buttons, whether
siblings render in one line, or how a header collapses as width shrinks.
Tabs, menu items, pressed or selected toggles and title-and-description cards
are not counted. `&&` branches all count unless their guards are textually
exclusive (`x` and `!x`, or one expression compared with different literals),
so branches that are exclusive for any other reason overcount.

For what the scan cannot see, a Playwright spec can count what a page shows
with [`actionRowsOverCap`](../../tests/helpers/visible-action-count.ts): the
visible buttons displaying a word, per `[role="toolbar"]`, `header` or
`.action-row`, at the viewport the spec set. Its
[own test](../../src-ui/src/__tests__/visible-action-count.rendered.test.tsx)
proves the count in Chromium; no product journey calls it yet.

For changed behavior, use the existing owner tests and an affected caller
journey. Check initial focus, Tab traversal, Escape/backdrop, history behavior,
focus return, reachable actions, long content, both themes and keyboard-sized
viewports. Reuse [the Playwright viewport helper](../../tests/helpers/visual-viewport.ts)
for controlled geometry. Its simulated keyboard does not replace a real
browser/native keyboard run. The [testing guide](testing.md) explains how to
record PASS, FAIL and NOT_VERIFIED without turning missing prerequisites into
success.
