---
status: current
subject: A person's own palette and CSS; agents propose, the person previews and keeps
decided: 2026-11-15
evidence:
  - kind: doc
    ref: packages/contracts/src/custom-appearance.ts
  - kind: doc
    ref: src-server/routes/me/custom-appearance.ts
  - kind: doc
    ref: src-ui/src/lib/custom-appearance/controller.ts
  - kind: doc
    ref: src-ui/src/lib/custom-appearance/keep-bar.ts
  - kind: doc
    ref: src-ui/src/lib/custom-appearance/decision-surfaces.ts
  - kind: doc
    ref: docs/guides/theming.md
---

# Custom appearance

A person can restyle Station for themselves: a palette over the
`@kontourai/ui` roles and custom CSS. An agent can write one for them. This
sits on top of the mode, the named color theme
([user color themes](user-color-themes.md)) and white-label branding; it
changes no shipped token.

## The document

Each person has one document on each Station, `/api/me/appearance`, stored
under `config/custom-appearance/` keyed by tenant and principal like account
preferences, with the same lock and atomic write. It is its own document, not
an account-preference key: that document has old-server sibling-file rules and
no compare-and-set. The owner is the request's own principal, through the
resolver every `/api/me` route uses, so no path or body names a person.
Device-only principals and non-people are refused (403), as for account
preferences. The document holds:

- `active`: the appearance in force, or none;
- `proposal`: one pending proposal, with a server id;
- `renderReport`: what the person's browser saw when it previewed that
  proposal;
- `revision`: a digest of `active` and `proposal` (not the report, so the
  browser that reported can still Keep with the revision it read).

An appearance is `{ version: 1, name, palette, css, visual? }`. The name refuses
control and bidirectional formatting characters, which could reorder the
preview bar's "proposed by an agent" line. The palette has an
optional entry per mode (`dark`, `light`) with `roles`, a map over
`APPEARANCE_ROLE_PROPERTIES` (the same list the color-theme catalog reads),
and `accent`, one hex that supplies brand, action and focus with a derived
black or white text partner. Values are `#rgb` or `#rrggbb`.

## Propose, preview, keep

Agents may read and propose. Keep, save, dismiss, turn off and the render
report refuse any request that may be an agent's (`requestMayBeAnAgent`, 403
`custom_appearance_person_only`), as the Personal Board routes do. Propose,
save and keep compare the revision; a stale one is 409. A change that would
take the stored document over its 16 MiB limit is 413
`custom_appearance_store_full` and changes nothing.

"Only the person" means only a request that is not recognizably an agent's:
`requestMayBeAnAgent` sees station-control's internal credential and its
agent-origin header. An agent that holds the person's own CLI credential, a
personal access token, or a signed-in browser (a Browser pane on Station
itself) is indistinguishable from the person and can save or keep directly.
This is the Personal Board posture; the same agent could press an approval in
that browser too.

