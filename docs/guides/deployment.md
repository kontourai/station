# Deployment Guide

## Local Development

```bash
./station start                          # Auto-installs, builds, starts server + UI
./station start --clean --force          # Wipe and rebuild from scratch
./station start --port=3142 --ui-port=3001  # Custom ports
```

## Docker Production

Station's container image has one public origin: its lifecycle UI proxy serves the UI,
API, streaming, terminal/voice WebSockets, identity, and device pairing from
port 3000. It runs as Node's unprivileged UID/GID `1000` and persists its home
in the `station-data` volume.

```bash
docker compose pull
docker compose up -d
```

Open <http://localhost:3000>. The configured host directory is bind-mounted at
`/workspace`. By default this is the narrow `station-workspace` named volume,
not the directory containing the Compose file. Bind an explicit project
directory when Station should edit host files:

```bash
export STATION_WORKSPACE_DIR=/absolute/path/to/projects
docker compose up -d
```

Port 3000 binds to `127.0.0.1` by default. Keep that loopback default behind a
same-host reverse proxy. Set `STATION_BIND_HOST=0.0.0.0` only when the host
firewall, tailnet, or another authenticated private ingress deliberately
controls remote reachability. If the browser-visible origin is not
`http://localhost:3000` or `http://127.0.0.1:3000`, allow that exact origin
before starting Compose so authenticated mutations retain origin protection:

```bash
export STATION_ALLOWED_ORIGINS=https://station.example.com
docker compose up -d
```

Use a comma-separated list only when the same Station is deliberately reachable
through multiple exact origins. Do not use wildcard origins.

Stable publication targets `ghcr.io/kontourai/station:latest`; preview
publication targets `:preview`. The release pipeline also defines exact
`vX.Y.Z`, semver-without-`v`, and immutable `sha-<40-character-SHA>` tags.
Check the registry and release record for availability before selecting a tag;
use the source-build path below when the selected artifact is not published. Inspect the
runtime identity through the public same-origin endpoint:

```bash
curl http://localhost:3000/__station/identity
```

For a local source build, provide immutable provenance explicitly; the Docker
context intentionally excludes `.git`, credentials, nested `node_modules`, and
generated `dist` directories. Docker installs its own platform dependencies in
the manifest-driven dependency stage; host output must not overlay that stage.
`node scripts/check-container-build-context.mjs` verifies this with Docker before
the container smoke build:


```bash
export STATION_RELEASE_SHA="$(git rev-parse HEAD)"
export STATION_RELEASE_REF=v0.0.0-preview.1
export STATION_RELEASE_CREATED_AT="$(git show -s --format=%cI HEAD | xargs -I{} node -e 'process.stdout.write(new Date(process.argv[1]).toISOString())' '{}')"
docker build --pull --tag station-local:preview \
  --build-arg "STATION_RELEASE_SHA=$STATION_RELEASE_SHA" \
  --build-arg "STATION_RELEASE_REF=$STATION_RELEASE_REF" \
  --build-arg "STATION_RELEASE_CREATED_AT=$STATION_RELEASE_CREATED_AT" .
export STATION_IMAGE=station-local:preview
docker compose up -d
```

The mounted directory must be readable and writable by UID 1000. On Linux,
adjust ownership or ACLs deliberately; do not run the image as root just to
work around a host bind-mount permission error. Upgrades retain `station-data`:

```bash
docker compose pull && docker compose up -d
```

Do not place Agent-app credentials in the image or a compose environment file.
Mount only the specific configuration or credential source an operator has
chosen to provide. Bootstrap the first browser without displaying or copying
the reusable environment credential:

1. Open Station, choose **Request access**, and submit a device name.
2. List pending requests inside the container:

   ```bash
   docker compose exec station ./station environment access list
   ```

3. Approve the exact request ID shown:

   ```bash
   docker compose exec station ./station environment access approve <request-id> --force
   ```

The browser receives a revocable HttpOnly device session and reconnects
automatically. Later paired host browsers can approve another browser in the
UI. Remove a device from Connections when access should end.

The production Compose file is intentionally not a source-mounted development
stack. Use `./station start --temp-home` for local development so credentials
and hot reload stay outside the published image contract.

## Monitoring Stack

The standalone monitoring stack lives in `monitoring/`:

```bash
cd monitoring && docker compose up -d
```

| Service | Port | Description |
|---------|------|-------------|
| Collector | `4318` | OTLP HTTP receiver |
| Prometheus | `9090` | Metrics storage |
| Grafana | `3333` | Dashboards (admin/station) |
| Jaeger | `16686` | Distributed traces |

