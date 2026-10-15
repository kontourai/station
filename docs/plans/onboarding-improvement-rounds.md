# Onboarding improvement rounds

Status: local implementation and verification, 2026-10-15. This is an execution plan,
not release qualification. Evidence and comparisons live in
[the audit report](../strategy/onboarding-20261015/report.html).

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

## Terminal epic

Do not call Terminal fixed because a shell starts or `pwd` returns. Retain the
current reproducible evidence and evaluate these behaviors as one workstream:

- Type and paste multiline commands; Enter, Backspace, arrows, Ctrl-C and Ctrl-D
  reach the PTY; focus is visible and recoverable after opening other panes.
- Fit rows/columns after pane open, resize, drag, collapse, restore, and font
  changes; output does not overwrite, disappear, or scroll the entire workspace.
- Explain which computer, Project, folder, shell and process own the session.
  An unavailable PTY or transport has an actionable reason and retry.
- Reconnect without duplicating commands or silently creating a different shell.
  Define whether close hides a pane or terminates its process; expose both actions.
- Test at least macOS and Windows PTY boundaries. On phones, define deliberate
  keyboard controls or offer command/result review; a desktop terminal squeezed
  into a narrow pane is not mobile acceptance.

## Subsequent rounds

Keep these findings open until their own behavior and failure paths are proven:

1. Same-host multi-instance browser cookie collision: scope credentials to the
   intended Station while preserving HttpOnly, Secure, SameSite, revocation and
   migration semantics. Reproduce sign-in to two ports in one profile, then
   restart/revoke each independently. Separate profiles are a development workaround.
2. Mobile pairing: browser launcher sessions currently cannot create offers; the
   UI must provide a trusted operator handoff without requiring someone to
   understand credentials or weaken permissions. Shorten the desktop path to a visible Pair phone action;
   verify physical iOS/Android QR, manual code, expired code, unreachable host,
   background/resume, revoke and reconnect. Simulator camera failure is not
   physical camera proof. A code must never imply that a network route exists.
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
