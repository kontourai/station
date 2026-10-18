# Agent smoke confidence

Station reports agent readiness as evidence, not as one ambiguous `Ready` flag.
Opening New Chat or Connections never sends a prompt.

## Evidence levels

- **Discovered** — Station found the client, but required setup may be missing.
- **Prerequisites ready** — required binaries/auth checks currently pass.
- **Live catalog** — the runtime returned a live model or capability catalog.
- **Smoke passed** — one explicitly requested chat turn completed within the
  bounded timeout and its assistant response, after outer whitespace is
  trimmed, was exactly `STATION_SMOKE_OK`.

The latest smoke result is reported separately as `not-tested`, `passed`, or
`failed`. A failed smoke keeps independently proven catalog evidence visible,
while its failure reason and next action remain explicit. Smoke proof is fresh
for 24 hours; stale proof no longer promotes a connection to `smoke-passed`.
The receipt must also match the current connection configuration. A newer
connection check can outrank an older smoke receipt; a passing smoke does not
hide a later authentication refusal.

Receipts are stored in `connection-smoke.json` under `STATION_HOME`. They contain
connection/provider/model identifiers, a configuration fingerprint, timing,
status, a one-turn limit and redacted failure metadata. The receipt does not
store the prompt, assistant response or session events. Runtime errors undergo
bounded pattern redaction; this is not a guarantee that every provider's
arbitrary error text is free of sensitive content.

An exact smoke confirmation proves only this bounded connectivity exchange. It
does not prove the UI or CLI send paths, project working-directory behavior or
project switching, history or inbox agreement, attachments, self-change, or
phone/native behavior.

## Check a connection in the UI

**Connections → Engines → Check connection** runs the same bounded turn, with a
visible allowance disclosure. Save changes first. The check can retry retained
authentication failures; missing binaries and other prerequisites still block it.
When the catalog is temporarily empty, a previously selected model can be checked
against the engine instead of being refused solely by a stale catalog. A non-empty
catalog that excludes that model still refuses it. A failed check is presented as
**Check failed**, and only a proven successful turn restores runtime auth health.

## Explicit dogfood command

The command refuses to run without the billable-turn confirmation flag. Each
selected connection gets one attempt; disabled connections, missing non-authentication prerequisites
and unsupported model/runtime choices fail before sending. An admitted attempt
sends one short turn asking for no tools or modifications, with a diagnostic
timeout clamped between 5 and 60 seconds. This instruction is not a tool sandbox.
Cleanup has a separate bounded grace. Station deletes its temporary thread and
events after confirmed cleanup; if cleanup cannot be confirmed, the result is
`cleanup-failed` and diagnostic state remains for recovery. A timeout therefore
does not promise that the underlying provider process stopped.

```sh
station environment credential show | npm run dogfood:agent-smoke -- \
  --origin=https://station.example.ts.net \
  --credential-file=- \
  --confirm-billable-one-turn
```

By default the command targets Claude, Codex, Ollama, and every enabled ACP
connection in the inventory. Repeat `--connection=ID` to select an explicit
subset. Live smoke remains an opt-in dogfood receipt; deterministic CI uses
fake adapters and never contacts providers or incurs spend.

## Source and checks

[ConnectionService](../../src-server/services/connections/connection-service.ts)
owns admission, configuration matching and durable results.
[ConnectionSmoke](../../src-server/services/orchestration/connection-smoke.ts)
owns the turn and cleanup; the
[readiness projection](../../src-server/services/connections/connection-readiness-evidence.ts)
combines checks, catalog and smoke evidence. The
[command tests](../../scripts/__tests__/station-agent-smoke.test.ts),
[readiness tests](../../src-server/services/connections/__tests__/connection-readiness-evidence.test.ts)
and smoke cases in the
[orchestration tests](../../src-server/services/orchestration/__tests__/orchestration-service.test.ts)
exercise these boundaries. A live receipt must name its actual connection and
time; these deterministic tests are not a live-provider receipt.

## Opt-in engine verification matrix

