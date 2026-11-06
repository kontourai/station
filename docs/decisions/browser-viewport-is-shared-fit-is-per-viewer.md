---
status: current
subject: The Browser page viewport is shared by every viewer; each viewer's fit and zoom are local
decided: 2026-11-04
evidence:
  - kind: doc
    ref: docs/guides/browser-workspace.md
  - kind: doc
    ref: docs/reference/browser-and-devices.md
  - kind: doc
    ref: src-ui/src/workspace-panes/browser-pane/BrowserPane.tsx
  - kind: doc
    ref: src-server/services/browser/browser-session-registry.ts
---

# The Browser page viewport is shared; fit is per viewer

## Decision

A Browser session is one page in one browser. Its viewport (width, height,
device scale, mobile emulation), page zoom and appearance are applied to that
page with Chrome DevTools Protocol emulation in
[the session registry](../../src-server/services/browser/browser-session-registry.ts)
(`setViewport`, `setZoom`). Every viewer is sent the same screencast of it,
and agents read and act on the same page. These settings are therefore shared,
and the pane says so:

- The ⋯ menu groups **Zoom**, **Appearance**, **Viewport** and **Rotate
  viewport** under **View for everyone watching**. The pane-sized choice is
  **Match this pane** (formerly *Fit to this pane*): it resizes the page for
  everyone, and the session history records it as `changed the viewport`.
- A pane that sees the viewport change without having made the change itself
  says **The page size changed to W × H for everyone watching.**, so another
  viewer's or an agent's resize is never silent.
- How a frame is drawn in one pane is that viewer's own: the live view scales
  the shared frame to fit its stage, and a pinch zooms and pans only that
  viewer's picture. Nothing a viewer does to their picture reaches the page.
- A page opened from a narrow pane (stage under 600 CSS px wide) is sized to
  that pane once, as soon as it is live. It has just been opened, so nobody
  else is watching yet. Attaching to an existing session, or opening one from
  a wider pane, keeps the session's viewport (1280 × 800 by default).

## Why not a per-viewer viewport

Per-viewer layout would need one page per viewer: separate DOM state, scroll,
form input and history, which is no longer one shared session that a person
and an agent can both drive. Client-side scaling cannot reflow a page either,
so a 1280-wide page on a 342-wide phone stays about a quarter scale. Reflow is
a page change, so it stays an explicit, shared, recorded action.

## Consequences

- A phone that opens a page gets a readable phone-width layout; a phone that
  joins a desktop-width session sees the desktop layout scaled, pinches to
  read, or chooses **Match this pane** knowing it changes the page for
  everyone.
- An agent that later reads a session opened on a phone sees the phone
  layout; the history shows who sized it.
