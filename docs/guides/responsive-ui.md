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
- the `responsive-surface-overlay` and `responsive-surface-panel` markers;
- an overlay context, linked to the surface it was opened from, so a menu
  inside it can take a layer above it (see [Action rows](#action-rows)).

Give the surface an accessible name. Do not add a second document Escape
listener, backdrop handler, focus trap or mount-time input focus. On a phone,
automatic input focus should follow an explicit request to type, rather than
summoning the keyboard when a person opened a chooser. `dismissible={false}`
suppresses the shared dismissal paths; the feature still owns a meaningful
completion/recovery path.

Wrap custom footer controls in `ResponsiveSurfaceActions`; `Dialog` already
does this for its footer. Feature classes own desktop layout and colors. The
shared mobile rules permit wrapping, add bottom safe-area padding, and give
matching direct-child controls a 44px minimum, under the phone-width query
only. A wide touch tablet does not match that query; a control that needs the
floor there declares it itself under `(hover: none)`. Use the existing block in
`index.css` for a control styled by the entry sheet (today the send-blocked
line's Remove attachments, the queued-retry Discard the composer repeats in a
short dock, and the transcript notice actions such as Retry and Discard). Use
the feature's own sheet for a control styled by a lazily loaded chunk, which
lands later in the cascade (today the Diff tools in the Coding side panel's
head). Nested controls and overflowing content still need their own caller
test.

On a phone, a request that needs the person — a harness question, an MCP
elicitation form or a tool approval (#3390) — keeps a compact card in the transcript and is answered in
[`RequestSheet`](../../src-ui/src/components/chat/RequestSheet.tsx), one
`ResponsiveDialogSurface` consumer shared by every such feature (#3331). It pins
the feature's own action row below a scrolling body, fits its height to the
content, and treats every dismissal path (backdrop, a swipe down on its grab
strip, Escape, back, the close control) as hide-only: the request stays pending
until one of its explicit actions answers it. `useRequestSheet(pending)` closes
the sheet when an answer given on this page settles the request; a request
resolved elsewhere leaves the pending list instead, which unmounts the card and
its sheet together. Desktop keeps the feature's inline card.

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
sheet should not scroll the page behind it. The outer `.app__main` frame uses
`overflow: clip` where supported so section focus cannot pan the toolbar away;
its explicit minimum sizes keep phone flex layouts shrinkable. Nested
`.content-view` and region bodies retain their own scrolling. Older WebViews
keep `overflow: hidden`; preventing their programmatic frame scroll is not
established by the Chromium checks. Apply safe-area values at the owning
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

### Mobile sheet typography

At the shared mobile breakpoint, `responsive-surface-panel` raises the compact
Station text aliases to the published Kontour UI tokens: supporting text uses
`--k-text-md` (14px), and shared sheet headings and action-menu labels use
`--k-text-lg` (18px). Desktop density remains owned by each surface. The task
picker uses 18px titles with up to two lines, Agent icons, 14px project/status
metadata, and a pinned New chat action at the lower right. Project names wrap.
The project picker retains [PickerCreateAction](../../src-ui/src/components/PickerCreateAction.tsx)
for its 52px add button. Chat creation shares [NewChatAction](../../src-ui/src/components/NewChatAction.tsx)
across the task picker, desktop inbox, the collapsed dock bar (icon only) and
the open, empty dock. The mobile bar composes the same conversation-plus glyph
with its toolbar button styles. Both forms retain a 44px minimum target and
an accessible name. It opens the start composer: its two chips stay on one line (the Agent
chip gives up width first) and the overflow sits with Start, so a phone gets
the chips on row one and [⋯ … Start] on row two with no viewport query; every
target is 44px, and the chip menus are edge sheets on a phone with their own
scrolling list. Creation controls remain outside the scrolling lists. The task picker presents
Input/Approval compactly and keeps reasons readable in full through details;
Git and PR data are read only when that details surface opens.

A page's one creation action uses
[PageCreateAction](../../src-ui/src/components/PageCreateAction.tsx): the
labelled primary button in the page header on desktop, and on phones a floating
round "+" in the lower right, so the stacked header does not give it a row of
its own. The "+" is [CreatePlusButton](../../src-ui/src/components/CreatePlusButton.tsx),
the same control the picker footers use. It keeps the label as its accessible
name, sits on the floating-action layer above `--dock-bottom-clearance` (dock,
safe area and on-screen keyboard), stays below dialogs, and hides while a
maximized chat or a detail sheet fills the screen. Use it only for creating
something; Connections is the first adopter.

The mobile header's **New chat** uses an icon-only chat-bubble-plus control in
the same toolbar button family as its neighbours, retaining its accessible
name. Source and component checks establish these placements and disabled
states. The relay UX screenshot harness omits the real dock and uses stubbed
data, so its geometry does not qualify dock/keyboard clearance, native operator
flow, physical devices or a released Nightly.

Shared panel entrances fade and translate upward by `--k-space-4` on mobile,
without scaling touch targets. Existing surfaces with a directional entrance
keep their own motion. The global reduced-motion reset still applies. Source
rules describe the treatment; browser checks at narrow widths, both themes,
long content and short heights establish whether controls remain reachable.

### Action rows

A header, toolbar or action row shows at most two labelled actions. Further
actions go into an overflow menu; an icon-only button with an accessible name
does not count.

Write a row with [`ActionRow`](../../src-ui/src/components/ActionRow.tsx). It
takes a `primary` action, a `secondary` action and `overflow` items, so there
is no slot for a third labelled button. `overflowLabel` names the `⋯` trigger
and its menu. An overflow item marked `tone: 'danger'` is painted as
destructive and moved last, behind a separator. An item with `checked` is a
toggle row (`menuitemcheckbox`); adding `exclusive` makes it one of a set
(`menuitemradio`), such as a merge method. `separatorBefore` draws a separator
above an item, for commands that follow a set of choices. A disabled item can
carry a `disabledReason`, shown under its label; such a row is `aria-disabled`
rather than `disabled`, so the keyboard can reach it and hear the reason, and
it refuses activation. A row with neither `primary` nor `secondary` shows the
first word of `overflowLabel` beside the `⋯` ("Manage ⋯" for "Manage Kiro
CLI"), which is then the row's one labelled action. The row's buttons and the trigger have an always-on 44px
hit area, and the trigger takes the height of the buttons beside it, so a row
needs no page-local responsive rule for its touch targets.

The menu is
[`ActionOverflowMenu`](../../src-ui/src/components/ActionOverflowMenu.tsx),
which the dock header's More menu also uses. It is placed from measured
geometry: below its trigger when it fits, otherwise on the side with more
room, capped to that room with internal scroll, kept inside the viewport
gutters, and re-placed once per frame on scroll and resize; it closes when its
trigger scrolls out of the viewport. Its layer is the one just above whatever
hosts its trigger: the highest z-index among the trigger's ancestors and among
the overlays it was opened from, which
[`ResponsiveDialogSurface`](../../src-ui/src/components/ResponsiveDialogSurface.tsx)
provides through [an overlay context](../../src-ui/src/components/overlay-layer.ts)
because a portal hides them from the DOM. With no such host it stays on the
navigation layer, below dialogs.

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
It counts only `Button` and `button`, plus an `ActionRow`'s filled slots (one
when neither is filled) and an overflow menu that shows a word; other components that render
a button, and labels passed as props or spreads, are not seen. Tabs, menu
items, toggles carrying `aria-pressed`, `aria-selected` or `aria-checked`,
menu triggers (`aria-haspopup` bare, `true`, `"menu"` or `"listbox"`) and
title-and-description cards are not counted. A `role` or `className`
exempts only when it is a static string; a conditional or computed value
exempts nothing. An element with content between two buttons ends a run. A
ternary's arms are alternatives: the row is counted once per arm and the
largest count stands. `&&` branches all count unless the syntax tree proves
their guards exclusive: a name or dotted chain against its own `!`, or one
chain compared with literals. A guard containing `||`, `??` or a call is
never proved exclusive, so such branches are summed. A file that does not
parse fails the gate. Renaming a recorded row's file, component or class
reports it as new; edit that entry's `row` by hand.

For what the scan cannot see, a Playwright spec can count what a page shows
with [`actionRowsOverCap`](../../tests/helpers/visible-action-count.ts): the
visible buttons displaying a word, per `[role="toolbar"]`, `header` or
`.action-row`, at the viewport the spec set. Its
[own test](../../src-ui/src/__tests__/visible-action-count.rendered.test.tsx)
proves the count in Chromium, and
[the Skills journey](../../tests/skills.spec.ts) asserts it on the skill
detail header at 1280 and 390 pixels. No other screen calls it yet.

For changed behavior, use the existing owner tests and an affected caller
journey. Check initial focus, Tab traversal, Escape/backdrop, history behavior,
focus return, reachable actions, long content, both themes and keyboard-sized
viewports. Reuse [the Playwright viewport helper](../../tests/helpers/visual-viewport.ts)
for controlled geometry. Its simulated keyboard does not replace a real
browser/native keyboard run. The [testing guide](testing.md) explains how to
record PASS, FAIL and NOT_VERIFIED without turning missing prerequisites into
success.
