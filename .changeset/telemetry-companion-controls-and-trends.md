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
