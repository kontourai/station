# R3 outside-agent OAuth evidence

Status: isolated implementation evidence for #4115, stacked on R2b (#4122).
This does not enable release exposure or qualify R4–R6.

**EXECUTED — protocol boundaries.** OAuth HTTP tests cover metadata, public
registration/refusals, exact resource, S256, scopes, redirect matching,
browser-ticket isolation/replacement/capacity, approval wakeup, nonce completion,
code single use/verifier failures, activation caps/supersession, strict rotation,
terminal family/grant transitions, final-five-minute issuance, CORS, direct and
unverifiable ingress budgets, persistent daily quotas, TTL/tombstones, Serve
startup/periodic suspension and the compiled release guard. Pairing-route scopes
and runtime HTTP regressions pass. No `/mcp` handler is installed.

**EXECUTED — fault injections.** Starting at committed clean
`a43e57290d1cdfb580a86e7c426ed6ef7bc7fdf4`, each injection ran its focused
baseline, produced a named boundary failure, restored exact original bytes,
and passed the restored focused suite. The implementation tree was clean
between injections.

| Injection | Caught behavior |
| --- | --- |
| Remove S256 method requirement | `PKCE S256 requirement` admitted a non-S256 authorize request |
| Suppress replay family/grant revocation | `strict refresh reuse` retained an active grant after consumed-token reuse, even at exhausted issuance budget |
| Suppress only replay grant terminal transition | `strict refresh reuse` found a terminated family with an active grant; live-store invariant raised `Outside OAuth active family corrupt` |
| Suppress only idle grant terminal transition | `seven-day idle` failed through HTTP admission/projection with the inconsistent family/grant state |
| Admit `x-forwarded-for` in loopback predicate | `loopback predicate refuses x-forwarded-for` exposed metadata instead of refusing |
| Skip UI proxy exclusions | Real HTTP UI proxy forwarded an excluded path; `outside OAuth and MCP paths never reach` failed |

The grant-only variants are runtime invariant failures at the named boundary,
not syntax/dependency/time-out failures. Additional audience/catalog/stream/
Project fault injections belong to R4+, and were not claimed here.

**EXECUTED — real native clients.** An isolated non-distributable composition
used the actual R3 HTTP handlers/private store and shared management review/
commit service, a synthetic Project, dedicated Station home and instance name,
and runtime port 43261. The host-owned harness compared the pending/browser code
and approved by request ID through the shared host domain service. It did not
exercise a released management route or a real passkey ceremony.

Both clients used private fresh profiles and `--no-browser` in PTYs, with an isolated
incognito browser as the authorization browser. No ordinary host browser opened.
The requesting page automatically submitted completion after approval with no
second click; clients received their own registered callbacks and exchanged the
code with their real verifier/resource. Both requested both advertised scopes;
tokens/grants selected only read-only.

| Client | Observed redirect | Result up to grant |
| --- | --- | --- |
| Claude Code 2.1.308 | `http://localhost:<ephemeral>/callback` | `mcp add --scope user --transport http`, then `mcp login --no-browser`: discovery 200, DCR 201, authorize 200, long-poll 200, completion 303, token 200, client exit 0 / authenticated; approximately 12.1 seconds |
| Codex 0.163.0 | `http://127.0.0.1:<ephemeral>/callback` | Direct isolated `config.toml` (file credential store), then `mcp login --no-browser`: discovery 200, DCR 201, authorize 200, long-poll 200, completion 303, token 200, client exit 0 / successful login; approximately 31.1 seconds |

Codex's preliminary GET `/mcp` received 404 and its discovery fallback still
found R3 metadata. No challenge-only stub or R4 transport was added. The client
success strings do not establish that MCP tools are available.

The first piped-input attempt reached DCR, then the first client correctly
required a terminal. The first browser attempt exposed a real completion bug:
`Referrer-Policy: no-referrer` made form-navigation `Origin` null and caused 403.
A failing header regression was executed before the fix. The wait page now
uses origin-only referrers, preserving exact Origin without disclosing OAuth
query values. Other responses retain no-referrer. The two successful client
runs above used that repaired source.

**EXECUTED — cleanup.** Both real clients logged out successfully; active test
grants were revoked and listeners stopped. Four allocated private client/Station
homes were deleted. Three newly created Keychain service entries were matched
to SHA-256 prefixes of the isolated profile directories, deleted, and verified
absent against the pre-run service-name baseline; no Keychain secrets were read.
Scratch guard and protocol source were restored byte-exact. The restored guard
SHA-256 is `a5061dc85cbe43963da737b6279d9aeb2d94b1709dd84211465a3f5e3c5e1aeb`.
Only redacted method/path/status/timestamp receipts were retained.

**REASONED — design interpretation.** Section 5.2 explicitly accepts native
and web public clients, while the task summary says native only. The document
wins: web requires the exact operator-allowlisted HTTPS redirect. No secret-based
client authentication, CIMD, `/mcp` router or Connections UI was added. Literal
loopback HTTP is local compatibility mode with an operator-chosen raw-forwarding
residual, not full HTTPS-profile qualification. Trusted HTTPS ingress accepts
identity only through a composition-owned verification callback, never caller
headers; unverified identity falls back to client/family/global budgets.

**REASONED — code-health disposition.** The new `validateGrant` method is an
intentional inert composition contract: the R3 token handler invokes the
composition's live-authority callback inside `rotate`, and isolated compositions
bind it to this shared domain method. The real native-client composition used
that same binding. There is no released caller until R6 by design. Introduced
complexity advisories cover explicit security predicates, persistent budget
accounting, Serve schema inspection and protocol/test composition; refusal
matrices and the named faults own their behavior. No suppression or threshold
change was added. Raw source audit verdict remains advisory `fail`; its wrapper
reported no blockers, one unused-member warning and eleven complexity advisories.

**NOT_VERIFIED.** MCP calls/tools/transport, production or hosted exposure,
trusted-HTTPS real-client acceptance, real passkey/browser approval, long-duration
refresh cadence/response-loss soak, both CLIs' forced-refresh re-login UI and
Codex's actual maximum callback wait. These remain separate from this successful
bounded OAuth-to-grant check. R6 owns release qualification.
