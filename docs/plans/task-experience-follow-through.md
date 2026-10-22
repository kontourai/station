# Task experience follow-through

Status: local cache and reload-recovery implementation is complete on one continuing branch,
`feat/task-epic-follow-through`. Open one pull request after the owned work is
complete. The branch starts from published consolidation revision
`d96f54887837be058c5e5119b8028daab0befea1`; it does not reopen the frozen
Task-room source or write to the consolidation branch.

## Owned remaining work

- [#3707](https://github.com/kontourai/station/issues/3707): refresh the changed
  Task record, graph and claim after status/dispatch; refresh project and
  connection-scoped lists after reference mutations. Preserve unrelated Task
  caches and domains. Implemented locally; the real mutation-hook/QueryClient
  cases fail against the old source and pass with the fix. No hosted or release
  qualification is implied.
- [#3703](https://github.com/kontourai/station/issues/3703): default-off tracker
  status write-back and change-provider close-on-merge. Blocked by the published
  contracts described in [the upstream handoff](task-tracker-sync-upstream-gaps.md).
  Preserve explicit status mapping, durable attempt/result records, local
  success on provider failure, and no blind replay after restart. Do not copy
  upstream adapters into Station or treat advisory rendered commands as writes.

## Work retained by other owners

The chat-first Task room, same-Session replies, publication and authority
contracts, Basis reveal geometry and remaining acceptance from #3727 stay with
[#3991](https://github.com/kontourai/station/pull/3991)'s master owner until an
explicit handback. Basis follow-ups
[#3863](https://github.com/kontourai/station/issues/3863) stay with the existing
Basis owner. Their source inclusion, old focused evidence and original-PR
closure do not qualify the combined product.

The master owner explicitly handed new draft/uncertain-operation recovery across
reload to this branch. The local implementation uses a bounded per-tab journal,
explicit Restore, current recipient/authority checks and exact agent-operation
or message-proposal replay. Missing receipts remain unknown. Focused tests and
an isolated paired-browser journey cover reload, lost acknowledgement,
Cancel/Discard and refusal boundaries. Four mutation controls failed as intended,
and restoring the committed source passed 49 focused tests. UI/E2E typechecks
and both real-browser journeys passed. The existing Basis owner completed a
bounded report-only source review of `3d354c4e71e..2e95157e847` with PASS and no
additional actionable findings. That review supersedes the earlier stale-view
finding at `60cd`; it did not independently execute the reported tests. The master-owned original draft/IME/lifecycle and Basis geometry
acceptance is unchanged by this scoped addition.

## Completion evidence

Use focused SDK tests and affected Task UI consumers for the cache change.
Retain the failing original-source control and restored result. Re-review the
canonical SDK explanation and regenerate the reader. Documentation freshness
against the feature branch's actual starting revision distinguishes this lane's
changes from inherited consolidation debt; ordinary readiness against main
remains a separate gate and must not be reported green while it fails.

For tracker integration, first verify the required published APIs, then cover
opt-out, unmapped statuses, exact-item drift, provider failure, durable result
records and uncertain restart without replay. Real tracker writes and
close-on-merge require their own authorized observed evidence. Keep one PR
until these owned obligations are complete or explicitly dispositioned.

## Delivery holds

- The consolidation landed at main `1dd83e0f305149b2d28e2eaff6645358cde5ad7f`.
  This branch merged it normally at `f7fd9e57c82b3b9d1ee810bd6b6c24613097aa6a`.
  Actual main was retained outside the owned feature delta, including its Task
  tab-retention and Basis refresh fixes. The integration does not qualify their
  original broader product acceptance.
- Integrated verification and standard readiness must pass before publication.
  The first owner run exposed one consumer fixture missing the new recovery
  capability; adding it retained all 63 mounted Task assertions and passed.
  Earlier pre-merge readiness failures remain historical receipts, not a reason
  to bypass the current standard gate.
- Tracker sync remains an upstream API dependency. The local recovery and cache
  changes do not complete or close #3703.

There is no additional unowned Task feature implementation identified in this
lane's inventory. Original Task-room acceptance remains with the master owner;
source readiness here is not delivery or qualification of that epic.
