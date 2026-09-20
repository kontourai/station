# Self-hosted routing broker

Status: bounded source implementation for local qualification. This is not a public listener or a production hosting recommendation.

The self-hosted broker carries versioned connection metadata only. It never receives Station operator credentials, account credentials, Project data, plugin data, application frames, or execution authority. Station still signs the opaque connection proof and enforces Device, account, and Project policy at the endpoint.

Run `npm run broker:self-hosted -- init /absolute/private-config.json` once for a routing generation, then run `npm run broker:self-hosted -- serve /absolute/private-config.json`. The configuration and credential output must be owner-only files in owner-only directories. The database path, credential path, loopback port, and every provisioned Station/enrollment/routing-generation/browser-Origin scope are explicit. A routing generation is independent of Station's connection-signing key generation and cannot rotate or approve endpoint trust. Port `0` requests an owned ephemeral listener; ports 3000 and 3141 are refused.

`init` publishes the private credential bundle before committing its hashes to SQLite. A retry reuses only an exact existing bundle for the same scope and routing generation. A conflicting or older routing generation refuses. `serve` never provisions or rotates credentials.

Connector and routing credentials are separate 256-bit secrets. Every request must match the credential direction, Station, enrollment, routing generation, and configured Origin. Browser preflight admits only an active configured Origin and the three required headers. Provisioning leaves a Station `offline`; an authenticated connector registration makes the current routing generation `online` for 30 seconds.

Connection offers use a caller-chosen client ID and nonce, expire after 30 seconds, and remain replay tombstones for five minutes. Each Station may hold 32 live offers and the broker 1024. Offer and answer SDP are capped at 128 KiB; the opaque Station proof is capped at 256 KiB. A connection accepts one answer. Withdrawal and a newer routing generation invalidate pending work without changing Station signing-key trust. Lease renewal uses an explicit revision CAS.

The service binds only to loopback. TLS termination, reverse-proxy hardening, public deployment, production connector lifecycle, and application transport remain later integration work under #1963.
