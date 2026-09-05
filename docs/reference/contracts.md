# @kontourai/station-contracts

Canonical cross-package contract ownership for Station.

Use `@kontourai/station-contracts/*` when you need stable API/domain shapes shared across `src-server`, `packages/sdk`, `packages/cli`, plugins, or tests. New code should import these modules directly instead of reaching through `@kontourai/station-shared`.

## Ownership rules

- Put stable cross-package types here.
- Keep module boundaries domain-oriented: `agent`, `auth`, `catalog`, `config`, `knowledge`, `layout`, `notification`, `orchestration`, `plugin`, `project`, `provider`, `runtime`, `runtime-events`, `scheduler`, `tool`.
- Do not put runtime helpers, parsers, build helpers, or Node-only utilities here.
- Use `@kontourai/station-shared` root only for compatibility re-exports. Runtime helpers belong on explicit subpaths such as `@kontourai/station-shared/parsers`, `@kontourai/station-shared/build`, and `@kontourai/station-shared/git`.
- Server-only provider interfaces do not belong here. Keep those in `src-server/providers/provider-interfaces.ts` or `src-server/providers/llm/model-provider-types.ts`.

## Modules

| Module | Owns |
|---|---|
| `@kontourai/station-contracts/acp` | ACP connection config and ACP connection status values |
| `@kontourai/station-contracts/agent` | Agent specs, metadata, tools, slash commands |
| `@kontourai/station-contracts/agent-plugin` | Agent Plugins 1.0 schema identities, name grammar, and Station extension declarations |
| `@kontourai/station-contracts/attention` | Attention projections and exact approval/permission request references and inspection states |
| `@kontourai/station-contracts/auth` | Auth status, renew results, user identity/detail models |
| `@kontourai/station-contracts/catalog` | Registry items, install results, skills, guidance assets |
| `@kontourai/station-contracts/cloud-move` | Read-only cloud preparation target, inventory, and unavailable-transfer projection |
| `@kontourai/station-contracts/config` | App config and template variables |
| `@kontourai/station-contracts/knowledge` | Knowledge namespaces, tree/search/document metadata |
| `@kontourai/station-contracts/learning-review` | Owner-neutral learning lifecycle projections and explicit access gaps |
| `@kontourai/station-contracts/layout` | Layout definitions, tabs, skills, templates |
| `@kontourai/station-contracts/notification` | Notification payloads and actions |
| `@kontourai/station-contracts/orchestration` | Connected-agent/orchestration request and response shapes |
| `@kontourai/station-contracts/plugin` | Plugin manifests, previews, overrides, conflicts, install outcomes and current permission status |
| `@kontourai/station-contracts/plugin-foreground-work` | Bounded foreground-work declarations, start intents, effect depth, run states, and safe public outcomes |
| `@kontourai/station-contracts/project` | Project config and metadata |
| `@kontourai/station-contracts/provider` | Provider kinds and provider-facing contract enums/types |
| `@kontourai/station-contracts/runtime` | Session metadata, workflow metadata, runtime responses |
| `@kontourai/station-contracts/runtime-events` | Runtime event stream payloads |
| `@kontourai/station-contracts/session-inventory` | Closed Session inventory rows, gaps, and current-answer Basis projection |
| `@kontourai/station-contracts/session-work-item` | Closed immutable Session-to-work-item association observations |
| `@kontourai/station-contracts/scheduler` | Scheduler jobs, stats, capabilities, notifications |
| `@kontourai/station-contracts/tool` | Tool definitions, permissions, connection configs |
| `@kontourai/station-contracts/unified-search` | Owner-qualified typed search results, provider pages, source states, open intents, and fresh owner-resolved open targets |
| `@kontourai/station-contracts/workspace-pane-host-contribution` | Package-level Pane-host actions and explicit owner-relative/default Agent selection |

## Import examples

```ts
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { LearningReviewProjectionOutcome } from '@kontourai/station-contracts/learning-review';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { SessionMetadata } from '@kontourai/station-contracts/runtime';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import type { UnifiedSearchResult } from '@kontourai/station-contracts/unified-search';
```

`learning-review` is a read-only projection contract. Its available form links
owner-issued source, candidate, evaluation, decision, activation, effect, and
retirement records; its unavailable forms contain no protected owner identity.
Station does not turn feedback, an accepted request, or transport success into
a promotion verdict. An empty effect-observation set means not observed, never
successful.

## Scheduler deferral events

The authenticated `/scheduler/events` stream exposes `job.deferred` as a
public scheduler wire event. Consumers should branch on these fields:

| Field | Meaning |
|---|---|
| `event` | Always `job.deferred`. |
| `job` | Scheduler job name. |
| `provider` | Scheduler provider ID. |
| `id` | Attempt observation ID when available. |
| `reason` | `scheduler_concurrency_limit`. |
| `disposition` | `waiting` while a durable retry remains live, or `released` when a first automatic occurrence is terminal without invocation. |

Older events may omit `disposition`; consumers must treat an omitted or unknown
value as terminal rather than keeping a job running indefinitely. `admitted`,
`stopped`, and `indeterminate` are metric lifecycle dispositions, not
`job.deferred` wire values. See [Monitoring](../guides/monitoring.md) for the
complete metric vocabulary and parked-depth formula.

**Removed in this release.** Station previously emitted `job.deferred` — and
`job.refused` for a manual run — with `reason: 'resource_posture'` plus
`posture` and `busy_percent`, when host CPU load gated scheduled work. Host
load no longer gates any work, so those events are gone: a consumer branching
on `reason === 'resource_posture'`, or subscribing to `job.refused`, will stop
receiving them. `scheduler_concurrency_limit` is the only deferral reason the
built-in scheduler now emits.

## Compatibility

`@kontourai/station-shared` still re-exports many of these types so older code can compile during convergence. That is a compatibility layer, not the canonical ownership model. New code should import the owning `@kontourai/station-contracts/*` module directly.

Server-only provider interfaces now live directly in `src-server/providers/provider-interfaces.ts`, `src-server/providers/provider-contracts.ts`, and `src-server/providers/llm/model-provider-types.ts`. The old `src-server/providers/types.ts` barrel was removed during convergence.
