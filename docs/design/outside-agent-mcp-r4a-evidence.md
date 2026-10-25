# Outside-agent MCP R4a evidence

Status: isolated implementation evidence, 2026-10-25; exposure remains compiled off.
Retention: keep this security-boundary receipt with #4115; later qualification must preserve its limits and initial failures.

## Scope and source

**EXECUTED:** Implemented R4a at `44eade11aded06b72638fb2fde7783ae294aefcb`, stacked on R3 `e457440c6cacb7d4e1c2035cc9d6c8ebeaf6a618`. After #4154 merged, integrated main with a merge, preserving the outside notification and UI-proxy assertions in two overlap conflicts. A subsequent refactor only made grant derivation and a fixture constant private.

**REASONED:** The [router](../../src-server/routes/outside-agent/mcp-routes.ts) is an isolated composition factory. The release runtime does not mount it and retains the unmodified compiled refusal. R4b discovery admission, R4c's remaining reads, Connections, full access and R6 exposure remain separate work. `chargeBudgets` and the consent-listener/release-guard areas owned by #4156/#4125 were not changed.

**REASONED:** The [dispatcher](../../src-server/services/outside-agent/mcp-dispatch.ts) derives a bearer-exposed outside caller from the live grant and reuses [shared Project read callbacks](../../src-server/tools/station-control-project-read-tools.ts). It exposes only `list_projects` and `get_project`. The dispatch gate is independent of listing and registration. Its two domain reads repeat current grant/catalog admission; they pass no internal bearer to another route or client and invent no internal Session.

**REASONED:** Sessions, resume history and pending requests are bounded in the composition owner: five sessions and ten in-flight requests/calls per grant, one MiB requests/results, 64 replay records within one MiB per session, and 30-minute session inactivity. Each outward chunk rechecks the original request bearer, live authority, family and version inside the store's synchronous decision span. A version change invalidates the session/cursors; the existing bearer can initialize a new session under the current selection. Checks prevent later emissions; bytes already handed to the network remain delivered.

**REASONED:** The transport composition owns its in-memory session/call counters. Multiple simultaneously serving transport owners would require shared transport reservations before deployment; this receipt does not qualify that topology. Live grant admission itself reads shared SQLite, and the emission tests use separate connections. Local committed changes close streams through notifications; a one-second authoritative sweep additionally closes otherwise idle transports after changes from another connection or authority source. Every emission checks immediately, independently of that sweep.

## Executed boundary tests

**EXECUTED:** The [transport tests](../../src-server/routes/outside-agent/__tests__/mcp-routes.test.ts) cover both `2025-06-18` and `2025-11-25` through initialize and subsequent calls, unsupported/mismatched versions, anonymous GET's 401 metadata challenge, unknown-method `-32601`, HTTP 200 unknown-tool `-32602`, underscore/foreign-selector refusal, and scoped Project/global reads. Same-owner foreign Projects appear absent before configuration read; deleted/reused Project identities refuse.

**EXECUTED:** The same suite covers JSON and SSE, authenticated GET/resume, session/family ownership, DELETE, revocation/narrowing/expiry/authority loss between read and outward emission, browser Origin removal, ingress/path negatives, compiled refusal, body/session limits and ten pending bodies refusing an eleventh request before domain work.

**EXECUTED:** The [audience matrix](../../src-server/routes/outside-agent/__tests__/mcp-audience.test.ts) traverses runtime admission plus real internal, engine-proxy and VoltAgent routers in a non-distributable composition that replaces only the compiled refusal. It checks ten credential presentations across seven routes (70 combinations), including real outside/refresh, internal control/Knowledge/proxy, paired Device, operator, anonymous, raw internal, and code-shaped credentials. A mixed outside bearer plus valid internal attestation also refuses. Positive controls reach the existing routes; denied cases cause no VoltAgent transport effects. Generic Station CORS cannot answer outside preflight or confer cookie authority.

**EXECUTED:** The normal release-guard suite separately retains the real guard and verifies refusal before downstream/store effects. The UI-proxy assertion now also rejects an ancestor prefix that would forward `/mcp`.

## Named fault injections

**EXECUTED:** Each injection began from the clean implementation commit. After each red run, the exact original file bytes were restored, the tree was checked clean, and the focused suite returned green (20 tests). The baseline also passed 20 tests.

