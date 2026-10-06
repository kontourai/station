# Environment Variables

Operator environment settings, grouped by category. This is not an inventory of
every internal launcher variable, test seam, or dependency's environment options.
Feature-specific settings are linked below. Set server variables before starting
the process; a shell change does not reconfigure an already running service.

> **Model providers are mostly not env vars.** Ollama and OpenAI-compatible endpoints are configured in the **Connections** UI, not through environment variables — see the [Connections Guide](../guides/connections.md). The AWS variables below apply **only when you run AWS Bedrock**; a local Ollama setup needs none of them.

## Server

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
| `STATION_FEATURES` | _(none)_ | Comma-separated feature flags (e.g. `strands-runtime`) | `src-server/runtime/bootstrap/station-runtime.ts` |
| `STATION_IDLE_SESSION_PARK_AFTER_MS` | `1800000` (30 minutes) | How long an at-rest session's engine may sit unused before Station parks it: the engine process stops, the session stays dormant, and its next turn restarts the engine in place from its resume cursor. Sessions holding an open request, running child work, or lacking a resumable engine are never parked. `0` disables parking; an invalid value keeps the default. | `src-server/runtime/bootstrap/runtime-initialize.ts`, `src-server/services/orchestration/orchestration-service.ts` |
| `ALLOWED_ORIGINS` | _(no additional origins)_ | Comma-separated exact browser origins. Runtime admission adds its own loopback origins at the bound port, packaged native-shell origins, and a specific bound host; the CLI also adds its UI listener origins and `--allowed-origin` values. This does not admit every localhost port or grant a credential. The permissive CORS helper used when HTTP security is absent is not the running Station security policy. | `src-server/security/station-browser-origins.ts`, `src-server/runtime/bootstrap/runtime-http.ts`, `packages/cli/src/commands/lifecycle.ts` |
| `STATION_REMOTE_REQUEST_TIMEOUT_MS` | `30000` (30 seconds) | Bound on each request this Station makes to another Station when it forwards delegated work to a saved SSH or peer Environment. It covers the headers and the body; a slower Station is reported as a timeout, and for a write the report says the change may still have been applied. An integer from `1` to `600000`; any other value fails startup rather than being clamped. It does not bound this Station's own API, and it does not include connecting an SSH tunnel. | `src-server/services/remote-stations/remote-station-forwarder.ts` |
| `STATION_TRUSTED_CONSENT_ORIGIN` | _(none)_ | Exact HTTPS origin (scheme, DNS name, optional port; no path, userinfo, wildcard or IP address) that consent review URLs are issued at, and that the consent listener accepts as the `Origin` of a decision when the request `Host` is that name. Validated at startup: a malformed value refuses to start Station. Unset keeps `http://<request host>:<consent port>`. Also the relying party for operator passkey enrollment: without it enrollment is unavailable ([guide](../guides/operator-passkeys.md)). See the [deployment guide](../guides/deployment.md#reaching-the-consent-origin-over-https). | `src-server/services/consent/consent-origin.ts`, `src-server/services/identity/operator-passkey-enrollment.ts`, `src-server/runtime/bootstrap/station-runtime.ts` |
| `STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN` | _(none)_ | Exact HTTPS origin whose loopback-only Tailscale Serve identity headers may be converted by Station's UI proxy into internally attested pairing-request provenance. Disabled by default; does not grant access or support Funnel. | `packages/cli/src/commands/lifecycle.ts` |
| `STATION_HOME_AUTHORITY_DATABASE` | _(unset — decision preparation disabled)_ | Opts a single personal controller into durable home-owner binding and transfer preparation. Absolute SQLite file in an existing owner-only POSIX directory outside the Station home, including symlink aliases. Existing files must be private regular single-link files. The controller configures WAL and FULL synchronization. Hosted tenancy, Windows controller storage, concurrent controller processes, automatic failover and transfer activation are unsupported. Back up the controller separately from portable homes. | `src-server/runtime/bootstrap/personal-home-authority-database.ts` |
| `STATION_HOSTED_TENANT_REGISTRY_FILE` | _(unset — personal mode)_ | Absolute path to a readable, regular, non-symlink JSON file enabling hosted exact-host ingress and persistence boundaries. Shape: `{"schemaVersion":1,"tenants":[{"id":"opaque-safe-id","authority":"tenant.example.com"}]}`. DNS names compare case-insensitively; an explicit port is significant. URLs, paths, wildcards, duplicate authorities, and invalid tenant IDs fail startup. Hosted persistence is POSIX-only. | `src-server/runtime/bootstrap/runtime-tenant-context.ts`, `src-server/runtime/bootstrap/hosted-persistence-boundary.ts` |
| `AWS_REGION` | `us-east-1` when no usable value applies | Bedrock fallback after agent region, model-connection region, and `app.json` region. Empty or malformed environment values are ignored. | `src-server/providers/llm/bedrock-region.ts` |
| `DEBUG_STREAMING` | _(false)_ | Exactly `true` sets the `debugStreaming` field in the primary chat route's `Stream starting` debug record. It currently does not enable additional stream logging. The logger's level controls whether that record is emitted. | `src-server/routes/chat/chat-primary-stream.ts` |

## Telemetry

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(none)_ | OTLP HTTP collector base URL; Station appends `/v1/traces` and `/v1/metrics`. Unset means this OpenTelemetry SDK/export path stays inactive. Local monitoring and direct product usage telemetry are separate. | `src-server/telemetry.ts` |
| `OTEL_SERVICE_NAME` | `station` | Service name reported in traces and metrics | `src-server/telemetry.ts` |
| `STATION_TELEMETRY_API_KEY` | _(none)_ | Optional `x-api-key` sent only with OTLP exports to `OTEL_EXPORTER_OTLP_ENDPOINT`. It is never used for direct product usage telemetry. | `src-server/telemetry.ts` |
| `STATION_TELEMETRY_ENABLED` | `true` | Product-usage fallback only when `app.json.telemetryEnabled` is absent. `false`, `off`, `0`, or `disabled` means off; `true`, `on`, `1`, or `enabled` means on (trimmed, case-insensitive). A saved setting wins. Emission also requires an endpoint and a disclosure receipt for the current inventory revision. | `src-server/services/usage-telemetry-service.ts` |
| `STATION_TELEMETRY_ENDPOINT` | _(none)_ | Direct HTTP ingestion endpoint for product usage telemetry. Unset by default: no usage telemetry is buffered, timed, or sent. | `src-server/services/usage-telemetry-service.ts` |
| `STATION_USAGE_TELEMETRY_KEY` | _(none)_ | Optional `x-api-key` sent only to `STATION_TELEMETRY_ENDPOINT` for direct product usage telemetry. This is deliberately separate from the OTLP export credential. | `src-server/services/usage-telemetry-service.ts` |

## Frontend

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `VITE_API_BASE` | _(unset)_ | Vite environment value read by both development and built frontend code. `window.__API_BASE__` takes precedence; otherwise this precedes the web same-origin fallback. For a built frontend, change it at build time. It does not create a production dev proxy or override every saved/native connection choice. | `.env.example`, `src-ui/src/main.tsx`, `src-ui/src/contexts/ApiBaseContext.tsx` |

## Feature-specific settings

- [Server logs and attachment retention](config.md#logging): `STATION_LOG_LEVEL`, `STATION_SERVER_LOG_RETENTION_DAYS`, `STATION_SERVER_LOG_MAX_BYTES`, `STATION_ATTACHMENT_RETENTION_DAYS`, and `STATION_ATTACHMENT_MAX_BYTES`.
- [Monitoring history](../guides/monitoring.md#environment-variables): `STATION_EVENT_LOG_RETENTION_DAYS` and `STATION_EVENT_LOG_MAX_BYTES`.
- [Native recovery](../user/native-recovery.md#check-the-local-diagnosis): `STATION_DESKTOP_LOG_LEVEL` and the shell's separate logs.
- [Conversations started outside Station](../user/getting-started.md#see-conversations-started-outside-station): `STATION_EXTERNAL_CLAUDE_SOURCE_ROOT`, `STATION_EXTERNAL_CODEX_SOURCE_ROOT`, and `STATION_EXTERNAL_GROK_SOURCE_ROOT` select the engine home Station reads instead of `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `GROK_HOME` and their defaults ([details](session-api.md)).
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
