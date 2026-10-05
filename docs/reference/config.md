# config reference

Runtime configuration lives below the selected `STATION_HOME`. Two files drive
most behavior: `config/app.json` for runtime-wide settings and
`agents/<slug>/agent.json` per agent. Shared saved-Station metadata is separate
at `$STATION_ROOT/config/profiles.json`.

For usage context, see [docs/guides/agents.md](../guides/agents.md).

---

## app.json

**Location:** `<STATION_HOME>/config/app.json`

Settings for this Station home. A field's scope depends on its consumer:
Station's own engine reads the model and prompt defaults below; external
engines have their own configuration and do not automatically inherit them.
Project or Agent choices can override applicable defaults.

The [settings registry](../../packages/contracts/src/settings-registry.ts)
defines accepted settings, defaults, visibility, and validation used by Settings
and `station config set`. The [file loader](../../src-server/domain/config-loader-app.ts)
also validates and migrates `app.json`. Prefer those interfaces to editing a
running home's file. This page covers the main settings; the registry includes
additional first-run, workspace, approval, contribution, and preview settings.

### core fields

| field | type | description |
|---|---|---|
| `defaultModel` | string | Fallback model ID on the selected Model connection when no closer choice supplies one. New homes seed an empty string; the model must exist on that connection. |
| `defaultLLMProvider` | string | ID of an existing Model connection used when no closer choice names one. This does not create a connection. |
| `invokeModel` | string | Preferred model for the global `/invoke` tool-calling pass; falls back to `defaultModel`. |
| `structureModel` | string | Preferred model for the global `/invoke` structured-output pass; falls back to the resolved invoke model, then `defaultModel`. This is separate from a named Agent's `/agents/:slug/invoke`. |

> **Bedrock-only:** `region` (and `defaultModel` when it holds a Bedrock model ID) apply only when you run AWS Bedrock. They are not universally required — a local Ollama setup needs neither AWS credentials nor a region. See the [Connections Guide](../guides/connections.md).

| field | type | description |
|---|---|---|
| `region` | string | Bedrock region after Agent and Model-connection overrides, before `AWS_REGION` and `us-east-1`. See the [shared resolver](../../src-server/providers/llm/bedrock-region.ts). |

### optional fields

