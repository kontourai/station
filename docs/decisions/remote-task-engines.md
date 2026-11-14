---
status: current
subject: Drive cloud-hosted coding agents through one remote task engine abstraction
decided: 2026-11-14
evidence:
  - kind: adr
    ref: docs/adr/0008-drive-acp-through-the-canonical-adapter-seam.md
  - kind: adr
    ref: docs/adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md
  - kind: adr
    ref: docs/adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md
  - kind: doc
    ref: docs/decisions/engine-credential-provider.md
  - kind: doc
    ref: packages/contracts/src/remote-task-engine.ts
  - kind: doc
    ref: src-server/services/remote-task-engines/service.ts
  - kind: doc
    ref: src-server/routes/remote-task-engines/__tests__/remote-task-engine-routes.test.ts
---

# Remote task engines

A remote task engine is a cloud-hosted coding agent: Station sends it a
prompt and a repository, the work runs on the vendor's machines, and the
results come back as messages and pull requests. Devin, the GitHub Copilot
cloud agent and Cursor Cloud Agents are bound today.

## Decision

### Which surface

A remote task is a Station engine conversation, not a separate dispatch
surface. The target is the provider adapter seam
([ADR 0008](../adr/0008-drive-acp-through-the-canonical-adapter-seam.md)),
so a remote task engine appears as an Agent and a chat and reuses the agent
picker, the transcript, the orchestration event store and its
`Last-Event-ID` resume
([ADR 0018](../adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md)),
notifications and usage display.

| Adapter seam | Remote task |
| --- | --- |
| `startSession` | Local only; nothing is sent. |
| first `sendTurn` | Create the task. |
| later `sendTurn` | Send a follow-up, where the binding declares one. |
| `interruptTurn` | Cancel, where declared; otherwise `termination-unconfirmed`, because the work keeps running at the vendor. |
| `hasSession` | True for a thread whose resume cursor names a remote task. The adapter contract allows this for work that genuinely survives a restart. |
| `streamEvents` | Vendor messages, keyed by the vendor's event id so replay is idempotent. |
| `respondToRequest` | Never needed: no Station approval is ever opened. |

A separate dispatch surface was rejected. It would need its own store, task
list, notifications and event stream, which duplicates what the adapter path
already has.

**Delivered in two pull requests.**

