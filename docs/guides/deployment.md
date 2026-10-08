# Deployment Guide

This page distinguishes checkout development, a container template, hosted
foundations, and a macOS dogfood supervisor. Choose the owning path before
running commands. Recipes change host state; source inspection or fixture PASS
is not proof that a particular image, network, cloud account or device is ready.

The [CLI reference](../reference/cli.md), [authentication guide](deployment-authentication.md),
and [monitoring guide](monitoring.md) own their detailed contracts. The source
review here covers the named deployment paths; historical platform observations
and unrun installer/rollback scenarios retain their separate evidence limits.

## Local Development

Deployment describes how a Station instance is run and reached; it does not
assign Project membership, room authority, or execution consent. See
[Station topology](../design/station-topology.md) for the role/identity
boundaries that deployments must preserve.

```bash
./station start --instance=dev-review --temp-home --port=3242 --ui-port=5274
# For a deliberate reset of this disposable development instance only:
./station start --instance=dev-review --temp-home --clean --force --port=3242 --ui-port=5274
```

Use unused ports and a separate home for development. `--clean` deletes the
selected home and build outputs; it is not just a rebuild flag. The lifecycle
owner refuses default-home cleaning without its additional explicit override.
Do not apply that override to make a disposable recipe work on a real home.

## Docker Production

`station service run` claims the home atomically before starting Station, even
on a fresh home without `service install`. It records the supervisor's PID and
birth fingerprint as a service owner. If Desktop or another live service holds
the home, the supervisor stays alive without starting Station and polls with
backoff capped at 30 seconds; it starts after the owner is gone. Lost ownership
at readiness or on an existing five-second health tick stops and reaps Station
before returning to that wait. Each tick checks the service id, type, PID and
birth without renewing the claim. Only a successful read showing a missing or
different owner triggers recovery; an unreadable tick read keeps Station
running and retries next tick. Startup claim read errors still exit nonzero.
Recovery waits for a live replacement service even at the same registry id.
Retraction clears only the supervisor's own PID and birth. Existing Dockerfile
and Compose commands need no policy-registration step.

Direct `command-station.js` launches remain unfenced and can serve the same
writable home as a registry claimant. When bound to `0.0.0.0`, they are reachable
through container networking and any published or proxied ports. The recipes
and historical qualifications below are not current image or cloud proof.


The default Compose mapping exposes port 3000. The lifecycle UI proxy serves
the UI, HTTP API, event streams, identity and Device pairing through that origin.
Dedicated terminal and voice listeners are separate; this proxy has no WebSocket
upgrade bridge to them, and the default mapping does not publish their ports.
The image runs as Node's unprivileged UID/GID `1000` and persists its home
in the `station-data` volume.

```bash
docker compose pull
docker compose up -d
```

Open <http://localhost:3000>. The workspace is mounted at `/workspace`. By default it is the
`station-workspace` named volume, not a host bind mount or the directory
containing the Compose file. Bind an explicit project
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

On successful completion the browser receives a revocable HttpOnly Device
session and can reconnect. A paired browser is not automatically an approver:
approval requires the route's current operator/local-home authority or an
explicitly promoted `access:approve` Device. Use the connection manager's
**Paired devices** view to revoke access. Registration, successful enrollment
and an authenticated subsequent request are separate observations.

The production Compose file is intentionally not a source-mounted development
stack. Use `./station start --temp-home` for local development so credentials
and hot reload stay outside the published image contract.

## Monitoring Stack

The standalone stack in `monitoring/` is independently managed from the
production Station container. It maps OTLP HTTP to 4318, Prometheus to 9090,
Grafana to 3333 and Jaeger to 16686. The checked-in template uses mutable image
tags, host port bindings and a development Grafana password/anonymous viewing;
it is not a hardened public monitoring deployment.

