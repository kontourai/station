# config reference

Runtime configuration lives below the selected `STATION_HOME`. Two files drive
most behavior: `config/app.json` for runtime-wide settings and
`agents/<slug>/agent.json` per agent. Shared saved-Station metadata is separate
at `$STATION_ROOT/config/profiles.json`.

For usage context, see [docs/guides/agents.md](../guides/agents.md).

---

## app.json

**Location:** `<STATION_HOME>/config/app.json`

Runtime-wide settings applied across all agents and sessions in this Station
home.

### core fields

| field | type | description |
|---|---|---|
| `defaultModel` | string | Default model used when an agent doesn't specify one. A Bedrock model ID when running Bedrock, or a local model name such as `llama3.1` when running Ollama. |
| `defaultLLMProvider` | string | ID of the Model connection used for inference by default (e.g. the seeded Ollama or Bedrock connection). |
| `invokeModel` | string | Model used for `/invoke` endpoint tool calling |
| `structureModel` | string | Model used for `/invoke` endpoint structured output |

> **Bedrock-only:** `region` (and `defaultModel` when it holds a Bedrock model ID) apply only when you run AWS Bedrock. They are not universally required — a local Ollama setup needs neither AWS credentials nor a region. See the [Connections Guide](../guides/connections.md).

| field | type | description |
|---|---|---|
| `region` | string | AWS region for Bedrock (e.g. `us-east-1`). **Bedrock-only.** |

### optional fields

