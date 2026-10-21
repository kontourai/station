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

A box is checked only after independent review and runtime acceptance. "In
#3875" means implemented with source-level evidence in that pull request and
not yet accepted.

- [ ] Main/Related/Tools are distinct shell regions; one workspace sidebar.
  In #3875: Files and every fallback open in Related or Tools; Left is never
  an automatic fallback and its toggle shows only while Left is in use.
- [ ] Preview replacement, Keep, edit protection and exact target focus work.
  In #3875 for file previews opened from a conversation link or a docked Files
  pane, including a per-occurrence Station fence and cross-window locked
  writes. Other related kinds wait for their slices.
- [ ] Quick review preserves source selection/search/scroll; Open promotes.
  Follow-up #3986 repairs the true recipient continuation lifecycle, desktop
  late-guard close and committed-model Chat/Up exits. The old review adoption
  callback was dormant; baseline failures instead exercise the real Chat
  SessionDetail recipient. Real browser journeys use canonical Chat at desktop
  and phone widths and transfer the exact reply to its confirmation. Local
  mutation/focused evidence is separate from independent/native/hosted acceptance.
  Implemented in #3981, stacked on #3964, awaiting independent qualification:
  the real Activity list offers Quick review in Related, reusing SessionDetail
  with an exact Session/Project identity and Station fence. Previous/Next use
  the list owner's current visible order, including pagination and collapsed
  groups, without changing its selected item, search or filters. Open keeps
  the target; an exact kept-target reopen focuses it. Draft replies register
  the normal owner guard and protect the preview. The real Activity caller,
  region host and SessionDetail browser journey passed at 1440px and 390px,
  including keyboard/focus, filtered siblings, typed replies and Cancel, source
  state, Keep/reopen, 44px navigation targets and real Back/Up. Five deliberate
  source defects failed owner assertions, then the restored suites passed.
  Independent/native acceptance and hosted checks are pending. Related reply
  drafts are keyed to the verified Station as well as API and Session.
- [ ] Source switching and cancelled guards preserve the right child and focus.
  In #3875 for file previews: source hide/restore, and Cancel on a covered,
  replaced or closed pane's guard leaves arrangement, selection, relation,
  state and focus unchanged.
- [ ] Warm/cold links, Back/Up and reload restore validated exact targets.
  In #3875: Up to the exact conversation or Files Project through canonical
  navigation, and a phone-layer reload reopens its exact pane. Cold child links
  are not started.
  Standalone SDK Up repair stacked on #3964: a direct Project plugin opener
  records its descriptor and instance, uses the canonical pane route after
  guarded Station/relation rechecks, and names the same opener in phone Back
  chrome. The actual direct and sandboxed-frame browser callers click Up on
  desktop and phone and return to the exact Reports root. Source/focused/browser
  evidence is separate from pending independent, hosted and native acceptance.
  The upgrade path is also implemented: reopening an old kept report from its
  same admitted Project-pane occurrence adds only its missing exact reference
  inside the existing locked focus transaction. Real direct/frame browser
  journeys restore the old record shape, reload, reopen and click Up at both
  widths; guard and scope/source changes refuse without mutation. Unwitnessed
  legacy records retain their fallback, rather than guessing an opener.
  SDK Up review continuation: optional metadata no longer changes transient
  selection identity; the host and record reader share reference validation,
  retaining a readable fallback for unrepresentable descriptors. Same-path Up
  adds no history. Focused real-owner tests cover replacement-layer/new-guard/
  caller supersession, mounted Station and generation rechecks, and attestation
  fence/Project-rename refusal. Browser routed returns and mutation evidence are
  recorded in the PR, not inferred from same-path clicks.
- [ ] Responsive folds preserve occurrence/controller/history identity.
  In #3875 for the phone layer only (Keep through replacement, Back, reopen).
- [ ] Coding leases stable outlets without rewriting ambient arrangements.
  Not started.
- [ ] One Chat controller and Terminal process owner across all hosts.
  Not started.
- [ ] Phone inbox/conversation, child destinations and properties sheet work.
  Not started.
- [ ] Direct and iframe SDK report journeys share bounded admission/outcomes.
  In the SDK pull request stacked on #3875 (#3964): one host implementation
  behind `useRelatedPanes` and the frame client, through the shared
  related-occurrence pipeline (guards, locked fresh-read commit, Station
  fence). Both tiers have a real-Station browser journey with the Related
  Reports example: direct (`related-panes.spec.ts`) and from Station's
  sandboxed plugin frame on a Station the spec owns, reached under a
  non-loopback name (`related-panes-frame.spec.ts`).
- [ ] Context/grant/generation failures and older-host fallback remain visible.
  In the SDK pull request: `context-mismatch`, `not-authorized` (disabled,
  removed or updated plugin, renderer not admitted, including when it changes
  while a guard answers), `station-unverified` and the bounds are refused at
  the host before anything is written; a removed plugin's related pane keeps
  its tab with a placeholder, and a same-version reinstall does not bring it
  back (browser journey, through the catalog's server-issued lifecycle
  generation); an older host answers `unsupported` without rejecting (SDK
  hook and frame client). Independent source review of d316d2776d3 found five
  holes, each reproduced and repaired with fault injection: target identity
  now includes the Project, captured context and generation; a capability is
  revoked with its occurrence or Station and a frame request with its
  document; a close re-admits everything inside the lock; the shared pipeline
  reads the committed arrangement and refuses on unsaved work registered
  while it asked; and disable, re-enable or reinstall is a new generation.
- [ ] Header/footer controls work expanded, collapsed, mobile and both themes.
  In #3875: account control beside Live work, region glyphs at the far right;
  browser geometry checked expanded at 216px in both themes, and collapsed and
  in the phone drawer at 390 and 320px. Coding toggle delegation is not
  started.
- [ ] Required local checks, independent review and native journeys recorded.
- [ ] PRs linked and actual REST landing recorded.
- [ ] Public SDK/contracts publication state recorded separately.

## Evidence

- Initial lane clean and equal to verified `origin/main` above.
- `npm run dependencies:ci` completed; hooks armed and real PTY handshake passed.
- Pre-edit `gate:for` completed for design, UI, contracts and SDK paths.
- All implementation and runtime acceptance items remain unqualified at plan
  creation. Update this ledger with observed results as the slices land.
- #3875 review repairs: unit and integration suites for the fence, locked
  transactions, the bound, guards, Keep on a phone and exact Up each fail when
  the behaviour they name is reverted (fault injection, recorded in the pull
  request). Known limits: switching tabs within a region still unmounts the
  hidden pane, as before; the open account menu's phone geometry is not
  measured.
- SDK related panes: unit and integration suites for the host's admission,
  placement, handles and budget, the plugin occurrence record and fence gate,
  the frame adapter and the SDK client each fail when the seam they name is
  reverted (fault injection, recorded in the pull request).
- #3875 review round 2: related opens refuse without a verified Station; the
  focus path, Up and a close answered after its pane moved each recheck what
  their guard was asked about; a menu that mounts open no longer dismisses
  itself under StrictMode (found in the running app); toolbar menus outrank the
  notification column they open into (found by hosted pr-smoke). Each fix has
  a test that fails when it is reverted.
