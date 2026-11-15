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
  browser that reported can still Keep with the revision it read);
- `owner`: an opaque per-person tag the browser keys its cache with.

An appearance is `{ version: 1, name, palette, css }`. The palette has an
optional entry per mode (`dark`, `light`) with `roles`, a map over
`APPEARANCE_ROLE_PROPERTIES` (the same list the color-theme catalog reads),
and `accent`, one hex that supplies brand, action and focus with a derived
black or white text partner. Values are `#rgb` or `#rrggbb`.

## Propose, preview, keep

Agents may read and propose. Keep, save, dismiss, turn off and the render
report refuse any request that may be an agent's (`requestMayBeAnAgent`, 403
`custom_appearance_person_only`), as the Personal Board routes do. Propose,
save and keep compare the revision; a stale one is 409.

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
  other than `data:` and `#fragment` (a text check over lowercased CSS with
  comments removed; deliberately conservative);
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
removed, including custom properties (whose raw value `var()` re-tokenizes, so
a backslash there is refused). A block that still fetches after that (a
shorthand holding `var()`) loses its declarations, and a sheet whose final text
still fetches applies nothing. Checking parsed values is what defeats escapes
and case tricks: `\75 rl(` and `URL(` both serialize as `url(`.

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
check-back proposals, proposed file changes and gate exceptions. Each owner
calls `useDecisionSurface(id)` (a layout effect, so the sheet is off before
the browser paints the decision), and ids come from one typed list.
Over-suspending is harmless, so owners that are always mounted on a settings
page (the sharing controls, relay operator panel, integration trust review)
register whenever they are mounted.

## The preview bar

The bar must not be hideable or spoofable by the CSS it previews:

- It is a closed shadow root on a host that is a child of `<html>`, not of
  `<body>`. Document CSS cannot select into it; the host's position, display,
  visibility, opacity and transforms are inline `!important`, which beats any
  author `!important`; `all: initial` stops inherited colour and font, and the
  bar's own styles use literal values (custom properties inherit through
  `all`).
- It is a manual popover, so it is in the top layer above anything the page
  can stack, and the page's own opacity does not reach it (measured: with
  `html { opacity: 0 }` the bar still paints).
- Keep accepts only a trusted activation: a pointer click where Keep is the
  topmost element at the pointer through both the document and the shadow
  root, or a keyboard activation while Keep has focus. Keep is not focused on
  mount. While `<html>` is made invisible or moved (opacity, visibility,
  display, filter, transform, translate, scale, rotate, clip-path, mask,
  mix-blend-mode, content-visibility, zoom), the bar is moved off screen, or
  anything covers Keep, Keep is disabled and says why.
- Escape reverts. Whatever else fails, the countdown reverts.

`* { display: none !important }` includes `<html>`, which removes every box
on the page including the bar; that preview cannot be kept and reverts on
Escape or the countdown.

## Feedback to the agent

When the person previews a proposal, the browser posts a render report for
that proposal id: how many elements each hook selector matched, the contrast
of the computed roles in the mode on screen (only pairs the preview changed,
since a theme's own pairs are not the proposal's doing), and what the guard
removed. `get_appearance` returns it.

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

The last applied appearance, sanitized, is cached in `localStorage`
(`station-custom-appearance-v1`) with the owner tag, and `main.tsx` applies it
before the first render. `CustomAppearanceBridge` replaces it when the
person's document answers. A refusal (401, 403, 404) turns it off and clears
the cache; a network failure keeps it.

## Accepted gaps

- Custom CSS can make any non-decision surface unreadable or hide it,
  including by setting `--k-*` variables, which the palette's contrast gate
  does not see. The render report rates the computed roles, and the person
  previews before keeping; there is no gate on CSS legibility.
- The server cannot rate a pair whose other side comes from the theme in
  force; the browser rates it at preview, in the mode on screen only.
- The cache follows the spirit of the appearance-cache ownership rule, not
  its full machinery: it belongs to whoever's document last answered on this
  origin. On a browser shared by two people, or on the signed-out connect
  screen, the previous person's custom appearance shows until the account
  boundary's read answers for someone else or refuses. It holds only that
  person's own palette and sanitized CSS.
- The registry relies on each decision owner calling the hook. A test pins
  the list; render tests prove registration for the owners listed as
  rendered in `decision-surfaces.test.tsx` and their suites, and the rest are
  one-line calls verified by review only. A new decision surface that forgets
  the hook is not suspended.
- No capability flag: the UI treats a 404 from an older Station as "not
  supported" and hides the Custom section; the agent tool reports the 404.
