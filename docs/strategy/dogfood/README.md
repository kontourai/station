# Dogfood run reports

Retention: permanent — the committed report digests are ledgered in `evidence-retention.json` and `evidence-archive.json`, and `scripts/__tests__/dogfood-evidence-retention.test.ts` fails if a cited digest loses its retained bytes, archive entry or ledger entry.

The `dogfood-NNN-*` directories are the twenty Flow reports from runs of the
internal `station-delivery v1` definition. That definition is
[retired](../station-delivery-retirement.md), so this is a closed set: no new
runs are added here. Two runs share the number 019.

Each report commits the digests of its evidence. The bytes are either retained
under the run's `evidence/` directory, packed in the receipts archive described
by [`evidence-archive.json`](evidence-archive.json) (the release
`dogfood-evidence-archive-v1` on kontourai/station-archive; check a download
with `node scripts/build-evidence-archive.mjs --verify=<path>`), or recorded as
unrecoverable in [`evidence-retention.json`](evidence-retention.json).

[`first-run-ritual.md`](first-run-ritual.md) is a current release checklist,
not a run report.
