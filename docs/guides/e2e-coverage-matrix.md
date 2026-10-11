# E2E Coverage Matrix

Reading map for the primary app surfaces and their Playwright evidence. The
full coverage gate is `npm run verify:e2e:full`; it runs the promoted product,
first-run, Starter clean-install, live smoke, extended, screenshot, and Android
buckets. The
product bucket itself is `npm run test:e2e:product`, which runs the promoted
cross-surface suite through `scripts/run-e2e-suite.mjs` against a temporary
`./station` instance.

`tests/e2e-manifest.mjs` is the source of truth for spec ownership. Every
top-level and Android Playwright spec must be assigned to exactly one bucket:
`product`, `first-run`, `starter-clean-install`, `smoke-live`, `extended`,
`screenshot`, `quarantine`, or `android`. Product, first-run, Starter
clean-install, smoke-live, extended, screenshot, and Android buckets are run
through `scripts/run-e2e-suite.mjs`; Android selects a separate Playwright project.
[Extended CI](../../.github/workflows/ci-extended.yml)'s Full Playwright Coverage job and the local `npm run verify` gate both use
the full contract, so new specs must update this manifest before they can stay
green.

Admission is claim-based, not feature-count-based: keep a Playwright test only
when the claim requires a real browser, packaged boundary, or end-to-end user
journey. API-only contracts move to route/service/SDK integration coverage.
Tests that can pass when their required UI is absent are vacuous and must be
repaired or removed. Surface maintenance uses four outcomes: keep, split, move
down with replacement, or remove as vacuous.

## Core Nav

This table routes to representative browser assertions. It is not a claim that
any surface has complete coverage or that the latest run passed. Specs combine
real application calls with fixture responses; inspect the named test and its
intercepts before extending its evidence to a backend or provider.

| Surface | Current spec owners | What to inspect |
| --- | --- | --- |
| Home / continuity rail | `task-first-home`, `root-route-restore`, Android `mobile-layout`, `mobile-chat-composer` | Continuation, first steps, deep links, loading/retry state, mobile geometry, and composer reachability; many Home responses are mocked |
| Projects | `project-lifecycle`, `project-forms`, `project-architecture`, `project-icons`, `coding-layout-plan-panel` | Create/edit/delete, layout selection, unsaved guards, failed saves, phone-sized form containment, and an icon set in settings reaching the sidebar, a Home row and the switcher through the live server |
| Settings / Customize | `settings`, `project-architecture`, `registry` | Topic navigation, legacy links, scope captions, save/readback and discard guards, mobile controls and overflow, and Customize → Plugins → Registry |
| Agents | `agents-pane`, `agents-readiness-board`, `agents-editor-gates`, `agents-editor-roundtrip`, `agents-copy-existing`, `agents-new-model-turn`, `agents-new-cli-turn`, `agents-new-muse-echo-turn`, `default-agent-workflow` | Separate browsing, readiness, editing, copying, and engine-specific turn journeys; `agents.spec.ts` is no longer the owner |
| Skills | `skills` | Create/edit/source labeling, command switches, variable resolution, test runs, read-only explanation, the retired playbook redirect, and the detail header's two-labelled-action cap at 1280 and 390 pixels |
| Registry | `registry`, `skills` | Tabs including Layouts, preview, search, install/remove, enable/disable, and action failures |
| Connections | `connections-crud`, `connect-modal`, `connect-remote-auth-recovery`, `connect-reconnect-banner` | Model/runtime/tool-server setup, manual consent, connection repair, keyboard focus, and phone-sized dialogs |
| Plugins | `plugin-update`, `plugin-preview`, `plugin-pane-sdk-context`, `minimal-workspace-example`, `bundled-plugin-registry-lifecycle` | Update success/failure, permission denial, installed plugin panes rendering, settings, removal, and dialog containment |
| Schedule | `schedule`, `schedule-runs` | CRUD, explicit run, filter/toggle, keyboard sorting, run history, output, and exact-run deep links |
| Monitoring | `monitoring` | Fixture history, event/search filters, chips, time ranges, stable toolbar actions at desktop and phone widths, and sidebar/metric rendering; this does not establish telemetry producer completeness |

The [manifest](../../tests/e2e-manifest.mjs) assigns each spec's bucket and
execution class. The [coverage runner](../../scripts/run-e2e-coverage.mjs) runs
all seven non-quarantine buckets, records per-bucket results, and treats a
successful exit with no executed tests as `EMPTY`, not coverage. A timed-out
bucket and an account-disabled scenario remain distinct from passed evidence.
The runner requires POSIX process-group settlement. Its `android` bucket uses
the separate browser project; a bucket name alone is not an installed Android
app or physical-device receipt.

## Assessment

- The Starter clean-install bucket boots a runner-owned, freshly created home
  with provider discovery and inherited product/OTLP telemetry disabled. It
  proves the Starter journey without reading a developer's Station state or
  sending to an endpoint configured in the parent shell. Scheduler admission
  is covered at the service and ledger seams; host resource observations are
  diagnostic only and do not control product work.
- The app now has a promoted product Playwright gate covering primary nav,
  connections, registry, plugins, schedule run history, and orchestration/chat
  flows.
- Phase 0 of the full-coverage completion plan added manifest ownership so new
  specs cannot silently fall out of a bucket.
- The primary product surfaces now have surface-owned workflow lanes instead of
  relying on shell-only checks.
- Manifest validation refuses unassigned specs. Regressions can still slip
  through an assigned test with weak assertions, an untested failure case, or
  feature work that changes a UI contract without updating its owning lane.

## Priority Lanes

1. Keep the manifest audit green for new specs.
2. Expand screenshot and extended buckets when a surface gains visual or
   runtime-only behavior that is not suitable for the hermetic product gate.

## Coverage Standard

For each primary product surface, prefer one named Playwright lane with a clearly declared tier target:

1. `smoke`
   - page render
   - one key affordance
2. `partial`
   - one meaningful mutation or workflow
   - one user-visible success assertion
3. `full`
   - create
   - edit
   - delete or reset/remove
   - unsaved-change guard where applicable
   - one user-visible success assertion
   - one failure-path assertion

These tiers are authoring targets. Assign one only after checking the actual
assertions and the retained run; a spec filename or manifest entry is not
enough to label an entire surface `full`. The table above deliberately records
concrete owners and claim boundaries instead.
