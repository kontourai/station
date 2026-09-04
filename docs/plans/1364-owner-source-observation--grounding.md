# Owner-backed learning source observation — grounding proposal

Status: approved bounded Station-owned observation implementation; HTTP/UI
exposure and runtime authorization wiring are NOT approved yet. Station #1364
remains open. The original foundation was `31f7eb37c3053b3e827b36685a74f0ff2d284cbb`;
normal merge `08b675dba` incorporates main `67d72d45` before this owner slice.
Verification receipts, not this plan, own the eventual test status.

## Verified publication boundary

Live npm metadata reports `@kontourai/flow-agents@6.2.0`, also Station's pin;
publication `gitHead` is `bcc5310f651febc326c7fd003a400edab9b50e34`.
Its export map includes `./console-contract`, `./kit-observability-contract`,
and `./schemas/*.json`. Read-only ESM resolution confirmed these public schema
paths, without importing or executing their producers:

- `@kontourai/flow-agents/schemas/workflow-learning.schema.json`
- `@kontourai/flow-agents/schemas/knowledge/proposal.schema.json`
- `@kontourai/flow-agents/schemas/knowledge/context-check-result.schema.json`

The same probe returned `ERR_PACKAGE_PATH_NOT_EXPORTED` for
`@kontourai/flow-agents/kits/knowledge/adapters/default-store/index.js`.
Tarball presence is not an API. Station's ADR-0001 and
`scripts/knowledge-kit-import-gate.mjs` prohibit private-import/filesystem
workarounds. Published file-format documentation is legitimate contract
evidence, not permission to execute internal Kit modules.

Public types and documentation were inspected in the verified published 6.2.0
dependency artifact of the separately owned composition worktree. This was
documentary access, not borrowing dependencies to execute this old worktree.

## What the owners actually report

- Published `kits/knowledge/docs/store-contract.md` §§1, 4, 6–8 and addenda B/J:
  record IDs are unique **within a store**; records carry immutable creation
  provenance, append-only mutation logs, and active/implemented/retired status.
  A `proposes` edge may remain after `apply`; it cannot alone prove an open
  proposal. Generic record `active` is not deployed learning activation.
- Public Knowledge write-proposal schema: status is always `proposed`;
  enactment is downstream. It does not supply activation/effect receipts.
- Public Context Check result schema: revision-pinned authority/retrieval,
  recalls, reconciliation and proposed context updates. `pass` is not evidence
  of learning effectiveness or deployment. Schema availability is not a
  supported record-access transport.
- Public workflow-learning schema and `docs/workflow-usage-guide.md` learning
  section: workflow facts, interpretation, outcome, routing and correction
  records. Console learning projection is explicitly `nonAuthority: true` and
  its CLI writes generated artifacts by default. Stable console-contract does
  not export a learning lifecycle type.
- Public Kit observability contract accepts projection kind `learning` with
  owner-defined `data`; it does not define the missing lifecycle semantics.

## Existing Station access is not a zero-write reader

Relevant source is unchanged between this foundation and the inspected main:

- `src-server/knowledge-store/adapters/default-store.ts:95`: construction
  creates the records directory; `get` at line 976 invokes `files.read`.
- `src-server/knowledge-store/adapters/shared/file-transactions.ts:112`:
  construction creates root/coordination directories. `read` at line 159
  delegates to `mutate('read-repair')`; line 178 invokes journal recovery.
- `src-server/knowledge-store/knowledge-store-provider.ts:187` lazily creates
  an adapter on cache miss. A nominal GET is therefore not proof of no writes.

Do not use this path, scrape private Kit implementation layouts, or add a
parallel JSONL learning ledger. This does **not** block extending Station's own
file-format-conformant adapter owner. ADR-0001 explicitly permits published file
formats; ADR-0009's Decision and `scripts/knowledge-kit-import-gate.mjs:8–14`
expressly recognize from-scratch Station adapters. `default-store.ts:1–15`
already implements the published `records/<id>.md` format. The initial proposal
incorrectly made a missing zero-write method an external-owner prerequisite;
the approved narrower local extension corrects that conclusion.

## Smallest meaningful proposed slice

1. Add `KnowledgeStoreProvider.observeExactRecord(rootId, recordId, authority)`
   inside the existing Station owner. It defaults to `restricted`; only a
   constructor-captured host policy can admit the exact target. A boolean,
   claimed principal, localhost, or registered root is not request authority.
   There is **no production policy or HTTP/UI caller** in this first slice.
2. Support only registered built-in `kit-default-store` roots via a separate
   construction-free observation port of `KnowledgeFileTransactions`, never
   `adapterFor`, ordinary `get`, read-repair, root bootstrap, or plugin adapters.
   Writer and observer use one metadata-only coordination-root resolver. The
   policy home is only an expected-owner assertion: a mismatch or a later
   runtime-home change refuses observation before open and at final recheck.
   It cannot move observation into a different lock namespace.
   Bound the real root registry and source file; validate exact filename/id and
   shared format/schema. Check identities before/after reading and refuse known
   journals/locks without opening their payloads or probing/reaping an owner.
   Symlink, hardlink, non-regular leaf, FIFO open-boundary, detected replacement,
   corruption and budget failures fail closed. No writes, repairs, events,
   indexes, processes or application home payload reads occur in observation.
   Source digest/time are Station observations, **not** owner revision or CAS.
   Absence of a visible journal/lock is not proof that no transaction occurred:
   return explicit `non-atomic`, unknown transaction state and unknown revision.
   Node pathname checks do not supply an atomic ancestor/openat capability.
3. Later, narrow `packages/contracts/src/learning-review.ts` and the pure view model
   with an explicit source-only variant. The present full projection requires
   scope, candidate kind/expected effect and owner projection identity that a
   generic record does not establish. Root location is not deployment scope;
   raw/compiled/concept is not skill/claim/guideline. Unsupported lifecycle
   stages remain gaps, with no approve/apply/retire action.
4. Add one authenticated read route and existing-query-domain consumer only
   after review of exact host-derived single-operator/root/record authorization,
   revalidation and denial semantics. No new source of persistence or truth.
   Other principals remain unavailable/restricted until supported policy exists.

Flow Agents #417/#1115 still track portable cross-product access and identity;
#1131 tracks Context Check and #1027/#1085 later lifecycle/effect semantics. They
are not prerequisites for Station's local source-only observation extension.

Acceptance: actual owner-produced record through the supported reader and real
route/view-model seam; exact root qualification; denied reads never invoke the
reader or disclose identity; bounded malformed/oversized input; no writes,
repairs, processes or mutations beyond the explicitly supported owner read;
stale/unknown source state preserved; no activation from approval/status/pass;
no success from zero effect observations. A real rated-response → candidate →
decision → active revision → observed effect chain remains later #1364 scope.

Estimate: roughly 2–3 engineer-days for the bounded local owner capability plus
adversarial tests and separately reviewed route/projection wiring. No effect,
privacy-runtime, or end-to-end product claim follows from the owner-only slice
or the current pure contract/view-model fixtures.