`dogfood:agent-smoke -- --matrix` extends the command's API/credential path
with longer diagnostic sessions. It does not replace the one-turn smoke or
promote connection readiness. The matrix is opt-in, may incur provider charges,
and live runs stay outside deterministic CI. Offline tests drive the real Hono
orchestration routes and `OrchestrationService` over loopback HTTP, behind the
daemon's real ingress middleware. `EnvironmentSecurityService` mints the bearer
credential, the production resolver derives the principal, and the production
current-principal check guards requests. A headerless request receives 401.
Only the provider adapter and read-only agent/connection configuration are
faked. These tests exercise real validation, conversation continuation, provenance projection,
output admission/storage/inspection and activation lifecycle. The test output
observer is a fake engine-side observer; real-provider and rendered-browser
qualification remain **NOT_VERIFIED** until an operator explicitly runs them.

Prepare a separate Station with an isolated `STATION_HOME`, instance name,
non-default server/UI ports (for example 43141/43000), a disposable working
folder, and **only the connection under test enabled**. Remove other engine
connections from that isolated instance; merely changing model mappings is
insufficient. The runner refuses an incomplete inventory or any second enabled
engine connection, and checks isolation again before every turn. It never
changes connection settings. Repeat against separate isolated configurations
for other engine × connection combinations.

```sh
station environment credential show | npm run dogfood:agent-smoke -- \
  --matrix --confirm-billable-engine-matrix \
  --origin=http://127.0.0.1:43000 --credential-file=- \
  --connection=example-engine --cwd=/path/on/server/disposable-matrix-workspace \
  --model=example-model-a --model=example-model-b --max-turns=12
```

The matrix-specific flag is required even if `--confirm-billable-one-turn` is
present. Refusal exits 2 before reading credentials, loading extensions, or
making requests. Credentials shorter than 16 characters are refused before any
request; short strings are never used for global redaction replacements.

Configure an available Agent bound to the selected connection. The runner uses
that connection's execution-default Agent, or an explicit `--agent=SLUG` (which
must have that binding). Native Station Agents may use the built-in engine
without an explicit connection binding. The runner discovers the engine's
advertised models and creates one conversation per selected model. Repeat `--model=ID` to allowlist launch selectors; omitted models
are never called, including during switch-and-back. Without an allowlist, all
advertised models are planned. `--max-turns=N` is a hard send ceiling (default 24,
allowed 1–1000). A plan larger than the ceiling refuses the entire run before
starting sessions; it does not truncate the catalog. Refusal reports the planned
count and explains how to select fewer models with repeatable `--model=ID` or
explicitly increase `--max-turns`. Four models with only the built-in scenarios
fit exactly at 24 turns; five require 30. Extension reservations add to that
count. The accepted plan and its
turn count are printed as JSON on stderr before the first foreground submission; stdout stays
one JSON results document. Each model gets up to six built-in sends:

| Scenario | Check |
| --- | --- |
| First | Exact smoke reply; remember a random conversation secret |
| Follow-up | Recall that secret without repeating it in the prompt |
| Model switch and back | Recall on a second advertised model, then the original |
| Artifact | Write a file with a fresh content nonce, call `declare_output`, compare its stored path and inspect its exact text bytes |
| Recycle | Observe loaded → unloaded across `stopSession`, then loaded after a foreground continuation recall |