Read [the monitoring guide](monitoring.md) before enabling the stack or setting
`OTEL_EXPORTER_OTLP_ENDPOINT`. `localhost` in a container names that container,
not an independently launched collector. Choose the intended reachable endpoint
and private exposure explicitly. Configured export is not collector receipt;
the guide records the startup meter-binding limitation and separates telemetry
from durable product outcomes.

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
running the [home backup and restore commands](../reference/cli.md#home-backup)
from a matching source checkout. These local archive verbs are not a promise
that the published client can restore a server home:


```bash
./station home backup --home=/srv/station/source-home --output=/srv/backups/station-drill --json
./station home restore --from=/srv/backups/station-drill --home=/srv/station/recovery-home --confirm --json
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
`station-home-recovery.json`; the CLI, JSON restore receipt and connected
browser banner disclose recovery from a copy. The browser uses the current
Station's status query and clears a prior host's notice when switching hosts. Retain that record when operating the recovered environment. It is
provenance metadata, not proof of source shutdown or a transfer certificate.
Keep one active writer by operational control; automatic cross-host handoff,
witness-less fork presentation, and per-tenant recovery require separate
verification before offering those guarantees to customers.

## Reverse Proxy

For a complete optional Compose proxy profile, see [Public HTTPS ingress](../../deploy/public-ingress/README.md). It keeps the root deployment private unless explicitly applied and removes direct Station host ports.

The following example terminates TLS for the UI and HTTP/SSE API through the
lifecycle proxy. It does not expose the dedicated voice/terminal listeners:

```nginx
server {
    listen 443 ssl;
    server_name station.example.com;
    # Supply the reviewed certificate/key and the rest of your TLS policy.

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
    }
}
```

Upgrade headers alone do not route a request to another listener. In the current
voice path, the client asks the backend for its voice port and connects to that
port on the selected API host. A secure public page therefore needs a supported
secure route to that listener; the single-port example above does not supply it.
[#2769](https://github.com/kontourai/station/issues/2769) tracks a verified ingress
contract and the adjacent terminal qualification. Preserve authentication,
origin, scope and instance checks when designing that route.

Station's browser-facing SSE routes send `X-Accel-Buffering: no` so nginx-family
proxies deliver chat tokens and operational events immediately. Preserve that
response header.

Station also sends `x-station-envelope: 1` on every JSON response it writes
itself. Clients use it to tell Station's own refusal from an error a proxy
answered: a queued chat message is dropped only on Station's refusal. Pass the
header through unchanged, and do not add it to responses the proxy generates.
A proxy that removes it leaves clients deciding by the body's shape, as they
did before the header existed.

`proxy_buffering off` is not merely defense in depth: the station-control MCP
endpoint streams through a handler-built response whose headers Station does not
set, so it does **not** carry `X-Accel-Buffering`. Without `proxy_buffering off`,
a long-running MCP tool call's progress notifications can stall behind the proxy.
Keep the directive if you use that endpoint.

Configure your public TLS origin normally; this image does not set a generic
trusted-proxy mode.

## Hosted tenant ingress (foundation only)

This is a pre-production request-context foundation, not a hosted-service
installation recipe. For that foundation, publish each tenant through Station's
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

That tenant is an exact deployment/customer authority selected from the request
host. It is not a person, organization membership, account, or capability
grant; see [Station topology](../design/station-topology.md).

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

Station discovers Projects from `<STATION_HOME>/projects/<slug>/project.json`.
Seed only an initialized home with the current schema. For a manual deployment,
initialize an isolated home through the supported lifecycle, stop its writers,
then place valid Project records and any layout files before the next start.
An already-qualified current-schema home archive is another starting point;
follow the recovery procedure rather than inventing schema-marker bytes.

A markerless directory containing Projects or legacy layouts is **not** a valid
fresh home. The [schema gate](../../packages/shared/src/station-home-schema.ts)
runs in both the CLI lifecycle and server entry before application migrations.
It refuses those directories instead of treating their contents as disposable
bootstrap scaffolding. Copying a Project is neither a schema migration nor a
Project membership grant.

After schema admission, the Project/layout portion of
[runStartupMigrations](../../src-server/domain/migration.ts) returns when
`projects/` already exists. Earlier orchestration migration and default-provider
initialization still run; this is not a no-write guarantee for the home.
The helper also retains legacy layout-to-Project conversion for an admitted
home. That leaf behavior does not make an arbitrary old, markerless home
upgradeable by starting Station.

A valid new home without Project or legacy layout records starts with zero
Projects and the Home actions for direct chat or opening a local project.
[Distribution Profiles](./distribution-profiles.md) covers starter-layout
catalog policy, which is separate from provisioning saved Project records.

## Headless Station on a Windows host over SSH

Use the owning installed-service or checkout lifecycle path, not the desktop
GUI executable as a headless server command. The current checkout's
[service command](../../packages/cli/src/commands/service.ts) has Windows,
launchd and systemd adapters. Its
[Windows adapter](../../packages/cli/src/commands/service-windows.ts) owns Task
Scheduler registration, the command wrapper, process identity and trusted paths.
The published CLI can control an existing installed service with
`service status|start|stop`; installing or removing a service needs the
lifecycle CLI of a checkout or a prebuilt server archive, and the
[`service` reference](../reference/cli.md#service) records what each kind of
unit runs. Follow [CLI availability](../reference/cli.md#invocation)
and inspect the intended instance/home before changing a service.

Earlier manual SSH notes used `node dist-server/command-station.js` from an
installed application directory and an ad-hoc highest-privilege scheduled task.
That was an installation-specific observation, not a portable current package
contract. Do not assume a present release contains that path, a separate Node
installation, or the same process-detachment behavior. A source server's schema
lookups depend on its configured working directory; the service wrapper owns
that detail. This review did not run a Windows installer or SSH session.

Reachability remains separate from authentication. Inspect the service's actual
bind address and port, then qualify the intended route from another Device.
Firewall changes require the operator's chosen interface/source restriction;
opening a port does not pair the Device. The versioned public handshake can
confirm an answering Station, while a protected request without credentials is
expected to be refused. A failed `curl` transport/status `000` can mean DNS,
TLS, refusal, timeout or routing failure; it is not a unique firewall diagnosis.

Do not replace an existing managed registration or remove a firewall rule by a
generic display name. Use the exact instance/registration owner and current
[service recovery guidance](native-shell-verification.md). Packaged Windows
behavior, cross-Device reachability and authenticated terminal/voice operation
remain separate qualification steps.

## Private tailnet dogfood on macOS

The legacy dogfood supervisor below is separate from the desktop channel
service and ordinary `station service` commands. Its staged dependency install
still uses `npm ci`; the current checkout uses managed pnpm and has no root npm
lockfile. Treat current-revision promotion as unqualified until that mismatch
is corrected and exercised. The retained rollback description is not a claim
that this audit installed or recovered a live service.

### Channel desktop apps: ports, homes, and targeting

The macOS desktop ships as up to three coexisting channel apps — `Station.app`
(stable), `Station Beta.app`, `Station Nightly.app`. Each channel has a
default server port — stable `18141`, beta `28141`, nightly `38141` — carried
in the app's **persisted service manifest** (`src-desktop/src/service_state.rs`
reconciles `manifest.server_port` against local state), so the port is stable
across restarts and self-updates in practice, but it is configuration, not a
compile-time constant: trust the manifest/live process, not the number.

Default homes are channel-qualified under `STATION_ROOT/instances/` (for
example `stable`, `beta`, `nightly`); an explicitly configured home or persisted
service manifest can choose another admitted path. The old `~/.station-nightly`
example described one deployment, not the current universal Nightly home.
Inspect the owning service manifest and instance status rather than guessing
from a directory or dumping a process's complete environment, which can contain
credentials. [service_state.rs](../../src-desktop/src/service_state.rs) owns
native home admission and [release channel ports](release-channel-ports.md)
records the default port families.

Saved Stations can target a loopback channel by name. Use an actually published
CLI version/tag; the name of a desktop release channel does not prove a matching
npm dist-tag exists. Local pairing offer/access list/approve/deny operations are
supported by the current published CLI as well as the checkout launcher, but
still require the exact existing local home and a proved loopback Station.
A remote endpoint or a saved pairing entry without `localService.baseDir` does
not provide that home. Other host lifecycle/security verbs have their own
[distribution boundary](../../packages/cli/src/distribution.ts).

For a non-default instance, select the actual home and loopback endpoint:

```bash
STATION_HOME=/absolute/path/to/the/selected/home \
  ./station environment access list --api-base=http://127.0.0.1:38141
