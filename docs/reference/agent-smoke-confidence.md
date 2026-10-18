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
and stays outside deterministic CI. Tests run against a loopback stub API;
real-provider and rendered-browser qualification remain **NOT_VERIFIED** until
an operator explicitly runs them.

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

The runner discovers the engine's advertised models and starts one session per
selected model. Repeat `--model=ID` to allowlist launch selectors; omitted models
are never called, including during switch-and-back. Without an allowlist, all
advertised models are planned. `--max-turns=N` is a hard send ceiling (default 24,
allowed 1–1000). A plan larger than the ceiling refuses the entire run before
starting sessions; it does not truncate the catalog. The accepted plan and its
turn count are printed as JSON on stderr before session commands; stdout stays
one JSON results document. Each model gets up to six built-in sends:

| Scenario | Check |
| --- | --- |
| First | Exact smoke reply; remember a random conversation secret |
| Follow-up | Recall that secret without repeating it in the prompt |
| Model switch and back | Recall on a second advertised model, then the original |
| Artifact | Write a file with a fresh content nonce, call `declare_output`, compare its stored path and inspect its exact text bytes |
| Recycle | Observe loaded → unloaded across `stopSession`, then loaded after a recall send in the same Station session |

One selected model leaves switch-and-back **unverified** and plans four built-in
sends. Recycle reads `/api/orchestration/sessions/loaded` before stop, after stop,
and after recall. A no-op stop or unavailable unload/resume observation is
**unverified** with its reason; a forgotten secret fails the response check.
These observations prove the public API's activation transition, not an OS
process exit or native provider-session identity. JSON retains those states.
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
Vendor prefixes must agree with the model family's vendor. Known OpenRouter
vendor-qualified forms, Bedrock regional Anthropic forms such as
`us.anthropic.claude-sonnet-4-5-20250929-v1:0`, and Vertex's
`claude-sonnet-4-5@20250929` are accepted. Semantic family/version/tier changes,
cross-vendor prefixes, arbitrary suffixes, and distinct explicit dates or
versions fail. The accepted/rejected table in the
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
  planning bound per model (or once per engine with `scope: 'engine'`). Without
  declarations, the plan reserves the
  remaining run ceiling for extensions (at least one send per scenario instance);
  its printed count is an upper bound. Every managed `sendTurn` command still
  consumes both the printed plan reservation and the hard run ceiling, including `ctx.api` and `ctx.command` calls.
  An extension exceeding either bound gets an explicit failure before another
  send. Trusted modules retain their existing authority; this is not a sandbox. `ctx` provides `sessionId`, `model`, `switchModel`,
  `nonce`, `artifactName`, `artifactContent`, `api(path, optionalBody, optionalMethod)`,
  `command(command)`,
  `send(prompt, requestedModel, exactExpectedText, optionalArtifactPath, optionalArtifactContent, optionalEvaluator)` and
  `recall(model)`. `send` returns the checked turn, including `turnId`, for
  subsequent API observations. Throw on a failed additional assertion; return a
  reason string for an unverified prerequisite. A scenario with no checked turns
  cannot pass. An engine-scoped scenario uses `scope: 'engine'` and gets a fresh
  session on the first selected model, once per invocation. Its optional
  `prepare(ctx)` runs before session startup and can return `{ metadata, state }`
  or `{ skipReason }`. Register each cleanup with
  `ctx.deferCleanup(label, asyncCleanup)` before attempting its mutation;
  obligations run in reverse order after the final session stop, including on
  setup, startup or turn failure and skip. Each cleanup failure adds a failed
  row while the remaining obligations are still attempted. Engine-scoped setup
  also exposes `engine`, `connectionId`, `cwd`, `model` and a `delivery` evidence
  map. The evaluator receives the exact turn's assistant text, complete stored
  output names, events, and identity checks. It returns additional named verdicts;
  it cannot overwrite the built-in checks. Passing `null` as the expected text
  delegates response judgment to those checks. Added scenarios may send additional
  billable turns; review extension code before confirming.

JSON goes to stdout and a timestamped `.json` file alongside a generated,
dated Markdown matrix in `docs/reference/engine-matrix-runs/` by default.
Use `--output-dir=PATH` for private receipts. Both include engine, connection,
launch selector, scenario, verdict, engine-inferred connection, served-as and
failure text; JSON also retains concrete comparison models, the send plan/count,
session/turn IDs and individual checks. New session-level `runtime.error` events
without a turn ID retain their actual error text; pre-send historical errors are
not reassigned to a later turn. Exit 0 requires every row
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
inventory. The disabled-tool verdict requires a recorded positive `ping` call
and no recorded `blocked` call across either probe turn. Unknown IDs fail before
sending. This tests MCP selection, not a native-tool disable or the entire
pre-tool approval chain. ACP has no MCP per-tool selection channel, and its
policy probe is unsupported; it receives an unrestricted fixture for the MCP
use check. Muse and unknown engines without server delivery are skipped.

The temporary Agent binds the selected connection, integration, Station Control
(for `declare_output`), and supported skill through Station's APIs. The skill's
nonce appears only in `scripts/probe.mjs`, never its `SKILL.md` or a prompt. The
script prints it and creates a uniquely named workspace file. The answer must
contain the nonce and the exact file must appear in that turn's stored outputs.
The skill API currently creates `SKILL.md` but cannot upload bundled resources,
so this diagnostic adds the script directly to the API-created package after
checking its path and body locally. Run it on the same host/filesystem as Station;
a remote-only client cannot perform this step.

The script lives at the API-returned skill package directory plus
`scripts/probe.mjs`. Claude's workspace materializer may also copy it into
`<cwd>/.claude/skills/<skill-id>/scripts/probe.mjs`. Its nonce is absent from
`SKILL.md` and the prompt, but an engine with filesystem access can still find
and read that script without loading the skill. A hidden filename or an obscure
package directory does not establish a delivery boundary. The nonce and output
therefore remain raw script-access/output observations: **skill delivery is
unverified even when both pass**, with an explicit `skillDelivery` check and
reason in the report. A skill-exclusive invocation path or an independently
observed load receipt is required to prove that stronger claim; this diagnostic
does not add such a path. Codex and ACP currently declare skills unsupported,
so they receive only the MCP turn.

The MCP verdict uses exact, server-qualified names in `tool.started` events,
never assistant prose. Missing identity provenance cannot verify a delivery
cell. A declared delivery without a passing probe renders **unverified** in a
separate delivery table. The overall scenario still requires the existing UI
output observer and a passing skill-delivery check where claimed for a pass.
A passing stored-output delivery probe does not establish rendering. The separate `nativeToolPolicy` delivery cell preserves
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
including alongside a skipped dependency. Session receipts and declared workspace
outputs remain for inspection; remove the disposable instance/workspace after
review. Provider loading, real Station lifecycle, native-tool policy enforcement,
and rendered outputs are **NOT_VERIFIED** by the deterministic fixture suite.