Enable telemetry in the app:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 ./station start
```

The standalone stack in `monitoring/` is independently managed from Station's
production container.

## Private cloud environment

See the [private cloud environment design](../design/private-cloud-environment.md)
for the initial single-VM architecture, execution boundaries, storage, and
backup/restore plan. Provider provisioning and workload sizing remain separate
validation work.

The container includes Git, an OpenSSH client, certificate trust, and terminal
support. Additional engine CLIs and language toolchains must be deliberately
installed and authenticated for the selected workload. The default Compose
configuration rotates container output logs and grants a 30-second stop grace
period. Its health check requires both image identity and live backend
readiness. Application and workspace files need their own retention/backup policy.

## Offline home recovery drill

Use a disposable home first, with the same Station release on source and target.
Record a Project, Task, room message, document edit, its durable edit receipt,
and the published revision link. Make another edit so the first revision is no
longer the current document. Stop every runtime using the source home before
running the [home backup and restore commands](../reference/cli.md#home-backup):

```bash
station home backup --home=/srv/station/source-home --output=/srv/backups/station-drill --json
station home restore --from=/srv/backups/station-drill --home=/srv/station/recovery-home --confirm --json
```

The archive contains sensitive home files and is not an encrypted transport.
Restrict archive access and encrypt off-host storage using your organization's
backup system. Preserve required evidence-signing keys securely; rotating the
operator credential is separate from replacing those keys. OS-held credentials,
external engine sessions, and workspace directories outside the home require
their own recovery procedures. Use owner-approved pairing for target clients.

Keep the source stopped and inaccessible to the recovery runtime. Open the
target with an isolated instance and ports, then check the exact recorded
Project/Task identities, room history, document, and original revision link.
When replaying a durable edit receipt, verify that it references the original
revision rather than the latest edit. Missing workspace files must remain
unavailable until separately restored; a missing evidence key must produce
unavailable evidence rather than silently re-signing old history. Do not resume
agents until their workspace, credentials, and execution ownership are verified.

The service integration drill in
[`home-reference-recovery.test.ts`](../../src-server/services/orchestration/__tests__/home-reference-recovery.test.ts)
executes real home backup/restore and persistence owners, removes its synthetic
source home and external workspace, rotates the target operator credential, and
checks exact references with intact and missing evidence keys. It uses a fixture
request-authority adapter; it does not prove client pairing, provider credential
migration, another operating system, or a cloud deployment. Run it with:

```bash
npm run test:focused -- src-server/services/orchestration/__tests__/home-reference-recovery.test.ts
```

Offline restore does not fence another host or grant it execution authority.
Each restore records a new recovery identity and the backup snapshot time in
`station-home-recovery.json`; the CLI and JSON restore receipt disclose recovery
from a copy. Retain that record when operating the recovered environment. It is
provenance metadata, not proof of source shutdown or a transfer certificate.
Keep one active writer by operational control; automatic cross-host handoff,
witness-less fork presentation, and per-tenant recovery require separate
verification before offering those guarantees to customers.

## Reverse Proxy

For a complete optional Compose proxy profile, see [Public HTTPS ingress](../../deploy/public-ingress/README.md). It keeps the root deployment private unless explicitly applied and removes direct Station host ports.

Terminate TLS in a reverse proxy that forwards the one public origin. Do not
split UI and API onto separate origins:

```nginx
server {
    listen 443 ssl;
    server_name station.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_buffering off;
    }
}
```

WebSocket upgrade headers are required for voice (S2S) and terminal sessions.
Station's browser-facing SSE routes send `X-Accel-Buffering: no` so nginx-family
proxies deliver chat tokens and operational events immediately. Preserve that
response header.

`proxy_buffering off` is not merely defense in depth: the station-control MCP
endpoint streams through a handler-built response whose headers Station does not
set, so it does **not** carry `X-Accel-Buffering`. Without `proxy_buffering off`,
a long-running MCP tool call's progress notifications can stall behind the proxy.
Keep the directive if you use that endpoint.

Configure your public TLS origin normally; this image does not set a generic
trusted-proxy mode.

## Hosted tenant ingress (foundation only)

For the first hosted foundation, publish each tenant through Station's
same-origin UI proxy and provide a fixed deployment registry to both child
processes:

```json
{"schemaVersion":1,"tenants":[
  {"id":"tenant_alpha","authority":"alpha.example.com"},
  {"id":"tenant_bravo","authority":"bravo.example.com:8443"}
]}
```

Mount that file read-only and set `STATION_HOSTED_TENANT_REGISTRY_FILE` to its
path before `station start`. The UI proxy reads exactly one raw `Host` field,
matches only a configured authority (ASCII case-insensitive DNS; explicit port
is significant), and returns `421` before static files, public pairing, or API
routes for malformed or unknown hosts. It strips caller-supplied internal
tenant headers and attests its selected tenant only over Station's existing
loopback/token hop. `Origin`, `Forwarded`, and `X-Forwarded-*` headers are not
tenant authority.

Hosted mode also carries that verified tenant only as server-owned execution
context. A request starts with the attested context, a resumed or adopted
session restores its validated persisted binding, and the exact built-in
`station-control` MCP server receives it only through a private carrier: a
token-bound Codex HTTP/SSE session, the exact built-in Claude child environment,
or the trusted async context selecting a native client. Station-agent relays
use the same server-owned session context. Public session responses, command
bodies, model options, tokens, and arbitrary same-name third-party MCP
integrations cannot provide or read that context. Direct/internal session
starts without a validated binding fail closed in hosted mode; personal mode
continues to use its existing shared local MCP connection.

Lifecycle and background provider notifications are explicitly aggregate-safe:
they observe provider status only, cannot issue tenant-scoped Station API calls,
and never infer tenant authority from a thread, session, or event payload.

The built-in native `station-control` client pool is bounded by the immutable
registry (at most 128 tenants), creates at most one client per tenant at a
time, and is released during runtime shutdown. Failed shutdown cleanup remains
visible to the runtime so it can be retried; tenant IDs never appear in its
telemetry attributes.

Do not externally reverse-proxy directly to the loopback backend: the
same-origin UI proxy is the supported terminator for this slice. This registry
selects request context only. It does **not** partition Station's data,
credentials, membership, RBAC, or authorization, so it is not multi-user or
tenant-isolation readiness. Keep such deployments pre-production until those
separate boundaries exist.

### Hosted persistence boundary

The presence of `STATION_HOSTED_TENANT_REGISTRY_FILE` enables hosted mode and
its persistence preflight. This is a POSIX-only hosted foundation: Windows
hosted startup is refused because Station does not yet have an ACL-based
persistence boundary there. Personal mode (the variable unset) retains its
existing local startup behavior and does not apply these hosted-only checks.

Before starting the service, the deployment storage administrator must provision
`STATION_HOME` for the effective Station service UID. The home must be a real
directory owned by that UID with no group or other access; its `data/` directory
must be owned by that UID and mode `0700`; and an existing
`data/orchestration.sqlite` must be a regular file owned by that UID and mode
`0600`. The home, `data/`, database, and the immediate persistence-path parents
that Station controls must not be symbolic links. If Station must create an
absent home, its existing parent must be a real directory that is not writable
by group or other users. Station creates a missing `data/` directory and
database with modes `0700` and `0600` only after it has verified that boundary.

For example, on POSIX a storage administrator can provision a new home before
the service starts (substitute the service account and configured path):

```bash
sudo install -d -o station -g station -m 0700 /srv/station
```

For an existing home with `data/` and the database already present, stop
Station, remove any symlink from the controlled path, correct ownership for the
service UID, and set the precise modes before restarting:

```bash
sudo chown station:station /srv/station /srv/station/data /srv/station/data/orchestration.sqlite
sudo chmod 0700 /srv/station /srv/station/data
sudo chmod 0600 /srv/station/data/orchestration.sqlite
```

If the preflight finds a missing/unsafe parent, a symlink, wrong owner, wrong
file type, or accessible mode, startup fails with
`HOSTED_PERSISTENCE_BOUNDARY_REJECTED` before Station opens SQLite, starts
watchers, or loads application data. Repair the named path condition above;
do not bypass the check by running the service as root or by turning hosted mode
off for a hosted deployment.

This boundary deliberately trusts the Station service account and any storage
administrator able to write `STATION_HOME`. A trusted writer can replace a
valid persisted `tenant_execution_context` from one configured tenant with
another (for example, alpha with bravo), changing the stored authority. That is
outside #1707's request-isolation promise. Station therefore does **not** claim
that a MAC over only the tenant column solves this problem: the same writer can
also rewrite the corresponding session, event, cursor, or related store state.
Whole-store authenticated integrity with key authority outside that writer is
follow-up scope.

Until their storage gains a durable tenant binding, hosted mode suppresses the
entire `/scheduler` API (including its reads, SSE, webhook, and mutations) and
the unbound `/api/tasks` task graph. File-memory conversation inventory,
lookup, mutation, context-management, and acknowledgement operations are also
unavailable; scheduler- and API-originated notifications without a persisted
session binding are not delivered. These surfaces are not partial
tenant-specific inventories: durable tenant-bound scheduler, task, file-memory
conversation, acknowledgement, and notification storage is later work.
The related project-local aliases are unavailable too: work-item provider and
claim routes, Flow-Agents workflow-sidecar task routes, and operating-state
board/task intents do not read or execute in hosted mode. The operating-state
GET remains unavailable as well. Its POST intent endpoint admits only the
exact Station `session resume` authority shape; the existing binder then
reauthorizes the subject against the fresh request authority and its persisted
session binding. Task, missing, malformed, and mismatched intents return the
same unavailable response without invoking local task state.

Tool approvals are likewise session-bound. A hosted approval without a
tenant-validated backing session is denied before it is registered, so it
cannot appear in events, attention, or a direct approval-resolution route.
Public direct resolution always uses fresh request authority; trusted runtime
settlement can resolve only an already-admitted private session binding. Both
pending and terminal lifecycle frames reauthorize their session metadata, so a
resolved or timed-out approval remains visible to its owner without retaining
tenant data or a settled-entry tombstone. Cross-tenant and unknown approval IDs
are indistinguishable from unavailable.

Hosted mode also keeps terminal REST and WebSocket surfaces unavailable because
terminal records have no durable tenant owner. Web Push public-key,
subscription, and unsubscription routes and delivery are unavailable for the
same reason: paired-device subscriptions have no durable tenant binding. These
surfaces return only when their backing storage carries and enforces that
binding; personal mode retains the existing terminal and Web Push behavior.
Answer shares are different: their list, mint, view, and revoke operations use
the existing session authority and remain available only for authorized
sessions. Personal mode retains its existing scheduler, task, and merged
file/session conversation behavior.

## Environment Configuration

For standard, minimal, and organization-owned starter layout policy, see
[Distribution Profiles](./distribution-profiles.md).

See [Environment Variables](../reference/env-vars.md) for all supported variables and their defaults.

Key variables for deployment:

```bash
PORT=3141                                    # Server port
STATION_HOME=/data/station             # Custom data directory
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318  # Telemetry
ALLOWED_ORIGINS=https://station.example.com  # CORS
STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN=https://station.example.com  # optional pairing provenance
STATION_HOSTED_TENANT_REGISTRY_FILE=/run/secrets/station-tenants.json # optional hosted ingress
```

### Pre-provisioning projects

Station discovers projects from `<STATION_HOME>/projects/<slug>/project.json`.
A distributor or deployment operator can pre-place one or more project
directories (each with a valid `project.json`, optionally a `layouts/`
subdirectory) under `<STATION_HOME>/projects/` before the very first server
boot. `runStartupMigrations` never creates or modifies anything once
`<STATION_HOME>/projects/` already exists, so pre-placed projects become the
app's initial state instead of the built-in empty/new-project prompt. This is
the supported provisioning mechanism — there is no separate plugin API for
seeding projects.

A brand-new `STATION_HOME` with no `projects/` directory and no pre-#1628
`<STATION_HOME>/layouts/*` content boots with zero projects, landing on the
Home view's "Start direct chat" / "Open local project" actions rather than a
seeded `Default` project. A pre-#1628 home with earlier
`<STATION_HOME>/layouts/*/layout.json` content is the one exception: it still
migrates to a `Default` project on first boot, carrying its layouts over,
exactly as before. See [Distribution Profiles](./distribution-profiles.md)
for starter-layout *catalog* policy, a related but distinct concern from
project provisioning.

## Headless Station on a Windows host over SSH

Reaching a Windows box's Station from another tailnet device (a phone, or
another host) is not the same as launching the app there, and three things
bite in a specific order. Verified end to end on a Windows 11 host reached
over Tailscale SSH.

**1. `station.exe` is the desktop app and cannot start over SSH.** It is the
Tauri shell; an SSH session has no interactive desktop, so the process spawns
and exits immediately with no error worth reading. The install ships the
headless server alongside it — run that instead:

```powershell
# From an SSH session on the Windows host
$node = "$env:LOCALAPPDATA\nvm\<version>\node.exe"   # Station requires Node 24.x
Start-Process -FilePath $node -ArgumentList "dist-server\command-station.js" `
  -WorkingDirectory "C:\Program Files\Station" -WindowStyle Hidden
```

