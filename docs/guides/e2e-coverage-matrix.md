# E2E Coverage Matrix

Snapshot of the primary app surface and its current Playwright coverage. The
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
clean-install, smoke-live, extended, and screenshot buckets are run through
`scripts/run-e2e-suite.mjs`; Android remains a separate Playwright project.
CI's Full Playwright Coverage job and the local `npm run verify` gate both use
the full contract, so new specs must update this manifest before they can stay
green.

Admission is claim-based, not feature-count-based: keep a Playwright test only
when the claim requires a real browser, packaged boundary, or end-to-end user
journey. API-only contracts move to route/service/SDK integration coverage.
Tests that can pass when their required UI is absent are vacuous and must be
repaired or removed. Surface maintenance uses four outcomes: keep, split, move
down with replacement, or remove as vacuous.

## Core Nav

| Surface | Current specs | Coverage level | Main gaps |
|---|---|---|---|
| Home / continuity rail | `task-first-home`, `root-route-restore`, Android `navigation`, `mobile-chat-composer` | full | Deterministic desktop + Pixel 7 coverage owns task continuation, guided start/project actions, concrete identity, one Advanced disclosure, deep links, root loading/retry/stale restore, overflow, touch geometry, and composer reachability |
| Projects | `project-lifecycle`, `project-forms`, `project-architecture`, coding-layout specs | full | Create, settings edit, delete, restore/navigation, unsaved guard, and failed-save error coverage are promoted; project-agent scoping contracts are covered at the route/contract layer |
| Agents | `agents`, `default-agent-workflow`, `builtin-runtime-workflow`; `acp-project-context` remains extended for ACP-specific context checks | full | Managed and connected create/edit/delete, tab shape, unsaved guard, failed-save error, runtime option persistence, chat/runtime flows, and ACP connection context are covered |
| Skills | `skills` | full | The one guidance-authoring lane. Product coverage includes create/edit/delete, duplicate, markdown import, guarded navigation, duplicate-destination errors, source labeling, command skills (the switch pair, derived variable chips, counters, test run), and the retired `/playbooks` path landing on the Skills tab |
| Registry | `registry`, `registry-install`, `skills` | full | Registry tabs cover Agents, Skills, Integrations, and Plugins with detail preview, search empty state, install/remove, installed-state reflection, action failure messaging, and plugin install/remove promotion; system endpoint contracts are covered below the browser layer |
| Connections | `connections-crud`, `connect-modal`, `connect-reconnect-banner`, parts of `settings`, runtime/provider chat specs | full | CRUD lane exists for provider, runtime, and tool-server flows; remaining work is maintenance, not missing ownership |
| Plugins | `plugin-update`, `plugin-system`, `plugin-preview` | full | Preview, install/remove API, bundle serving, update success/failure, detail metadata, settings persistence, provider toggles, changelog expansion, and selected-plugin remove recovery are promoted |
| Schedule | `schedule`, `schedule-runs` | full | Hermetic CRUD coverage includes add, edit, duplicate, run, filter, enable/disable, delete, run history, and output deep links |
| Monitoring | `monitoring` | full | Hermetic history coverage includes sidebar stats, active and historical agents, metrics, event type filters, free-text search, agent/conversation/tool/trace chips, time-range fetching, and clear/reset empty state |

## Assessment

- The Starter clean-install bucket boots a runner-owned, freshly created home
  with provider discovery and inherited product/OTLP telemetry disabled. It
  proves the Starter journey without reading a developer's Station state or
  sending to an endpoint configured in the parent shell. Its explicit healthy
  resource observation isolates this product path from unrelated host load;
  resource-posture fault tests remain the authority for honest deferral.
- The app now has a promoted product Playwright gate covering primary nav,
  connections, registry, plugins, schedule run history, and orchestration/chat
  flows.
- Phase 0 of the full-coverage completion plan added manifest ownership so new
  specs cannot silently fall out of a bucket.
- The primary product surfaces now have surface-owned workflow lanes instead of
  relying on shell-only checks.
- Regressions can still slip through when newly added specs are not assigned to
  a manifest bucket or when feature work changes a UI contract without updating
  the owning lane.

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

The matrix should declare which tier each surface is targeting in the current phase instead of assuming `full` everywhere.