| Injected defect | Observed assertion failure | Restored result |
| --- | --- | --- |
| Remove `access.resource !== resource` in the private store | Wrong-audience token initialized the real outside endpoint (200 instead of 401); one test failed | 20 passed |
| Skip catalog admission at `tools/call`, keeping listing filtered | Three tests failed, including a schema-valid hidden `navigate_to` call reaching its HTTP effect seam | 20 passed |
| Skip the live checks before outward enqueue | Four tests received content after revoke, narrowing, expiry or authority loss; revoke/narrow used another SQLite connection | 20 passed |

**EXECUTED:** Restored SHA-256 digests were `fef4127638fbb09a6ce24c4df6eb068db750360dc2d29866743fc7774c25b985` (store), `61f90cfd5b446a83ba9adb70ebe90d612288574fa1b4c6ae3eea808fbd8febd4` (dispatch) and `4b526a2d4fd26d761b4552ec93802e94cd5c6f8380a88880fa3c5cc90f28c40d` (router). The later export-only refactor changes the dispatch file's bytes, not the exercised admission branch.

## Real clients

**EXECUTED:** Claude Code `2.1.308` and Codex CLI `0.163.0` completed `mcp login station --no-browser` against an isolated Node HTTP composition of the real OAuth, MCP, runtime admission, private store, Project service and host-management routes. Two synthetic file-backed Projects and a fresh Station home/instance were used on an allocated non-default port. This is same-machine HTTP compatibility evidence, not HTTPS/profile conformance, the full Station application, passkey, hosted-client or release qualification.

**EXECUTED:** Only the disposable sibling checkout's compiled guard was disabled. The requesting page ran in the collaborative browser's Incognito profile. Its displayed comparison code was matched to the host listing, then the real host command implementation approved by request ID with explicit client/fingerprint and unselected supersession. Approval traversed the actual host-proof-protected HTTP routes using a local-grant credential. Automatic browser completion led both real CLIs to exchange their PKCE-bound codes successfully. Claude used `localhost` and Codex used `127.0.0.1` callbacks; both requested read and full while approval selected read-only.

**EXECUTED:** With separate `CLAUDE_CONFIG_DIR`/`CODEX_HOME` and Codex TOML written directly (no `codex mcp add`), Claude's stream-json `mcp_status`/`mcp_call` controls and Codex app-server's `mcpServerStatus/list`/`mcpServer/tool/call` listed exactly the two R4a tools and successfully called `get_project` with `slug: alpha`. Both returned `success: true` and Alpha's Project record. No provider conversation or model turn was needed.

**EXECUTED:** Early harness attempts did not qualify login: a pipe-backed invocation was refused as non-terminal, host command arguments initially used the wrong flag syntax, and duplicated Content-Type was correctly rejected. Those setups were diagnosed before the successful journeys; no failed attempt was counted as a pass. The successful journeys completed well within the live client waits. This run did not measure either client's maximum callback window.

**EXECUTED:** Both clients logged out, test grants were revoked, the listener was stopped, and the Incognito tab was closed. The temporary Claude Keychain entry was deleted and its profile-derived service was verified absent; Codex used isolated file credential storage and logout cleared it. The scratch guard was restored byte-exactly with SHA-256 `a5061dc85cbe43963da737b6279d9aeb2d94b1709dd84211465a3f5e3c5e1aeb`; scratch Git status was clean. The implementation checkout's guard was never changed.

## Verification and documentation limits

**EXECUTED:** Before main integration, server-test and CLI typechecks passed, content excluded-name scanning passed, and the repository source-scan lane passed 65 suites / 690 tests. The focused runtime/transport/pairing selection passed 239 tests. The final integrated selection, documentation gates, branch-scoped Veritas and normal push-hook outcomes are recorded in the PR with their source revision.

**REASONED:** Shipped Connections, operator, deployment, CLI and MCP learning guides retain their current unavailable-feature claims because this slice enables no release surface. This design links the isolated implementation receipt instead of advertising a new operator journey. Remaining reads, host-exclusion counts, final release acceptance, shared multi-owner transport budgets and live HTTPS/passkey qualification are not established here.