**2. The working directory is load-bearing.** The server resolves `schemas/`
relative to the process CWD, so launching from `$HOME` dies on
`C:\Users\<user>\schemas\app.schema.json`. `-WorkingDirectory` must be the
install root, not the script's directory.

**3. A process started from an SSH session dies with that session.** It shares
the session's job object, so the listener disappears the moment you
disconnect — which reads as "it started fine and then the host went down."
Register a scheduled task so it survives:

```powershell
$node = "$env:LOCALAPPDATA\nvm\<version>\node.exe"
$action = New-ScheduledTaskAction -Execute $node -Argument "dist-server\command-station.js" `
  -WorkingDirectory "C:\Program Files\Station"
Register-ScheduledTask -TaskName "Station Server" -Action $action `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)) `
  -User (whoami) -RunLevel Highest -Force
Start-ScheduledTask -TaskName "Station Server"
```

`Register-ScheduledTask -UserId "$env:USERDOMAIN\$env:USERNAME"` fails with
"No mapping between account names and security IDs was done" on a
non-domain-joined host; `-User (whoami)` resolves correctly.

**Then the firewall.** The server binds `0.0.0.0`, but Windows Firewall blocks
inbound by default and the installer adds no rule, so the port is open locally
and invisible from the tailnet. Scope the rule to the Tailscale CGNAT range
rather than opening it to the LAN:

```powershell
New-NetFirewallRule -DisplayName "Station API (Tailscale only)" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 3141 -RemoteAddress 100.64.0.0/10 -Profile Any
```

**Verify from another tailnet node, not from the host.** A local check passes
while the firewall still blocks everyone else. `/.well-known/station/v1` should
return 200 and the protected endpoints 401 — 401 is the correct answer to an
unauthenticated caller and confirms reachability, whereas `000` means no route
or a blocked port:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://<tailscale-ip>:3141/.well-known/station/v1
curl -s -o /dev/null -w "%{http_code}\n" http://<tailscale-ip>:3141/api/system/identity
```

