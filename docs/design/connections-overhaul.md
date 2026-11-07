# Connections overhaul and the resource-hub kit

> **Status: proposal, 2026-11-07; owner-directed.** Tracking issue
> [#4710](https://github.com/kontourai/station/issues/4710). Nothing here is
> implemented yet. The [Connections guide](../guides/connections.md) remains the
> current user journey until each slice below lands and updates it. This record
> builds on the readiness and explicit-Add rules in
> [connections onboarding](connections-onboarding.md) and does not change them.

## Outcome

Every connection answers four questions, in this order:

1. **Can I use it now?** One verdict, its reason, and at most one fix.
2. **How much is left?** Provider-reported allowance, where the provider reports it.
3. **What is it doing and costing?** Station-observed usage over 7 or 30 days.
4. **What depends on it?** Agents, scheduled jobs and projects that select it.

Configuration is the fifth question and lives on its own tab.

The pages that answer these questions share one **resource-hub kit**, so other
list/detail pages (Agents, Skills, Plugins, Sessions) can adopt the same status,
row, detail, usage and editor primitives instead of rebuilding them.

## Evidence

Captured on `origin/main` `c32b332c` with an isolated Station on macOS, the
locally installed Claude Code, Codex and Muse Code, and source inspection.
Screenshots were not committed; they contain a real account's allowance.

| Observation | Cause |
| --- | --- |
| Claude Code showed **Status: Ready** beside **7-day limit: 0% left**. | No readiness path reads `EngineAccountUsage.exhausted` ([engine-accounts contract](../../packages/contracts/src/engine-accounts.ts)). |
| Claude Code listed 64 models, including other vendors', while **Connect through** read **Your account**. | The server passes its own environment to engine children ([child-process environment](../../src-server/utils/child-process-environment.ts)). An inherited `ANTHROPIC_BASE_URL` with gateway discovery made the CLI list the gateway's catalog. The UI does not disclose ambient routing. |
| Cursor, Kiro CLI and OpenCode were detected but appeared only deep inside **Add engine**. | The Engines list shows only connected engines and added-but-unconnected ACP entries. |
| The Knowledge tab showed no attention dot with no embedding model. | [Section signals](../../src-ui/src/views/connections-hub/connection-section-signals.ts) check only the vector database. |
| `/connections` opened an empty Models tab while all activity was on Engines. | The resolver falls back to Models when nothing needs attention. |
| Engine usage appears only for Claude Code and Codex, behind credential-management access. | `/api/analytics/usage-rollup` allow-lists `provider` to `claude` and `codex` ([analytics routes](../../src-server/routes/operations/analytics.ts)). ACP engines record receipts as `provider: 'acp'` with context occupancy only; Station's engine records none. |
| Engine detail repeats status three times and ends with a ~5,700px **Advanced** section. | [Engine detail](../../src-ui/src/views/AgentConnectionView.tsx) renders read-only facts as form fields, the full catalog as chips, and every option in one disclosure. |
| Computers rows show the UI origin and **Authorized**, nothing about the machine. | [Computer rows](../../src-ui/src/views/connections-hub/computer-rows.ts) hold liveness only for SSH profiles. |
| Tool servers read **Not checked yet**; their `usedBy` is never shown. | `usedBy` holds display names from home agents only ([agent tool map](../../src-server/domain/config-loader-agents.ts)). |

Readiness is derived in five places that disagree: the provider presentation
resolver, the section-rail rule, the built-in engine picker, the server-side
agent runnability and the first-run projection. The rail misses failed checks,
degraded engines and unverified models that the resolver labels.

## The resource-hub kit

The kit lives in `src-ui/src/components/resource-hub/`. It composes existing
owners (`SplitPaneLayout`, `DetailHeader`, `Tabs`, `ActionRow`, the state family,
`StatusBadge`, `Metric`, `Progress`) rather than replacing them, and its CSS uses
only `--k-*` tokens.

| Primitive | Responsibility | Replaces |
| --- | --- | --- |
| `ResourceStatus` | `{ verdict, label, tone: SemanticTone, reason?, action? }`. `verdict` is `ready`, `limited`, `blocked`, `setup` or `off`. One mapping to `StatusBadge` tones. | `ProviderTone`, `ComputerStateTone`, inline status dots and subtitle-text status. |
| `resourceRow()` | Builds a `SplitPaneLayout` item: status badge, up to two facts (for example "43% left", "$3.10 this week"), and one trailing action. | Seven hand-written row builders. |
| `useResourceFilter()` | Search filtering for rows. | A filter in every page. |
| `ResourceDetail` | Header with the status verdict, its reason, and one primary fix; route-synced tabs; one scroll owner. | Progress rail, summary tiles and readiness notice copies. |
| `ResourceTabs` | `/…/:id/:tab` tabs with manual activation; the list keeps its surface identity. | The dropped third segment in today's parser. |
| `FactList` | Read-only facts as a `dl`. | Read-only values styled as inputs. |
| `MetricTiles`, `Meter` | Tiles over `Metric`; allowance meter over `Progress` with text. | Four tile and two meter implementations. |
| `DailyBars` | Daily bar chart that keeps unreported days distinct from zero, with a table alternative. | Five hand-rolled charts. |
| `UsagePanel` | Period selector, tiles, daily chart and coverage for any `UsageRollup` filter. | Engine account `Activity`, `UsageRollupPanel`. |
| `UsedByList` | Dependents with links. | Slug-prefix guesses and unused `usedBy`. |
| `AttentionList` | One sentence and one action per item. | Readiness notices scattered per page. |
| `useResourceEditor()` | Seed, dirty tracking, `useUnsavedGuard`, save and reset for a detail's settings. | Five seed/dirty/save implementations; closes the Tools guard gap. |

Route plumbing gains one helper that parses and serializes
`/connections/<section>/<id>/<tab>` against an allow-list, so a new tab is not a
six-file change. Unknown tabs are not-found.

## One readiness derivation

`deriveConnectionHealth(connection, evidence)` in
`src-ui/src/views/connections-hub/connection-health.ts` returns a
`ResourceStatus` from contract fields only:

1. Policy disallowed or disabled: `off`.
2. A blocking prerequisite, sign-in, credential or API key: `setup`, with that fix.
3. A fresh failed check or an unreachable endpoint: `blocked`, with **Check again**.
4. A provider-reported exhausted allowance: `blocked`, reason "Allowance reached,
   resets <time>", and **Use another account** or **Use <sibling engine>** when one
   is ready. A window at or above 90% used is `limited`.
5. Ambient or proxy routing: `ready` or `limited` with a **via <gateway>** fact.
6. Otherwise the existing resolver label.

The rail dots, the `/connections` resolver, list rows, detail headers and the
overview read this one function. The server-side runnability and first-run
projection remain authoritative for dispatch; the client derivation must not
claim Ready where they refuse. Converging those server projections is outside
this record.

## Usage for every connection

- `/usage-rollup` accepts any engine id and an optional `connectionId`. An unknown
  id returns an empty rollup with `coverage.state: 'unknown'`, not a 400.
- Usage receipts gain an optional `connectionId` from the session's recorded
  connection (`session.configured` metadata). Engines routed through a model
  connection also record `modelConnectionId`, so the Models tab can show usage.
- ACP receipts record the engine's connection id instead of `acp`. ACP engines
  report context occupancy, not totals; their usage panel says so instead of
  showing zero.
- Totals for this Station are readable with the same access as the engine page.
  Per-account breakdowns keep the credential-management requirement.

## Pages

**Overview (`/connections`).** Replaces the redirect. It shows:
- **Needs you:** `AttentionList` from `deriveConnectionHealth` across sections.
- **Allowance:** one meter per subscription engine, with reset countdowns.
- **Last 7 days:** tokens and cost by engine and model connection.
- **Section tiles:** health and count for each section.

**Engines.**
- Rows show the verdict and facts such as allowance left, a reset countdown, or
  weekly cost.
- Detected, unconnected engines are rows with **Connect**. **Add engine** lists
  only engines that are not installed.
- Detail tabs:
  - **Overview:** verdict, allowance, 7-day usage, dependents, last check.
  - **Usage:** `UsagePanel`, by model, allowance history.
  - **Models:** searchable table and default model, labelled with the catalog source.
  - **Accounts:** profiles and sign-in, with per-account allowance.
  - **Settings:** name, routing, app home, skills; capabilities as `FactList`.
    Reset sits under a danger zone.

**Models.**
- The empty state is the add catalog, shown once.
- Detail tabs: Overview, Usage (via `modelConnectionId`), Models, Settings.

**Tools.**
- Rows show tool count, last probe and the agents that use the server.
- **Check all** probes every server.
- The editor adopts `useResourceEditor`.

**Knowledge.** One verdict: semantic search on or off and why, with one fix.
It also shows index statistics (documents, chunks, projects, last indexed).
The storage path moves to Settings.

**Computers.** Rows show what each computer runs: its engines and active turns where the
Station can observe them, and last seen for paired Stations. Broker and delegation
become sub-pages.

## Slices

| Slice | Content | Depends on |
| --- | --- | --- |
| 1. Kit | Resource-hub primitives, tab routing helper, `deriveConnectionHealth`, tests | — |
| 2. Usage server | Rollup filter, receipt `connectionId`/`modelConnectionId`, ACP attribution | — |
| 3. Engines | Status fixes, detected rows, tabbed detail, ambient-routing disclosure | 1, 2 |
| 4. Overview | `/connections` page | 1, 2, 3 |
| 5. Models, Tools, Knowledge, Computers | Rows, details and verdicts on the kit | 1, 2 |

Each slice updates the Connections guide and module map for what it ships.

## Non-goals

- Automatic routing or failover across accounts; [#189](https://github.com/kontourai/station/issues/189) owns that.
- New provider quota sources beyond those already read.
- Changing what dispatch accepts as runnable.

## Risks and limits

- Allowance comes from provider endpoints that change shape. Unknown readings stay
  unknown and never become Ready or zero.
- Receipts written before slice 2 have no `connectionId`. Connection-scoped views
  disclose that gap instead of attributing old usage.
- ACP engines expose no token totals today; their usage remains partial until an
  engine reports them.