STATION_HOME=/absolute/path/to/the/selected/home \
  ./station environment access approve <request-id> --api-base=http://127.0.0.1:38141
```

The example port is the Nightly default, not discovery. The
[command implementation](../../packages/cli/src/commands/environment.ts) resolves
saved Station targets and verifies local identity/proof before sending the host
credential.

When exposing a lifecycle-managed instance over the tailnet, map its configured
UI proxy port, not an inferred API-plus-offset port. The dogfood installer below
targets `uiPort`. A native channel's service layout must be inspected separately.
Paired Devices save the public endpoint, so changing an established public port
requires an explicit reconnection plan:

```bash
tailscale serve --bg --https=<public-port> http://127.0.0.1:<configured-ui-port>
tailscale serve status                                              # what fronts what
curl --silent --show-error https://<device-fqdn>:<public-port>/api/system/status   # FQDN as shown by `tailscale serve status`
# authentication_required confirms a refusal, not workload health or readiness
```

#### Reaching the consent origin over HTTPS

Consent decisions are served by a separate listener (`API + 3`, or
`STATION_CONSENT_PORT`) so a decision page is a different browser origin from
the app. By default its review URLs are plain `http://<host>:<consent port>`,
which a remote browser on the tailnet cannot use as a secure context. To issue
an HTTPS review URL, add a second Tailscale Serve mapping from an HTTPS name to
the **consent** port (not the UI port), and tell Station the exact origin:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:<consent-port>
STATION_TRUSTED_CONSENT_ORIGIN=https://<device-fqdn>:8443
```

The value must be an exact `https` origin on a DNS name: no path, trailing
slash, trailing-dot host, port 0, userinfo, wildcard or IP address (WebAuthn relying-party IDs must be
domains, so an IP-only Station gets no HTTPS consent origin). Station checks it
at startup and refuses to start on a malformed value instead of falling back to
`http`. When set, review URLs use that origin, and the consent listener accepts
a decision from it when the request `Host` is that name and the browser's
`Origin` header equals that origin exactly; any other origin is still refused.
This is in addition to the existing port-pinned
`http://<host>:<consent port>` path, which keeps working. The HTTPS consent
name must be the same hostname as the app's (with Tailscale, both are the device
FQDN): the consent session cookie is host-scoped and is not sent across
hostnames, so a different name fails closed with `unauthenticated`. Unset, the
behavior is unchanged. The origin is never added to `ALLOWED_ORIGINS`.