As on every other host, tailnet reachability is not authorization — the phone
still has to request access and be approved.

**To undo both host changes:**

```powershell
Unregister-ScheduledTask -TaskName "Station Server" -Confirm:$false
Remove-NetFirewallRule -DisplayName "Station API (Tailscale only)"
```

Note this serves whatever build is installed under `C:\Program Files\Station`;
it does not track `origin/main`, so a Windows host stays on its installed
version until the app itself is updated.

## Private tailnet dogfood on macOS

### Channel desktop apps: ports, homes, and targeting

The macOS desktop ships as up to three coexisting channel apps — `Station.app`
(stable), `Station Beta.app`, `Station Nightly.app`. Each channel has a
default server port — stable `18141`, beta `28141`, nightly `38141` — carried
in the app's **persisted service manifest** (`src-desktop/src/service_state.rs`
reconciles `manifest.server_port` against local state), so the port is stable
across restarts and self-updates in practice, but it is configuration, not a
compile-time constant: trust the manifest/live process, not the number.

Homes differ per channel: on this deployment model stable runs from
`STATION_ROOT/instances/stable` (default root `~/.station`; admission logic in
`service_state.rs`) and nightly from its own isolated `~/.station-nightly` —
both facts read from the LIVE processes' `STATION_HOME`, which is the only
ground truth (the split also appears in `src-desktop` fixtures, but the home,
like the port, comes from the app's service state). Do not infer a channel's
home from directory
names on disk — `~/.station/instances/nightly` may exist without being the
nightly app's home. The ground truth for a running server is its own
environment: `ps eww -o command -p <server-pid> | tr ' ' '\n' | grep
STATION_HOME`.

Saved CLI profiles map friendly names to each channel's loopback endpoint and
credential — client-tier commands (`stations`, `setup`, `agents`, `chat`, and
the rest) work identically from any machine via
`npx @kontourai/station-cli@<channel> ...`, matching the channel tag to the
Station you're targeting (`nightly` for a Station Nightly host, `latest` for
stable); `./station stations` is the same surface from inside this checkout —
see [the CLI reference's Invocation section](../reference/cli.md#invocation)
for the full npx / `./station` / `station-dev` story. Environment-security
verbs (`environment access list|approve|deny`) are host-local (they read
secrets that only exist on the machine running the Station) and only run
through `./station` — they are not reachable through `npx`/the published
CLI, regardless of targeting. They do accept `--station=<name>` (station#4515),
so once a Station is saved under a name, `./station environment access list
--station=<name>` is equivalent to the explicit `--api-base` pair below; the
worked example spells out the pair explicitly rather than assuming a
nightly-channel profile is already saved on this device. The worked example
for approving a phone against the **nightly** channel is:

```bash
STATION_HOME=~/.station-nightly \
  ./station environment access list --api-base=http://127.0.0.1:38141
STATION_HOME=~/.station-nightly \
  ./station environment access approve <request-id> --api-base=http://127.0.0.1:38141
```

When exposing a channel over the tailnet, the Serve mapping must target the
channel's fixed port, and paired devices embed the *public* port in their saved
endpoint URLs — so treat an established public port as permanent even if its
number is historical:

```bash
tailscale serve --bg --https=<public-port> http://127.0.0.1:38141   # nightly
tailscale serve status                                              # what fronts what
curl -sk https://<device-fqdn>:<public-port>/api/system/status   # FQDN as shown by `tailscale serve status`
# {"error":{"code":"authentication_required"}} == alive and gated (healthy)
```

#### Troubleshooting the pairing path

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Device stuck "waiting for approval"; host sees no request | Serve mapping fronts a port nothing owns (dangling proxy) | `curl` the public URL (000 = dangling) and `lsof -nP -iTCP:<local-port> -sTCP:LISTEN` |
| Device: "isn't the one this device paired with" | The public endpoint fronts a different instance (another channel, a rebuilt home, or a stray locally-started server on that port) than the one the device paired with | Confirm which pid owns the mapped local port, then its `STATION_HOME` via `ps eww` |
| CLI: "loopback Station identity does not match this local Station home" | `STATION_HOME` doesn't match the server behind `--api-base` | Read the server's real home from its process env (above); never guess from directory names |
| Buttons in the device's connection UI appear dead | Their requests POST into a dangling endpoint and fail silently (station#4475) | Same dangling-proxy check as row one |
| A CLI invocation boots a whole runtime and collides on ports | `dist-server/command-station.js` is the **server** entry, not an operator CLI — use the repo launcher `./station` | — |
| A mystery local server answers Station endpoints | Orphaned test/stage instances re-parented to launchd (worktree perf runs, synthetic stage-phone proxies) linger for weeks and answer probes convincingly | `ps -o ppid= -p <pid>` — ppid 1 from a dead lane is an orphan; sweep it |


The repository-owned dogfood supervisor keeps one named Station instance on
the exact `origin/main` commit whose GitHub Actions `CI` **push** run completed
successfully. It stages a detached clean release and runs `npm ci` plus
`./station build` before stopping the active release. Promotion binds all four
Station listeners to `127.0.0.1`, verifies the exact build SHA locally and through
Tailscale Serve HTTPS, and only then commits `active`/`previous` state. A build
failure leaves the active process alone; a post-stop failure restarts and
health-checks the previous built release.

This recipe is private-tailnet only. It refuses an existing conflicting HTTPS
root handler or Funnel, never enables Funnel, never runs `tailscale serve
reset`, and leaves unrelated Serve ports and paths in place.

Tailscale reachability is not authorization. On a direct non-loopback Station
connection, protected requests require an approved device session or the
environment credential; only the versioned public handshake and liveness
document are unauthenticated. Bootstrap a phone without copying a reusable
credential:

```bash
# On the phone, open the Station URL and choose Request access. Then, on the
# Station host (or after SSHing into it):
./station environment access list
./station environment access approve <request-id>
```

The second command asks for confirmation and uses the host credential only over
loopback. The phone receives a revocable HttpOnly device session and reconnects
automatically. If several requests are waiting, use the exact ID shown by
`access list`; `--latest` is an explicit convenience. Noninteractive SSH also
requires `--force`. For a non-default instance, export the same `STATION_HOME`
and `STATION_PORT` used at startup (or pass the matching loopback `--api-base`)
before running either command. The CLI verifies the Station's nonce/HMAC proof
before it sends authorization, so a wrong local port fails closed.

Direct credential display remains an advanced break-glass path:

```bash
./station environment show
./station environment credential show
```

If used, enter the second command's output only into Station Connect's masked
credential field; never include it in a URL, command example, log, or
screenshot. Keep the local terminal open until an authenticated protected read
succeeds. Credential
rotation preserves the environment ID and invalidates every saved client;
environment reset rotates both and requires full re-bootstrap. See the
[remote access threat model](../security/remote-access-threat-model.md) for the
surface matrix, recovery, and rollback procedure.

Station ignores forwarding headers and has no generic trusted-proxy mode. Raw
Tailscale identity headers are stripped. When the exact HTTPS origin is opted
in with `STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN`, the loopback-only UI proxy
accepts Tailscale Serve's sanitized, WhoIs-backed user headers only for that
authority and only when Funnel is absent. It converts them into bounded
pairing-request provenance; identity never approves the request or authorizes
another route. The sibling UI and API processes share a per-start random
256-bit internal proxy token. The UI strips inbound Station attestation headers
and marks every ordinary browser proxy request as remote; socket shape and Host
are never internal authority. The API accepts a `local` attestation only from a
direct loopback internal consumer that already possesses the token. Invalid,
spoofed, or UI-proxied attestation is remote, and the UI refuses to proxy if the
token is absent. Thus a tailnet Host and an SSH-forwarded UI request both remain
credential-protected through the repository-owned proxy chain.

This is a private contract between Station sibling processes, not authority for
an external reverse proxy. Keep the handler private-tailnet-only; do not expose
it through Funnel or an untrusted reverse proxy. `ALLOWED_ORIGINS` only adds
exact browser CORS origins; it does not authenticate a caller or configure
proxy trust. Leave the Tailscale Serve origin variable unset for any other
ingress design.

### Install

The supported and tested runtime is Node.js 24.x. The installer also requires runnable `npm`,
`git`, `curl`, `launchctl`, and `plutil`; an authenticated `gh` with `run list`
and the required JSON fields; and Tailscale with `status --json` and `serve
status --json` plus full `get-config`/`set-config` transactions while logged
into the desired tailnet. It resolves every tool to
an absolute executable, verifies these capabilities before changing Tailscale
Serve or launchd, and writes a deterministic tool-directory `PATH` into the
LaunchAgent. During installation it also runs the configured login shell once,
with a five-second bound, to capture its effective `PATH`. Station accepts only
absolute, existing directories owned by root or the current user that are not
group- or world-writable, resolves only the supported
`claude`, `codex`, `kiro-cli`, `cursor-agent`, and `opencode` command names, and
publishes those resolutions through a current-user-owned mode-`0700` directory
at `bin/clients` below the support root. That private directory is prepended to
the deterministic operational path. User path directories and unrelated
executables are never written to the plist, and launchd never evaluates shell
startup files.
The capture shell runs in a dedicated process group; a timeout terminates the
group and closes capture pipes so background startup-script descendants cannot
extend the bound.
Each resolved executable is canonicalized and revalidated at selection and
publication: it and its relevant ancestry must remain root- or current-user-owned
and not group- or world-writable. A safe PATH directory therefore cannot smuggle
an unsafe target into the managed service through a symlink.

Client discovery is optional. A missing or unsupported shell, malformed output,
non-zero exit, or timeout produces an actionable warning and retains the
operational path, so it cannot make an otherwise-valid installation fail.
Selected client targets and rejected path-entry reasons are printed during
installation without printing unrelated environment variables. After installing
or moving a client, rerun `./ops/dogfood/install-macos.zsh` to refresh the shim
set. Refresh removes stale client entries atomically.

The checkout's `origin/main` is the release source. The Station data directory
must be an external absolute path; it is never copied, cleaned, versioned, or
placed below the supervisor/release directories.

The installer is for a fresh named instance and fails closed if any selected
loopback port is already occupied. The API port must be at most 65532, and the
API, terminal (`API + 1`), voice (`API + 2`), consent (`API + 3`,
station#3677), and UI ports must be five distinct ports; all five are checked
for unmanaged listeners. It never guesses that an unmanaged listener
is safe to stop or adopt. For an existing ad-hoc dogfood service, first stage
and verify the repository-owned supervisor on unused ports with a separate
temporary Station home, then perform a bounded migration that stops the old
service only after the new release is built and seeds `active`/`previous` state
before reusing the persistent home. Do not bypass the occupied-port check or
run two Station processes against the same `STATION_HOME`.

```bash
cd /absolute/path/to/station
STATION_HOME="$HOME/.station/instances/stable" \
  STATION_INSTANCE=dogfood \
  STATION_SERVER_PORT=18141 \
  STATION_UI_PORT=18000 \
  ./ops/dogfood/install-macos.zsh
```

The installer copies the checked-in runner into
`~/Library/Application Support/Station Dogfood/bin`, writes a mode-0600 JSON
config, configures only the Tailscale HTTPS root proxy to
`http://127.0.0.1:18000`, and installs
`~/Library/LaunchAgents/io.kontourai.station-dogfood.plist`. The user agent keeps
one supervisor process alive; that process reconciles local health every 30
seconds and survives an individual reconcile failure. Each tick holds one
exclusive lock per supervisor directory; an abandoned lock ages out after 30 minutes.
A lock whose recorded owner PID is still live is never stolen, regardless of
age.

Installation is transactional around host state. It snapshots the complete
Tailscale Serve configuration plus the previous runner, config, supervisor
state, private client shim set, plist, and loaded state before any mutation.
Failure stops the newly
active release, restores the prior process/state (or no process/state for a
fresh install), restores every file byte-for-byte with its owner/mode, and
verifies the full Serve and launchd state, including restoring the prior client
targets and plist `PATH`. Reinstall refuses semantic config
changes; those require the controlled migration path. The installer runs one
reconcile synchronously and requires state, local status provenance, and all
four loopback listeners to agree before loading the persistent LaunchAgent or
reporting success. Installation then requires launchd to keep the supervisor
running before it commits the transaction. That synchronous reconcile defers release pruning so every
SHA named by the pre-install state remains available for rollback. Only after
launchd bootstrap and loaded-state verification commit the transaction does a
best-effort prune keep the new `active`/`previous` pair.
If any managed-file restore fails verification, the prior LaunchAgent is not
bootstrapped. Station leaves launchd stopped and retains the transaction evidence
directory named in the critical diagnostic for manual recovery.
Rollback also requires positive proof that the exact LaunchAgent label is absent.
If `bootout` fails or bounded polling cannot prove absence, Station does not
replace the runner, helper, config, state, client shims, or plist and does not
bootstrap. The diagnostic reports launchd state as unknown, retains transaction
evidence, and gives the exact manual `bootout`/`print` confirmation required
before recovery.
If `origin/main` equals a snapshot-referenced previous SHA, staging uses a
distinct UUID release worktree. Dependency/build/attestation failure removes
only that temporary worktree; the snapshot release and its build manifest are
never rebuilt or replaced in place.

The support and log roots must be real, current-user-owned directories with
mode `0700`; symlinks, foreign ownership, and group/other access fail closed.
Supervisor state, config, lock, update log, runtime log, and launchd logs are
created with mode `0600` (the LaunchAgent carries umask `0077`). Lifecycle
locks require PID birth fingerprints for both lock and guard ownership. On
Windows, these are canonical round-trip UTC ISO creation times. Native handles
are normalized to CIM's microsecond precision before formatting, so persisted
lock identities and native process handles share one exact comparison value. A
crashed guard is reclaimed through uniquely named election claims before
quarantining the verified inode/content. Lease expiry triggers a PID/birth
liveness check but never revokes a matching live claimant; every destructive
step revalidates the elected claim, guard, and canonical inode. Thus an old
invocation cannot move or remove a replacement owner's lock and a crashed
claimant cannot block later recovery.

Promotion polling remains independently limited to once every five minutes, so
the faster health cadence does not increase normal GitHub traffic. The target
recovery budget is at most 60 seconds from a required listener loss through a
same-SHA restart and successful API, terminal, voice, UI, and tailnet checks.
Receipts reserve `intervalAllowanceMs: 15000` for the supervisor loop and
record both `preDetectionDurationMs` and `postDetectionDurationMs`;
`worstCaseEndToEndMs` is their sum and must remain at most 60000 before
readiness is committed.
A breach is an availability failure, not a healthy `current` check.

Same-SHA recovery uses one force-start lifecycle invocation. That invocation
proves and cleans the stale managed instance, rotates the runtime log only
after safe ownership proof, starts one replacement, and waits up to 20 seconds
for its exact authenticated boot identity. It does not use the slower aggregate
status route as the startup gate. PID birth-fingerprint mismatches and unrelated
listeners still fail closed.

Linux can invoke the same persistent Node supervisor from a user service,
using the same absolute config fields and restart policy. A systemd unit
is not host-verified or installed by this macOS recipe.

### Status and exact release receipt

```bash
SUPPORT="$HOME/Library/Application Support/Station Dogfood"
LOGS="$HOME/Library/Logs/Station Dogfood"
CONFIG="$SUPPORT/config.json"
RUNNER="$SUPPORT/bin/station-dogfood-reconcile.mjs"

node "$RUNNER" status --config="$CONFIG"
jq -r '.active.sha, .active.ci.url, .health.status, .previous.sha // "no previous release"' "$SUPPORT/state.json"
launchctl print "gui/$UID/io.kontourai.station-dogfood"
curl --fail --silent --show-error http://127.0.0.1:3141/api/system/identity | jq .
TAILNET_URL="$(jq -r .tailnetUrl "$CONFIG")"
curl --fail --silent --show-error "$TAILNET_URL/api/system/identity" | jq .
tailscale serve status --json | jq .
```

The `active.sha` must equal the provenance SHA returned by both identity
endpoints. `active.ci.url` is the accepted exact-SHA `CI` push-run receipt. A
pending, failed, absent, PR-only, different-workflow, or wrong-SHA run blocks
promotion.

### Logs and failure recovery

```bash
tail -F "$LOGS/station-update.log"          # successful reconcile outcomes
tail -F "$LOGS/station-runtime.log"         # managed Station server output
tail -F "$LOGS/station-runtime.log.previous" # immediately previous retained runtime log
tail -F "$LOGS/station-lifecycle.jsonl"      # correlated boot, intent, shutdown, and exit events
tail -F "$LOGS/station-launchd.log"         # launchd runner stdout
tail -F "$LOGS/station-launchd-error.log"   # actionable reconcile failures
jq '.health, .recoveryHistory[-1], .failedCandidates[-1], .active, .previous' "$SUPPORT/state.json"
```

A failed candidate is retained in `failedCandidates` with its phase and error.
The public UI proxy owns `GET /api/system/readiness`: it returns structured
`200 ready` only when the supervisor state and a short live API identity probe
agree. During backend loss it returns structured `503 unavailable`, browser
navigations receive a minimal recovery document instead of a healthy-looking
SPA shell, and failed backend proxy calls return structured 503 responses.

`health.status` is `unavailable` while a required listener is missing,
`recovering` while the exact recorded release is restarting, and `ready` only
after all four loopback listeners and tailnet provenance pass. The bounded last
20 `recoveryHistory` receipts retain the exact SHA, failed checks, detection,
attempt, and recovery/failure timestamps, outcome, observed reason, and
per-stage detection/stop/start/local/tailnet timing. SLA compliance is recorded
separately from runtime health: an authenticated local and tailnet recovery
remains `ready` when `withinBudget` is false, with `budgetExceededByMs`
preserved for follow-up instead of triggering another destructive restart. A
signal such as `SIGTERM` can be observed in the append-preserved runtime log;
the sender remains `unknown` unless the runtime or operating system supplies
identity evidence. The runtime log is private mode `0600`, appends across
normal restarts, and rotates only while Station is stopped after 10 MiB,
retaining the immediately previous secured log.
The bounded JSONL lifecycle journal correlates instance, exact SHA, random boot
ID, and backend PID across `started`, fsynced `stop_intent`, observed shutdown,
and process-exit events. It classifies expected promotion, operator stop,
expected recovery/rollback, unexpected signal, crash, and an unobservable
SIGKILL/native crash without inventing a sender. Public readiness responses
never expose the PID, paths, journal reason, or boot identity.
Journal reads and writes share a bounded cross-process ownership lock and read
the retained previous/current generations coherently. Stop intents carry a
short-lived operation ID and expiry plus a completed, already-absent, or failed
result; failed, orphaned, and expired operations cannot classify later exits as
expected.

The terminal and voice `/__station/health` upgrades are identity-only: they
close before registering a business client, allocating a terminal, starting a
voice provider, or creating a voice session. Managed instance state also pins
each backend/UI PID to its operating-system start token and command digest.
Station verifies that fingerprint immediately before signaling; absent
processes are already stopped, while reused PIDs and unrelated port owners are
reported and never killed. Recovery stops on failed proof before rotating logs
or starting another process. Modern instance state is an owned mode-0600 file
inside an owned mode-0700 directory; publication fsyncs the exact record and
directory, verifies the final inode and bytes, and guarded removal quarantines
only the securely read record.
For dependency/build failure, `active` was never stopped. For start, local
health, provenance, or tailnet health failure, `active` still names the prior
release after that release has been restarted and verified. If rollback itself
fails, the command names both failures and exits non-zero; inspect the runtime
and launchd-error logs before intervening. On the next supervisor health tick,
an unhealthy currently-active SHA is stopped if possible, restarted from its recorded built
release, and reverified.

Release storage is bounded to the healthy `active` and `previous` worktrees.
Failed candidates are removed after a successful rollback (their compact
failure receipt remains in state), and older release worktrees are pruned only
after a healthy promotion/current-release check. A rollback failure retains its
candidate for diagnosis because no healthy cleanup point has been established.
Before any candidate start, active recovery, or rollback, the runner rejects
symlinked/escaped release paths and requires a detached Git `HEAD` plus a valid
`main` build manifest whose SHA exactly matches the recorded release.

To trigger one non-destructive reconcile and inspect its exit status:

```bash
node "$RUNNER" reconcile --config="$CONFIG"
echo $?
```

### Removal

Removal deliberately leaves `STATION_HOME` and the Tailscale Serve
configuration untouched so shared data and unrelated handlers cannot be
deleted accidentally:

```bash
launchctl bootout "gui/$UID/io.kontourai.station-dogfood"
rm "$HOME/Library/LaunchAgents/io.kontourai.station-dogfood.plist"
rm -rf "$HOME/Library/Application Support/Station Dogfood"
```

Then inspect `tailscale serve status --json`. Remove the HTTPS handler only if
it still points at this instance and no other required handler shares that
listener. Never use a blanket `tailscale serve reset` as dogfood cleanup.