The first (#4935) builds the substrate under that adapter, and nothing that
shows up as an Agent or a chat:

- the vendor-neutral service;
- the three bindings;
- the gates;
- the credential handling;
- a tracker that catches stored tasks up while a client reads them;
- HTTP routes under `/remote-task-engines`.

The routes' events read uses Station's own per-task sequence, with
`after` or `Last-Event-ID`, the same resume role the orchestration stream
gives `Last-Event-ID`.

The second, stacked on the first, composes the chat adapter. It needs four
things:

- a new engine family in the closed `EngineCapabilityMatrix`;
- an answer to how `limits.engines.allowed` treats it;
- a transcript projection of the stored messages onto runtime events;
- Agent and picker entries, behind the same preview.

### Capabilities

Every operation is a per-binding flag in `RemoteTaskCapabilities`. The
service refuses an operation whose flag is off before any request leaves the
host (`remote-task-capability-unsupported`), and a client reads the same
flags from the connection view so it never offers an operation the binding
lacks.

| Capability | Devin v3 | Copilot agent tasks | Cursor v1 |
| --- | --- | --- | --- |
| create | `POST …/sessions` (`prompt`, `repos`) | `POST /agents/repos/{o}/{r}/tasks` | `POST /v1/agents` |
| create options | none (no model or branch field) | model, base ref, pull request | model, starting ref, `autoCreatePR` |
| get | `GET …/sessions/{id}` | `GET /agents/tasks/{id}` | agent, then its latest run |
| list | `first`/`after` pages | `page`/`per_page` | `limit`/`cursor` |
| follow-up | `POST …/messages` (steers) | none | follow-up run; `delivery: "steer"` when busy |
| messages | `GET …/messages?after=` | none | each finished run's `result`, from the runs list |
| cancel | `DELETE …/sessions/{id}` (terminate) | none | cancel the latest run |
| usage | ACUs; USD overage (Teams) | AI credits or premium requests, per session | tokens (`/usage`) |
| outputs | `pull_requests[].pr_url` | pull request by id only (`pull:<id>`) | `git.branches[].prUrl` |

Usage stays in the vendor's unit. Station reports USD only where the vendor
reports it: Devin's `on_demand_usage`. A figure in a unit the binding does
not declare is dropped.

Cursor's agent stream is not read. Its `assistant` events are text deltas for
an ordinary agent, and opening a stream is rate-limited apart from requests
(60 a minute, 600 an hour). Each finished run's `result` is the agent's
message for that run, keyed by run id, so a poll costs three requests and no
stream opens, and a replay cannot store a fragment twice.

### Trust boundary

The work leaves the host, so Station's confinement and approval policy do
not apply to it. Instead, every call passes these checks in order, and a
refusal sends nothing:

1. **The Feature Preview** `remote-task-engines`, which is off by default and
   read at each call.
2. **The managed policy** `limits.engines.remoteTasks`, a list of vendor
   ids. Unlike every other engine key, absence restricts: on a machine with
   a managed policy, a vendor the list does not name is off. A policy can
   only allow what the preview and the acknowledgement then still gate.
3. **The acknowledgement**, per connection. A person accepts a statement that
   names the vendor and says that prompts and code leave this computer. The
   service requires the current statement word for word, and the
   acknowledgement stops counting when the statement's version changes.
4. **The credential**, kept only in the engine host-auth vault
   ([engine credential provider](engine-credential-provider.md)) in one bucket
   per connection:
   - Connection ids carry a `remote-task-` prefix, which an ACP connection id
     may not take, so no ACP connection can name the bucket. Removing a remote
     task connection deletes only its own key.
   - A token shorter than 16 characters is refused, so redaction by exact
     match is reliable.
   - The value reaches a binding only as the auth header for one call.
   - It is never returned to a client, logged, or passed on in a vendor's
     error text: the vendor's message and error code are redacted of it.
5. **Who asks.** A request that may be an agent's is refused on every route,
   so an agent cannot send host code off the machine.

Station never forwards anything the vendor could use to reach the host:

- Cursor's `mcpServers`, `envVars` and `customSubagents` are never sent; a
  Station Control server above all must not be.
- Devin's `session_secrets` and `secret_ids` are never sent, and neither is
  `create_as_user_id`, which would impersonate a user.
- Copilot is never called through the undocumented endpoints that
  `gh agent-task` uses.

Station does not pre-check a vendor's plan eligibility. It passes on the
vendor's refusal in the vendor's own words.

### Polling, rate limits and offline

- **Cadence.** The interval may be 5 s to 10 min and the backoff ceiling
  5 s to 30 min, not below the interval. Each binding has its own default:
  Devin 15 s, Copilot and Cursor 30 s, because Cursor documents 20 requests a
  minute per key. An out-of-range configuration is refused with 400, never
  clamped.
- **Backoff.** A failure doubles the delay up to the ceiling. A rate limit,
  meaning a 429 or GitHub's exhausted-quota 403, waits at least the vendor's
  `Retry-After` or `X-RateLimit-Reset`, up to one hour. Interactive routes
  answer 429 with `Retry-After` and never retry.
- **Only for a reader.** The tracker polls a task only while a client has
  touched it (created, written to, synced or read its messages) within the
  last 15 minutes. Nothing is polled that nobody reads, so no vendor quota or
  disk is spent unseen. Repeated reads never shorten the cadence.
- **When polling stops.** The tracker also stops polling a task that is
  finished, idle or waiting for the person, and polls again after the next
  follow-up, cancel or sync. A task already finished and settled at the last
  sync is not paged again. A vendor's end-of-stream answer on a finished task
  (Cursor's `409 agent_archived`, Devin's `410`) ends paging instead of
  failing the sync.
- **What is retried.** Only failures that resolve on their own: a rate
  limit, an unreachable vendor, and the preview or policy turned off, which
  rechecks at the ceiling. Anything else stops polling until a client touches
  the task again: no acknowledgement or credential, a connection that is gone,
  an answer or a stored file Station cannot handle, or an unexpected error.
- **Offline.** While Station is offline the task keeps running at the
  vendor. After a restart nothing polls until a client reads a task, and that
  read resumes from the stored vendor cursor. Each task's file holds the
  cursor, the stored messages and the vendor ids already seen, written
  together, so a replayed page adds nothing.
- **Bounded storage.** A message's text is cut at 16,000 characters and
  marked. A task keeps its newest 2,000 messages within 4 MiB. A read says
  when messages after the client's position were dropped (`missed`). A vendor
  answer larger than 4 MiB is refused. Removing a connection while one of its
  syncs is in flight leaves no task file behind.
- **Settings.** A connection's settings (Devin's organization) cannot change
  once it has stored tasks.

