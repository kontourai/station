# Plugin core delivery

This is the active implementation plan for [#2993](https://github.com/kontourai/station/issues/2993),
following the [accepted design](../design/shell-plugins-distributions.md).
The epic is unfinished. The feature branch `feat/plugin-core-epic-2993` is the
single integration branch; its draft PR is the eventual atomic merge to main.
Implementation commits may be reviewed separately inside that PR.

## Consolidated source

The branch preserves the normal merge histories of:

- #3993: explicit repository workspace binding, including #3997's generic
  Layout/Session panel memory and the owner's reset of old Coding preferences.
- #4017: exact-version, signature-verified pnpm JavaScript bootstrap and its
  verification-workflow consumers.
- Current main, including the already-landed SDK/core bindings from #3992.

These statements identify source, not combined qualification or delivery.
Previous focused, hosted and diagnostic receipts remain tied to their original
revisions. The combined branch needs its own checks and final acceptance.
The public-key secret-scan disposition remains an explicit pending decision;
consolidation does not authorize changing its baseline.

## Remaining implementation and acceptance

| Work | Acceptance owner | State |
| --- | --- | --- |
| Generic `primary`, `presentation`, `drillIns` host | #2995 | Next: real plugin/Coding browser parity, correct Chat ownership, rail, breadcrumb and Back behavior |
| Owner × subject, templates and clone; Board UX | #2996, #2997 | Pending: two-principal route isolation and Project policy enforcement |
| Install trust, verified signer/digest, grants and update consent | #2998–#3001 | Pending: offline real-bundle verification, writer-shaped migration, consent-listener and nonce proofs |
| Required slots and safe mode | #3002, #3003 | Pending: non-removable defaults, fallback/override lifecycle and recovery without executing failed plugins |
| Distribution manifests, precedence, defaults and branding | #3004, #3005, #3008 | Pending: extension/replacement, reset and authorization-preserving configuration |
| Verified offline default set and public plugin scaffold | #3995, #3006 | Pending: pinned artifacts and identities, offline admission, starter and signing proof |
| Board, Browser and Device extraction | #3007 and the design's extraction sequence | Pending: installed plugin delivery and real persisted-state migration |
| File, PR-review and Coding extraction | #3009 and the design's jG/jF/jP sequence | Pending: public SDK-only consumers, migration and replacement-plugin acceptance |
| Home and Inbox/Chat extraction | #3010, #3011 | Pending: required-slot integration and approval-channel acceptance |
| Plugin authoring and complete learning path | #3012 | Updated with each implemented contract; final end-to-end authoring proof remains pending |

SDK-4 and the Ghostty/TerminalView prerequisite (#3994) retain their existing
owners. This branch consumes their published contracts and coordinated source;
it must not build a second terminal or pane-command implementation. Coding has
no interim terminal under the accepted owner decision.

OPEN-11 still requires the owner's approval-channel choice. It does not block
independent layout work, but approval extraction cannot claim completion before
that decision is implemented and tested.

## Completion rule

Do not close the epic because the current PR is green. Each row needs its actual
caller, persistence migration, negative/mutation proof and updated canonical
documentation. Security slices need independent security review. The combined
candidate needs exact-head protected PR and queue qualification; publication,
offline installation, real browser/device behavior and provider outcomes remain
separate evidence. Unavailable prerequisites remain unfinished work.
