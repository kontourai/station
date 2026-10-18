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
`deepseek-ai`/`deepseek` name the same vendors. An undated `-v1:0` suffix is
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
  planning bound per model (or once per engine with `scope: 'engine'`). Without declarations, the plan reserves the
  remaining run ceiling for extensions (at least one send per scenario instance);
  its printed count is an upper bound. Every POST through the managed API
  reserves a turn, including unknown routes, handoff, delegation continuation,
  Agent chat/invoke and steer commands. Only these known non-billable operations
  are exempt: `stopSession`, `interruptTurn`, `inspectSteerInput`,
  `setApprovalMode`, `discardDraft`, and session-output inspection. This is a
  conservative request budget: an extension's other POSTs consume its declared
  `maxTurns` reservation even if they do not invoke a model. Review those
  reservations when adding extension setup operations. The effective HTTP
  method and path are normalized; query strings and explicit methods cannot
  bypass either the printed reservation or hard run ceiling.
  An extension exceeding either bound gets an explicit failure before another
  send. Trusted modules retain their existing authority; this is not a sandbox.
  `ctx` provides the current `sessionId`, stable `conversationId`, `model`, `switchModel`,
  `nonce`, `artifactName`, `artifactContent`,
  `api(path, optionalBody, optionalMethod)`, `command(command)`,
  `send(prompt, requestedModel, exactExpectedText, optionalArtifactPath, optionalArtifactContent, optionalEvaluator)` and
  `recall(model)`. `send` returns the checked turn, including `turnId`, for
  subsequent API observations. Throw on a failed additional assertion; return a
  reason string for an unverified prerequisite. A scenario with no checked turns
  cannot pass. An engine-scoped scenario uses `scope: 'engine'` and gets a fresh
  session on the first selected model, once per invocation. Its optional
  `prepare(ctx)` runs before session startup and can return `{ metadata, state }`
  or `{ skipReason }`. A returned `metadata.agentSlug` selects that Agent in the
  public chat target after checking its availability and engine binding. Register each cleanup with
  `ctx.deferCleanup(label, asyncCleanup)` before attempting its mutation;
  obligations run in reverse order after the final session stop, including on
  setup, startup or turn failure and skip. Each cleanup failure adds a failed
  row while the remaining obligations are still attempted. Engine-scoped setup
  also exposes `engine`, `connectionId`, `cwd`, `model` and a `delivery` evidence
  map. The evaluator receives the exact turn's assistant text, complete stored
  output names, events, and identity checks. It returns additional named verdicts;
  it cannot overwrite the built-in checks. Passing `null` as the expected text
  delegates response judgment to those checks and requires an evaluator. Artifact content may be an expected string or a verifier function over the inspected text. The evaluator also receives `sessionEvents` for engine-reported configuration receipts. Added scenarios may send additional
  billable turns; review extension code before confirming.

`ctx.api` forwards every supplied transport argument. Its third argument is the
HTTP method: `ctx.api(path, undefined, 'DELETE')` performs DELETE cleanup. If the
method is omitted, the command transport retains its GET default without a body
and POST default with a body. Existing two-argument calls remain valid.
`ctx.sessionId` is a getter: before the first send it is the proposed
conversation ID, and after each send it is the runtime session ID in Station's
receipt. Read it lazily when making an observation or API request; do not
capture or destructure it before a send and reuse that value afterward.
`ctx.conversationId` remains stable across those changes.

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
session/turn IDs and individual checks. New session-level `runtime.error` events
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

### Opt-in engine delivery probes (#3824)

Use the bundled scenario module with the same confirmation and isolated Station
requirements above:

```sh
station environment credential show | npm run dogfood:agent-smoke -- \
  --matrix --confirm-billable-engine-matrix \
  --origin=http://127.0.0.1:43000 --credential-file=- \
  --connection=example-engine --cwd=/path/on/server/disposable-matrix-workspace \
  --scenario-module=./scripts/engine-delivery-probes.ts \
  --model=example-model-a --max-turns=6
```

This appends one delivery session per engine/connection invocation, using the
first selected model. It declares `maxTurns: 2`, reserving two additional sends
once per engine, rather than per model. The printed plan names the delivery
scenario, its scope, instance count and turn bound; the preflight refusal and
hard send ceiling include those turns. It adds at most two sends: a skill turn
where the
capability matrix declares skill delivery, then an MCP follow-up. The existing
model scenarios still run per model. The CLI loads trusted TypeScript extensions
through the installed `tsx` loader. No live model execution is part of the
fixture tests or a default smoke run.