One selected model leaves switch-and-back **unverified** and plans four built-in
sends. Recycle reads `/api/orchestration/sessions/loaded` before stop, after stop,
and after recall. A no-op stop or unavailable unload/resume observation is
**unverified** with its reason; a forgotten secret fails the response check.
The first message uses `POST /api/orchestration/chat` with the Agent target,
workspace, model override and conversation ID. Follow-ups, model switches and
recycle recall use `POST /api/orchestration/chat/:conversationId/continue` with
a model override. The runner follows each receipt's `sessionId` and
`providerTurnId`; it does not assume conversation and runtime session IDs stay
identical. Stop uses the public `/api/orchestration/commands` route's
`stopSession` command. Internal `startSession` and `sendTurn` commands are not
accepted by that route. These observations prove the public API's activation transition, not an OS
process exit or native provider-session identity. JSON retains those states.
The offline adapter publishes an opaque `resumeCursor` through the provider
session/turn contract. Its durable memory is keyed only by that cursor, never
by Station's thread ID; stop clears hot memory. Recycle recall therefore
requires Station to return the cursor on restart. Dropping it fails recall.
Artifact support depends on the engine using Station's native output producer;
an undeclared file cannot pass. The runner uses the output's exact event ID with
`POST /outputs/:eventId/inspect`, requires the returned session/turn/output
identity, and compares the inspected text to the expected nonce. A non-text or
unavailable inspection cannot pass the content check. Artifact filename and
content nonces differ from the conversation secret. There is no automatic send retry. A failed
scenario leaves later scenarios unverified and does not prevent testing the next
model. Each API request and turn poll has a timeout (`--timeout-ms`, default
60000, allowed 100–300000); a timeout does not confirm provider termination.
The runner attempts a final bounded stop and retains sessions, events and files
for inspection. Cleanup failure is a separate failed row. Delete the disposable
instance/workspace after reviewing the report.

Every completed turn passes only when its exact response, independently
reported model, engine-inferred connection, and complete rendered/stored output
name multisets agree. The connection verdict infers the sole enabled connection
from the observed engine kind. It is not a provider-issued connection receipt;
the matrix column is named **Engine-inferred connection** to preserve that limit. Provenance is read from the exact
session/turn's assistant messages, never from the requested model metadata.
Missing reported model or engine is unverified. Launch selectors stay unchanged
in sends. When the catalog provides `resolvedModel`, that concrete identity is
the comparison target. A Claude SDK alias such as `sonnet` or `default` without
resolution is recorded as **alias without resolution**, never a substitution.
Vendor prefixes must agree with the requested model's vendor: known families
supply that identity, while an explicitly vendor-qualified request also covers
new families and vendor namespaces without a fixed registry. A bare unknown family cannot establish a reported prefix's vendor
and remains unverified. Known OpenRouter vendor-qualified forms, Bedrock regional
forms (`us`, `eu`, `apac`, `global`, `jp`, `au`, `us-gov`) immediately before a
matching vendor, including `us.meta.*` and `us.amazon.nova-pro-v1:0`, bare
Bedrock vendor-dot forms such as `anthropic.claude-sonnet-4-5-20250929-v1:0`, and Vertex's
`claude-sonnet-4-5@20250929` are accepted. Semantic family/version/tier changes,
cross-vendor prefixes, arbitrary suffixes, and distinct explicit dates or
versions fail. Dots inside bare model IDs (for example `grok-4.1` or
`qwen3.5-coder`) remain part of the model name. Only an explicit `vendor/`
prefix, a known Bedrock vendor-dot prefix, or a known `region.vendor.` form
establishes a vendor prefix. `moonshotai`/`moonshot`, `xai`/`x-ai` and
`deepseek-ai`/`deepseek` name the same vendors. A `-vN:M` suffix, with or without a preceding date, is
accepted only on a Bedrock vendor-dot form; bare `gpt-4.1-v1:0` and
`claude-sonnet-4-5-v1:0` are distinct IDs, not accepted aliases.
The accepted/rejected table in the
[matrix tests](../../scripts/__tests__/station-engine-matrix.test.ts) pins this
policy. All stored-output pages are read; partial results fail. Duplicate or
extra rendered names fail even if the expected card exists.

### Independent rendered-output observation and scenario registration

An API output read is stored evidence, not proof of rendering. Without an
observer, output checks and overall rows remain unverified, including empty
output turns. Supply `--scenario-module=/absolute/path/to/probes.mjs` to load a
trusted local ES module. It may export either or both:

- `observeOutputs({ sessionId, turnId })`: inspect an authenticated Station UI,
  wait for the complete output list for that turn (including pagination), and
  return `{ sessionId, turnId, names: string[] }`. Workspace file names are the
  full relative paths, PR names their refs. An identity mismatch is unverified.
  Read rendered nodes independently; do not copy the output API into this return
  value. The observer owns browser setup, its deadline and cleanup. No browser
  observer is bundled in this change; UI checks remain explicitly unverified
  without one.
