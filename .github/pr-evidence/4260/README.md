# Layout read-failure captures — PR #4260

Retention: source-pinned visual evidence for this PR; retain with its review history.
Captured from `f7e245d270596b892d3e08ba941c3171d6fe7140` in headless Chromium against an isolated instance
(`./station start --instance=layout-final2 --home=<scratch>`) with a scratch
project `demo-proj` and its Coding layout. Playwright aborted
`/api/projects/demo-proj/layouts/coding` to simulate an unreachable server.
These show UI state only, not native shell rendering.

- `error-390-dark.jpg`, `error-390-light.jpg`: the steady error card at 390 px.
- `retrying-390-light.jpg`, `retrying-1440-dark.jpg`: Try again busy while the
  request is held open.
- `recovered-390-dark.jpg`: the Coding workbench after the request is allowed
  through again.
