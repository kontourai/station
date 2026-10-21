# Task tracker sync: published-contract gaps

Status: blocked on upstream contracts, inspected 2026-10-15 against Station
`6b4e443ae26` and the installed `@kontourai/flow-agents@6.5.1`. This is a
bounded implementation handoff, not a delivery claim. No tracker write was
performed. [Owner decision 4](../design/work-plane-composition.md#decisions-owner-ratified-2026-07-20)
requires Flow Agents to own sync semantics. [Station #3703](https://github.com/kontourai/station/issues/3703)
asked for both items below and to stop at any missing upstream contract rather
than reimplement it; Station behavior remains unchanged.

## Published-contract recheck

On 2026-10-21, the Task follow-through lane inspected the npm tarball for
`@kontourai/flow-agents@9.2.0` without installing it or changing Station's
`6.5.1` pin. Its root exports still provide mutation rendering and local-file
mutation adapters, but no settings-aware exact-item observation/target-resolution
operation. The shipped ChangeProvider declaration adds `adoptExisting` for an
open change bound to a publish request's exact refs and head. That does not
supply a general kept-change merged/closed observation, and the package root
does not export that internal provider interface as a consumer API.

The upstream observation requests
[#1508](https://github.com/kontourai/flow-agents/issues/1508) and
[#1509](https://github.com/kontourai/flow-agents/issues/1509), and label status
mismatch [#1507](https://github.com/kontourai/flow-agents/issues/1507), were still
open at this dated check. The two implementation blockers
below remain. No dependency upgrade, tracker write, merge operation or live
tracker qualification was performed. An eventual published contract must be
inspected again before the Station integration can proceed.

## Verified starting points

- Station delegates board reads to the published settings and pull-work CLIs in
  [`flow-agents-work-item-provider.ts`](../../src-server/services/work-item-providers/flow-agents-work-item-provider.ts).
- Assignment claims use the package CLI through
  [`assignment-claim-service.ts`](../../src-server/services/evidence/assignment-claim-service.ts).
- [`task-close-out.ts`](../../src-server/services/projects/task-close-out.ts) uses
  Station's exact-identity PR read. Its person-controlled `closeOnMerge` policy,
  kept-PR identity checks and reconciliation limits remain in force.
- Flow Agents exports the seven shared statuses and mutation request/result
  types, `createGithubMutationRenderer` and `createLocalFileMutationProvider`.
  `triage` and `canceled` are Station-local; the [glossary](../glossary.md#tasks--work-items)
  now identifies both. No mapping to a shared status has been selected.

## Write-back blocker: live observation and target resolution

The mutation contract exists. The missing piece is a published adapter operation
that resolves shared provider settings and freshly observes an exact work item
at the native surface that mutation will change. The package's root-exported
`WorkItemProvider.list` interface describes normalizing caller-supplied native
issue JSON; it is not a factory for live exact-item reads.

The shipped CLI offers `work-item-mutation-provider render|apply|status`:
`render` accepts caller-supplied target/observed JSON, while `apply` and `status`
operate on a local backlog file. The GitHub renderer does not fetch current
state. The existing live `pull-work-provider` path returns `ready_queue` and
`intake_gaps`; an in-progress item already on the board can be absent from both.
Changing the person's ready-status filters to force it into a selection would
repurpose policy as mutation authority.

There is also a read/write mismatch for the supported label mutation surface:
the renderer produces `status:<value>` label commands, but issue normalization
uses project status or issue open/closed state, not those labels. The offline
CLI capture supplies an OPEN issue with `status:in_progress` and receives
`status: "todo"`. Projects v2 mutation requires project/item/field/option IDs;
the ready-queue read does not provide a resolved mutation target for a chosen
neutral status. Station must not implement either adapter mapping itself.

**Upstream request ([kontourai/flow-agents#1508](https://github.com/kontourai/flow-agents/issues/1508); label read/write mismatch: [#1507](https://github.com/kontourai/flow-agents/issues/1507)):** publish a settings-aware exact-item observe/target-resolve
CLI or root export for supported mutation surfaces. Return identity, current
mutation base, resolved target and supported-operation policy; distinguish
missing/unavailable/unsupported results. Its read status must agree with its
mutation representation, including labels and Projects v2 option selection.
This enables Station to use the existing mutation provider, re-observe just
before executing advisory output, and refuse drift without copying adapters.

After that ships, Station still needs its own default-off person opt-in,
durable per-transition attempt/result, explicit unmapped-status skip reason,
local-success-on-provider-failure behavior, and bounded delivery without
automatic retries. A pending attempt across restart must remain indeterminate
rather than being replayed blindly. These host responsibilities are not
implemented or qualified by this handoff.

## Close-on-merge blocker: arbitrary change observation

The research behind #3703 correctly identified normalized `open|merged` observations, but
those belong to the authenticated publish operation. The installed
`build/src/cli/change-provider.d.ts` exposes `checkCapability` and
`createOrRecover`; the latter can create a PR. It cannot be used as a read-only
substitute for a kept-PR refresh. Neither its factory nor the interface is
exported by the package root.

The shipped `observeGithubMergedChange` implementation is package-private and
requires a Flow-bound repository, base/head refs, immutable head SHA and provider
actor. It only confirms merged state. Station's kept declaration records do
not supply that binding, and importing its internal path fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. Executing the public authorized merge operation
would perform a different, unauthorized action. `publish-change reconcile-final-state`
checks local trust/release artifacts; it is not a live PR reader.

**Upstream request ([kontourai/flow-agents#1509](https://github.com/kontourai/flow-agents/issues/1509)):** publish a read-only provider-neutral change observation
operation accepting an exact provider/host/repository/ref/native-ID identity.
Return observed identity and normalized open/merged/closed-without-merge or
unavailable state, preserving the distinction that only merged can complete a
Task. It must work independently of a Flow publish/merge gate and never create
or merge a change. Include provider capability discovery so Station can use
the adapter where supported without assuming GitHub.

Station retains its current exact-identity PR reader and conversation refresh.
Even after an observation contract ships, conversation listing, reviews and
checks may still need Station's PR provider: the current Flow Agents contract
does not offer those operations. A short comment at the close-out import names
the current gap. Jira and Linear adapters remain upstream ([kontourai/flow-agents#1510](https://github.com/kontourai/flow-agents/issues/1510)) and outside this lane.

## Executed contract captures

[`task-tracker-sync-cli-captures.json`](task-tracker-sync-cli-captures.json)
contains complete input documents and parsed stdout, stderr and exit codes from
the installed public CLI. The inputs use example coordinates, and no rendered
command was executed. These are observed package outputs, not invented mocks
or Station integration-test fixtures.

From the repository root, resolve the installed CLI as
`node_modules/@kontourai/flow-agents/build/src/cli.js`. Write `mutation.request`
and `mutation.target` from the capture to separate temporary JSON files, then
run:

```sh
node node_modules/@kontourai/flow-agents/build/src/cli.js work-item-mutation-provider render --request-json <request.json> --target-json <target.json>
```

This returned exit 0 with `status: "not_verified"` and the reason
`no current provider observation was supplied to compare against the mutation's declared base`.
Add `--observed-json <observed.json>` with `{"status":"ready"}` to reproduce
`mutation.rendered` (`advisory: true`, two `gh_commands` arrays), or
`{"status":"review"}` to reproduce `mutation.conflict` (`advisory: true`, no
commands). Exit 0 means the CLI answered, not that a mutation was applied.

For the read probes, write `read.settings`, `read.issues` and `read.board` to
temporary JSON files. Run `pull-work-provider --settings-json <settings.json>`
with `--issues-json <issues.json>` or `--items-json <board.json>`, adding
`--now 2026-10-15T00:00:00.000Z`. Both returned exit 0: the former produced
`todo` despite the status label; the latter omitted the in-progress board item
and reported `zero_ready_items`. These are offline normalization probes, not
live tracker observations.

## Evidence disposition

- **EXECUTED:** dependency setup; public mutation render probes (unobserved,
  advisory render, conflict); read normalization/filter probes; root-export
  availability and private-path rejection; public publish/merge CLI help.
- **NOT_VERIFIED:** Station write-back integration, default-off behavior,
  durable failed-attempt/local-success behavior and restart delivery. Implementation
  stopped at the required upstream observation contract.
- **NOT_VERIFIED:** ChangeProvider-based kept-PR close-out and its mutation
  controls. Implementation stopped at the required upstream read-only contract.
- **NOT_VERIFIED:** baseline/injected/restored behavioral fault injection for
  those new behaviors; no implementation was added to mutate. Existing tests
  can establish only the retained behavior, not the requested migration.
- Gate, focused-test and readiness results are recorded on the pull request for
  #3703. No hosted qualification or real tracker write is claimed.
