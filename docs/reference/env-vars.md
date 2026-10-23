# Environment Variables

Operator environment settings, grouped by category. This is not an inventory of
every internal launcher variable, test seam, or dependency's environment options.
Feature-specific settings are linked below. Set server variables before starting
the process; a shell change does not reconfigure an already running service.

> **Model providers are mostly not env vars.** Ollama and OpenAI-compatible endpoints are configured in the **Connections** UI, not through environment variables — see the [Connections Guide](../guides/connections.md). The AWS variables below apply **only when you run AWS Bedrock**; a local Ollama setup needs none of them.

## Server

The trusted `STATION_WORKLOAD_*` settings configure managed Linux service
resource limits. See [Linux service workload budgets](../guides/development.md#linux-service-workload-budgets)
for defaults, platform support and refusal behavior.

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `PORT` | _(the channel's `serverPort` — `39140` development, `18141` stable, `28141` beta, `38141` nightly)_ | Server listen port. When unset, `resolveRuntimePort` resolves the running channel's contract from `config/channel-ports.json` rather than any fixed number; `PORT=0` or `STATION_PORT_MODE=auto` self-allocates a contiguous block for the HTTP, terminal (`+1`), voice (`+2`), and consent (`+3`) listeners. Not to be confused with `DEFAULT_SERVER_PORT` (`3141`) in `packages/shared/src/ports.ts`, which is the historic source-checkout constant `STATION_PORT` falls back to below | `src-server/index.ts`, `src-server/runtime/bootstrap/runtime-port.ts` |
| `STATION_HOST` | `0.0.0.0` for the server entry point | Listen address. The CLI passes its resolved host to the child server. Binding an address does not bypass request authentication or browser-origin checks. | `src-server/index.ts`, `packages/cli/src/commands/lifecycle.ts` |
| `STATION_PORT_MODE` | _(unset)_ | `auto` selects a free contiguous listener block even when `PORT` is set. Other values leave `PORT`/channel resolution in control. | `src-server/runtime/bootstrap/runtime-port.ts` |
| `STATION_CHANNEL` | `stable` for an otherwise unconfigured runtime | Runtime channel: `stable`, `beta`, `nightly`, or `dev` (`development` is an alias). Source launchers establish development context; arbitrary values are rejected. Channel selects default paths and ports, not release promotion or update eligibility by itself. | `packages/shared/src/runtime-path-resolver.ts`, `config/channel-ports.json` |
| `STATION_NATIVE_DEVICE_PROOF_PILOT` | _(unset or `0` — disabled)_ | `1` enables the source native Device-proof pilot only with session-reference verify/login capabilities and a matching native application connector; unsupported opt-in or other values fail startup. Mounts operator-only binding management and the narrowly scoped native account/Project-read admission. Host signing IPC and ordinary native UI are not enabled by this flag. | `src-server/runtime/bootstrap/native-device-proof-runtime.ts`, `src-server/runtime/bootstrap/station-runtime.ts` |
| `STATION_NATIVE_ENROLLMENT_PILOT` | _(unset or `0` — disabled)_ | `1` separately mounts the source native enrollment ceremony, operator surface registry and pending-enrollment approval. Requires the Device-proof pilot, configured native relay and supported pending account provider; other values or unsupported opt-in fail startup. Recovery completes before admission. See [native enrollment](../design/native-relay-enrollment.md); this flag is not a native application or physical-device qualification receipt. | `src-server/runtime/bootstrap/station-runtime.ts`, `src-server/runtime/routes/runtime-routes.ts` |
| `STATION_ROOT` | `~/.station` when neither root nor home is set | App-owned root for client profiles (`config/profiles.json`), cache, installs, and runtime containers. Without an explicit root, a home under `instances/<channel>` or `instances/dev/<id>` derives its containing root; another explicit home becomes its own root. Before mutation, controlled root entries must be real directories. A whole-root alias and ordinary OS ancestor aliases are canonicalized and allowed. | `packages/shared/src/runtime-path-resolver.ts` |
| `STATION_HOME` | `<root>/instances/<channel>`; development adds `<instance-id>` | Selected runtime home. An explicit `STATION_ROOT` keeps shared profiles there; without one, the home also determines the root as described above. Hosted mode requires a private, service-owned POSIX home, `data/` at `0700`, and an existing `data/orchestration.sqlite` at `0600`. Controlled storage entries cannot be symlinks; ordinary OS ancestor aliases are outside that check. | `packages/shared/src/runtime-path-resolver.ts`, `src-server/runtime/bootstrap/hosted-persistence-boundary.ts` |
| `STATION_API_BASE` | _(unset)_ | Before `station start`, supplies the CLI UI server's `window.__API_BASE__` override. Web fallback is the page's own origin, unless a build-time override or selected saved Station supplies another endpoint; native clients also have host-supplied connection selection. Used separately by CLI clients and `station-control`. See [remote access](cli.md#accessing-station-remotely-198) and [saved Stations](../guides/connections.md#saved-station-addresses). | `packages/cli/src/commands/lifecycle.ts`, `src-ui/src/contexts/ApiBaseContext.tsx`, `src-server/tools/station-control-shared.ts` |
| `STATION_PORT` | `PORT`, then `3141`, only in the final control-client fallback | `station-control` resolves `STATION_API_BASE`, then a registered runtime base, then `http://127.0.0.1:<STATION_PORT or PORT or 3141>`. The runtime normally injects its actual bound base and port into its built-in child. This variable does not choose the server's listen port. | `src-server/tools/station-control-shared.ts`, `src-server/runtime/bootstrap/station-control-runtime-env.ts` |
| `STATION_CONSENT_PORT` | `PORT + 3` | The distinct-origin consent listener's port (station#3677) — the fifth first-class instance port after server, terminal (`+1`), voice (`+2`), and UI. The CLI passes the resolved value (channel contract or `--consent-port`); the runtime derives `PORT + 3` when unset. If the listener cannot bind, approvals fail closed while Station stays usable | `packages/cli/src/commands/lifecycle.ts`, `src-server/runtime/bootstrap/station-runtime.ts` |
| `STATION_SUPERVISOR_IPC` | _(unset)_ | Set to `1`, with `STATION_SUPERVISOR_GENERATION`, by the [process supervisor](../design/process-supervisor.md) on each core server generation it forks over an IPC channel. The server then parks until promoted and binds its listeners through that channel. `1` without an IPC channel refuses to start. Not an operator setting; terminal and engine child processes do not inherit either variable. | `src-server/runtime/bootstrap/supervisor-link.ts`, `src-server/utils/child-process-environment.ts`, `packages/supervisor/src/supervisor.ts` |
| `STATION_FEATURES` | _(none)_ | Comma-separated feature flags. The only flag is `strands-runtime`, which overrides the `runtime` setting to `strands` for this process ([#3909](https://github.com/kontourai/station/issues/3909) decides when it ends). | `src-server/runtime/bootstrap/runtime-initialize.ts` |
| `STATION_PROJECT_RESOURCE_SHADOW` | _(unset — shadow on)_ | `off` (case-insensitive) stops the session-cwd shadow comparison: the resolver's reads and its `git remote` spawn no longer run one tick after a session start. Each skipped comparison is still recorded as `disabled` in `<home>/project-resource-shadow.json`, so a switched-off home stays distinguishable from one where the observer never ran. Session starts are unaffected either way. See [the shadow decisions](../design/portable-project-identity.md#101-the-session-cwd-shadow). | `src-server/services/projects/project-resource-shadow.ts` |
| `STATION_DEPLOYMENT_CAPABILITIES` | _(unset — every capability `unknown`)_ | JSON object declaring what this deployment can provide, reported as `deployment` by `GET /api/system/capabilities`. Known keys are `web-push` and `scheduler`; each value is `supported`, `unsupported` or `unknown`. Unknown keys and values read as `unknown`, and an empty or malformed declaration makes every capability `unknown`. The server cannot authenticate this declaration, so absence never counts as support. | `src-server/capabilities/deployment-capabilities.ts` |
| `STATION_IDLE_SESSION_PARK_AFTER_MS` | `1800000` (30 minutes) | How long an at-rest session's engine may sit unused before Station parks it: the engine process stops, the session stays dormant, and its next turn restarts the engine in place from its resume cursor. Sessions holding an open request, running child work, or lacking a resumable engine are never parked. `0` disables parking; an invalid value keeps the default. | `src-server/runtime/bootstrap/runtime-initialize.ts`, `src-server/services/orchestration/orchestration-service.ts` |
| `ALLOWED_ORIGINS` | _(no additional origins)_ | Comma-separated exact browser origins. Runtime admission adds its own loopback origins at the bound port, packaged native-shell origins, and a specific bound host; the CLI also adds its UI listener origins and `--allowed-origin` values. This does not admit every localhost port or grant a credential. The permissive CORS helper used when HTTP security is absent is not the running Station security policy. | `src-server/security/station-browser-origins.ts`, `src-server/runtime/bootstrap/runtime-http.ts`, `packages/cli/src/commands/lifecycle.ts` |
| `STATION_REMOTE_REQUEST_TIMEOUT_MS` | `30000` (30 seconds) | Bound on each request this Station makes to another Station when it forwards delegated work to a saved SSH or peer Environment. It covers the headers and the body; a slower Station is reported as a timeout, and for a write the report says the change may still have been applied. An integer from `1` to `600000`; any other value fails startup rather than being clamped. It does not bound this Station's own API, and it does not include connecting an SSH tunnel. | `src-server/services/remote-stations/remote-station-forwarder.ts` |
| `STATION_TRUSTED_CONSENT_ORIGIN` | _(none)_ | Exact HTTPS origin (scheme, DNS name, optional port; no path, userinfo, wildcard or IP address) that consent review URLs are issued at, and that the consent listener accepts as the `Origin` of a decision when the request `Host` is that name. Validated at startup: a malformed value refuses to start Station. Unset keeps `http://<request host>:<consent port>`. Also the relying party for operator passkey enrollment: without it enrollment is unavailable ([guide](../guides/operator-passkeys.md)). See the [deployment guide](../guides/deployment.md#reaching-the-consent-origin-over-https). | `src-server/services/consent/consent-origin.ts`, `src-server/services/identity/operator-passkey-enrollment.ts`, `src-server/runtime/bootstrap/station-runtime.ts` |
| `STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN` | _(none)_ | Exact HTTPS origin whose loopback-only Tailscale Serve identity headers may be converted by Station's UI proxy into internally attested pairing-request provenance. Disabled by default; does not grant access or support Funnel. | `packages/cli/src/commands/lifecycle.ts` |
| `STATION_HOME_AUTHORITY_DATABASE` | _(unset — decision preparation disabled)_ | Opts a single personal controller into durable home-owner binding and transfer preparation. Absolute SQLite file in an existing owner-only POSIX directory outside the Station home, including symlink aliases. Existing files must be private regular single-link files. The controller configures WAL and FULL synchronization. Hosted tenancy, Windows controller storage, concurrent controller processes, automatic failover and transfer activation are unsupported. Back up the controller separately from portable homes. | `src-server/runtime/bootstrap/personal-home-authority-database.ts` |
| `STATION_HOSTED_TENANT_REGISTRY_FILE` | _(unset — personal mode)_ | Absolute path to a readable, regular, non-symlink JSON file enabling hosted exact-host ingress and persistence boundaries. Shape: `{"schemaVersion":1,"tenants":[{"id":"opaque-safe-id","authority":"tenant.example.com"}]}`. DNS names compare case-insensitively; an explicit port is significant. URLs, paths, wildcards, duplicate authorities, and invalid tenant IDs fail startup. Hosted persistence is POSIX-only. | `src-server/runtime/bootstrap/runtime-tenant-context.ts`, `src-server/runtime/bootstrap/hosted-persistence-boundary.ts` |
| `AWS_REGION` | `us-east-1` when no usable value applies | Bedrock fallback after agent region, model-connection region, and `app.json` region. Empty or malformed environment values are ignored. | `src-server/providers/llm/bedrock-region.ts` |

## Telemetry

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `DO_NOT_TRACK` | _(none)_ | Any value except empty or `0` forces every product publisher Off, overriding saved consent. OTLP diagnostics retain their separate configuration. | `src-server/domain/telemetry-configuration.ts` |
| `STATION_TELEMETRY_TIER` | `lite` | `off`, `lite`, or `full` policy default for absent Kontour/operator choices; plugin publishers remain Off until explicitly chosen; `full` is capped at Lite and never grants consent. Reports reason `environment`. Lite sends independently per publisher after notice. The legacy Full acknowledgement covers operator only; author Full requires its separate destination-bound receipt. | `src-server/domain/telemetry-configuration.ts` |
| `STATION_AUTHOR_TELEMETRY_ENDPOINT` | empty | Public build-time input from the owner-gated repository Actions variable in official release producers. Empty means no author sink and leaves the independent author sender inert. Source execution ignores the runtime value; builds reject non-official contexts and invalid HTTPS URLs. See [official build activation](../guides/release-rings.md#author-telemetry-in-official-builds). | `esbuild.config.mjs`, `src-server/domain/telemetry-build-constants.ts` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(none)_ | OTLP HTTP collector base URL; Station appends `/v1/traces` and `/v1/metrics`. Used when no saved collector address exists; without either address, this SDK/export path stays inactive. Local monitoring and direct product usage telemetry are separate. | `src-server/domain/telemetry-configuration.ts`, `src-server/telemetry.ts` |
| `OTEL_SERVICE_NAME` | `station` | Service name reported in traces and metrics | `src-server/telemetry.ts` |
| `STATION_OTEL_API_KEY` | _(none)_ | Optional `x-api-key` for the environment collector. A saved collector address or key reference suppresses this environment key. Never used for product observations. | `src-server/domain/telemetry-configuration.ts`, `src-server/telemetry.ts` |
| `STATION_PRODUCT_TELEMETRY_ENABLED` | _(none)_ | Legacy fallback after saved per-publisher choices and `STATION_TELEMETRY_TIER`. False/off/0/disabled means Off; true/on/1/enabled supplies Lite even with an existing Full receipt (trimmed, case-insensitive). DNT wins. | `src-server/domain/telemetry-configuration.ts`, `src-server/services/usage-telemetry-service.ts` |
| `STATION_PRODUCT_TELEMETRY_ENDPOINT` | _(none)_ | Operator product POST address when no saved address exists. Station appends no path. Each resolved tier governs its own sender; absent addresses produce only local unconfigured ledger records. | `src-server/domain/telemetry-configuration.ts`, `src-server/services/usage-telemetry-service.ts` |
| `STATION_PRODUCT_TELEMETRY_KEY` | _(none)_ | Optional `x-api-key` for Full at the environment product destination. Lite and feedback never attach it. A saved address or key reference suppresses this environment key. Never resolved from an OTLP key. | `src-server/domain/telemetry-configuration.ts`, `src-server/services/usage-telemetry-service.ts` |
| `STATION_TELEMETRY_API_KEY` | _(none)_ | Legacy same-destination alias for `STATION_OTEL_API_KEY`. | `src-server/domain/telemetry-configuration.ts` |
| `STATION_TELEMETRY_ENABLED` | _(none)_ | Legacy same-destination alias for `STATION_PRODUCT_TELEMETRY_ENABLED`. | `src-server/domain/telemetry-configuration.ts`, `packages/contracts/src/settings-registry.ts` |
| `STATION_TELEMETRY_ENDPOINT` | _(none)_ | Legacy same-destination alias for `STATION_PRODUCT_TELEMETRY_ENDPOINT`. Existing full-POST addresses retain their meaning. | `src-server/domain/telemetry-configuration.ts` |
| `STATION_USAGE_TELEMETRY_KEY` | _(none)_ | Legacy same-destination alias for `STATION_PRODUCT_TELEMETRY_KEY`. | `src-server/domain/telemetry-configuration.ts` |

A valid nonempty canonical value wins over its legacy alias. Blank values are
absent. Invalid boolean values are ignored before trying the alias and default;
effective values and Settings provenance use the same resolver. Bootstrap
notices name invalid, legacy or conflicting variables without their values.
Aliases remain supported until a separate release decision removes them.
Product and OTLP keys never cross destinations; product consent remains
independent of OTLP configuration or connection checks.
Saved addresses and SecretBinding references are described in
[Usage telemetry](usage-telemetry.md#delivery-status-and-connection-checks).

## Kontour Console bridge

Station can copy each conversation's events to Kontour Console as Console event
records. Both destinations are off by default; with neither variable set the
bridge does nothing. Delivery failures never affect a session: they are counted
on `station.console.emissions` and logged once per outage.

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `STATION_CONSOLE_HUB_URL` | _(unset — hub delivery off)_ | Base URL of a Console hub, for example `http://127.0.0.1:3737`. Station sends records with `POST <url>/records`; a trailing slash is removed. | `src-server/services/evidence/console-bridge-service.ts` |
| `STATION_CONSOLE_FILE_SINK` | _(unset — file export off)_ | `1`, `true`, `yes` or `on` (any case) writes records as JSONL under `.kontourai/console/events/station-bridge/` in each session's project workspace, plus an export manifest under `.kontourai/console/resources/station/`. Other values leave it off. | `src-server/services/evidence/console-bridge-service.ts` |
| `STATION_CONSOLE_SCOPE` | `station-local` | Project scope ID stamped on every record and used in the file-export path. Set it to keep several Stations' records apart in one hub. | `src-server/services/evidence/console-bridge-service.ts`, `src-server/services/evidence/console-bridge.ts` |

## Frontend

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `VITE_API_BASE` | _(unset)_ | Vite environment value read by both development and built frontend code. `window.__API_BASE__` takes precedence; otherwise this precedes the web same-origin fallback. For a built frontend, change it at build time. It does not create a production dev proxy or override every saved/native connection choice. | `.env.example`, `src-ui/src/main.tsx`, `src-ui/src/contexts/ApiBaseContext.tsx` |

## Feature-specific settings

- [Server logs and attachment retention](config.md#logging): `STATION_LOG_LEVEL`, `STATION_SERVER_LOG_RETENTION_DAYS`, `STATION_SERVER_LOG_MAX_BYTES`, `STATION_ATTACHMENT_RETENTION_DAYS`, and `STATION_ATTACHMENT_MAX_BYTES`.
- [Monitoring history](../guides/monitoring.md#environment-variables): `STATION_EVENT_LOG_RETENTION_DAYS` and `STATION_EVENT_LOG_MAX_BYTES`.
- [Native recovery](../user/native-recovery.md#check-the-local-diagnosis): `STATION_DESKTOP_LOG_LEVEL` and the shell's separate logs.
- [Conversations started outside Station](../user/getting-started.md#see-conversations-started-outside-station): `STATION_EXTERNAL_CLAUDE_SOURCE_ROOT`, `STATION_EXTERNAL_CODEX_SOURCE_ROOT`, `STATION_EXTERNAL_GROK_SOURCE_ROOT` and `STATION_EXTERNAL_OPENCODE_SOURCE_ROOT` select the folders Activity reads Claude Code, Codex, Grok and OpenCode history from, instead of `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME` and OpenCode's `XDG_DATA_HOME` data folder and their defaults ([details](session-api.md), [OpenCode source](../../src-server/providers/sessions/opencode-session-source.ts)).
- [Engines from the public registry](../guides/connections.md#engines-from-the-public-registry): `STATION_PUBLIC_AGENT_REGISTRY` set to `off`, `0`, `false` or `no` (any case) stops Station downloading and listing the public agent registry ([source](../../src-server/services/acp/public-agent-registry.ts)).
- [Testing](../guides/testing.md): test prerequisites, fixture paths, transfer baselines, and verification timeouts.
- [Deployment authentication](../guides/deployment-authentication.md) and [Web Push](../guides/web-push-notifications.md): deployment-specific identity and notification setup.

Launchers also set process identity, bound ports, and short-lived credentials for
their children. Those values are implementation details, not settings to copy
from another process. For source discovery, search the relevant owner for
`process.env`, `import.meta.env`, and injected `env` parameters.

## AWS IAM Permissions (Bedrock-only)

These apply only if you connect AWS Bedrock as a Model provider. Local Ollama and OpenAI-compatible endpoints need no AWS setup.

Example actions used for Bedrock inference and catalog discovery. This is a
broad resource example, not a least-privilege policy or a promise that a model
is enabled in your account. Restrict resources and regions for your deployment;
inference profiles can require both profile and model permissions. See
[AWS's inference-profile prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListFoundationModels",
        "bedrock:ListInferenceProfiles"
      ],
      "Resource": "*"
    }
  ]
}
```

The [Bedrock connection adapter](../../src-server/providers/llm/bedrock-llm-provider.ts)
lists foundation models and inference profiles. The
[embedding adapter](../../src-server/providers/llm/bedrock-embedding-provider.ts)
uses `InvokeModel`; the wildcard example above already includes that action.
If you narrow resources, include the embedding model you select.

Pricing lookup uses `pricing:GetProducts` separately from inference; the example
does not grant it. See the [catalog owner](../../src-server/providers/llm/bedrock-models.ts)
and [AWS Price List access guidance](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/security_iam_id-based-policy-examples.html).