Station-control has `get_appearance` (the document plus a guide: roles, CSS
rules, hook selectors, "propose small changes; the person previews at
/appearance") and `propose_appearance`. Both are `role: 'self'` with any
caller assurance, the Personal Board tools' policy: a proposal changes nothing
the person has not seen, so a bearer-exposed caller may make one. They are in
the restricted-network allow-list for the same reason.

The person previews a proposal in their own tab from the Appearance page. It
applies at once and reverts after 20 seconds unless kept; a bar shows the
countdown. Escape reverts without deciding; Discard dismisses the proposal;
Keep makes it active. The person can also edit a palette and CSS and save
directly, or preview their own draft.

## What is checked where

The server refuses what it can rate from the proposal alone, so an agent gets
the reason in the tool result:

- shape, name length, hex values and known roles;
- CSS over 50,000 characters, any backslash, `@import`, `@font-face`,
  `image-set()`, `cross-fade()`, `image()`, `src()`, `attr()`, and `url()`
  other than `data:`, or `#id` in exactly `filter`, `clip-path`, `mask`,
  `mask-image`, `marker`, `marker-start`, `marker-mid`, `marker-end` and
  `offset-path` (with `-webkit-` forms of clip-path, mask and mask-image).
  Elsewhere `url(#x)` resolves against the page and fetches the page itself;
  prefixes are not trusted, because `mask-box-image` takes an image (found in
  review), and a Chromium test confirms each listed property makes no
  request. A double quote inside a single-quoted string, or a control
  character in a string, in a declaration with a URL-taking function is
  refused too: the browser re-serializes it with a backslash, which its
  guard refuses next to `url()`, so the server says so first ("use single
  quotes in a data: SVG, or percent-encode the double quotes"). The text is lowercased, comments are removed outside strings,
  and it is checked declaration by declaration, split outside strings and
  parentheses; deliberately conservative;
- contrast, at 4.5:1, of each pair whose two values the proposal sets itself:
  the text ramp on page, panel and raised panel, the accent as text on those
  surfaces, status tones on page and panel, status-contrast text on each tone,
  and the accent's text partner on the accent. These are the color-theme
  catalog's rules, with the brand-as-text pair from `validateBrandOverride`
  and Station's action-as-text rule, all at the text threshold.

The browser is the guard. The CSS is parsed into a constructed stylesheet and
the parsed rules are walked (`sanitize-css.ts`): style rules, nested rules,
`@media`, `@supports`, `@container`, `@layer` and `@keyframes` are kept, every
other at-rule is dropped, and a declaration whose parsed value fetches is
removed, including custom properties. A backslash is refused where it could
still matter: in a custom property's raw value or any value holding `var()`
(substitution re-tokenizes it, so `\75 rl(` becomes `url(`), and in any value
with a URL-taking function (the URL parser reads `\` as `/`, so
`url("\\data:…")` and `url("\\#x")` load a same-origin path; found in
review). Elsewhere it is ignored, because the CSSOM adds its own escapes when
it serializes strings and attribute selectors (`[title='"']`), which the
server accepts. A block that still fetches after that (a shorthand holding
`var()`) loses its declarations, and a sheet whose final text still fetches
applies nothing. Block and sheet text is split into declarations outside
strings and parentheses, so a `";"` cannot cut a declaration in two (found in
review: `var(--e) ";" \75 rl(…)` slipped through a naive split). Checking
parsed values is what defeats escapes and case tricks: `\75 rl(` and `URL(`
both serialize as `url(`.

The palette is one adopted sheet of `:root[data-theme="<mode>"]` blocks with
`!important` values, so it applies over Station's tokens, a named theme's sheet
and the inline white-label and device-accent values. The CSS is a second
adopted sheet; adopted sheets follow every document sheet in the cascade.

## Approval surfaces are out of reach

CSS can hide, move, relabel or cover a control. Custom CSS an agent wrote
could disguise an Approve button as Deny, or overlay one, to get its own
request approved. So while any decision surface is mounted, the CSS sheet is
disabled; the validated palette stays (it has passed the contrast rules and
cannot move anything).

A decision surface is any component where a person grants authority:
tool and permission approvals, input requests, the exact-request and
inspection approvals, the inbox approval row, plugin permission requests, MCP
app tool-call confirmation, approval and pairing toasts, peer Station
requests, needs-input replies, tool access requests, agent terminal runs,
plugin install and update confirmation, extension access consent, integration
trust review, device pairing review, relay device enrollment, relay route key
and browser Station trust approval, the share-answer pairing prompt, Task and
account sharing controls, the usage-sharing prompt, job, automation and
check-back proposals, proposed file changes and gate exceptions, and the
standing grants a person sets: the approval mode sheet with its full-access
confirm, allowing agents to control devices, people's roles, and the
integration trust and editor panels, the ACP session mode sheet (it applies
a mode at once), default approval modes for the account and for an Agent,
memory review, device sharing and personal access tokens. Any notification
that carries actions registers, not only tool-approval and pairing toasts.
Each owner
calls `useDecisionSurface(id)` (a layout effect, so the sheet is off before
the browser paints the decision), and ids come from one typed list.
Over-suspending costs only convenience, so owners that are always mounted on a
settings page (the sharing controls, relay operator panel, integration trust
and editor panels, people, device setup) register whenever they are mounted.
The cost: while any registered owner is mounted (a pending approval in the
chat dock, or one of those settings pages), custom CSS is paused and a preview
cannot be kept (below).

The palette stays during a decision. It cannot move or relabel a control, but
it can recolour one: a palette that swaps the positive and negative tones makes
Deny read green. The controls carry their labels, and the palette's changed
text pairs must pass contrast, in both modes, before it can be kept (below).

## The preview bar

The bar must not be hideable or spoofable by the CSS it previews:

- It is a closed shadow root on a host that is a child of `<html>`, not of
  `<body>`. Document CSS cannot select into it; the host's position, display,
  visibility, opacity and transforms are inline `!important`, which beats any
  author `!important`; `all: initial` stops inherited colour and font, and the
  bar's own styles use literal values (custom properties inherit through
  `all`). The host's own `::before` and `::after` are outside the shadow tree
  and would paint inside the bar's top layer, so a shadow `:host` rule turns
  them off with `!important` (which beats the document's), and Keep is
  disabled if either paints anyway (found in review: a pointer-transparent
  `::after` reading "Discard" over Keep).
- It is a manual popover, so it is in the top layer above anything the page
  can stack, and the page's own opacity does not reach it (measured: with
  `html { opacity: 0 }` the bar still paints).
- Keep accepts only a trusted activation: a pointer click where Keep is the
  topmost element at the pointer through both the document and the shadow
  root, or a keyboard activation while Keep has focus. Keep is not focused on
  mount. While `<html>` or `<body>` is made invisible or moved (opacity,
  visibility, display, filter, transform, translate, scale, rotate,
  clip-path, mask, mix-blend-mode, content-visibility, zoom), the bar is
  moved off screen, anything covers Keep, or a hit test at five points of the
  page lands on `<html>` or `<body>` themselves (the app fills the viewport, so
  that is a pseudo-element overlay such as `html::after { position: fixed;
  inset: 0 }`), Keep is disabled and says why. The hit test assumes the app
  root fills the viewport, which it does today (`100dvh`); a page that left
  body showing would disable Keep. Keep is also off while
  an approval holds the preview's CSS back (the person would keep CSS they did
  not see), in a safe-mode tab, and when a text pair the preview changed fails
  contrast on the palette over the theme, in either mode (the mode not on
  screen is read by switching `data-theme` and back in one synchronous task;
  a root-theme observer sees two attribute records). The bar's direction is
  pinned left to right, which `all: initial` does not reset.
- Escape reverts. Whatever else fails, the countdown reverts.

`* { display: none !important }` includes `<html>`, which removes every box
on the page including the bar; that preview cannot be kept and reverts on
Escape or the countdown.

## Feedback to the agent

When the person previews a proposal, the browser posts a render report for
that proposal id: how many elements each hook selector matched, the contrast
of the roles in the mode on screen (only pairs the preview changed, since a
theme's own pairs are not the proposal's doing), and what the guard removed.
`get_appearance` returns it. The roles are read with the custom CSS out of the
cascade, so they are the palette over the theme: rating what the CSS computes
would let CSS that sets a role only when the page holds some text
(`:root:has([data-x^="k"])`) read that text back through the ratios (found in
review). The hook counts use fixed selectors, so they disclose only how many
of those elements the page has.

## Stable selectors

`APPEARANCE_HOOKS` in the contracts lists the selectors custom CSS may rely
on, with descriptions: the sidebar, the three dock regions (`data-region`),
the chat header, the transcript, a person's and an agent's message, the
composer, a dialog panel, a menu and a button. Class names are not part of
the contract.

## Recovery and pre-paint

`?appearance=safe` turns custom appearance off in that tab for the rest of its
session; the Appearance page says so and offers to turn it back on. The page
also offers "Turn off custom appearance", which saves none.

The last applied appearance is cached in `localStorage`
(`station-custom-appearance-v1`) as the text the server accepted, and
`main.tsx` parses, checks and sanitizes it again before the first render. The
sanitized serialization is not cached: the CSSOM expands shorthands, so a
49,002-character sheet serializes to 74,057 characters, over the limit the
parse enforces, and every reload flashed (found in verification). The cache
carries no owner; see the gaps. `CustomAppearanceBridge` replaces it when the
person's document answers. A refusal (401, 403, 404) turns it off and clears
the cache; a network failure keeps it.

## Accepted gaps

- The server's text check splits on strings and parentheses, so a stray `(`
  or quote inside an unquoted `url()` (`filter:url(data:a(b);
  background-image:url(#x)`) desyncs it and can attribute a declaration to
  the wrong property. The browser guard reads the parsed declarations and
  contains it.
- Person-only routes rely on `requestMayBeAnAgent` (see Propose, preview,
  keep): an agent with the person's CLI credential, a personal access token
  or a signed-in browser pane can save or keep directly.
- The CSS guard is tested only in Chromium. The macOS desktop app renders in
  WKWebView, where the CSSOM walk is NOT_VERIFIED; the final re-check of the
  whole sanitized text, and the server's text check, are the backstop there.
- An overlay with `pointer-events: none` is invisible to the page hit test, so
  an opaque one (`html::after { pointer-events: none; ... }`) leaves Keep
  enabled; the person sees a page that is covered. An overlay drawn by an
  element inside the app is also not caught; Keep still works through the top
  layer.
- Theoretical: a top-layer element opened after the bar, with
  `pointer-events: none`, could paint over it without failing the topmost
  checks. Station opens no such element from CSS; CSS cannot create one.
- The contrast gate and the render report rate the palette with the CSS out of
  the cascade (so the report cannot leak page content). CSS that sets a
  background without its text colour is not rated: in review, a proposal that
  restyled `[data-slot="button"]` left a disabled button's label invisible
  while the report showed no contrast failure. The agent guide says to set the
  colour with the background.
- CSS can tell it is being previewed (the bar is an extra child of `<html>`,
  in the top layer) and can change over time (an animation delayed past the
  countdown), so a kept appearance can look different from its preview. The
  guarantees that do not depend on the preview hold regardless: approval
  surfaces suspend the CSS, nothing fetches, and the person can turn it off or
  open a safe-mode tab.
- Custom CSS can make any non-decision surface unreadable or hide it,
  including by setting `--k-*` variables, which the palette's contrast gate
  does not see. The render report and the Keep gate rate the palette over
  the theme with the CSS out of the cascade; there is no gate on CSS
  legibility.
- The server cannot rate a pair whose other side comes from the theme in
  force; the browser rates it at preview, in both modes, against the theme in
  force then. A later change of named theme is not re-rated.
- White-label branding and a device accent are inline values written for the
  mode on screen and are not rewritten during the other mode's read, so with
  either active and no palette accent, the other mode's accent pairs are rated
  with the shown mode's values (found in delta review). A person's draft Keep
  also fails with 409 if an agent proposes during its preview; Save works
  again on the re-read revision.
- The cache follows the spirit of the appearance-cache ownership rule, not
  its full machinery: it belongs to whoever's document last answered on this
  origin. On a browser shared by two people, or on the signed-out connect
  screen, the previous person's custom appearance shows until the account
  boundary's read answers for someone else or refuses. It holds only that
  person's own palette and the CSS text the server accepted, which is checked
  and sanitized again before it applies.
- The registry relies on each decision owner calling the hook. Render tests
  prove registration for 18 of the 41 ids (named in
  `decision-surfaces.test.tsx`: permission request, tool approval, URL input
  request, proposed change, exact request, device pairing, needs-input reply,
  terminal run, job, automation and check-back proposals, approval mode,
  notifications with actions, account and Agent approval defaults, memory
  review, people roles, access tokens). The rest are one-line calls verified
  by review only. A new decision surface that forgets the hook is not
  suspended.
- No capability flag: the UI treats a 404 from an older Station as "not
  supported" and hides the Custom section; the agent tool reports the 404.

## Appearance studio extension

The off-by-default `appearance-studio` preview offers typed visual controls,
bounded embedded raster images, a saved library and portable theme files.
The person remains the only writer of saved/applied themes. New visual and
library operations select the live preview choice inside the storage mutation
lock. Existing reads and turn-off remain available, and already accepted
appearances continue rendering after the preview is disabled.

Images are PNG/JPEG/WebP base64 data with bounded file bytes, signatures,
structural headers and dimensions; they are not decompressed by the contract
parser. A browser decode can still reject malformed compressed pixels. A
portable pack is strict versioned JSON with only the appearance payload.
Library writes share the owner's atomic file and have their own revision;
renames/edits return the ID of the resulting saved appearance.

A successful `propose_appearance` result can render an inline conversation
card. Its exact proposal ID, name and server-derived `sourceSessionId` survive
history excerpts and content spill as bounded display metadata. Preview and
Keep re-read that exact proposal using the conversation's current authority;
source Session, actual Station route and local shell painter must agree. A
relayed conversation cannot infer the target Station from its host credential
scope. Dismiss and Keep use current revisions, and late render reports cannot
restore a settled proposal in the query cache. The protected Keep bar remains
the decision surface, reachable without navigating away from the chat.

Source and tests establish contracts and exercised paths only. Desktop
WKWebView, physical devices and deployed Nightly require separate qualification.
