# Pane workspace implementation

Owner: `feat/pane-workspace-20261019`, based on `ac9a23234b1e`.
Authorization: Brian, “Let's plan it out and do it all.”
Contract: [Pane relationships](../design/pane-relationships.md).

The prior HTML prototypes are design evidence only. Source implementation,
executed tests, native runtime acceptance, hosted qualification, merge and SDK
publication are separate delivery states.

## Implementation order

1. **Relationships and navigation.** Extend the real region/pane owners with
   bounded occurrence relations, exact target dedupe, preview/Keep/edit guards,
   source hide/restore, and child links/history/reload. Integrate Activity review
   and file opens. Prove Cancel and exact Station separation at the caller seam.
2. **Coding presentation and mobile.** Add stable Related/Tools outlets with
   exclusive ownership; preserve the original Coding host and its one panel
   writer. Suspend ambient arrangements. Add mobile inbox/conversation roots,
   child destinations and properties sheet. Observe one Chat/Terminal owner and
   process identity through folds, hide/show, session changes and owner release.
3. **SDK integration.** Add the optional versioned host capability, compatible
   descriptor role and SDK hook. Apply the same admission/budget/refusal path to
   direct and iframe occurrences. Dogfood report open/reveal/close, guards,
   wrong context, generation disable and older-host fallback. Document/version
   public contracts using package release conventions.
4. **Shell controls.** Move account to sidebar footer and existing region glyphs
   to far right. Make Left advanced-only without deleting saved placements.
   Delegate Coding toggles to its state owner. Preserve collapsed/mobile access,
   visible focus, 44px targets, themes and live-work discoverability.
5. **Qualification and landing.** Focused tests/typechecks, required `ci:fast`,
   Veritas readiness, independent Opus source/runtime review, desktop and real
   iOS/Android shell journeys. Normal hooks and linked PRs; Ready/autoqueue only
   after acceptance. T3 watch owns asynchronous monitoring. REST merged evidence
   is required before reporting landing; publication requires registry evidence.

## Acceptance ledger

- [ ] Main/Related/Tools are distinct shell regions; one workspace sidebar.
- [ ] Preview replacement, Keep, edit protection and exact target focus work.
- [ ] Quick review preserves source selection/search/scroll; Open promotes.
- [ ] Source switching and cancelled guards preserve the right child and focus.
- [ ] Warm/cold links, Back/Up and reload restore validated exact targets.
- [ ] Responsive folds preserve occurrence/controller/history identity.
- [ ] Coding leases stable outlets without rewriting ambient arrangements.
- [ ] One Chat controller and Terminal process owner across all hosts.
- [ ] Phone inbox/conversation, child destinations and properties sheet work.
- [ ] Direct and iframe SDK report journeys share bounded admission/outcomes.
- [ ] Context/grant/generation failures and older-host fallback remain visible.
- [ ] Header/footer controls work expanded, collapsed, mobile and both themes.
- [ ] Required local checks, independent review and native journeys recorded.
- [ ] PRs linked and actual REST landing recorded.
- [ ] Public SDK/contracts publication state recorded separately.

## Evidence

- Initial lane clean and equal to verified `origin/main` above.
- `npm run dependencies:ci` completed; hooks armed and real PTY handshake passed.
- Pre-edit `gate:for` completed for design, UI, contracts and SDK paths.
- All implementation and runtime acceptance items remain unqualified at plan
  creation. Update this ledger with observed results as the slices land.
