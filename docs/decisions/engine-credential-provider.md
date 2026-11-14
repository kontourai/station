---
status: current
subject: Issue engine credentials only through a typed, scoped, reviewed provider
decided: 2026-11-13
evidence:
  - kind: adr
    ref: docs/adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md
  - kind: doc
    ref: src-server/services/acp/acp-inbound-extension-policy.ts
  - kind: doc
    ref: packages/contracts/src/engine-credential-provider.ts
  - kind: doc
    ref: packages/contracts/src/engine-secret-storage.ts
  - kind: doc
    ref: src-server/services/acp/__tests__/acp-inbound-extension-policy.test.ts
---

# Engine credentials through a typed, scoped provider

This record replaces the blanket refusal in
[ADR 0013](../adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md)
("no Station-held credential is ever bridged into an agent's extension
request"). The refusal still holds for every method except the reviewed
bindings below; see [agent extension bindings](agent-extension-bindings.md)
for the rest of ADR 0013's current answer.

## Decision

Station may answer an engine's request for a credential only through a
reviewed engine-credential binding. A binding is one vendor wire method, the
credential kind, and the launch arguments Station itself adds to make the
engine delegate its credential to the host. The answer comes from an issuer
whose only source is Station's engine host-auth vault. The generic
inbound-extension registry keeps refusing credential-shaped methods, as a
deny-only backstop.

An issuer answers only a process Station launched from a built-in
descriptor with those delegation arguments. It is scoped to that process's
connection and credential profile, and returns an access token and its
expiry, never a refresh token. It cannot import Station's own principals.
Each issue is rate-limited and audited without values, and managed policy can
switch issuing off.

Where the engine can own its credential (kiro-cli `--auth-method cli`, Codex
`CODEX_HOME` profiles), Station prefers that. Engine-held secrets
(`_kiro/secret/*`) use the same reviewed path, with a key policy that
restricts them to the engine's MCP-grant namespace.

Rejected:

- answering by method name;
- handing over Station's own credentials;
- a registry shared between sessions or connections;
- letting user-configured or plugin commands opt in.

## Where it is enforced

- `REVIEWED_ENGINE_CREDENTIAL_BINDINGS` and `REVIEWED_ENGINE_SECRET_BINDINGS`
  in the [inbound extension policy](../../src-server/services/acp/acp-inbound-extension-policy.ts)
  are frozen tables. Adding an entry takes a reviewed change.
- `AcpInboundExtensionRegistry.registerCredentialResponder` accepts only a
  table entry itself (object identity, so an exact copy is refused) with an
  ACP wire. It also needs launch facts saying the process came from a
  built-in descriptor whose argv carries the binding's delegation arguments.
  `registerSecretResponder` accepts only a secret-table entry.
- The generic `register` still throws for a credential-shaped name, and
  `resolve` serves such a name only from a reviewed responder.
- A refused issue answers JSON-RPC `-32000` with fixed text. A failing
  issuer's own message never reaches the engine. A secret refusal answers
  `-32602` without echoing the value.

The bindings today:

| Binding | Wire | Delegation argument | Evidence |
|---|---|---|---|
| `kiro.get-access-token` | ACP `_kiro/auth/getAccessToken` (connection scope) | `--auth=acp-callback` (bundle route only) | kirocrew `test/fixtures/acp_frames/kas/host-auth-callback-live.jsonl` |
| `codex.chatgpt-auth-tokens-refresh` | Codex app-server `account/chatgptAuthTokens/refresh` | none pinned, so no responder can install | Named only; the wire shape is not observed or pinned here |
| `kiro.mcp-grant-storage` (secret) | `_kiro/secret/get`, `store`, `delete` | announced as `_meta.kiro.secretStorage` | kirocrew `acp/kas_secret_storage.py` |

The vault, the issuer and its hourly cap, the Kiro sign-in flows and the
audit belong to the engine host-auth service. The managed-policy switch is
the `engineHostAuth` control (`EngineHostAuthPolicy`). Neither is in this
record's evidence.
