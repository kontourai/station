# Self-hosted routing broker

Status: bounded source implementation for local qualification. This is not a public listener or a production hosting recommendation.

The current private-file custody implementation is POSIX-only. Windows startup refuses with `self_hosted_broker_private_custody_unavailable_on_windows` until the broker adopts an audited DACL owner; it never falls back to unchecked Windows paths.

The self-hosted broker carries versioned connection metadata only. It never receives Station operator credentials, account credentials, Project data, plugin data, application frames, or execution authority. Station still signs the opaque connection proof and enforces Device, account, and Project policy at the endpoint.

Run `npm run broker:self-hosted -- init /absolute/private-init-config.json` once for a routing generation, then run `npm run broker:self-hosted -- serve /absolute/private-serve-config.json`. The configuration and credential output must be owner-only files in owner-only directories. The database path, credential path, loopback port, and every provisioned Station/enrollment/routing-generation/browser-Origin scope are explicit. A routing generation is independent of Station's connection-signing key generation and cannot rotate or approve endpoint trust. Port `0` requests an owned ephemeral listener; ports 3000 and 3141 are refused.

Initialization and serving use separate private configuration files. Initialization contains exactly one provision record:

```json
{"version":"station-self-hosted-broker/v1","databasePath":"/srv/station-broker/state.sqlite","credentialsPath":"/srv/station-broker/station-a.credentials.json","port":0,"provision":[{"stationId":"station-example","enrollmentId":"enrollment-example","routingGeneration":1,"browserOrigin":"https://station-client.example"}]}
```

Serving points at the same database and provisions nothing:

```json
{"version":"station-self-hosted-broker/v1","databasePath":"/srv/station-broker/state.sqlite","credentialsPath":"/srv/station-broker/unused.json","port":0,"provision":[]}
```

`init` publishes the private credential bundle before committing its hashes to SQLite. A retry reuses only an exact existing bundle for the same scope and routing generation. A conflicting or older routing generation refuses. `serve` never provisions or rotates credentials.

Connector and routing credentials are separate 256-bit secrets. Every request must match the credential direction, Station, enrollment, routing generation, and configured Origin. Browser preflight admits only an active configured Origin and the three required headers. Provisioning leaves a Station `offline`; an authenticated connector registration makes the current routing generation `online` for 30 seconds.

This tranche provisions one operator-owned routing credential for one Station and browser Origin. It is not per-Device enrollment or revocation, does not bootstrap an account, and does not complete routine fresh-client onboarding. The outbound Station connector and its independently approved connection-signing trust are the next consumer; the broker cannot mint or replace either authority.

Connection offers use a caller-chosen client ID and nonce, expire after 30 seconds, and remain replay tombstones for five minutes. Each Station may hold 32 live offers and the broker 1024. Offer and answer SDP are capped at 128 KiB; the opaque Station proof uses its owning 4 KiB contract limit. A connection accepts one answer. Withdrawal and a newer routing generation invalidate pending work without changing Station signing-key trust. Lease renewal uses an explicit revision CAS.

The service binds only to loopback. TLS termination, reverse-proxy hardening, public deployment, production connector lifecycle, and application transport remain later integration work under #1963.

## Connector lifecycle library

`SelfHostedBrokerClient` fixes one configured broker origin and refuses redirects, oversized responses, and response fields outside the v1 contract. `SelfHostedBrokerConnector` registers, renews by revision, polls at most 32 offers, answers once, and withdraws. Before reading or answering it requires a caller-owned current `ApprovedStationConnectionTrust` for the exact Station and enrollment, and rechecks that descriptor around asynchronous answer construction.

This library does not launch a connector, integrate `StationRuntime`, open WebRTC, distribute routing credentials, enroll a Device, or approve a signing key. Its answer callback remains an uncomposed capability until the Pion adapter has a reviewed production owner.
