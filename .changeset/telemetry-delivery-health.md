---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add current-process product and OTel delivery status contracts, validated SDK queries and content-free connection checks. Queries and mutations retain the selected Station's request authority. Product acknowledgements require matching commit receipts; OTel callback and probe acceptance do not establish downstream storage or canonical personal usage.

Add revision-bound SDK management of explicit instance SecretBinding grants for one product or OTel destination. These grants confer no MCP, ACP, person, Project or execution authority. Older strict binding readers reject the new stored grant property; rollback requires a compatible backup and must not delete grants to make old code accept the document.

Saved product changes fence queued observations and attempts immediately after persistence, independently of Agent activation. Late startup uses a validated current configuration snapshot before restoring disclosure. Saved collector changes fence the old exporter and require a Station restart to activate the replacement.

Add the canonical usage-export request/page contract and request-authorized committed-order source reader. Pages retain token/provider-cost receipts and source coverage uncertainty; they do not issue companion grants, create durable indexes or establish deletion/restore/clone acceptance.