- `scenarios: [{ id, async run(ctx) { /* probe */ } }]`: append unique scenario
  IDs after the built-ins. The existing `additionalScenarios` interface remains
  valid. An optional positive integer `maxTurns` per scenario declares its
  per-model planning bound. Without declarations, the plan reserves the
  remaining run ceiling for extensions (at least one send per scenario/model);
  its printed count is an upper bound. `ctx.api` is the billable channel:
  POST, PUT, PATCH and DELETE requests reserve budget, including unknown routes.
  Only POST `stopSession`, `interruptTurn`, `inspectSteerInput`,
  `setApprovalMode`, `discardDraft`, and session-output inspection are exempt.
  Use `ctx.setupApi` for the audited preparation and cleanup operations below;
  they consume no turn reservation. The effective method and path are normalized;
  query strings and explicit methods cannot bypass the ceiling.
  An extension exceeding either bound gets an explicit failure before another
  send. Trusted modules retain their existing authority; this is not a sandbox.
  `ctx` provides the current `sessionId`, stable `conversationId`, `model`, `switchModel`,
  `nonce`, `artifactName`, `artifactContent`,
  `api(path, optionalBody, optionalMethod)`,
  `setupApi(path, optionalBody, optionalMethod)`, `command(command)`,
  `send(prompt, requestedModel, exactExpectedText, optionalArtifactPath, optionalArtifactContent)` and
  `recall(model)`. `send` returns the checked turn, including `turnId`, for
  subsequent API observations. Throw on a failed additional assertion; return a
  reason string for an unverified prerequisite. A scenario with no checked turns
  cannot pass. #3824 can add nonce-based skill/MCP/tool-policy probes at this
  registration seam without another runner. Added scenarios may send additional
  billable turns; review extension code before confirming.

`ctx.api` forwards every supplied transport argument. Its third argument is the
HTTP method: `ctx.api(path, undefined, 'DELETE')` performs DELETE cleanup. If the
method is omitted, the command transport retains its GET default without a body
and POST default with a body. Existing two-argument calls remain valid.
`ctx.setupApi` uses the same signature and defaults but forwards only the
method/path pairs in the setup allowlist. It requires a Station-relative path
and rejects encoded separators or ambiguous nested encoding. Turn routes,
MCP tool execution, unknown writes and unlisted reads are refused before the
transport is called. Preparation and cleanup in #3832 should use this channel;
turns continue through `send`/`recall` or the billable `api` channel. An extension
with `maxTurns: 2` may perform all six setup POSTs and then send two turns
without inflating its printed billable bound. Setup can launch MCP processes
and change configuration; it retains ordinary server auth and command authority.
`ctx.sessionId` is a getter: before the first send it is the proposed
conversation ID, and after each send it is the runtime session ID in Station's
receipt. Read it lazily when making an observation or API request; do not
capture or destructure it before a send and reuse that value afterward.
`ctx.conversationId` remains stable across those changes.

### Setup API allowlist

Only these existing methods are allowed. GET/DELETE counterparts use the
resource routes, not invented GET/DELETE versions of the action subroutes.
Re-audit the handlers before widening this list.

| Method and path | Handler | Why it does not submit a turn |
| --- | --- | --- |
| POST `/integrations` | [tools.ts](../../src-server/routes/agents/tools.ts):422 | Saves integration configuration with `enabled: false`. |
| POST `/integrations/:id/reconnect` | [tools.ts](../../src-server/routes/agents/tools.ts):894 | Probes MCP tools and reloads configuration when enabled. |
| POST `/integrations/:id/tools/apply` | [tools.ts](../../src-server/routes/agents/tools.ts):999 | Persists disabled-tool policy and reloads configuration. |
| POST `/integrations/:id/enabled` | [tools.ts](../../src-server/routes/agents/tools.ts):908 | Persists enabled state and reloads configuration. |
| POST `/api/skills/local` | [skills.ts](../../src-server/routes/agents/skills.ts):145 | Creates local skill package files. |
| POST `/agents` | [agents.ts](../../src-server/routes/agents/agents.ts):362 | Saves a definition with deferred configuration activation. |
| GET `/integrations`, `/integrations/:id` | [tools.ts](../../src-server/routes/agents/tools.ts):342,460 | Reads configuration, status and tool catalog. |
| DELETE `/integrations/:id` | [tools.ts](../../src-server/routes/agents/tools.ts):869 | Deletes the integration and releases its runtime resources. |
| GET `/api/skills`, `/api/skills/:name` | [skills.ts](../../src-server/routes/agents/skills.ts):97,116 | Reads installed skills and package metadata. |
| DELETE `/api/skills/:name` | [skills.ts](../../src-server/routes/agents/skills.ts):324 | Removes owned skill files. |
| GET `/agents` | [agents.ts](../../src-server/routes/agents/agents.ts):261 | Lists the agent catalog. |
| GET `/api/agents`, `/api/agents/:slug` | [enriched-agents.ts](../../src-server/routes/agents/enriched-agents.ts):973,999 | Reads enriched agent configuration. |
| DELETE `/agents/:slug` | [agents.ts](../../src-server/routes/agents/agents.ts):557 | Deletes configuration with deferred activation. |