| field | type | default | description |
|---|---|---|---|
| `defaultMaxTurns` | positive integer | `200` | VoltAgent step cap after `guardrails.maxSteps` and top-level Agent `maxSteps`. Missing/zero values fall through in the resolver, but the settings write interface requires a positive integer. This is a finite cap, not unlimited execution; the Strands adapter does not apply this setting. |
| `defaultMaxOutputTokens` | positive integer | no Station-applied cap | Output-token cap passed by Station's framework adapters when an Agent has no `guardrails.maxTokens`. Provider/model limits still apply. |
| `systemPrompt` | string | [seeded Station prompt](../../src-server/domain/app-config-seed.ts) | Prepended to Agent instructions by Station's engine. An absent or empty value is reseeded on load. |
| `templateVariables` | array | seeded `AGENT_NAME=Station` on a new home | Named replacements used by Station's prompt processing; built-in date/time and user variables are separate. |
| `defaultChatFontSize` | number | `14` | Chat UI font size in pixels (10–24) |
| `registryUrl` | string | bundled starter registry, if present | Plugin registry URL or path. Relative paths resolve from the process working directory (the install root under the CLI). When unset, `examples/registry/default.json` is used if present; otherwise no default registry provider is registered. Changing it takes effect after restarting Station. See [Plugin registry](../guides/plugins.md#plugin-registry). |
| `defaultApprovalMode` | `"connection-default"` \| `"ask"` \| `"auto"` \| `"never"` | `"connection-default"` | Approval posture applied when a session starts, below the chat's own pick and its Agent's default; never applied to a session already running. Raising it to `"never"` (full access) needs the operator in person or an authenticated caller, such as a paired device, whose granted scope carries `approval:full-access`; an Agent can never set it. A refused write is 403 `approval-full-access-not-granted`; when a paired device asked, the refusal names that device and the operator's grant command (`station environment access scope <device> --add approval:full-access`). See [Device access and remote work](../guides/machine-relationships.md#what-a-paired-device-may-do-and-full-access). |
| `runtime` | `"voltagent"` \| `"strands"` | `"voltagent"` | Agent framework runtime. Use `--features=strands-runtime` to opt in to Strands. |
| `gitRemote` | string | — | Not currently used. The update path reads the git remote from the Station checkout itself, never from config. |
| `logLevel` | `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Server log level. Overridden by `STATION_LOG_LEVEL` when set — see [Logging](#logging) below. |
| `defaultEmbeddingProvider` | string | — | Not currently applied. Typed and settable, but no project-creation path reads it — new projects do not pick up this value. |
| `defaultEmbeddingModel` | string | — | Not currently applied. Typed and settable, but no project-creation path reads it — new projects do not pick up this value. |
| `defaultVectorDbProvider` | string | — | Not currently applied. Typed and settable, but no project-creation path reads it — new projects do not pick up this value. |
| `terminalShell` | string | — | Shell to use for terminal sessions (e.g. `/bin/zsh`) |
| `knowledgeStores` | boolean | `false` | Enables personal conversation-root bootstrap in the Knowledge store path. It does not gate all Knowledge APIs, migrate existing data, or remove roots when turned off. Kept out of the general Settings UI. |

### templateVariables

Each entry defines a `{{key}}` replacement where Station calls its
[prompt substitution function](../../src-server/runtime/agents/runtime-template-variables.ts).
These are literal replacements, not a template language. Custom entries override
same-named built-ins. External engines do not automatically run this function.

| field | type | description |
|---|---|---|
| `key` | string | Variable name used as `{{key}}` in prompts |
| `type` | `"static"` \| `"date"` \| `"time"` \| `"datetime"` \| `"custom"` | How the value is resolved |
| `value` | string | The value (required for `static` and `custom`) |
| `format` | string | JSON-encoded `Intl.DateTimeFormatOptions` for date/time types. For example, `"{\"year\":\"numeric\",\"month\":\"2-digit\",\"day\":\"2-digit\"}"`. Writes and file loads reject malformed JSON, non-object values, and options invalid for the chosen date/time type before substitution. A pattern such as `YYYY-MM-DD` is not accepted. Use the built-in `{{iso_date}}` for an ISO date. |

### Ollama-first example (local, no credentials)

Sets defaults for Station's engine. First add an Ollama Model connection and
use its actual ID below; detection alone does not create or enable it. The model
must already be available there. No region or AWS credentials are needed. See
the [Connections Guide](../guides/connections.md) and
[startup owner](../../src-server/runtime/bootstrap/runtime-startup.ts).

```json
{
  "defaultLLMProvider": "ollama",
  "defaultModel": "llama3.1",
  "invokeModel": "llama3.1",
  "structureModel": "llama3.1",
  "defaultMaxOutputTokens": 16384
}
```

### Bedrock example

Replace these illustrative model IDs with models available through your Bedrock
connection and account. They do not assert current provider availability.

```json
{
  "region": "us-east-1",
  "defaultLLMProvider": "bedrock-connection-id",
  "defaultModel": "selected-bedrock-model-id",
  "invokeModel": "selected-tool-model-id",
  "structureModel": "selected-structure-model-id",
  "defaultMaxTurns": 15,
  "defaultMaxOutputTokens": 16384,
  "systemPrompt": "You are working in the {{project}} project. Today is {{date}}.",
  "templateVariables": [
    { "key": "project", "type": "static", "value": "my-app" },
    { "key": "date", "type": "date", "format": "{\"year\":\"numeric\",\"month\":\"2-digit\",\"day\":\"2-digit\"}" }
  ],
  "defaultChatFontSize": 14,
  "registryUrl": "https://registry.example.com"
}
```

---

## Logging

Station's server logger (`src-server/utils/logger.ts`) writes structured trace/debug/info/warn/error/fatal lines to stdout and, once boot has installed the sink, to a durable NDJSON store under `<STATION_HOME>/logs/server/server-YYYY-MM-DD.ndjson` (one file per UTC day). Retention mirrors the runtime event log: age- and size-bounded, with the active day always protected.

A successful read — a 2xx/304 `GET` or `HEAD` — is logged at `debug`; every other request (any other status, every mutation, and every streaming response) is logged at `info`. Because the level is applied before the durable store is written, at the default `info` those successful reads are not recorded at all rather than filed one level down, and the Developer → Logs level filter cannot recover them: set `STATION_LOG_LEVEL=debug` (or `logLevel` in `app.json`) before reproducing if you need the full access log.

The Tauri desktop shell has a separate log and level (`STATION_DESKTOP_LOG_LEVEL`), documented with its recovery and privacy boundaries in [Recover a desktop start](../user/native-recovery.md#check-the-local-diagnosis). Do not substitute server-log output for evidence of native-window or renderer behavior.

**Stored logs and privacy.** Stdout is redacted; the durable store retains
unredacted messages and context, which can contain paths, tokens, or other
secrets. On POSIX, the store reasserts and verifies directory mode `0700` and
file mode `0600` when opening a day file. Failure leaves the durable sink
unwritable while redacted stdout logging continues. The Windows branch skips
those POSIX checks; this code is not a Windows ACL guarantee.

Diagnostics chooses its rendering from the request's bound
[`home-possession` locality](../../src-server/security/runtime-request-security.ts),
not from a caller-supplied query or the socket address alone. That locality is
minted through local-grant secret possession or a qualifying same-machine
UI-bootstrap exchange. Pairing codes, access requests, operator credentials,
and remote browser bootstrap do not by themselves earn it. UI-bootstrap keeps
its distinct mint kind and does not gain the consent broker's local-grant
approval authority.

The internal server token starts with home-possession, but the
[station-control authority guard](../../src-server/security/station-control-authority-guard.ts)
withdraws it from ordinary tool requests unless their caller is a bound
operator. A tool's use of a local HTTP hop does not by itself guarantee
unredacted logs. The [mint routes](../../src-server/runtime/routes/runtime-routes.ts)
and [diagnostics handler](../../src-server/routes/system/diagnostics.ts) show the
issuance and read boundaries.

| variable | default | description |
|---|---|---|
| `STATION_LOG_LEVEL` | — | Overrides `app.json`'s `logLevel` for every logger in this process — every `createLogger()` call site resolves it at creation, and a later `app.json` change is pushed to all of them via `setGlobalLogLevel`, not just Station's own root logger. Takes precedence over the configured value; an invalid value is ignored (falls back to `logLevel`/`"info"`) with a single startup warning. `"fatal"` is not a valid value here — fatal is emit-only, never a configurable filter floor. |
| `STATION_SERVER_LOG_RETENTION_DAYS` | `30` | Days of server log files retained on disk (the active day is always kept regardless of age). |
| `STATION_SERVER_LOG_MAX_BYTES` | `268435456` (256 MiB) | Maximum total bytes retained across server log files; oldest non-active-day files are removed first once the budget is exceeded. |

## Chat attachments

An attachment's bytes are never stored inside the event log. `turn.started`
records the attachment's name, type and size and a content-addressed reference;
the bytes themselves live under `<STATION_HOME>/attachments/<aa>/<sha256>`,
addressed by the SHA-256 of their decoded content, so the same image pasted
into many turns is stored once (station#3374).

Deleting a conversation deletes its attachments' bytes, not merely its access
to them: the binding is dropped and any blob left with no bindings is reclaimed
immediately where filesystem removal succeeds; removal errors are swallowed and retention can retry later. A blob still shared with another conversation survives — content
addressing means those are the same bytes, and the other conversation still
shows them.

Retention is age- and size-bounded, the same two axes as the event and server
logs. When a blob has been reclaimed the transcript still shows the attachment
as a chip carrying its name and type — it loses the preview, not the record
that the turn carried a file, and the chat dock refuses to re-send that turn
rather than re-sending it without the image.

The transcript's own reads are byte-budgeted and hand on the reference rather
than the bytes, so the browser fetches previews from
`GET /api/attachments/:ref` (station#3385) — an authenticated, same-origin
route that serves inert `application/octet-stream` and 404s once a blob is
reclaimed.

| variable | default | description |
|---|---|---|
| `STATION_ATTACHMENT_RETENTION_DAYS` | `90` | Days an attachment blob is kept after it was last referenced — written, re-attached to another turn, or served to a transcript. A successful blob read refreshes its filesystem timestamp; merely leaving a conversation open is not a retention pin, and the size budget can still reclaim it. |
| `STATION_ATTACHMENT_MAX_BYTES` | `536870912` (512 MiB) | Maximum total bytes retained across attachment blobs; oldest are removed first once the budget is exceeded. |

Two separate ceilings still bound what may be attached at all, per chat and per
home (`CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES`,
`CHAT_ATTACHMENT_MAX_STORE_ENCODED_BYTES` in
`packages/contracts/src/chat-attachment.ts`); a turn that would exceed either is
refused before it is dispatched.

### Reading Station's own logs (station#1896)

The write side above has a matching self-read path — Station can answer "what did you just log" without an operator tailing a file by hand.

- **`GET /api/diagnostics/logs`** — query params `level` (minimum severity floor, `trace`..`fatal`; invalid values 400 naming the accepted list), `since`/`until` (inclusive bounds; send ISO 8601 timestamps, although the current route accepts any string `Date.parse` can parse and returns 400 only when parsing fails), `q` (case-insensitive substring matched against the rendering **the caller will actually receive**, never the other one — a remote caller can only search what a remote caller could see; `q=[REDACTED]` matches any redacted-path entry that had a field redacted), `limit` (default 200, hard cap 1000, clamped rather than rejected). Scans the daily files newest-first, reading each one backward in bounded chunks (never a whole-file load), and returns the **last N matches found in its bounded backward scan, ordered by parsed timestamp** (it does not scan the entire history to prove the globally newest timestamps), stopping early once `limit` is satisfied or a 32 MiB per-query scan budget (`DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES`) is spent. Response: `{ entries, truncated, scannedFiles, unreadableFiles, oldestScannedDay, skippedMalformedLines, scanBudgetExhausted }` — the reader is explicit about what it actually covered: an unopenable day file counts in `unreadableFiles` (and forces `truncated: true`) rather than silently shrinking coverage (a successfully-opened but 0-byte day file yields no lines and is excluded from `scannedFiles`/`oldestScannedDay`; content coverage is unaffected), and `scanBudgetExhausted` names the I/O cap specifically when it's the reason for truncation. Gated at the same pairing-scope tier as `GET /api/diagnostics/bundle` (`src-server/security/pairing-route-scopes.ts`). Locality does not change who may hit the route; it changes whether the body is redacted.
- **`read_logs`** MCP tool (station-control) — calls the same HTTP handler. Its caller binding determines redaction; the internal hop alone is insufficient. Its tool schema accepts integer limits 1–1000, while the HTTP route clamps an out-of-range value.
- **Redaction on egress:** without bound home-possession, the reader applies `redactDeep` to secret-named fields and secret-pattern redaction to string leaves, including message and error text. Both filtering and output use this rendering. With bound home-possession, the reader uses the unredacted stored entry. This differs from stdout, where write-time redaction remains in place.

### Correlating `read_logs` output with monitoring events (station#1897)

The [correlation helper](../../src-server/utils/logger-correlation.ts) reuses
monitoring key names from [`K`](../../src-shared/monitoring-keys.ts). The call
sites below bind them with `logger.child()`. Search `read_logs` or
`GET /api/diagnostics/logs` with `q=<id>` to find matching rendered lines within
the reader's limits, then use the same conversation ID in monitoring. This is a
substring search, not a structured join or a complete transcript.

Remote log redaction can replace a secret-shaped binding value, while the
monitoring path does not use that same log-redaction pass. Such a value cannot
be joined reliably from the remote log output; local home-possession reads
retain it.

| Correlation key | Log binding field | Monitoring event field | Bound at |
|---|---|---|---|
| Conversation/session id | `gen_ai.conversation.id` | `gen_ai.conversation.id` | Orchestration session start/reattach (`OrchestrationService.dispatchWithReceipt`); `POST /api/orchestration/chat` |
| Agent slug | `station.agent.slug` | `station.agent.slug` | Same call sites, when the agent is known at bind time |
| Station user id | `station.user.id` | `station.user.id` | `POST /api/orchestration/chat` |

[Scheduler attempts](../../src-server/services/scheduling/builtin-scheduler.ts)
bind `station.scheduler.job_name` and `station.scheduler.job_run_id`. These are
scheduler-local keys: a run ID is not a conversation ID. The
[execution owner](../../src-server/services/scheduling/builtin-scheduler-execution.ts)
invokes the scheduled-turn adapter after durable admission; monitor actions
have their own Task dispatch path. Use the job's receipts when following an
attempt into any resulting session, rather than assuming the IDs match.

---

## agent.json

**Location:** `<STATION_HOME>/agents/<slug>/agent.json`

Defines a single agent. The directory name is the agent's slug.

### top-level fields

| field | type | required | description |
|---|---|---|---|
| `name` | string | yes | Display name shown in the UI |
| `prompt` | string | yes | System prompt for this agent. Supports `{{key}}` template variables |
| `description` | string | no | Short description shown in agent pickers |
| `icon` | string | no | Icon identifier for the UI |
| `model` | string | no | Legacy model selection fallback. `execution.modelId` and the selected Model connection determine current routing; the ID is not necessarily a Bedrock model. |
| `region` | string | no | AWS region override for this agent |
| `maxSteps` | integer | no | VoltAgent step cap, below any in-memory `guardrails.maxSteps` and above `defaultMaxTurns`. The Agent file schema accepts 1–100. `maxTurns` is not the Agent field. |
| `tools` | object | no | Tool and MCP server configuration |
| `guardrails` | object | no | Model inference constraints |
| `commands` | object | no | Slash commands available in this agent's chat |
| `ui` | object | no | UI configuration including quick prompts |
| `skills` | string[] | no | Skill IDs available to this agent |
| `execution` | object | no | Runtime, model connection, and optional model dispatch policy |
| `project` | string | no | Owning Project slug; absent means global scope. The Project must exist when the value is introduced. |
| `audience` | object | no | Who besides the operator may list, read and use the Agent (`station.agent-audience/v1`). Absent means operator only. See [audience](#audience). |

### audience

`audience` takes one of three versioned shapes. Absent and `operator` mean the
same thing: only the operator's own requests see the Agent. Agents saved before
this field existed need no rewrite.

```json
{ "version": "station.agent-audience/v1", "kind": "operator" }
{ "version": "station.agent-audience/v1", "kind": "project-permission", "permission": "discuss" }
{ "version": "station.agent-audience/v1", "kind": "project-roles", "roles": ["viewer", "contributor"] }
```

`permission` is a Project member action (`view`, `discuss`, `edit`, `execute`,
`approve`, `manage-members`, `manage-extensions`, `manage-compute`). `roles` is
a non-empty, duplicate-free list of `viewer`, `contributor`, `admin` and `owner`.
A member audience requires `project`, because membership belongs to one Project.
An invalid value is refused on save and load with the reason, for example
`/audience: audience.permission must be one of: ...`. The
[validator](../../src-server/domain/validator.ts) runs
[`agentAudienceRefusal`](../../src-server/services/agents/agent-audience.ts)
ahead of the [schema](../../schemas/agent.schema.json). A save cannot clear the
field with `null`; set `kind` to `operator` instead.

Admission is decided per request against the caller's current, active
membership in the owning Project; see
[Agent audience](../design/project-membership.md#agent-audience) for what a
member may do with an admitted Agent today.

### execution / model dispatch

An agent normally invokes its selected model connection directly. To opt one
agent into ordered failover and explicit attempt/cost budgets, configure a
dispatch policy under `execution.modelOptions`. The selected `modelConnectionId`
is the first local candidate; the `candidates` array contains local fallbacks.
Omit `agentConnectionId` for Station's engine. A present value names an actual
external engine connection; `managed` is not a special selector for this example.

```json
{
  "execution": {
    "modelConnectionId": "primary-model",
    "modelId": "model-a",
    "modelOptions": {
      "dispatch": {
        "enabled": true,
        "candidates": [
          {
            "modelConnectionId": "fallback-model",
            "modelId": "model-b",
            "estimatedUsdPer1kTokens": 0.004
          }
        ],
        "budget": {
          "maxAttempts": 2,
          "maxElapsedMs": 30000,
          "maxTotalTokens": 20000,
          "maxCostUsd": 0.25
        },
        "policy": { "retryRuntimeFailures": true }
      }
    }
  }
}
```

When omitted or disabled, direct model behavior is unchanged. Both supported
agent frameworks use the same dispatch wrapper. This config does not route
external engines through that wrapper. Terminal receipts are appended to
`<STATION_HOME>/monitoring/model-dispatch-receipts.ndjson`; they contain digests,
opaque candidate identifiers, outcome, timing, token, and estimated-cost data,
but not prompts, credentials, endpoints, connection IDs, or model configuration.

#### `policy.minimumEvidence` and `policy.requiredCapabilities`

```json
{
  "policy": {
    "minimumEvidence": "confirmed",
    "requiredCapabilities": ["abort", "usage"],
    "retryRuntimeFailures": true
  }
}
```

| field | type | description |
|---|---|---|
| `minimumEvidence` | `"unavailable"` \| `"declared"` \| `"confirmed"` | Excludes any candidate graded below this level. Default `"unavailable"` (no evidence-level floor; other admission rules still apply). |
| `requiredCapabilities` | string[] | Excludes any candidate missing one of these capability strings. Default `[]` (no requirement). |

Each candidate's evidence level comes from its model connection's
live readiness state (`discovered` → `prerequisite-ready` → `catalog-ready` →
`smoke-passed`, the same ladder shown on the Connections page), mapped onto
Dispatch's three-level scale:

| Connection evidence | Dispatch level | Meaning |
|---|---|---|
| `discovered` | `unavailable` | Connection is known; nothing about it has been checked |
| `prerequisite-ready`, `catalog-ready` | `declared` | Setup is satisfied or a catalog lists the model, but no chat turn has run |
| `smoke-passed` | `confirmed` | A bounded one-turn smoke actually completed |

A candidate with no live evidence available for this call path (connection
unknown, or evidence temporarily unresolvable) grades `unavailable` with no
capabilities — it never falls back to a claimed level. If the underlying
readiness evidence is stale, the grading is downgraded a rank as a defensive
floor; in practice this rarely fires, because the readiness producer itself
(`connection-readiness-evidence.ts`) already reverts a connection's *level*
upstream once its evidence goes stale — a smoke result that has aged out
stops being reported as `smoke-passed` at the source, rather than arriving
here as a stale `smoke-passed`. `requiredCapabilities` is judged against the
same live grading: `abort`/`usage` are present once a candidate has any live
evidence at all. `"structured-tools"` (station#1430) is present once a
candidate additionally has any live evidence AND its bound model's own
provider catalog genuinely reported tool-calling support — the same
`toolSurface` shown on the Connections page's model inventory, resolved
fresh every TTL window through the same deterministic, compute-on-demand
inventory accessor as the rest of this grading (never a cache that depends
on whether the Connections page happened to be open). It is satisfiable
today, but only for a connection whose provider adapter actually reports
this: as of station#1430, that is Ollama (`/api/show`'s `capabilities`
array) — Bedrock, OpenAI-compatible, Anthropic, and Google all leave it
`undefined` because none of their model-listing APIs expose a real
capability signal (see each adapter's own comment in
`src-server/providers/llm/` for what was checked). Set
`requiredCapabilities: ["structured-tools"]` only for an agent whose bound
model connection can actually earn it; every other connection excludes with
a named reason rather than silently failing.

**Evidence is graded lazily, behind a 60-second TTL, not baked in at agent
(re)build (station#1431).** Dispatch candidates are still assembled when the
agent instance itself is built, but each candidate's evidence grade is
resolved per Dispatch invocation rather than fixed for the model's lifetime:
within a 60-second window a call reuses the last grade (still one batched
connection-readiness lookup, covering every candidate connection, not one
per candidate); once the window elapses, the next call re-resolves live
evidence the same batched way. So: running an explicit smoke on a connection
(Connections page, or the smoke API) and then waiting up to 60 seconds is now
enough — no rebuild required — for an agent's `minimumEvidence: "confirmed"`
policy to start admitting that candidate. A connection or agent configuration
save still triggers a full agent rebuild as before (saving a connection
commits a launchability revision that the runtime reconciles agents
against); a newly built dispatch model has a fresh evidence cache. A
throwing or temporarily-unavailable evidence source degrades every candidate
to `unavailable` for that call. A policy requiring stronger evidence can then exclude all candidates and prevent inference. The lookup failure is
not cached — the next call retries rather than pinning the failure for a
full TTL window.

### tools

Controls integration selection and Station-engine approval. Provider delivery and
external-engine approval are separate; see the [Agent guide](../guides/agents.md).

| field | type | description |
|---|---|---|
| `mcpServers` | string[] | IDs of MCP server integrations to connect (defined in `<STATION_HOME>/integrations/<id>/integration.json`) |
| `mcpMode` | `add` / `replace` | Preserve harness MCP integrations or replace their configured list. Omission retains legacy engine behavior. Harness built-in tools remain. |
| `mcpLoading` | `on-demand` / `always` | Claude native tool-search setting; omission preserves the harness default. |
| `available` | string[] | Loaded-tool filter. Omitted or `["*"]` includes all loaded tools; `[]` includes none. The VoltAgent loader matches runtime/original MCP names through its mapping; Strands matches runtime/mapped original names and trailing-`*` prefixes. |
| `autoApprove` | string[] | Tool-name grants that skip interactive confirmation after stale-generation, delegation, and config-protection checks. The Station-engine hook matches runtime names; external-engine approval is separate. A grant covers plain calls only, never an escalation or a plan exit, even for `*` (see [what autoApprove never covers](../guides/agents.md#what-autoapprove-never-covers)) |
| `unattendedAutoApprove` | string[] | Explicit opt-in: tools that may run with nobody to confirm (scheduled jobs, `/invoke`, CLI, delegated children) on Station's engine. Same patterns as `autoApprove`. Earlier policy checks and existing grants run first. For calls reaching this opt-in, an enabled guardian in enforce mode blocks deny/defer (including error fallback); review mode does not block the opt-in. See [Unattended runs](../guides/agents.md#unattended-runs) |

### guardrails

Inputs to Station's framework adapters. This is not a guarantee that every
provider or external engine supports the same controls. The
[model factory](../../src-server/runtime/frameworks/framework-model-factory.ts)
and [VoltAgent adapter](../../src-server/runtime/frameworks/voltagent-adapter.ts)
show where token and sampling values are passed.

| field | type | description |
|---|---|---|
| `maxTokens` | number | Maximum output tokens (overrides `defaultMaxOutputTokens`) |
| `maxSteps` | number | Present in the TypeScript type and read by VoltAgent, but rejected inside `guardrails` by the current Agent JSON schema. Set top-level `maxSteps` in `agent.json`. Strands does not apply the configured step cap. |
| `temperature` | number | Sampling temperature; file schema accepts 0–2, while a provider may impose narrower limits. |
| `topP` | number | Nucleus sampling probability |
| `stopSequences` | string[] | Not currently applied. Typed and accepted, but no engine reads it today — do not rely on it to constrain output. |

### ui / quickPrompts

`ui.quickPrompts` is a retained configuration shape. The file loader validates
its prompt text, but the current UI does not consume it. Saving these entries
does not create chat buttons or route a prompt to another Agent.

| field | type | description |
|---|---|---|
| `id` | string | Unique identifier |
| `label` | string | Intended button label; no current renderer |
| `prompt` | string | Stored prompt text |
| `agent` | string | Retained optional routing field; no current UI consumer |

### complete example

This is a file-shape example. Replace connection, model, integration, and tool
IDs with configured values. Quick prompts are retained metadata as described
above; they do not currently appear as buttons.

```json
{
  "name": "Code Reviewer",
  "description": "Reviews code for correctness, style, and security issues",
  "execution": {
    "modelConnectionId": "review-model-connection",
    "modelId": "selected-review-model"
  },
  "prompt": "You are an expert code reviewer working on {{project}}. Review code for correctness, security, and adherence to best practices. Be concise and actionable.",
  "maxSteps": 20,
  "tools": {
    "mcpServers": ["filesystem", "github"],
    "available": ["read_file", "list_directory", "create_pull_request", "get_pull_request"],
    "autoApprove": ["read_file", "list_directory"]
  },
  "guardrails": {
    "maxTokens": 8192,
    "temperature": 0.3
  },
  "ui": {
    "quickPrompts": [
      {
        "id": "review-pr",
        "label": "Review open PR",
        "prompt": "Review the most recently opened pull request and summarize findings."
      },
      {
        "id": "security-scan",
        "label": "Security scan",
        "prompt": "Scan the current directory for common security vulnerabilities."
      }
    ]
  }
}
```

## Follow the implementation

| Topic | Owners and callers |
| --- | --- |
| App settings and migrations | [Settings registry](../../packages/contracts/src/settings-registry.ts), [file loader](../../src-server/domain/config-loader-app.ts), [config routes](../../src-server/routes/system/config.ts) |
| Agent files and prompts | [Agent schema](../../schemas/agent.schema.json), [validator](../../src-server/domain/validator.ts), [Agent loader](../../src-server/domain/config-loader-agents.ts), [instruction builder](../../src-server/runtime/agents/runtime-agent-builder.ts) |
| Model selection and dispatch | [Provider resolution](../../src-server/runtime/plugins/runtime-provider-resolution.ts), [dispatch policy](../../src-server/runtime/conversation/dispatch-model-policy.ts), [framework model factory](../../src-server/runtime/frameworks/framework-model-factory.ts) |
| Tool loading and approval | [VoltAgent MCP loader](../../src-server/runtime/mcp/mcp-manager.ts), [Strands loader](../../src-server/runtime/frameworks/strands-tool-loader.ts), [pre-tool policy](../../src-server/runtime/agents/pre-tool-policy.ts) |
| Logs | [Logger](../../src-server/utils/logger.ts), [store](../../src-server/services/infra/server-log-store.ts), [reader](../../src-server/services/infra/server-log-reader.ts), [diagnostics route](../../src-server/routes/system/diagnostics.ts) |
| Attachments | [Blob store](../../src-server/services/orchestration/attachment-blob-store.ts), [event store and bindings](../../src-server/services/orchestration/event-store.ts), [authorized read route](../../src-server/routes/orchestration/attachments.ts) |
| Personal conversation roots | [Bootstrap predicate and creation](../../src-server/knowledge-store/conversation-root-bootstrap.ts), [runtime caller](../../src-server/runtime/bootstrap/station-runtime.ts) |
