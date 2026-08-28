# Issue lifecycle

Station keeps issue ownership explicit with two mutually exclusive handoff labels. The canonical label inventory is [`.github/labels.json`](../../.github/labels.json), and the deterministic transition rule is [`scripts/issue-lifecycle-reducer.mjs`](../../scripts/issue-lifecycle-reducer.mjs).

- Opening or reopening an issue applies `needs:maintainer`.
- A maintainer with triage, write, maintain, or admin permission may deliberately apply `needs:reporter`; this removes `needs:maintainer`.
- A substantive comment from the issue reporter while `needs:reporter` is present restores `needs:maintainer` and removes `needs:reporter`.

The automation never infers a transition from prose. It ignores blank comments, HTML comments, quoted Markdown, emoji-only replies, and acknowledgements such as `+1`, `thanks`, and `ack`. It changes only these two labels and leaves priority, correctness, assignment, `agent:claimed`, delivery-stage, closure, and unrelated labels untouched.

Delivery labels are an independent axis: choose at most one of `stage:source`, `stage:preview`, or `stage:stable`. The protected-base Source availability workflow projects only source from exact same-repository merged-PR closing facts in a bounded main push range. The terminal `Publish Station release` availability job can advance that same issue set only after a successful public (non-draft) stable or preview publication. It redownloads every release asset, validates the v2 inventory, updater, container and SBOM predicates, recomputes the inventory SHA-256, verifies each exact tag/ref/source GitHub attestation, and bounds a same-channel prior-public-release commit/PR/closing-issue range. `station-updater-public-key.txt` is a public, inventory-bound and release-attested asset; after staging it is the sole updater verification authority, never a signing environment secret. Branches, open PRs, dry runs, drafts, failed publication, paginated or ambiguous provider facts, first releases, conflicts, and lost label-write readback are `NOT_VERIFIED` and change nothing. The job mutates only this stage axis and reads every mutation back (archive#3809; archive#3817 public-contribution policy).

## Label reconciliation

`npm run labels:check` verifies the committed contract. Reconciling GitHub labels is intentionally a separate write operation: it requires `--reconcile --write-authorized --repo=kontourai/station --confirm-repository=kontourai/station`. It creates or updates declared labels, reports unexpected live labels, and never deletes them.