| field | type | default | description |
|---|---|---|---|
| `defaultMaxTurns` | number | `0` | Maximum agentic turns (maps to VoltAgent `maxSteps`). `0` = no limit (falls back to 200). |
| `defaultMaxOutputTokens` | number | `16384` | Maximum tokens in a single model response |
| `systemPrompt` | string | — | Global system prompt prepended to every agent's instructions |
| `templateVariables` | array | `[]` | Named variables available for `{{key}}` substitution in prompts |
| `defaultChatFontSize` | number | `14` | Chat UI font size in pixels (10–24) |
| `registryUrl` | string | bundled starter registry | Plugin registry source. A URL, an absolute path, or a path relative to the install root. When unset, Station falls back to the bundled `examples/registry/default.json` — see [Plugin registry](../guides/plugins.md#plugin-registry). |
| `runtime` | `"voltagent"` \| `"strands"` | `"voltagent"` | Agent framework runtime. Use `--features=strands-runtime` to opt in to Strands. |
| `gitRemote` | string | — | Not currently used. The update path reads the git remote from the Station checkout itself, never from config. |
| `logLevel` | `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Server log level. Overridden by `STATION_LOG_LEVEL` when set — see [Logging](#logging) below. |
| `defaultEmbeddingProvider` | string | — | Not currently applied. Typed and settable, but no project-creation path reads it — new projects do not pick up this value. |
| `defaultEmbeddingModel` | string | — | Not currently applied. Typed and settable, but no project-creation path reads it — new projects do not pick up this value. |
| `defaultVectorDbProvider` | string | — | Not currently applied. Typed and settable, but no project-creation path reads it — new projects do not pick up this value. |
| `terminalShell` | string | — | Shell to use for terminal sessions (e.g. `/bin/zsh`) |

### templateVariables

Each entry in `templateVariables` defines a `{{key}}` replacement available in any prompt.

| field | type | description |
|---|---|---|
| `key` | string | Variable name used as `{{key}}` in prompts |
| `type` | `"static"` \| `"date"` \| `"time"` \| `"datetime"` \| `"custom"` | How the value is resolved |
| `value` | string | The value (required for `static` and `custom`) |
| `format` | string | JSON format options for date/time types |

### Ollama-first example (local, no credentials)

Points new projects at a local Ollama model. No `region` and no AWS credentials needed — the Ollama Model connection is seeded automatically on first launch when Ollama is running. See the [Connections Guide](../guides/connections.md).

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

```json
{
  "region": "us-east-1",
  "defaultModel": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "invokeModel": "us.amazon.nova-2-lite-v1:0",
  "structureModel": "us.amazon.nova-micro-v1:0",
  "defaultMaxTurns": 15,
  "defaultMaxOutputTokens": 16384,
  "systemPrompt": "You are working in the {{project}} project. Today is {{date}}.",
  "templateVariables": [
    { "key": "project", "type": "static", "value": "my-app" },
    { "key": "date", "type": "date", "format": "YYYY-MM-DD" }
  ],
  "defaultChatFontSize": 14,
  "registryUrl": "https://registry.example.com"
}
```

---

## Logging

Station's server logger (`src-server/utils/logger.ts`) writes structured trace/debug/info/warn/error/fatal lines to stdout and, once boot has installed the sink, to a durable NDJSON store under `<STATION_HOME>/logs/server/server-YYYY-MM-DD.ndjson` (one file per UTC day). Retention mirrors the runtime event log: age- and size-bounded, with the active day always protected.

The Tauri desktop shell has a separate log and level (`STATION_DESKTOP_LOG_LEVEL`), documented with its recovery and privacy boundaries in [Recover a desktop start](../user/native-recovery.md#check-the-local-diagnosis). Do not substitute server-log output for evidence of native-window or renderer behavior.

**Security trade (UX audit D6).** Stdout is still deep-redacted before it reaches pino. The durable store holds **unredacted** bytes so a local operator can read their own logs through Developer → Logs and `read_logs`. Because those files can contain secrets (paths, nested `apiKey` fields, tokens that slipped into a `msg`), the directory is created `0700` and each day file `0600` — re-asserted on every open, the same POSIX floor as the local-grant secret and operator credential. Anyone who can read `~/.station` as this OS user can already read those other secrets; this is not a new trust boundary. Remote/paired/non-local HTTP callers still receive the same redacted bytes as before. Locality is the one `isLocalRuntimeCaller` predicate, which reads only a mint-time `locality: 'home-possession'` field on the credential. That stamp is written solely when mint proved possession of the Station home: presenting the local-grant secret from the `0600` file, or exchanging the per-boot UI-bootstrap token on a direct-loopback request with no proxy attestation. Operator credentials, access-request / pairing-code / tailnet grants, and a bootstrap exchanged through the UI proxy (or from a remote host) never carry it. The auth boundary binds the predicate onto the request; diagnostics reads that bound flag, not a second derivation. The per-boot internal token hop (station-control / local CLI) is recorded as home-possession at the boundary because that token is minted for this process at boot.

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
into many turns is stored once (archive#3374).

Deleting a conversation deletes its attachments' bytes, not merely its access
to them: the binding is dropped and any blob left with no bindings is reclaimed
immediately. A blob still shared with another conversation survives — content
addressing means those are the same bytes, and the other conversation still
shows them.

Retention is age- and size-bounded, the same two axes as the event and server
logs. When a blob has been reclaimed the transcript still shows the attachment
as a chip carrying its name and type — it loses the preview, not the record
that the turn carried a file, and the chat dock refuses to re-send that turn
rather than re-sending it without the image.

The transcript's own reads are byte-budgeted and hand on the reference rather
than the bytes, so the browser fetches previews from
`GET /api/attachments/:ref` (archive#3385) — an authenticated, same-origin
route that serves inert `application/octet-stream` and 404s once a blob is
reclaimed.

| variable | default | description |
|---|---|---|
| `STATION_ATTACHMENT_RETENTION_DAYS` | `90` | Days an attachment blob is kept after it was last referenced — written, re-attached to another turn, or served to a transcript. Reading it moves the clock, so an open conversation does not lose its images. |
| `STATION_ATTACHMENT_MAX_BYTES` | `536870912` (512 MiB) | Maximum total bytes retained across attachment blobs; oldest are removed first once the budget is exceeded. |

Two separate ceilings still bound what may be attached at all, per chat and per
home (`CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES`,
`CHAT_ATTACHMENT_MAX_STORE_ENCODED_BYTES` in
`packages/contracts/src/chat-attachment.ts`); a turn that would exceed either is
refused before it is dispatched.

### Reading Station's own logs (archive#1896)

The write side above has a matching self-read path — Station can answer "what did you just log" without an operator tailing a file by hand.

- **`GET /api/diagnostics/logs`** — query params `level` (minimum severity floor, `trace`..`fatal`; invalid values 400 naming the accepted list), `since`/`until` (ISO 8601 bounds, inclusive; invalid format 400), `q` (case-insensitive substring matched against the rendering **the caller will actually receive**, never the other one — a remote caller can only search what a remote caller could see; `q=[REDACTED]` matches any redacted-path entry that had a field redacted), `limit` (default 200, hard cap 1000, clamped rather than rejected). Scans the daily files newest-first, reading each one backward in bounded chunks (never a whole-file load), and returns the **last N matches ordered by parsed timestamp** (tail semantics; a multi-writer day file is not assumed to be in strict append order), stopping early once `limit` is satisfied or a 32 MiB per-query scan budget (`DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES`) is spent. Response: `{ entries, truncated, scannedFiles, unreadableFiles, oldestScannedDay, skippedMalformedLines, scanBudgetExhausted }` — the reader is explicit about what it actually covered: an unopenable day file counts in `unreadableFiles` (and forces `truncated: true`) rather than silently shrinking coverage (a successfully-opened but 0-byte day file yields no lines and is excluded from `scannedFiles`/`oldestScannedDay`; content coverage is unaffected), and `scanBudgetExhausted` names the I/O cap specifically when it's the reason for truncation. Gated at the same pairing-scope tier as `GET /api/diagnostics/bundle` (`src-server/security/pairing-route-scopes.ts`). Locality does not change who may hit the route; it changes whether the body is redacted.
- **`read_logs`** MCP tool (station-control) — the same query, for an agent debugging Station's own runtime behavior. station-control is a local hop (`x-station-proxy-caller: local` + the per-boot internal token), so it receives unredacted lines through the same HTTP handler.
- **Redaction on egress** (archive#1922, UX audit D6): a **remote or paired** caller receives every entry through `redactDeep` (secret-named fields, e.g. nested `config.apiKey`) and `redactSecrets` on every string leaf (secret-*shaped* text inside free-form fields like `msg`/`err.message`/`err.stack` — a connection string or bearer token embedded in error text, not just a suspiciously-named field). A **local** caller (`isLocalRuntimeCaller` — mint-time `locality: 'home-possession'`) receives the unredacted store bytes, including filesystem paths that used to render as `[REDACTED_PATH]`. Slice 1's write-time seam still deep-redacts each write's *context* object before it reaches **pino/stdout**; the durable store is written unredacted so the local operator's Developer surface is usable. The read path remains the boundary that redacts the whole entry uniformly, `msg` included, for every non-local client.

### Correlating `read_logs` output with monitoring events (archive#1897)

Every adopted call site binds `logger.child(bindings)` with the SAME key strings `src-server/monitoring/emitter.ts`'s `MonitoringEmitter` uses for OTel GenAI monitoring events (`src-shared/monitoring-keys.ts`'s `K`, re-exported — never re-declared — by `src-server/utils/logger-correlation.ts`'s `LOG_BINDING_KEYS`). Querying `read_logs`/`GET /api/diagnostics/logs` with `q=<conversationId>` (or an agent slug, or a Station user id) returns every bound log line for that value; the SAME id also keys the `gen_ai.conversation.id` field on that conversation's monitoring events (`GET /api/monitoring` and friends), so a single id correlates both surfaces (one disclosed asymmetry: the **remote** log-read path runs every string value through the shared secret-pattern redaction while the monitoring side does not, so a binding VALUE that happens to look secret-shaped — an `sk-`/`gh_`-prefixed id, an AWS-key-shaped string — reads back as `[REDACTED]` from a remote/paired `read_logs` and the join degrades to the monitoring side only; a local operator sees the binding unredacted. Today's id shapes (UUID-derived conversation ids, OS-username user ids) cannot trip this, and the trade-off is pinned by a test rather than weakening redaction for hypothetical future id shapes):

| Correlation key | Log binding field | Monitoring event field | Bound at |
|---|---|---|---|
| Conversation/session id | `gen_ai.conversation.id` | `gen_ai.conversation.id` | Orchestration session start/reattach (`OrchestrationService.dispatchWithReceipt`); `POST /api/orchestration/chat` |
| Agent slug | `station.agent.slug` | `station.agent.slug` | Same call sites, when the agent is known at bind time |
| Station user id | `station.user.id` | `station.user.id` | `POST /api/orchestration/chat` |

Scheduler job runs (`BuiltinScheduler.executeJob`) bind `station.scheduler.job_name`/`station.scheduler.job_run_id` instead — a scheduled job invokes an agent directly (`agent.generateText`), outside the orchestration conversation seam `MonitoringEmitter` instruments, so there is no monitoring-event concept of a "job run" to align a key with; these two keys are Station-local, queryable through `read_logs` the same way (`q=<jobRunId>`), just not joinable against a monitoring event.

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
| `model` | string | no | Bedrock model ID. Falls back to `defaultModel` from app.json |
| `region` | string | no | AWS region override for this agent |
| `maxTurns` | number | no | Turn limit override (maps to VoltAgent `maxSteps`). Falls back to `defaultMaxTurns` |
| `tools` | object | no | Tool and MCP server configuration |
| `guardrails` | object | no | Model inference constraints |
| `commands` | object | no | Slash commands available in this agent's chat |
| `ui` | object | no | UI configuration including quick prompts |
| `skills` | string[] | no | Skill IDs available to this agent |
| `execution` | object | no | Runtime, model connection, and optional model dispatch policy |

### execution / model dispatch

An agent normally invokes its selected model connection directly. To opt one
agent into ordered failover and explicit attempt/cost budgets, configure a
dispatch policy under `execution.modelOptions`. The selected `modelConnectionId`
is always the first candidate; the `candidates` array contains fallbacks.

```json
{
  "execution": {
    "agentConnectionId": "managed",
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
agent frameworks use the same policy path. Terminal receipts are appended to
`<STATION_HOME>/monitoring/model-dispatch-receipts.ndjson`; they contain digests,
opaque candidate identifiers, outcome, timing, token, and estimated-cost data,
but not prompts, credentials, endpoints, connection IDs, or model configuration.

#### `policy.minimumEvidence` and `policy.requiredCapabilities`

```json
"policy": {
  "minimumEvidence": "confirmed",
  "requiredCapabilities": ["abort", "usage"],
  "retryRuntimeFailures": true
}
```

| field | type | description |
|---|---|---|
| `minimumEvidence` | `"unavailable"` \| `"declared"` \| `"confirmed"` | Excludes any candidate graded below this level. Default `"unavailable"` (every candidate passes). |
| `requiredCapabilities` | string[] | Excludes any candidate missing one of these capability strings. Default `[]` (no requirement). |

**Both are derived, honest signals as of archive#1426 — not operator-typed
claims.** Each candidate's evidence level comes from its model connection's
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
evidence at all. `"structured-tools"` (archive#1430) is present once a
candidate additionally has any live evidence AND its bound model's own
provider catalog genuinely reported tool-calling support — the same
`toolSurface` shown on the Connections page's model inventory, resolved
fresh every TTL window through the same deterministic, compute-on-demand
inventory accessor as the rest of this grading (never a cache that depends
on whether the Connections page happened to be open). It is satisfiable
today, but only for a connection whose provider adapter actually reports
this: as of archive#1430, that is Ollama (`/api/show`'s `capabilities`
array) — Bedrock, OpenAI-compatible, Anthropic, and Google all leave it
`undefined` because none of their model-listing APIs expose a real
capability signal (see each adapter's own comment in
`src-server/providers/llm/` for what was checked). Set
`requiredCapabilities: ["structured-tools"]` only for an agent whose bound
model connection can actually earn it; every other connection excludes with
a named reason rather than silently failing.

**Evidence is graded lazily, behind a 60-second TTL, not baked in at agent
(re)build (archive#1431).** Dispatch candidates are still assembled when the
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
against); that remains the only way to see a change take effect
*immediately*, on the very next turn, rather than within the TTL window. A
throwing or temporarily-unavailable evidence source degrades every candidate
to `unavailable` for that call without failing the turn, and the failure is
not cached — the next call retries rather than pinning the failure for a
full TTL window.

### tools

Controls which MCP servers and tools the agent can use.

| field | type | description |
|---|---|---|
| `mcpServers` | string[] | IDs of MCP server integrations to connect (defined in `<STATION_HOME>/integrations/<id>/integration.json`) |
| `available` | string[] | Allowlist of specific tool names exposed to the agent. Empty means all tools from connected servers |
| `autoApprove` | string[] | Tool names that execute without user confirmation |

### guardrails

Inference parameters applied to every model call for this agent.

| field | type | description |
|---|---|---|
| `maxTokens` | number | Maximum output tokens (overrides `defaultMaxOutputTokens`) |
| `maxSteps` | number | Maximum agentic steps per turn |
| `temperature` | number | Sampling temperature (0–1) |
| `topP` | number | Nucleus sampling probability |
| `stopSequences` | string[] | Not currently applied. Typed and accepted, but no engine reads it today — do not rely on it to constrain output. |

### ui / quickPrompts

`ui.quickPrompts` surfaces one-click prompts in the chat interface.

| field | type | description |
|---|---|---|
| `id` | string | Unique identifier |
| `label` | string | Button label shown in the UI |
| `prompt` | string | Prompt text sent when clicked |
| `agent` | string | Optional agent slug to route the prompt to |

### complete example

```json
{
  "name": "Code Reviewer",
  "description": "Reviews code for correctness, style, and security issues",
  "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "prompt": "You are an expert code reviewer working on {{project}}. Review code for correctness, security, and adherence to best practices. Be concise and actionable.",
  "maxTurns": 20,
  "tools": {
    "mcpServers": ["filesystem", "github"],
    "available": ["read_file", "list_directory", "create_pull_request", "get_pull_request"],
    "autoApprove": ["read_file", "list_directory"]
  },
  "guardrails": {
    "maxTokens": 8192,
    "maxSteps": 30,
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
