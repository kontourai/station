---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
"@kontourai/station-shared": minor
"@kontourai/station-cli": patch
---

Remote MCP integrations can use an OAuth client the operator registered: `ToolDef.oauthClient` adds a pre-registered `clientId` with its declared authorization server `issuer` (required with any client ID, and optional otherwise to pin registration), a Client ID Metadata Document `clientMetadataUrl`, default `scopes`, and `clientSecretRef`, a secret binding id written only by the secret-binding routes. A new `mcp-integration-oauth-client` grant (`SecretBinding.oauthClientGrants`) authorizes a binding as one integration's client secret at the `issuer` and `resource` it was bound for, and a server with no client registration reports the `client-id-required` authorization state. The SDK adds `bindOAuthClientSecret`/`unbindOAuthClientSecret`, their query hooks, and an optional per-sign-in `scopes` choice on `useStartIntegrationOAuthMutation` (an empty list requests the server's advertised scopes). The tool contract adds `toolServerOAuthResourceIdentity`, `assertToolOAuthClientWritable` and `withoutToolBindingReferences`; the shared credential store adds `upsertMany`; the CLI import refuses, and export strips, OAuth client-secret references.