The probe creates a unique integration through `/integrations`, handshakes it
through `/integrations/:id/reconnect`, and checks Station's discovered tool list
before applying a disable through `/integrations/:id/tools/apply`. The bundled
local stdio MCP server exposes harmless `ping` and `blocked` actions. The table
in `scripts/engine-delivery-probes.ts` names `blocked` for Station, Claude and
Codex; the deterministic test reads the fixture's actual MCP `tools/list`, and
runtime preflight repeats the existence check against Station's integration
inventory. MCP use requires a successful `tool.completed` matched to the current
turn's server-qualified `ping` start by call ID; observable output must contain
`DELIVERY_PING_OK`. A blocked action is a breach only with a matched successful
completion or its `DISABLED_TOOL_WAS_CALLED` output. A rejected/hallucinated
attempt is not a breach. Positive selection proof requires an engine-reported
tool list containing this server's `ping` and omitting `blocked`; without it,
non-use remains unverified. Claude's init `tools` shape comes from line 1 of the
[CLI capture](../../src-server/providers/__tests__/fixtures/claude-2.1.296-skill-invocation-local.jsonl);
the mapper retains it as `session.configured.metadata.engineToolNames`. Other
engines without this receipt remain unverified. Unknown IDs fail before
sending. This tests MCP selection, not a native-tool disable or the entire
pre-tool approval chain. ACP has no MCP per-tool selection channel, and its
policy probe is unsupported; it receives an unrestricted fixture for the MCP
use check. Muse and unknown engines without server delivery are skipped.

The temporary Agent binds the selected connection, integration, Station Control
and supported skill through Station's APIs. The skill's
nonce appears only in `scripts/probe.mjs`, never its `SKILL.md` or a prompt. The
script generates a fresh runtime input and writes `{ input, proof }`, where
`proof = HMAC-SHA256(nonce, input)`. The receipt must appear in the answer and
its contents must verify through the existing identity-bound artifact inspection
API. Echoing the embedded nonce or declaring a known filename is insufficient.
The script cell additionally requires passing skill delivery. This proves a
computed execution receipt, not OS attestation of a particular executable: an
agent running equivalent HMAC code can reproduce the receipt protocol.
The skill API currently creates `SKILL.md` but cannot upload bundled resources,
so this diagnostic adds the script directly to the API-created package after
checking its path and body locally. Run it on the same host/filesystem as Station;
a remote-only client cannot perform this step.

The script lives at the API-returned skill package directory plus
`scripts/probe.mjs`. Claude may materialize it under
`<cwd>/.claude/skills/<skill-id>/scripts/probe.mjs`. Finding this file is not skill
invocation. The skill verdict additionally requires the exact turn's recorded
`Skill` tool call with `arguments.skill` equal to the probe's unique name and a
matching successful `tool.completed` event and the verified execution receipt. A `Read` of that script without
`Skill` fails. Missing invocation records or a missing engine-specific shape
remain unverified, with their reason. A failed invocation cannot pass merely
because the script was read separately.

The per-engine table is intentionally small:

| Engine | Adopted invocation shape | Fixture basis / limit |
| --- | --- | --- |
| Claude | SDK assistant `tool_use` named `Skill`, `input.skill`; mapped to `tool.started` with the same name/input, then a successful completion for that call ID | [Skill capture](../../src-server/providers/__tests__/fixtures/claude-2.1.296-skill-invocation-local.jsonl), lines 2–4; [Read-only counterexample](../../src-server/providers/__tests__/fixtures/claude-2.1.296-script-read-local.jsonl), lines 2–3; [Claude mapper](../../src-server/providers/adapters/claude-adapter-events.ts) |
| Station (`station-agent`) | None adopted; unverified | No captured invocation shape in this provider corpus. `activate_skill` exists in [SkillService](../../src-server/services/agents/skill-service.ts); that declaration is not an invocation receipt. |
| Codex | None adopted; unverified | [Recorded collaboration stream](../../src-server/providers/__tests__/fixtures/codex-0.155.1-collab-v1-spawn-wait-completed.jsonl) supplies no adopted skill form; [mapper](../../src-server/providers/adapters/codex-adapter-events.ts). Skills are currently declared unsupported. |
| ACP | None adopted; unverified | No raw skill-invocation capture; [mapper](../../src-server/providers/adapters/acp-adapter-events.ts). Do not guess from a CLI-specific tool title. Skills are currently declared unsupported. |
| Muse | None adopted; unverified | [Recorded Bash stream](../../src-server/providers/__tests__/fixtures/muse-1.3-bash-tool-turn.jsonl) supplies no adopted skill form; [adapter](../../src-server/providers/adapters/muse-adapter.ts). Skills are currently declared unsupported. |

