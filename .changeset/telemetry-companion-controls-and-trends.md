---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add scoped Companion installation, start/stop, retained-operation recovery and received-product-trends clients. Queries partition by captured Station authority, validate bounded responses and keep current runtime/storage observations separate from historical operation receipts. Mutations do not retry automatically.

Add additive preparation metadata, managed lifecycle DTOs and a bounded product-trends contract with a pure decoder. Product aggregates preserve retention, producer-clock time and unknown delivery coverage; they do not represent personal usage or billing. Engine and outcome dimensions must match the existing disclosure inventory.

These APIs require a compatible server. Installation and start admission still require an authenticated architecture-qualified artifact and explicit operator intent. This change does not issue that qualification, enable sending, acknowledge disclosure or grant personal source access.

Add the metadata-only `AnalyticsSourceEnrollmentIntent` DTO for preparing or cancelling a personal source enrollment proposal. Its destination-verification and export-authority flags remain false; it neither issues a credential nor enables synchronization.

Add public receiving-key candidate contracts for person/tenant-scoped analytics key slots. Candidates bind a source proposal and return signed public keys only; signature integrity is not remote-person authentication, source approval or an export grant. Source credential delivery and synchronization remain separate work.

Add `AnalyticsSourceApproval` for recorded source-user consent. Personal reviews use the existing distinct-origin consent channel with a requester-bound decision policy and exact source/key/policy revalidation. Recorded approval remains separate from source credential issuance and export activation.

Add encrypted source credential delivery and receiving-custody DTOs. Approved source policies produce idempotent recipient-bound ciphertext with hash-only source storage; receiving APIs return metadata and retain plaintext privately. These stages do not activate source export or verify source identity.

Add a receiving delivery-possession proof and a single scoped source export endpoint. Each read checks the current approved policy, Device/account standing, tenant, owner set and credential hash, with grant-bound continuations and queued-response revocation. The static proof grants no general API identity; receiving source verification and automatic synchronization remain separate work.

Add explicit same-policy source credential rotation with expected-revision checks, bounded operation replay custody and idempotent encrypted delivery recovery. Rotation invalidates previous export credentials, proofs, continuations and queued responses; receiving materialization refuses rollback. It does not extend or broaden source permission.

Add explicit receiving-source address confirmation through personal consent and a bounded HTTPS canonical-page reader. Core retains the narrow credential privately, checks source identity before sending it, validates pages through a shared pure contract decoder and rechecks source/receiving authority before queued release. Source rotation clears confirmation. This adds no durable index, background sync or installed/native qualification.

Journal private source deletion and owner/tenant scope changes transactionally with their EventStore mutations. Bound retained invalidations to 10,000 entries, refuse changed/missing evidence, and fence canonical continuations plus queued source/receiving pages against destructive changes. The source revision header is distinct from credential rotation; old opaque cursors require a fresh first page. Companion invalidation replay and restored-home generation fencing remain separate work.

Add grant-scoped retained invalidation replay with bounded fixed-head pages, exact owner/tenant selection, generation-bound cursors and explicit 410 responses for pruned checkpoints. Epoch changes, rotation, revocation and lost journal evidence refuse instead of advancing a replica blindly. Companion materialization remains separate work.

Add strict private usage commit/checkpoint/receipt contracts and isolated companion storage. An operator service provisions only an empty key hash; private capabilities alone bind/read data. Page, checkpoint and receipt commit atomically with stale-writer/incarnation checks and idempotent lost-reply recovery. Retained storage is not current source authority; Core sync, invalidation application, current Insights and deployment qualification remain separate work.

Add page-bounded Core private usage capture and operation-ID recovery. It derives a target/grant-specific private capability from owned analytics custody, rechecks source/person access before writes, and keeps keys and staged summaries out of API results. Temporary outbox bodies expire while content-free recovery intent remains. Historical capture status does not establish a live index; invalidation application and current Insights remain separate work.

Add private companion invalidation commit/checkpoint/receipt contracts and a schema-v2 migration. Withdraw older captured facts, preserve newer thread incarnations, advance replay and recovery evidence atomically, and reject late older writes across windows. Existing data upgrades without assuming deletion history was applied. Core replay orchestration and live indexed query qualification remain separate work.

Connect Core sync to bounded source invalidation replay before advancing fact pages. Persist private replay intent, recover lost replies by the original operation, and recheck person/source access at the final write. Return replay progress without exposing facts or credentials; retained gaps refuse reconciliation, and completed mutations restart the selected snapshot. Current Insights, restore fencing and deployment qualification remain separate work.
