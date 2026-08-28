# Environment Variables

All environment variables recognized by Station, grouped by category.

> **Model providers are mostly not env vars.** Ollama and OpenAI-compatible endpoints are configured in the **Connections** UI, not through environment variables — see the [Connections Guide](../guides/connections.md). The AWS variables below apply **only when you run AWS Bedrock**; a local Ollama setup needs none of them.

## Server

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `PORT` | `3141` | Server listen port | `src-server/index.ts` |
| `STATION_ROOT` | `~/.station` | App-owned root for shared client profiles (`config/profiles.json`), cache, channel installs, and runtime containers. Before runtime mutation, existing `config`, `cache`, `installs`, `instances`, and `instances/dev` entries must be real directories: files, symlinks/reparse points, and unreadable entries are refused even for an external home. A whole-root alias and ordinary OS ancestor aliases are canonicalized and allowed. | `packages/shared/src/runtime-path-resolver.ts` |
| `STATION_HOME` | `<STATION_ROOT>/instances/<channel>` | Runtime-only home override. It never moves shared profiles or defaults. In hosted mode, this must be a real directory owned by the effective Station service UID with no group/other access; `data/` must be `0700`, and an existing `data/orchestration.sqlite` must be a service-owned regular file at `0600`. The controlled path must not use symlinks. | `src-server/utils/paths.ts`, `src-server/runtime/bootstrap/hosted-persistence-boundary.ts` |
| `STATION_API_BASE` | _(unset — same-origin default)_ | Explicit API base override. When set before `station start`, the CLI's UI server injects it as `window.__API_BASE__`; also used by the built-in `station-control` MCP server and the CLI's own client commands. **When unset (the common case), the UI talks to its own origin (`window.location.origin`)** — no config needed for localhost, a LAN/tailnet host, or a single-origin HTTPS reverse proxy; see [cli.md#accessing-station-remotely-198](cli.md#accessing-station-remotely-198) | `packages/cli/src/commands/lifecycle.ts`, `src-server/tools/station-control-shared.ts` |
| `STATION_PORT` | `3141` | Loopback port used by the built-in `station-control` MCP server to construct `http://127.0.0.1:${STATION_PORT}` when `STATION_API_BASE` is unset | `src-server/tools/station-control-shared.ts` |
| `STATION_CONSENT_PORT` | `PORT + 3` | The distinct-origin consent listener's port (archive#3677) — the fifth first-class instance port after server, terminal (`+1`), voice (`+2`), and UI. The CLI passes the resolved value (channel contract or `--consent-port`); the runtime derives `PORT + 3` when unset. If the listener cannot bind, approvals fail closed while Station stays usable | `packages/cli/src/commands/lifecycle.ts`, `src-server/runtime/bootstrap/station-runtime.ts` |
| `STATION_FEATURES` | _(none)_ | Comma-separated feature flags (e.g. `strands-runtime`) | `src-server/runtime/bootstrap/station-runtime.ts` |
| `ALLOWED_ORIGINS` | _(none)_ | Comma-separated additional CORS origins (localhost origins are always allowed) | `src-server/runtime/bootstrap/station-runtime.ts` |
| `STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN` | _(none)_ | Exact HTTPS origin whose loopback-only Tailscale Serve identity headers may be converted by Station's UI proxy into internally attested pairing-request provenance. Disabled by default; does not grant access or support Funnel. | `packages/cli/src/commands/lifecycle.ts` |
| `STATION_HOSTED_TENANT_REGISTRY_FILE` | _(unset — personal mode)_ | Absolute or deployment-mounted JSON file that enables the hosted exact-host ingress and persistence boundaries. The file must be a readable regular file and parse as `{"schemaVersion":1,"tenants":[{"id":"opaque-safe-id","authority":"tenant.example.com"}]}`. DNS authority comparison lowercases ASCII host names; an explicitly configured port is significant. URLs, paths, wildcards, duplicate/canonical-colliding authorities, and invalid tenant IDs fail startup. Hosted startup is POSIX-only: it refuses an unsafe home or Windows rather than weakening the storage boundary. When unset, Station retains its existing personal/local behavior. | `packages/cli/src/commands/lifecycle.ts`, `src-server/runtime/bootstrap/runtime-tenant-context.ts`, `src-server/runtime/bootstrap/hosted-persistence-boundary.ts` |
| `AWS_REGION` | `us-east-1` | Default AWS region for Bedrock API calls (Bedrock-only) | `src-server/routes/connections/models.ts` |
| `DEBUG_STREAMING` | `false` | Enable verbose SSE streaming debug logs in chat routes | `src-server/routes/chat/chat.ts` |

## Telemetry

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(none)_ | OTLP collector URL. Telemetry is disabled when unset. | `src-server/telemetry.ts` |
| `OTEL_SERVICE_NAME` | `station` | Service name reported in traces and metrics | `src-server/telemetry.ts` |
| `STATION_TELEMETRY_API_KEY` | _(none)_ | Optional `x-api-key` sent only with OTLP exports to `OTEL_EXPORTER_OTLP_ENDPOINT`. It is never used for direct product usage telemetry. | `src-server/telemetry.ts` |
| `STATION_TELEMETRY_ENABLED` | `true` | Fallback that enables server-side product usage telemetry when the Settings toggle has not been saved. `false`, `off`, `0`, or `disabled` prevents product telemetry emission. | `src-server/services/usage-telemetry-service.ts` |
| `STATION_TELEMETRY_ENDPOINT` | _(none)_ | Direct HTTP ingestion endpoint for product usage telemetry. Unset by default: no usage telemetry is buffered, timed, or sent. | `src-server/services/usage-telemetry-service.ts` |
| `STATION_USAGE_TELEMETRY_KEY` | _(none)_ | Optional `x-api-key` sent only to `STATION_TELEMETRY_ENDPOINT` for direct product usage telemetry. This is deliberately separate from the OTLP export credential. | `src-server/services/usage-telemetry-service.ts` |

## Frontend

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `VITE_API_BASE` | _(unset — same-origin default)_ | Dev-mode (`vite dev`) backend API URL override (build-time, Vite). Only used in the unbuilt dev server — the built app has no dev proxy and resolves the same-origin default (`window.location.origin`) instead when unset. Checked ahead of the same-origin default, with the same precedence as `STATION_API_BASE` | `.env.example`, `src-ui/src/main.tsx`, `src-ui/src/contexts/ApiBaseContext.tsx` |

## AWS IAM Permissions (Bedrock-only)

These apply only if you connect AWS Bedrock as a Model provider. Local Ollama and OpenAI-compatible endpoints need no AWS setup.

Minimum IAM policy for Bedrock access:

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
        "bedrock:GetFoundationModel"
      ],
      "Resource": "*"
    }
  ]
}
```

For knowledge base embeddings, also add:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel"
  ],
  "Resource": "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-*"
}
```
