---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add scoped Companion installation, start/stop, retained-operation recovery and received-product-trends clients. Queries partition by captured Station authority, validate bounded responses and keep current runtime/storage observations separate from historical operation receipts. Mutations do not retry automatically.

Add additive preparation metadata, managed lifecycle DTOs and a bounded product-trends contract with a pure decoder. Product aggregates preserve retention, producer-clock time and unknown delivery coverage; they do not represent personal usage or billing. Engine and outcome dimensions must match the existing disclosure inventory.

These APIs require a compatible server. Installation and start admission still require an authenticated architecture-qualified artifact and explicit operator intent. This change does not issue that qualification, enable sending, acknowledge disclosure or grant personal source access.
