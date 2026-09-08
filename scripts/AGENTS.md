# Scripts and verification scope

Executable policy is the source of truth. Keep a gate deterministic, fail-closed, and independently testable; do not widen an allowlist or bypass a guard to make it pass. New child-process tests must be classified in `scripts/vitest-resource-manifest.mjs`.

Every new `spawn`, `spawnSync`, or `execFile` call must pass `windowsHide: true`.

The generated verification schedule and detailed reuse/failure policy have one owner: [docs/guides/testing.md](../docs/guides/testing.md). Regenerate from `scripts/verification-lanes.mjs`; do not copy generated blocks into an instruction file. Use the focused policy tests, not a broad verification lane, while iterating.

For evidence tooling, use the [fixture/profile/mutation commands](../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness) rather than another bespoke runner. Reuse `scripts/lib/owned-process.mjs` for process-tree ownership and bounded output. A nonzero command exit is not automatically a caught mutation: distinguish assertion failure from missing dependencies, empty selection, timeout, and wrong-root execution. Restoration must preserve intervening edits. New policy needs known-bad catch tests and false-positive controls before joining `verification:policy:gate`.

For asynchronous verification, collect the process exit status before reporting PASS. A log containing only the command header, or no error yet, is still pending. Resolve retained artifact paths before passing them to owners that require absolute paths; relative report directories are valid caller inputs.

Before a scripted bulk edit, assert the expected match count and anchor replacement boundaries within the intended owner. Repeated loop names are not unique anchors. Inspect the complete diff and its size before committing; a green source guard does not prove unrelated checks survived its own edit.
