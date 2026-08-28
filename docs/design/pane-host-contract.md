# The pane-host contract: one interface, two transports

Status: design for station#4201, feeding #4220 and #4190. Follows
`docs/design/pane-or-shell.md` (criterion, runtime tiers, and the iframe
threat model).

## The problem, from evidence

The Board extraction (#4200) found a first-party pane leaning on five shell
capabilities with no published equivalent, and resolved them for ONE pane by
hand-injecting a typed host (`ConsoleBoardPaneHost`). The iframe runtime
(`PluginFrameHost`) meanwhile speaks its own ad-hoc message set. Every future
extraction re-deriving its own host, and every iframe capability added ad
hoc, is the same divergence this repo keeps paying for — two expressions of
one need, drifting.

The destination (#4220): a pane written against ONE host contract runs in
either tier — direct calls in-process, postMessage across the iframe — and
the runtime becomes a user trust decision. This document is that contract's
design.

## The decomposition

Every capability a pane asked for so far falls into one of four categories,
and the category decides how it crosses the boundary:

| Capability (evidence) | Category | Contract disposition |
| --- | --- | --- |
| `openProjectWorkspace` (Board) | **Intent** | `host.navigate(target)` — the iframe transport already has a `navigate` message; converge on one target vocabulary |
| toast (iframe, today) | **Intent** | `host.notify(text, tone)` — budget/refusal rules stay shell-owned |
| `presentBoardUnavailable` (Board) | **Intent** | `host.presentUnavailable(reason)` — the shell owns redirect + notice |
| `ConfirmModal` (Board) | **Request/response intent** | `host.confirm({title, message}) → Promise<decision>` — the SHELL renders its own modal on the pane's behalf; the pane never receives a component. Identical semantics in-process and across postMessage, and the shell's one confirm chrome stays the only one |
| `isMobile` (Board) | **Environment fact** | `host.facts.device` — a subscribable value; in-process a context read, across the frame pushed on change. Later members (theme, locale) join here, never as new ad-hoc messages |
| `ErrorState` (Board) | **Visual primitive** | NOT host surface. Inline chrome cannot be shell-rendered into an iframe; publish it instead — `ErrorState` joins the published component set in `@kontourai/station-sdk` (which already ships React components), both tiers import it, the iframe bundles it |
| `usePageHeader` (Board, moved to its mounter) | **Placement concern** | stays OUT of the contract — the placement (route mounter, dock host) owns header/banner/redirect, as M4a established. A pane that thinks it needs the page header is a pane doing its placement's job |
| ready / initialize / fill / teardown (iframe, today) | **Lifecycle** | the contract's handshake; in-process equivalents are mount/unmount and layout, already owned by the pane frame |

Two rules fall out and are worth stating as rules:

1. **Components never cross the contract.** A capability is an intent, a
   fact, or a published package — the moment a host member has a
   `ComponentType`, it cannot survive the frame boundary, and the tier-2
   contract has silently forked from tier 3. (`ConsoleBoardPaneHost`'s two
   component slots are therefore transitional, replaced by `confirm` and the
   published `ErrorState`.)
2. **Placement concerns stay with the placement.** The contract is what any
   host owes any occupant; headers, banners, and redirects are what a
   PARTICULAR placement does with its own chrome.

## The shape

```ts
// @kontourai/station-contracts — transport-agnostic, serializable throughout
interface WorkspacePaneHostContract {
  navigate(target: PaneNavigationTarget): void;
  notify(notice: { text: string; tone: NoticeTone }): void;
  presentUnavailable(reason: PaneUnavailableReason): void;
  confirm(request: { title: string; message: string }): Promise<PaneConfirmDecision>;
  facts: {
    read(): PaneHostFacts;                       // { device: { isMobile } … }
    subscribe(listener: (facts: PaneHostFacts) => void): () => void;
  };
}
```

Every parameter and result is structured-clone-safe by construction — that is
what makes the second transport a mechanical adapter rather than a second
design. The in-process adapter is direct calls; the frame adapter maps each
member onto request/response messages over the existing `PluginFrameHost`
channel (whose `navigate`/`toast` messages become the first two adapter
cases rather than staying bespoke).

## What this deliberately does not include

- **Data access.** Panes read server state through the SDK (tier 2) or the
  HTTP surface (tier 3) — the host contract is about the SHELL, not the
  server. Folding data into it would recreate the god-object the shell just
  finished decomposing.
- **Arbitrary extension.** A pane needing a capability not listed here files
  it; the categories above decide its shape. The contract growing a
  `ComponentType` member is the regression tripwire.

## Sequencing

1. `ErrorState` moves to `@kontourai/station-sdk`'s published components
   (in-repo; Console Kit is not touched).
2. The contract types land in `@kontourai/station-contracts` with the
   in-process adapter, and the Board's host refits onto them — deleting both
   component slots. The Board is the proof that tier 2 rides the contract.
3. The frame adapter lands in `PluginFrameHost`, absorbing `navigate`/`toast`
   into it. #4190's dogfood plugin is then written against the contract and
   must run in BOTH tiers — one artifact, both runtimes, or the contract is
   not done (#4220's success criterion).
4. The install-time trust prompt (#4220) rides on 1–3.
