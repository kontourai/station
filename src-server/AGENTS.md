# Server scope

Read [the module map](../docs/architecture/module-map.md) for the affected module. Preserve public API and contract boundaries: route validation belongs at the route seam; domain behavior stays in services. Do not reach into sibling Kontour repositories. Use the Station logger seam, not new `console.*` calls.

Run the exact focused server tests selected by `npm run gate:for`; add a targeted route/service test for changed behavior. Read [development guidance](../docs/guides/development.md) for lifecycle and security conventions.

Every new process launch must set `windowsHide: true`.

Batch repeated reads at the owning request seam, preserving user scope, corruption behavior, and freshness between requests. Verify the caller actually uses the batch; a helper-only test cannot establish request cost. Follow the [test-effectiveness route](../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness) for targeted mutations and diagnostic profiling, and keep browser counters separate from server/device performance claims.
