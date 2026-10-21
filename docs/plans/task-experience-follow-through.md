# Task experience follow-through

Status: active implementation on one continuing branch,
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
Cancel/Discard and refusal boundaries; mutation and final review evidence remain
required. The master-owned original draft/IME/lifecycle and Basis geometry
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