With this origin set, a paired browser can also enroll an operator passkey; see
[Enroll an operator passkey](operator-passkeys.md).

#### Troubleshooting the pairing path

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Device stuck "waiting for approval"; host sees no request | Serve mapping fronts a port nothing owns (dangling proxy) | Inspect the curl transport error and `lsof -nP -iTCP:<local-port> -sTCP:LISTEN`; status 000 alone is not a diagnosis |
| Device: "isn't the one this device paired with" | The public endpoint fronts a different instance (another channel, a rebuilt home, or a stray locally-started server on that port) than the one the device paired with | Confirm which pid owns the mapped local port, then the owning service/instance record and configured home |
| CLI: "loopback Station identity does not match this local Station home" | `STATION_HOME` doesn't match the server behind `--api-base` | Read the owning service's configured home; never guess from directory names |
| Buttons in the device's connection UI appear dead | A failed request, unavailable endpoint or UI failure may be involved; the old station#4475 incident is not a universal diagnosis | Same dangling-proxy check as row one |
| A CLI invocation boots a whole runtime and collides on ports | `dist-server/command-station.js` is the **server** entry, not an operator CLI — use the repo launcher `./station` | — |
| A mystery local server answers Station endpoints | Another legitimate instance or an abandoned process may answer the same probe | Confirm exact instance, PID birth and service ownership before any stop; PPID 1 alone proves neither abandonment nor cleanup authority |


