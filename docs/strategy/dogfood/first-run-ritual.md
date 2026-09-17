# First-run dogfood ritual

A 15-minute scripted fresh-home tour one maintainer (rotating) runs **before
each stable release cut**, on the build the train would ship. The automated
walkthrough sees rendering; this ritual feels confusion. Every step below maps
to a surface where the v0.1.2 audit (#765) found breakage that only required
*being a new user once*.

**Setup:** `station start --temp-home` from the release candidate, pair a
browser via the ui-bootstrap flow, viewport ~1440×900.

**Filing:** anything that feels off — even "just copy" — gets filed
immediately with a screenshot. Use the in-app **Report a problem** flow
(⌘K → "Report a problem", or the help `?` menu): it pre-fills route, build,
and recent console errors; attach your screenshot to the issue it opens.
Write findings in #765's format: `severity · one-line title`, what you did,
what you saw, screenshot.

| # | Step (~2 min each) | What should happen |
|---|---|---|
| 1 | **First boot.** Look at Home before clicking anything. | Clear next action for a new user; no setup CTA missing (#765 B4), no stray debug buttons (B5), no nag loop (B1), no READY badges beside "cannot verify" toasts (B2). |
| 2 | **One chat, 2+ turns.** New chat on a real engine; send a second turn while the first runs. | Both turns land in the *same* conversation; no raw session errors (A1), no fragment sessions or orphan drafts (A2); tool calls show results (A4). |
| 3 | **One project.** Create a project with a working directory; chat inside it; reload the deep link. | Modal fits the viewport (F7); reload returns to the conversation, not an inspector (A5); headers name the real working directory (C2). |
| 4 | **One plugin.** Install a bundled/featured plugin from Registry; open its layout and panes. | Everything it ships renders — no "Unsupported layout tab", no "Temporarily unavailable" (D1); Registry categories make sense (F1). |
| 5 | **One docked pane.** Show Activity in a dock region (⌘⇧A, or the region toolbar); try to use it; hide it again. | Content stays reachable while docked (C1); actions inside the pane still work; ⌘M behaves. |
| 6 | **One scheduled job.** Create a job from Schedule. | Defaults point at an agent that can actually run (D8); empty states before data look intentional (F3). |
| 7 | **Sweep.** Open the browser console; skim the routes you visited. | No 403/404/503 noise on a healthy instance (E5); no status chips disagreeing with each other (E4); any UI copy naming a CLI command actually matches the CLI (D3). |

Done means: every step walked, every off feeling filed (not triaged — filing
is the ritual, triage is the train's job), and the release conductor told
"ritual clean" or given the issue list.
