# Connections overhaul and the resource-hub kit

> **Status: proposal, 2026-11-07; owner-directed.** Tracking issue
> [#4710](https://github.com/kontourai/station/issues/4710). Nothing here is
> implemented yet. The [Connections guide](../guides/connections.md) remains the
> current user journey until each slice lands and updates it. This record keeps
> the finite readiness labels and explicit-Add rules in
> [connections onboarding](connections-onboarding.md). It changes one recorded
> decision there, the `/connections` resolver, as stated under [Overview](#pages).
> Usage attribution is a child of [#189](https://github.com/kontourai/station/issues/189).

## Outcome

Every connection answers four questions, in this order:

1. **Can I use it now?** One recorded readiness label, its reason, and at most one fix.
2. **How much is left?** Provider-reported allowance, where the provider reports it
   and the viewer may read it.
3. **What is it doing and costing?** Station-observed usage over 7 or 30 days.
4. **What depends on it?** Agents, scheduled jobs and projects that select it.

Configuration is the fifth question and lives on its own tab.

Pages that answer these questions share a small **resource-hub kit**. Each
primitive enters the kit when a real consumer needs it, so Agents, Skills,
Plugins and Sessions can adopt proven pieces rather than a speculative library.

## Evidence

Captured on `origin/main` `c32b332c` with an isolated Station on macOS, the
locally installed Claude Code, Codex and Muse Code, and source inspection.
Screenshots were not committed; they contain a real account's allowance.

| Observation | Cause |
| --- | --- |
| Claude Code showed **Status: Ready** beside **7-day limit: 0% left**. | Only the account overview reads allowance ([engine account overview](../../src-ui/src/views/EngineAccountOverview.tsx)). Whether the provider also reported an exhausted verdict was not captured. |
| Claude Code listed 64 models, including other vendors', while **Connect through** read **Your account**. | The server passes its own environment to engine children ([child-process environment](../../src-server/utils/child-process-environment.ts)). An inherited `ANTHROPIC_BASE_URL` with gateway model discovery made the CLI list that endpoint's catalog. The page does not disclose ambient routing. |
| Cursor, Kiro CLI and OpenCode were detected but appeared only deep inside **Add engine**. | The Engines list shows connected engines and added-but-unconnected entries, not detected apps. |
| Nothing told the user that semantic search was off with no embedding model. | [Section signals](../../src-ui/src/views/connections-hub/connection-section-signals.ts) check only the vector database, and the Knowledge page shows the gap as an empty card. |
| `/connections` opened an empty Models tab. | [The resolver](../../src-ui/src/views/ConnectionsHub.tsx) navigates on first render, before its queries resolve, then falls back to Models. |
| Engine usage appears only for Claude Code and Codex. | `/api/analytics/usage-rollup` allow-lists `provider` to `claude` and `codex` ([analytics routes](../../src-server/routes/operations/analytics.ts)). Receipts carry no connection id. ACP adapters record context occupancy and deliberately omit cost. |
| Engine detail repeats status three times and ends in a long **Advanced** section. | [Engine detail](../../src-ui/src/views/AgentConnectionView.tsx) renders read-only facts as inputs, the catalog as chips and every option in one disclosure. |
| Computers rows show the UI origin and **Authorized**, nothing about the machine. | [Computer rows](../../src-ui/src/views/connections-hub/computer-rows.ts) hold liveness only for SSH profiles. |
| Tool server `usedBy` is never shown. | It holds display names from home agents only ([agent tool map](../../src-server/domain/config-loader-agents.ts)). |

Readiness is derived in five places that disagree: the provider presentation
resolver, the section rail, the built-in engine picker, server-side agent
runnability and the first-run projection. The resolver labels a `degraded`
engine **Limited**, while dispatch refuses anything that is not `ready`
([enriched agents](../../src-server/routes/agents/enriched-agents.ts)).

## Constraints from review

- **Access.** `/usage-rollup` requires `access:manage` because it fans out to
  paired Stations with stored credentials
  ([route scopes](../../src-server/security/pairing-route-scopes.ts)); `localOnly`
  cannot lower that. Account allowance also requires `access:manage` and calls the
  provider live. Neither may become a background read for every viewer.
- **Provider verdicts.** Station does not recompute allowance thresholds; the
  provider's verdict wins ([credential usage](../../src-server/services/connections/credential-usage.ts)).
  Claude reports per-model windows, so one exhausted window is not a whole-engine verdict.
- **Allowance is per account.** Agents can pin accounts, opt-in recovery can switch
  accounts, and proxy-routed engines do not spend the subscription.
- **Receipt `provider` is the adapter kind.** Exports, cost scopes, peer parsing
  and telemetry key on it. New attribution is added beside it.
- **Copy.** Recorded labels stay: **Retry check** and **Check connection**, not
  "Check again". "Needs you" and "Blocked" are Session and Task words.

## Readiness

One client selector, `deriveConnectionHealth` in
`src-ui/src/views/connections-hub/connection-health.ts`, feeds rail dots, the
resolver, list rows and detail headers. It returns one of the recorded labels
from `resolveProviderPresentation`, plus whether the connection needs attention.
Anything dispatch would refuse for a reason the reader can fix needs attention,
including `degraded`. Managed-policy refusals read **Not allowed**, offer no fix
and carry no mark. Resting states do not need attention either: a model
connection that is **Saved — not verified** or **Reachable — no model catalog**,
and Knowledge without an embedding model. Their own pages state them.

Allowance is not read for status in the first slices. Status later reflects
allowance through **recorded evidence**: a fresh, provider-reported quota refusal
from a real turn (`provider-plan-quota-exhausted`, Codex usage-limit details,
the usage-limit banner's recovery state), scoped to the account that served it.
That evidence becomes a server-side contract field next to `readinessEvidence`,
so every viewer gets the same answer and dispatch and Connections agree. Live
allowance stays detail on the engine page for viewers with `access:manage`.

## Usage for every connection

- Receipts gain an optional `connectionId` beside `provider`, filled from the
  session's recorded connection. Proxy-routed engines also record
  `modelConnectionId`. Old receipts stay unattributed.
- `/usage-rollup` accepts any provider kind with declared usage semantics,
  optional `connectionId` and `modelConnectionId` filters, and grouping by either. Unknown kinds still return 400. A
  connection filter applies to this Station's receipts only, including the
  aggregate window, because connection ids are local.
- New fields stay off usage exports, peer transfers and telemetry until those
  schemas are reviewed for consent.
- Access is unchanged. A local-only totals route readable at lower access would
  need its own threat-model entry; [`/station-usage`](../../src-server/routes/operations/analytics.ts)
  is the precedent. Until then the Usage tab shows a clear access state.
- Delegated child sessions are separate sessions and are not counted again in a parent.

## The resource-hub kit

The kit lives in `src-ui/src/components/resource-hub/`, composes existing owners
(`SplitPaneLayout`, `DetailHeader`, `Tabs`, `ActionRow`, the state family,
`StatusBadge`) and uses only `--k-*` tokens. It owns presentation, never verdicts:
a feature supplies `{ label, tone, reason?, action? }`.

| Primitive | Enters with | Replaces |
| --- | --- | --- |
| Status badge mapping | Slice 1 | Inline dots, `ProviderTone`/`ComputerStateTone` rendering, status in subtitle text |
| `resourceRow()` | Slice 1 | Hand-written row builders that concatenate status into text |
| Detail tab routing helper | Slice 1 | The silently dropped fourth path segment |
| Detail scaffold, facts list | Slice 3 | Progress rail, summary tiles, read-only inputs |
| Usage panel, daily bars, metric tiles | Slice 3 | Engine account activity, `UsageRollupPanel`, competing tile and chart copies |
| Editor hook (seed, dirty, guard, save) | Slice 3 | Five seed/dirty/save implementations; the missing Tools guard |
| Attention list | Slice 4 | — |
| Used-by list | Slice 5, with its projection | Slug-prefix guesses |

## Pages

**Overview (`/connections`).** This reverses the recorded "resolver, not a
destination" decision: the root becomes a page because the resolver cannot
answer the four questions. It shows items needing attention, one sentence and one action
each; section tiles with health and count; and, for viewers with
`access:manage`, allowance meters and last-7-days usage by connection.

**Engines.**
- Rows show the recorded label and facts such as last-week usage.
- Detected, unconnected engines appear as **Found, not connected** rows. **Connect**
  runs the existing Add result flow in place. **Add engine** keeps its one catalogue.
- Detail tabs:
  - **Overview:** label and reason, dependents, last check, the route actually used.
  - **Usage:** usage panel and allowance history.
  - **Models:** searchable table with catalog source and default.
  - **Accounts:** saved credential accounts, sign-in and per-account allowance.
  - **Settings:** name, routing, app home, skills, with capabilities as facts and reset last.
- Ambient routing shows the endpoint origin only, with userinfo and query removed.
  When routing cannot be observed (settings files the probe does not load), it says
  "route unknown" rather than "Your account".

**Models.** The empty state shows the add catalog once. Detail tabs are
Overview, Usage (by `modelConnectionId`), Models and Settings.

**Tools.**
- Rows show tool count, last probe and the agents that use the server.
- **Check all** probes with a concurrency bound and never starts OAuth.

**Knowledge.**
- One label: semantic search on or off, and why, with one fix.
- Index statistics from the existing status route.

**Computers.**
- Rows show what this Station can observe.
- Cross-Station reads (a paired Station's engines or turns) wait for an access
  decision like the usage rollup's.

## Slices

| Slice | Content | Depends on |
| --- | --- | --- |
| 1. Honest status | `deriveConnectionHealth` with dispatch parity; rail, resolver race, Knowledge embedding; status badge and rows for Engines and Models; tab routing helper | — |
| 2. Usage attribution (#189 child) | Receipt `connectionId`/`modelConnectionId`, rollup filter and grouping, local-only connection scope | — |
| 3. Engines detail | Tabs, usage panel, editor hook, detected rows, routing disclosure | 1, 2 |
| 4. Overview | `/connections` page and attention list | 1, 2, 3 |
| 5. Models, Tools, Knowledge, Computers | Rows, details, used-by projection on the kit | 1, 2 |
| 6. Allowance evidence | Server contract field from recorded quota refusals; status and dispatch agree | 1 |

Each slice updates the Connections guide and module map for what it ships.

## Non-goals

- Automatic routing or failover policy; [#189](https://github.com/kontourai/station/issues/189)
  and the existing opt-in credential recovery own it.
- Lowering access to usage or allowance reads without a threat-model entry.
- Changing what dispatch accepts as runnable.

## Risks and limits

- Provider allowance endpoints change shape. Unknown readings stay unknown.
- Receipts written before slice 2 have no `connectionId`; connection views disclose the gap.
- ACP adapters report context occupancy only and omit cost deliberately, so they
  produce no usage receipts. Their usage panel states that, never zero.
- Claude Code and Codex record `connectionId` only when dispatch passes it, so
  their engine pages keep filtering by provider kind.
- **Check all** starts configured tool servers; the bound keeps it from flooding a host.