### Candidates not bound

The Factory Sessions API is not bound: its reference says it "is enabled for
selected organizations only".

## Where it is enforced

- The service gate is in
  [`service.ts`](../../src-server/services/remote-task-engines/service.ts).
- The bindings table is
  [`bindings/index.ts`](../../src-server/services/remote-task-engines/bindings/index.ts).
- The routes are
  [`remote-task-engine-routes.ts`](../../src-server/routes/remote-task-engines/remote-task-engine-routes.ts).
  Their pairing scopes are in `pairing-route-scopes.ts`: reads are
  `orchestration:read`, changes `orchestration:operate`, and the token
  `engine:login`.
- The policy slice is `limits.engines.remoteTasks` in
  `packages/contracts/src/managed-policy-engines.ts`, and the Group Policy
  control is "Allowed remote task engines".

Tests:

- [Route gates](../../src-server/routes/remote-task-engines/__tests__/remote-task-engine-routes.test.ts):
  every route with the preview off, the policy off and no acknowledgement;
  credential isolation between two connections; polling bounds.
- [Who may call](../../src-server/routes/remote-task-engines/__tests__/remote-task-engine-routes-authority.test.ts):
  the production check refuses an agent-origin header, the internal principal
  and an unauthenticated request on every route.
- [Runtime composition](../../src-server/runtime/routes/__tests__/runtime-routes-remote-task-engines.test.ts):
  the preview the runtime binds and the runtime's managed policy reach the
  routes.
- [Devin](../../src-server/services/remote-task-engines/__tests__/remote-task-devin.test.ts),
  [Copilot](../../src-server/services/remote-task-engines/__tests__/remote-task-github-copilot.test.ts)
  and [Cursor](../../src-server/services/remote-task-engines/__tests__/remote-task-cursor.test.ts):
  each binding against an HTTP fake serving the vendor's documented shapes.
- [Tracker](../../src-server/services/remote-task-engines/__tests__/remote-task-tracker.test.ts):
  interest, cadence and what is retried.
- [Service rules](../../src-server/services/remote-task-engines/__tests__/remote-task-service.test.ts):
  capability flags, usage units, and removal during a sync.

## Not verified

Every vendor fact comes from the published references, read 2026-11-14 and
cited in each binding. No call was made to a real vendor. Two facts are
undocumented:

- the unit of Devin's integer `created_at`, read as seconds;
- the format of an entry in Devin's `repos` list, sent as `owner/name`;
- whether Devin's `end_cursor` is null on a last page. Station keeps the last
  cursor Devin issued, so at worst one page is re-read per poll;
- whether Cursor's runs list carries each finished run's `result`. When an
  entry leaves it out, Station reads that run, up to five per poll.
