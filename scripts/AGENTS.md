# Scripts and verification scope

Executable policy is the source of truth. Keep a gate deterministic, fail-closed, and independently testable; do not widen an allowlist or bypass a guard to make it pass. New child-process tests must be classified in `scripts/vitest-resource-manifest.mjs`.

Every new `spawn`, `spawnSync`, or `execFile` call must pass `windowsHide: true`.

The generated verification schedule and detailed reuse/failure policy have one owner: [docs/guides/testing.md](../docs/guides/testing.md). Regenerate from `scripts/verification-lanes.mjs`; do not copy generated blocks into an instruction file. Use the focused policy tests, not a broad verification lane, while iterating.
