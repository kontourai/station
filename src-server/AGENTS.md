# Server scope

Read [the module map](../docs/architecture/module-map.md) for the affected module. Preserve public API and contract boundaries: route validation belongs at the route seam; domain behavior stays in services. Do not reach into sibling Kontour repositories. Use the Station logger seam, not new `console.*` calls.

Run the exact focused server tests selected by `npm run gate:for`; add a targeted route/service test for changed behavior. Read [development guidance](../docs/guides/development.md) for lifecycle and security conventions.

Every new process launch must set `windowsHide: true`.