Integration activation uses configuration reload/rollback
([tools.ts](../../src-server/routes/agents/tools.ts):268 and
[station-runtime.ts](../../src-server/runtime/bootstrap/station-runtime.ts):1668),
not foreground-message or turn dispatch. MCP probing can connect a tool-server
process. The setup-channel test stubs those setup side effects and validates
POST bodies against the real route schemas; all model/control requests still
use the real authenticated orchestration app. It proves budget isolation and
refusal at the channel boundary, not live MCP startup or delivery.

The adapter catalog and orchestration return types explicitly retain optional
`resolvedModel`. The [server route test](../../src-server/routes/orchestration/__tests__/orchestration.routes.test.ts)
checks that a fake adapter's concrete alias resolution survives real discovery,
service dispatch and JSON serialization. A catalog resolution is not per-turn
served-model proof. The [matrix integration test](../../src-server/routes/orchestration/__tests__/engine-matrix.integration.test.ts)
executes all five scenarios against the real foreground routes with a fake
adapter, including actual stored outputs and inspected file contents. The
pure tests retain the model-alias table, verdict rules and Markdown renderer;
there is no permissive replacement for the execution routes.

JSON goes to stdout and a timestamped `.json` file alongside a generated,
dated Markdown matrix in `docs/reference/engine-matrix-runs/` by default.
Use `--output-dir=PATH` for private receipts. Both include engine, connection,
launch selector, scenario, verdict, engine-inferred connection, served-as and
failure text; JSON also retains concrete comparison models, the send plan/count,
session/turn IDs and individual checks. Both formats show two distinct counts:
`reservedBillableRequests` counts non-exempt mutating requests handed to the
transport, including unknown routes and failures. `sentTurns` counts POST
submissions to known foreground, continuation, handoff, delegation, agent
chat/invoke and steer routes actually handed to the transport. It excludes
configuration writes and rejected reservations. These are submission attempts,
not proof of provider acceptance or completion; per-turn checks supply that
evidence. Setup calls affect neither count. New session-level `runtime.error` events
without a turn ID retain their actual error text. The cursor starts empty for
each new conversation and advances only through a completed-turn event. Startup
errors belong to this run. Reads before later sends do not reset the cursor.
An error explicitly scoped to an earlier completed turn is not attributed to a
new turn; the offline negative control pins that distinction. Unscoped startup
errors on a freshly created matrix conversation are never excluded as history. Errors in the gap after a terminal,
including errors emitted during `stopSession`, fail the next attempted scenario
before another billable send.
Exit 0 requires every row
to pass; failures or unverified rows exit 1. Review receipts before committing:
provider errors receive bounded redaction, but arbitrary error text and model
or connection identifiers can still be sensitive.

Catalog removal (issue #3822 rule 4) is deferred. Diagnostic timeouts, missing
provenance and transient authentication failures do not establish that an
advertised model is unsupported. A follow-up needs an engine/catalog owner,
a durable failure taxonomy, invalidation/recovery rules and picker tests before
using failed sends to suppress advertised models. This runner only records
findings and leaves the catalog unchanged.