The new Claude fixtures are real **CLI tool-execution** captures, driven by
loopback fixture inference rather than a real model. Claude Code 2.1.296 / Agent
SDK 0.3.300 advertises the input schema; the local provider requests the call,
the CLI loads the skill or reads the file, and both captures end successfully.
They prove the emitted protocol shape and mapper behavior, not live-model
adherence or behavior on every CLI version. The [capture metadata](../../src-server/providers/__tests__/fixtures/claude-2.1.296-skill-local.meta.json)
records provenance and redactions. Usage/cost fields are CLI estimates over
fixture token counts, not provider billing evidence. The manual, non-billable
[capture helper](../../scripts/fixtures/capture-skill-delivery.mjs) uses only a
loopback endpoint, fixture credentials and an isolated CLI config:

```sh
node scripts/fixtures/capture-skill-delivery.mjs skill /absolute/path/to/claude
node scripts/fixtures/capture-skill-delivery.mjs read /absolute/path/to/claude
```

Those commands write raw local artifacts under `.kontourai/skill-captures/`;
inspect and scrub them before committing. Normal tests replay checked-in
captures through the real mapper; they do not start the CLI or call a model.

The MCP verdict uses exact, server-qualified tool starts and matched successful completions,
never assistant prose. Missing identity provenance cannot verify a delivery
cell. A declared delivery without a passing probe renders **unverified** in a
separate delivery table. The overall scenario still requires the existing UI
output observer and a passing skill-delivery check where claimed for a pass.
A passing stored-output delivery probe does not establish rendering. The separate
`nativeToolPolicy` delivery cell preserves
the capability matrix's declaration but always renders **unverified**, including
when MCP selection passes. This probe observes neither native tool disables
nor the pre-tool blocking/grant chain. External adapters also lack a native
per-tool-disable enforcement path or complete native inventory.

For an optional third-party Streamable HTTP fixture, set
`STATION_DELIVERY_PROBE_MCP_ENDPOINT` to an endpoint implementing the same
`ping`/`blocked` contract. Station probes it before enabling it or sending a
delivery turn. An unreachable dependency skips the delivery row with its reason;
a reachable endpoint missing a required action fails the inventory guard.
ACP authored MCP passthrough is stdio-only, so this override skips ACP.

Cleanup stops the probe session, deletes the temporary Agent and skill through
Station's APIs, and deletes the integration (including its disable policy).
Obligations are registered before creation so a lost acknowledgement still
triggers a cleanup attempt. Every failed cleanup is reported as a failed row,
including alongside a skipped dependency. SIGINT/SIGTERM trigger all registered
compensations once, concurrently so a stalled session stop cannot prevent the
three DELETEs. A five-second deadline exits 130/143 and prints unconfirmed and
all run-owned IDs for recovery. SIGKILL, host/process crashes, or a server-side
create that commits after an interrupted request's cleanup are outside that
confirmation; inspect the printed IDs before discarding the instance. Session receipts and declared workspace
outputs remain for inspection; remove the disposable instance/workspace after
review. Live provider loading, native-tool policy enforcement, and actual rendered
outputs are **NOT_VERIFIED** by the deterministic fixture suite.

### Delivery API route audit

The mounted route owners are `runtime-routes.ts:3135` (`/agents`), `:3167`
(`/api/skills`) and `:3828` (`/integrations`). Setup requires an operator
credential with authority to author command-backed integrations; the integration
management middleware and command-choice gate are not bypassed by a probe.
`validate()` parses JSON and applies the named schema
(`src-server/routes/schemas/schema-validation.ts:67`). GET/DELETE leaves use
`param()` (`:114`) plus the named service's ownership/existence checks; they have
no body schema. The probe sends no PUT requests.

