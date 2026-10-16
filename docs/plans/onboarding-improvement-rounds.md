# Onboarding improvement rounds

Status: local implementation and verification, 2026-10-15. This is an execution plan,
not release qualification. Evidence and comparisons live in
[the round-three report](../strategy/onboarding-20261015/round-three.html).

## Product direction

A beginner should install an app, choose an AI connection, and send a message.
A Project adds a folder and shared context when needed. A custom Agent is an
optional saved configuration. A tracked task is an explicit action, separate
from choosing a computer. Layout and transport terminology should appear only
when the person needs to change them.

Desktop starts with chat and opening work. A phone starts with connecting to a
running Station; it uses that computer’s agents and files. Responsive layout
must not be confused with permission to run a local service.

## This implementation round

| Problem | Change | Acceptance boundary |
| --- | --- | --- |
| Codex Instructions locks after one character | Validate authored instructions against system or first-message delivery; keep warnings editable | Stateful editor typing/clearing, real new Codex chat, first-turn runtime receipt |
| Phone Coding splits chat from an empty work area | Keep chat in the central workbench; preserve ambient dock and app toolbar ownership | Single-controller integration and actual Safari keyboard captures |
| Coding composer falls below viewport | Bound layout route height, preserve flowing page scroll | Long transcript browser geometry and app at 1280 × 800; Settings remains scrollable |
| Header mixes conversation, assistant and future-project context | Title above assistant/model; running chats use a real menu; direct mobile project switching retained under the product contract | 280–850px real CSS, keyboard menu, phone title/actions |
| Agent Chat action forgets the clicked Agent | Use typed selection including its owning Project | Real rail action through production parser; baseline red, fixed and mutation/restoration |
| Project setup sends users to management | Open the server-returned applied layout through canonical navigation | Selected layout only, create-once retry, no-layout fallback |
| Redundant project chat callout | Remove callout/helper and their obsolete tests | Project-bound HomeStartComposer handoff keeper |
| Location chip silently changes chat into task | Label the action Run a task | Task launch remains explicit; remote admission unchanged |
| Station assistant setup sends users to model accounts | Open existing engine chooser from setup | Explicit account/engine choice; no arbitrary engine selection |
| Pairing permission errors blame the address | Distinguish insufficient scope from origin rejection; give the host operator route | Executed web denial plus shared pairing-panel refusal cases |
| Mobile setup exposes desktop and transport internals | Pairing first, computer setup handoff, advanced alternatives | Safari simulator connect/manual fallback and narrow desktop request-access path |
| Fresh home imports unrelated history | Seed out-of-project following off only for new homes | Explicit opt-in works; existing absent/explicit settings and copied history preserved |
| Source checkout is the first install instruction | Put desktop downloads and signed archive command first | Public archive install + launch in isolated roots; no change to existing installation |
| Installer stops on Finder metadata | Clean owned extraction stage after moving verified files | Signed archive fixture with injected .DS_Store and real macOS install |

## Round three

Implemented after the second review:

- Station chooser → **Pair phone** opens the existing invitation screen directly.
- Phone setup has one heading and one instruction; advanced setup stays collapsed.
- CLI invitations include the short manual code. Browser and iOS Safari simulator
  completed code → request → exact operator approval → cookie exchange.
- Fresh launcher links work in an existing tab. Older pairing responses cannot
  replace a newer sign-in result.
- New cookies are namespaced by Station identity. A real two-Station HTTP test
  proves coexistence, separate revocation, and refusal of ambiguous credentials.
- Terminal keeps its renderer across routine status updates, reconnects on real
  credential changes, preserves output while disconnected, and never replays input.
  Phones get Ctrl+C, Tab and history buttons.
- Coding header labels truncate before overlapping actions; layout loading uses
  one plain status with a working Back action.
- Phone Coding shows the title once. The first-chat guide makes Projects and
  custom Agents optional instead of requiring them before chat.

