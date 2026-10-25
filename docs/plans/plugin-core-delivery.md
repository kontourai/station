# Plugin core delivery

This is the active implementation plan for [#2993](https://github.com/kontourai/station/issues/2993),
following the [accepted design](../design/shell-plugins-distributions.md).
The epic is unfinished. The feature branch `feat/plugin-core-epic-2993`
consolidates the implemented repository-binding, panel-state and bootstrap work
in #4046. The owner renewed the instruction to land existing PRs on 2026-10-23;
#4046 may land its qualified subset without closing #2993. The remaining rows
below still require implementation and acceptance.

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
The owner approved the exact historical public-key secret-scan fingerprint on
2026-10-22. Its attestation is recorded in `.gitleaksignore`; no rule, path or
future occurrence is exempted.

## Remaining implementation and acceptance

| Work | Acceptance owner | State |
| --- | --- | --- |
| Generic `primary`, `presentation`, `drillIns` host | #2995 | Implemented in source: contract fields and refusals, `layout.primaryChat` grant, declaration stated on layout reads, generic `LayoutStackHost`, and a real-browser parity spec over built-in Coding and a fixture plugin layout. Pending: the owner's conditional default placement (Diff docked when the workspace has changes), not built |
| Owner × subject, templates and clone; Board UX | #2996, #2997 | Pending: two-principal route isolation and Project policy enforcement |
| Install trust, verified signer/digest, grants and update consent | #2998–#3001 | Pending: offline real-bundle verification, writer-shaped migration, consent-listener and nonce proofs |
| Required slots and safe mode | #3002, #3003 | Required-slot resolver implemented in source for built-in Home and Inbox/Chat, live Home-role adaptation, default mutation refusals and recovery signal. Safe-mode boot/recovery UI (#3003), bundled defaults and independent security review remain pending |
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

OPEN-11 was answered on 2026-10-22: high-risk approval decisions use a
kernel-owned channel; ordinary approvals stay in the shell. Approval extraction
still requires implementation and tests for that boundary.

## Completion rule

Do not close the epic because the current PR is green. Each row needs its actual
caller, persistence migration, negative/mutation proof and updated canonical
documentation. Security slices need independent security review. The combined
candidate needs exact-head protected PR and queue qualification; publication,
offline installation, real browser/device behavior and provider outcomes remain
separate evidence. Unavailable prerequisites remain unfinished work.
