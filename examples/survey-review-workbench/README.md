# Survey Review Workbench

Kontour Survey's Review Workbench as a Station layout plugin. A reviewer works a
queue of extracted candidates (`@kontourai/survey/review-workbench`),
sessions persist per project on the Station server, and a completed review
projects into a Surface trust bundle.

## What it contributes

- **Layout** `survey-review` with one tab mounting
  `mountReviewWorkbench` (Survey's DOM mount function) plus Station chrome
  for sessions and projection.
- **Server module** (`server/plugin.mjs`, dependency-free ESM) providing the
  per-project persistence behind Survey's `ReviewSessionEventStore` contract:
  - `GET  /api/plugins/survey-review-workbench/projects/:projectSlug/review-sessions`
  - `GET  /api/plugins/survey-review-workbench/projects/:projectSlug/review-sessions/:sessionName`
  - `PUT  /api/plugins/survey-review-workbench/projects/:projectSlug/review-sessions/:sessionName`
    — body `{ snapshot?, events, expectedEventCount? }`, optimistic
    concurrency via `expectedEventCount` (409 on conflict, current events
    returned)
  - `POST /api/plugins/survey-review-workbench/projects/:projectSlug/trust-bundles`
    — body `{ sessionName }`; the server derives the bundle from persisted
    review state rather than accepting a client-authored verdict

## Storage contract

- Review sessions (Station-owned, shared per project):
  `<STATION_HOME>/projects/<projectSlug>/plugin-data/survey-review-workbench/review-sessions/<sessionName>.json`
  holding `{ name, snapshot, events, updatedAt }` — the pre-decision queue
  snapshot plus the append-only event log Survey's replay helpers expect.
- Trust bundles (the hand-off the trust panel renders):
  `<project workingDirectory>/.station/trust-bundles/survey-<sessionName>.json`.
  If the project has no working directory, the bundle is stored under the
  plugin-data directory instead and the response flags
  `location: "station-home"`.

## Try it

```bash
cd /path/to/station
npm run dependencies:ci
cd examples/survey-review-workbench
npm run build
```

`npm run build` invokes the checkout's own `./station` launcher by relative
path, from this example's directory, so it works in this repository without a globally installed `station`
(station#2124). If you copy this example elsewhere, that relative path no
longer resolves — point the build script at your installed `station`, or use
the checkout-independent `buildPlugin()` entrypoint shown in
`docs/guides/build-your-first-plugin.md`.

Install the built plugin from the Plugins page — or from a terminal with
`station plugin install <this directory>`, which previews it, prints what it
requires, and asks before submitting installation. Preview can stage content;
it is not a no-write operation. (Over raw HTTP that is
`POST /api/plugins/preview` followed by `POST /api/plugins/install` carrying
the preview's answer as `consent`; an install without one is refused.) Then add
the "Survey Review" layout to a project via *Add layout → From plugin*.
The server module is trusted code and needs the separate host-owned
`plugin.server` grant. Its browser fetches use the selected API base but do not
attach the SDK's native/bearer transport; remote and native use need separate
qualification. Same-origin cookie behavior is not evidence for those transports.

Use **Load example review** to seed a session from Survey's published example
data (`@kontourai/survey/example-data/public-directory-review-resource`) —
clearly demo content. Make decisions, reload to confirm persistence, then
**Project to Trust Bundle**.