| Probe request | Real route owner | Validation / submitted body |
| --- | --- | --- |
| `POST /integrations` | `src-server/routes/agents/tools.ts:422` | `integrationSchema`, `src-server/routes/schemas/schema-definitions/runtime.ts:212`; `{ id, kind: 'mcp', transport: 'stdio', command, args }`, or the documented HTTP `endpoint` variant. The route saves it disabled. |
| `POST /integrations/:id/reconnect` | `src-server/routes/agents/tools.ts:894` | No body schema; `{}` is ignored. `probeIntegration` performs the real handshake and persists inventory. |
| `GET /integrations` | `src-server/routes/agents/tools.ts:342` | No body; discovered original tool names are projected by the real route. |
| `POST /integrations/:id/tools/apply` | `src-server/routes/agents/tools.ts:999` | `integrationToolsApplySchema`, `runtime.ts:291`; `{ disabledTools: ['blocked'] }`. |
| `POST /integrations/:id/enabled` | `src-server/routes/agents/tools.ts:908` | `integrationEnabledSchema`, `runtime.ts:290`; `{ enabled: true }`. |
| `POST /api/skills/local` | `src-server/routes/agents/skills.ts:145` | `localSkillCreateSchema`, `src-server/routes/schemas/schema-definitions/content.ts:76`; string `name`/`body`, description; omitted `global` uses the local package scope. |
| `GET /api/skills/:name` | `src-server/routes/agents/skills.ts:116` | Required name parameter; `getSkill` resolves the package path. |
| `POST /agents` | `src-server/routes/agents/agents.ts:362` | `agentCreateSchema`, `content.ts:437`, then `validator.validateAgentSpec` (`src-server/domain/validator.ts:92`, managed prompt guard `:132`); name/slug/model/prompt, execution binding and Auto mode, selected skill and MCP servers. Additional Agent fields pass through to the real service/loader; the route checks selected skill names. |
| `DELETE /agents/:slug` | `src-server/routes/agents/agents.ts:557` | Required slug; service refuses reserved identities or referenced Agents. |
| `DELETE /api/skills/:name` | `src-server/routes/agents/skills.ts:324` | Required name; service requires a writable, owned package. |
| `DELETE /integrations/:id` | `src-server/routes/agents/tools.ts:869` | Required ID; built-ins and contributed definitions cannot be deleted. Removing the integration also removes its stored disable policy. |

The [real-route lifecycle suite](../../scripts/__tests__/engine-delivery-routes.test.ts)
mounts these actual Hono route factories with real ConfigLoader, SkillService,
MCPService, AgentService and file persistence in a temporary home. It runs the
actual scenario setup and registered cleanup, including lost acknowledgement
after Agent persistence, probes the local MCP process, checks persisted skill /
policy / Agent state, then checks that all three DELETEs removed their resources.
Only authenticated-principal binding and runtime Agent activation are test
composition; no LLM adapter starts. The verdict suite's setup stubs now use the
real mutation schemas and exact route/method patterns instead of accepting any
`/integrations/*` operation.

The [full matrix integration harness](../../src-server/routes/orchestration/__tests__/engine-matrix.integration.test.ts)
now also mounts these CRUD routes and runs the entire bundled delivery scenario
against real foreground routes, OrchestrationService, EventBus and SQLite. A fake
Station adapter loads the API-created Agent from the real store, executes the
bundled script, declares its actual file through the native output owner, and
calls `ping` on the configured local MCP server. The result retains Station's
unverified skill cell because no captured Station invocation shape is adopted;
execution and MCP-use checks pass; script and selection cells remain unverified without native skill/tool-list receipts. The test asserts fourteen counted sends,
three successful DELETEs and no retained resources. It found and fixed an invalid
empty managed-Agent prompt that schema-only stubs had accepted. It does not
exercise external adapters' passthrough or prove native policy enforcement.

| Turn request | Real route owner | Validation / submitted body |
| --- | --- | --- |
| `POST /api/orchestration/chat` | `src-server/routes/orchestration/orchestration.ts:2916` | `foregroundMessageSchema` (`:981`, derived from `foregroundMessageObjectSchema`, `:802`); conversation ID, selected temporary Agent in `target`, expected engine, directory workspace, `model.override`, message and client turn ID. |
| `POST /api/orchestration/chat/:conversationId/continue` | `orchestration.ts:3310` | `continueForegroundMessageSchema` (`:997`); message, `model.override` and client turn ID. |
| `POST /api/orchestration/commands` | `orchestration.ts:5650` | `orchestrationCommandSchema` (`:571`); cleanup uses only `{ type: 'stopSession', threadId }`, never start/send commands. |
