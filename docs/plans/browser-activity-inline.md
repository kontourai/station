# Inline browser activity

Status: implementation plan for [#4660](https://github.com/kontourai/station/issues/4660).
GitHub owns live delivery state. The [Browser workspace guide](../guides/browser-workspace.md) owns
the supported behavior.

## Outcome

Keep browser actions and their page together in the conversation. An inline
card, floating view and Browser pane view the same authorized browser session.
Moving the view preserves the page and login; ordinary live-surface control
and human preemption continue to apply. The floating view remains available.

The reference is KiroCrew's `BrowserLiveCard`, `BrowserLiveCardViews` and
`TurnBlock` at `aca93ab3c4`. Use the interaction pattern as a reference rather
than copying its separate browser runtime or recording store.

## Shared owners

- Browser session identity, profile admission and history: existing browser
  service and `/api/browser` routes.
- Frames, input, control and cleanup: `LiveSurfaceCanvas` and the shared
  live-surface lease. Extract browser-specific viewer chrome from
  `FloatOverChatHost` for both placements.
- Session/access queries: one scope-aware owner shared by inline and float.
- Viewer input lifetime: extend the existing lease/input routes and registry
  with bounded, authenticated source registration. Sealing a retiring source
  rejects late queued input and cancels only its held presses. Failed cleanup
  retains custody and fences input until neutral cleanup succeeds. This does
  not complete the broader [input safety proposal](live-surface-input-safety.md).
- Tool state, approvals and results: existing transcript parts and
  `ToolCallDisplay`; one browser grouping path for streaming and settled work.
- Visibility: existing `shownSources` arbitration. A hidden viewer must not
  retain another frame stream, and a visible pane wins over the inline view.
- Recording: existing explicit human browser recording. A summary is not a
  recording; offer playback only when real recorded media is available.

## Delivery lanes

1. Terra: extract the reusable browser viewer and queries; add inline live,
   settled and moved states with Float and Open in pane actions. Reuse page
   dialogs, control ownership and the existing recording flow.
2. Terra, in parallel: bind the controller's conversation/Station authority,
   identify browser calls and group them using one shared transcript owner.
   Preserve mixed-tool ordering, failed and unresolved calls, and approval
   controls. Register no duplicate per-surface projection or tool renderer.
3. Integrator: register the off-by-default `inline-browser-activity` Feature
   Preview, maintain the canonical guide and review ledger, integrate both
   lanes, and run the focused checks after writers stop.
4. Sol: independently review the combined diff, including authority changes,
   session selection, hidden streams, historical honesty and test value.
   Fix findings and obtain a fresh review when the repair is material.
5. Integrator: normal hooks, Veritas readiness, protected auto-merge and a
   confirmed GitHub merge receipt. Do not bypass a gate to meet the schedule.

All implementation lanes share one isolated sibling integration worktree with
disjoint file ownership. The integrator owns Git commits and test execution.

## Preview and authority

The preview is offered in Settings → Advanced → Feature previews and starts
off. Disabling it restores ordinary transcript rendering and the existing
float behavior, without ending the browser session. It grants no browser
access. Opening the inline viewer uses the same browser reads and frame
budget as existing viewers; recording retains its explicit resource cost.

The conversation controller supplies Station identity and request scope.
Select an exact browser session from the call input or a successful open
result, then require matching Project, principal and bound conversation.
Missing or ambiguous identity must not select the newest browser. A remote
conversation must not borrow the currently selected Station's preview or
credentials. Read-only and historical conversation adapters must not gain
interactive browser controls by mounting a card.

## Acceptance and promotion evidence

- Preview off leaves ordinary calls and floating behavior intact.
- Streaming and settled work keep stable anchors and the same call renderer.
- Browser and non-browser calls remain correctly ordered; refusals,
  unresolved calls and pending approvals remain visible and actionable.
- Different browser session IDs receive distinct views. Another Project,
  principal, conversation or Station cannot select the source.
- Inline, float and pane placement does not create duplicate frame streams.
  Off-screen views release viewing resources and held input follows the
  source-scoped cleanup path. Failed cleanup retains custody and blocks input;
  another viewer's empty close cannot clear that failure.
- Settled cards describe historical calls. Opening the current session is
  labeled separately from playback of a real recording. Reload or generation
  loss must not manufacture historical media.
- Recording remains explicit, bounded and subject to the existing owner and
  generation checks; closing or changing the source cleans up its clip.
- Render and inspect the live, failed, moved and settled states at 390 and
  1440 pixels in both themes; check keyboard controls and touch targets.
- Execute focused owner/integration tests, ordinary push hooks and readiness.
  Hosted CI, real browser interaction and merge receipts are separate claims.

Automatic durable per-turn screen replay is outside this delivery. Before
adding it, extend the existing recording owner with a reviewed per-frame
masking policy, turn association, retention limits, restart behavior and
deletion semantics. Do not add a second recording store or silently retain
logged-in page content merely because the inline preview is enabled.