Independent review found and corrected cookie-adoption ambiguity, native proof
cookie-name whitespace, a stale pairing response, and polling recovery state.
Independent mutation changed the unique-current credential rule: the real HTTP
ambiguity assertion failed as intended; exact source restoration passed 121 tests.

Terminal still needs packaged Windows PTY, physical phone keyboard, and long
running-process recovery qualification. Browser/simulator checks do not prove
those boundaries. Closing a terminal ends its session; hiding the pane does not.

## Subsequent rounds

Keep these findings open until their own behavior and failure paths are proven:

1. Qualify two simultaneous browser Stations across updates and credential
   rotation. Source isolation and revocation have route-level regression proof;
   retain real browser receipts separately.
2. Pairing still needs physical iOS/Android QR, native shells, unreachable-host
   recovery, expiration and background/resume qualification. Browser launcher
   grants remain unable to administer other devices; use the trusted desktop
   session or the matching host CLI. Pairing never creates a network route.
3. Installer experience: verify Windows and Linux on fresh machines without
   development tools, PATH recovery, update/rollback, and browser sign-in.
   Double-click desktop should be the primary novice route when signing and
   delivery support it. This round does not publish installers or certify those OSes.
4. Reduce the remaining duplicated assistant/engine/model and Station/profile
   labels using reported facts. Avoid replacing unknown runtime identity with
   a friendly but invented default.
5. Repeat the desktop and mobile journey with a person unfamiliar with coding.
   Count required choices, terminology explanations, recovery attempts, and time
   to a first useful answer. Keep failures alongside successful receipts.

Each round should end with actual before/after captures, independent critique,
focused regressions for real failures, and a separate list of unverified claims.

The October audit proposed moving the mobile future-project control into Chat
actions. The repository’s mobile primary-context contract requires direct
Project and conversation switching, so that removal is not implemented. Review
the mental-model proposal separately; retain the direct action meanwhile.

Code-health review found no new dead exports or duplication. GuidedConnect’s
role-specific branches introduced an advisory complexity finding (cyclomatic
32). The desktop/native/mobile access paths remain explicit in their existing
owner; a later decomposition should preserve the shared connection ceremonies
and the tested narrow-desktop recovery route.

## Round four

[Before/after and recovery evidence](../strategy/onboarding-20261015/round-four.html).

- Coding names the conversation once; composer controls own Agent and engine/model.
- Global setup reminders stay on Home without an open conversation. Coding-engine
  repair belongs to that Agent choice, never an unrelated global reminder.
- Same-origin browser outages no longer recommend another host address. Access
  repair goes directly to the selected Station. Cold-start recovery retries
  without reload and resumes on foreground/online; refusals do not auto-retry.
- Pairing dialog sizing includes its padding; mobile inputs avoid Safari focus zoom.
- Terminal work is explicitly outside this round.

Round-four capture artifacts are a dated local audit, not public product
contracts or release qualification. Source and regression receipts are separate
from Safari simulator evidence and physical-device acceptance.

## Recovery verification

The final recovery pass retires superseded history-capability requests before
they can consume recovery attempts or create orphaned timers. Optional MCP
prompt lookups now cancel with their query, retain HTTP error metadata, apply
a 30-second request deadline, and do not retry automatically.

At `987c661c12a`, 75 focused checks passed; restoring the old production owners
caused six intended failures, and restoration passed all 75 again. Independent
source review reported no P1/P2 findings. This proves those bounded repairs.

The rebuilt app restored desktop and Safari history after a Station restart,
and a message sent from Safari completed a real `list_projects` call. The first
desktop tool call after restart failed with an HTTP transport error; history
also temporarily failed before recovering. The restart/repair failures tracked in [#3713](https://github.com/kontourai/station/issues/3713) remain
unexplained and are not claimed fixed by the bounded repairs. Physical devices,
native shells and release delivery remain unverified. Terminal remains outside
this pass.