The repository-owned dogfood supervisor keeps one named Station instance on
the exact `origin/main` commit whose GitHub Actions `PR: CI` **push** run completed
successfully. Its staging code creates a detached release and currently calls
legacy `npm ci` plus `./station build` before stopping the active release.
That dependency command is not the repository's managed pinned-pnpm setup path;
the current root has no npm lockfile. This supervisor's successful staging on a
current revision needs qualification/correction before use, not a claim inferred
from its older fixtures. [#2776](https://github.com/kontourai/station/issues/2776)
tracks that correction. Promotion binds the configured API, terminal, voice,
consent and UI listeners to `127.0.0.1`, verifies the exact build SHA locally and through
Tailscale Serve HTTPS, and only then commits `active`/`previous` state. A build
failure leaves the active process alone; a post-stop failure restarts and
health-checks the previous built release.

This recipe is private-tailnet only. It refuses an existing conflicting HTTPS
root handler or Funnel, never enables Funnel, never runs `tailscale serve
reset`, and leaves unrelated Serve ports and paths in place.

Tailscale reachability is not authorization. On a direct non-loopback Station
connection, protected requests require an approved device session or the
environment credential. Public handshake, identity/proof and bootstrap routes have explicit
bounded exceptions; the [authentication guide](deployment-authentication.md)
owns that route inventory. Bootstrap a phone without copying a reusable
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
rotation preserves the environment ID and replaces the operator credential.
It does not itself revoke separately paired Device grants. Environment reset
has a different identity/device-grant boundary; inspect the owning operation
before using either as a recovery step. See the
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
one supervisor process alive; that process reconciles local health with a 15-second delay between completed ticks and survives an individual reconcile failure. Each tick holds one
exclusive lock per supervisor directory; an abandoned lock ages out after 30 minutes.
A lock whose recorded owner PID is still live is never stolen, regardless of
age.

The installer stages a transaction around host state. It snapshots the complete
Tailscale Serve configuration plus the previous runner, config, supervisor
state, private client shim set, plist, and loaded state before any mutation.
Rollback attempts to stop the newly
active release and restore the prior process/state (or no process/state for a
fresh install), restores every file byte-for-byte with its owner/mode, and
verifies the full Serve and launchd state, including restoring the prior client
targets and plist `PATH`. Reinstall refuses semantic config
changes; those require the controlled migration path. The installer runs one
reconcile synchronously and requires state, local status provenance, all five
listener owners and the API/terminal/voice/UI probes to agree before loading the persistent LaunchAgent or
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
`worstCaseEndToEndMs` adds those two durations and the interval allowance, then
compares the total with the 60000-ms target. The runner can record runtime health
as `ready` after successful recovery even when `withinBudget` is false; the
budget breach remains a separate failed availability objective, not a reason
to restart a recovered process again.

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
UI_PORT="$(jq -r .uiPort "$CONFIG")"
curl --fail --silent --show-error "http://127.0.0.1:$UI_PORT/__station/identity" | jq .
TAILNET_URL="$(jq -r .tailnetUrl "$CONFIG")"
curl --fail --silent --show-error "$TAILNET_URL/__station/identity" | jq .
tailscale serve status --json | jq .
```

The `active.sha` must equal the provenance SHA returned by both identity
endpoints. `active.ci.url` is the accepted exact-SHA `PR: CI` push-run receipt. A
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
`200 ready` only when the supervisor state and a live API identity probe agree.
The probe waits 2.5 seconds by default; a caller with a longer deadline states
it in the `x-station-readiness-budget-ms` request header, a whole number of
milliseconds of up to nine digits, clamped to 100 ms–40 s (anything else falls
back to the default),
which Station's own status and supervisor probes do. A caller that disconnects
releases the proxy's backend check immediately. During backend
loss — a refused or failed connection, a non-200 answer, or an answer carrying
a different boot identity, which fails at once without waiting on the budget —
it returns structured `503 unavailable`, browser navigations receive a minimal
recovery document instead of a healthy-looking SPA shell, and failed backend
proxy calls return structured 503 responses. When the backend accepted the
connection but did not confirm its identity within the budget, it returns
structured `503 {"ready":false,"status":"degraded"}`: still not ready, because
a busy backend and a wedged one look the same from here, but browser
navigations keep receiving the app instead of the recovery document.

`health.status` is `unavailable` while a required listener is missing,
`recovering` while the exact recorded release is restarting, and `ready` only
after all five listener owners and the API/terminal/voice/UI probes and tailnet provenance pass. The bounded last
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

To request one reconcile, first review the selected config and current state.
This is a mutating operation: it may fetch/build, stop/start, promote/roll back
or prune releases. Use `status` for a read-only inspection. After an authorized
reconcile, inspect its exit status:

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
# After verifying the supervisor and its managed runtime are stopped,
# archive/remove only this installation's confirmed support directory.
```

Stopping the LaunchAgent alone is not proof that every managed child stopped.
Confirm the exact lifecycle instance and release worktree ownership before
removing files; preserve rollback/diagnostic evidence if shutdown is uncertain.
Then inspect `tailscale serve status --json`. Remove the HTTPS handler only if
it still points at this instance and no other required handler shares that
listener. Never use a blanket `tailscale serve reset` as dogfood cleanup.
