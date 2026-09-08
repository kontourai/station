# Server scope

Read [the module map](../docs/architecture/module-map.md) for the affected module. Preserve public API and contract boundaries: route validation belongs at the route seam; domain behavior stays in services. Do not reach into sibling Kontour repositories. Use the Station logger seam, not new `console.*` calls.

Run the exact focused server tests selected by `npm run gate:for`; add a targeted route/service test for changed behavior. Read [development guidance](../docs/guides/development.md) for lifecycle and security conventions.

Every new process launch must set `windowsHide: true`.

Batch repeated reads at the owning request seam, preserving user scope, corruption behavior, and freshness between requests. Verify the caller actually uses the batch; a helper-only test cannot establish request cost. Follow the [test-effectiveness route](../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness) for targeted mutations and diagnostic profiling, and keep browser counters separate from server/device performance claims.

Do not assume path helpers are pure string operations: Flow Agents resolves its shared artifact root through Git. Resolve that root once per listing request and reuse it for sidecar paths; avoid a persistent cwd cache that could miss worktree or authority changes.

For installed-package integrity reads, keep asynchronous callers on the yielding digest path. Coalesce callers only into a scan that starts after they arrived, and serialize physical scans of the same tree. A catalog snapshot is inert, request-local data; never reuse it as execution or mutation authority.
