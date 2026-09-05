# Public HTTPS for a single-owner Station

This optional Compose overlay puts one Station behind Caddy at one explicit
hostname. It reuses the root Station service and persistent volumes. It does
not provision DNS, change cloud firewall rules, enroll users, create customer
accounts, or turn one Station home into a multi-tenant store. For a managed
pilot, keep each customer's runtime, home, workspace, credentials, and network
boundary separate. Companies can operate the same profile in their own cloud.

The default deployment remains private. Applying this overlay is an explicit
public-ingress operation: Caddy publishes TCP 80 and 443, while the Station
service publishes no host ports. Do not attach untrusted containers to this
Compose network or mount another customer's volumes into it.

## Prepare

Requirements: a reviewed Station container image pinned by digest, Docker
Compose 2.24 or later, a DNS hostname you control, a persistent host, and existing
operator access through Station's normal enrollment flow. The proxy image is
pinned to an official Caddy image index supporting multiple architectures; review
its release and digest when updating. The overlay requires an explicit, unique Compose project name. Keep it stable
to retain the existing volumes; never reuse it for a different customer.

From the repository root, prepare a private `deploy/public-ingress/.env` file
(the repository ignores `.env` files):

```dotenv
COMPOSE_PROJECT_NAME=acme-station
STATION_IMAGE=ghcr.io/your-company/station@sha256:REPLACE_WITH_REVIEWED_DIGEST
STATION_PUBLIC_HOST=station.example.com
```

Use a bare DNS hostname without a scheme, port, path, wildcard, or credentials.
The Station allowed origin is derived from that one hostname. The digest above
is a placeholder, not a runnable image. No cloud or agent credentials belong in
this file. Keep your selected workspace mount configuration when adding the
overlay to an existing deployment.

Render and inspect the complete result before publishing:

```bash
docker compose --env-file=deploy/public-ingress/.env -f docker-compose.yml \
  -f deploy/public-ingress/compose.yaml config
```

Check the selected images, exact hostname, retained volumes and workspace mount,
no Station host ports, and only the proxy's 80/443 bindings. Both Compose files
must be passed in this order for each lifecycle command; relative paths resolve
from the repository-root file. The required-variable checks reject missing
configuration, but do not verify DNS ownership, image provenance, or that a
supplied image reference is a digest. Those are operator prerequisites.

## Publish and verify

Before starting, point the hostname's A/AAAA records at this host and review its
cloud and host firewall rules for TCP 80/443. Remove a stale AAAA record if the
host cannot serve IPv6. Keep backend and administration ports private. Caddy's
[automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https)
include reachable challenge ports and writable persistent certificate storage.
Use a staging CA while experimenting with public issuance to avoid production
rate limits. This profile uses the normal production CA defaults.

After reviewing the public exposure and DNS destination:

```bash
docker compose --env-file=deploy/public-ingress/.env -f docker-compose.yml \
  -f deploy/public-ingress/compose.yaml up -d
docker compose --env-file=deploy/public-ingress/.env -f docker-compose.yml \
  -f deploy/public-ingress/compose.yaml ps
```

Visit `https://station.example.com` and verify the certificate hostname and
trusted chain without bypassing TLS checks. Confirm HTTP redirects to HTTPS,
`/__station/identity` matches the selected build, and an unauthenticated request
cannot create a Project. Use normal owner-approved pairing, then exercise a
workspace read, an SSE-backed live view and a terminal/WebSocket journey. A
healthy internal container alone does not prove public ingress or enrollment.

Caddy handles WebSocket upgrades and automatically flushes SSE responses.
The profile retains normal backend cancellation when a client disconnects; it
does not set negative `flush_interval`, which would keep backend requests alive. It strips unrelated identity headers while preserving
Station's own authorization and cookies. It does not configure header-based
identity, company SSO, or a proxy-auth bypass. See the
[reverse-proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Operate and recover

Keep `ingress-data` persistent: it contains certificate account/key material and
must be private, backed up and restored deliberately. Do not share it across
customer deployments. Caddy renews certificates; monitor its logs, expiry and
external reachability. Normal proxy logs are bounded by Docker's local driver;
HTTP access logging is not enabled by this profile.

Retain both Compose files when recreating the service. Inspect backups of the
Station home and workspace separately under their existing lifecycle contracts.
Do not use `down -v` during an upgrade or rollback. To stop public ingress while
keeping data and the backend intact:

```bash
docker compose --env-file=deploy/public-ingress/.env -f docker-compose.yml \
  -f deploy/public-ingress/compose.yaml stop ingress
```

Rollback image references only to reviewed compatible versions. Switching back
to root Compose alone changes port exposure; inspect the resulting configuration
before applying it. Monitor actual CPU, RAM, disk and agent workload before
sizing a small VM. This overlay is not an autoscaler, billing/control plane,
hostile-workload sandbox or multi-tenant application isolation proof.


## Qualify the proxy locally

With Node 24, Docker, and the repository's managed dependencies installed:

```bash
npm run dependencies:ci
node deploy/public-ingress/smoke.mjs
```

This starts a disposable HTTP protocol fixture and the pinned Caddy image on a
private test network, publishes only ephemeral loopback ports, and verifies the
local TLS certificate using its generated CA explicitly. It does not install a
CA into the host trust store, modify DNS, request a public certificate, or start
the GCP VM. It exercises composed port isolation, redirects, header stripping,
authorization forwarding, SSE delivery before stream completion, client-disconnect cancellation, and WebSocket
upgrade. Each created container/network carries an ownership label and is
removed after the run. Public CA issuance, real-domain reachability and customer
workload capacity still require deployment-specific acceptance.
