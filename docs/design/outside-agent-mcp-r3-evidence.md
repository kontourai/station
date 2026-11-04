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

## Round 1 repair — 2026-10-25

**EXECUTED — custody.** The remote PR head was confirmed as
`a46931449dd7a6fc1d4345e6154f45dfcc9115e6` in the clean sibling worktree.
The initial broad fetch encountered an unrelated concurrent ref-update race;
a scoped fetch of `main` and the PR branch succeeded. Main at
`8930cc98aadd87c5dee1e1b1c19c0e91bcb27e77` was merged, never rebased. Repair
source and regression tests were frozen in clean commit
`e9cc93378244aa7ebaedab1ffccd40885148d7d0` before fault injection.

**EXECUTED — reviewed findings and repairs.**

| Finding | Disposition and evidence |
| --- | --- |
| 1: sweep before budget | Confirmed. Cheap global/verified-peer admission now precedes client/family and CORS-policy reads. Over-budget authorize probes do no domain-record reads/writes or sweep. History/audit cleanup belongs to the 30-second tick; live expiry visits capped live sets and status reads check their own row. Audit capacity uses a transactional counter. HTTP instrumentation with zero and 99,000 seeded events refuses audit-table scans during admitted allocation and waiting-page transitions, and any domain-table operation during refused probes. This is an executed operation-bound proof, not a wall-clock benchmark. |
| 2: peer-table saturation | Confirmed under the simulated trusted-ingress seam. Global refusal stops before supplementary writes. A full 4,096-row table evicts its oldest supplementary row while preserving global quota counters. A 2,100-peer HTTP flood allocates only globally admitted peer rows, and a separately filled table still admits a legitimate key to normal protocol validation. |
| 3: authorize audit churn | Confirmed. Pure same-ticket pending replacements add neither requested nor request-ended events; replacing approved/coded requests retains audit. HTTP churn keeps event count constant. An operator diagnostic reports `audit_pressure` at 80%, before admission closes. |
| 4: callback cookie path | Confirmed. Registration refuses `/oauth` and its descendants, including encoded spellings and malformed encoded paths. The regression covers the other-loopback-port callback shape and keeps ordinary `/callback` acceptance. |
| 5: sweep health overwritten | Confirmed. Availability requires both a healthy sweep and a clear Serve result. Repeated clear Serve results cannot recover a failed sweep; a later successful sweep can. |
| 6: ingress, Serve and Vite details | Confirmed. Both additional internal identity/tenant headers refuse every OAuth leaf; bare-port Web/TCP targets map the named port. A real Vite-to-HTTP-backend test proves excluded literal/encoded paths never reach the backend, with ordinary Station discovery as a positive control. The reference explains absent-executable allowance and macOS installed-but-stopped refusal. |

**REASONED — scope qualifications.** Token replay is the necessary exception to
blanket “no store reads after budget refusal”: a bounded credential lookup still
checks correctly bound consumed code/refresh reuse and revokes the family/grant,
even when issuance is exhausted. The existing strict-refresh and code-replay
HTTP regressions still pass. No unregistered supplied client ID allocates a
limiter key. Supplementary-key eviction can reset an individual supplementary
allowance; durable global ceilings remain authoritative.

The accepted design explicitly forbids discarding undelivered audit events.
This repair preserves that rule rather than introducing a 90-day delivery-loss
exception. Until R5 wires delivery, sustained distinct flows can still saturate
the audit cap; pure same-ticket pending churn cannot, and the warning is an
operator diagnostic rather than a delivered notification. Both the design and
reference now state this residual.

**EXECUTED — required faults from clean committed source.** Each HTTP-suite
baseline/restored run passed 84 tests, exit 0. The tree was clean between
injections. Each restored file matched its original bytes and SHA-256.

| Injection | Named failure | Injected result | Restored SHA-256 |
| --- | --- | --- | --- |
| Put full sweep before cheap admission | `budget refusal precedes domain storage and audit size never adds request scans` saw audit retention SQL | 1 failed / 83 passed, exit 1 | `bf13d4ab73b0eaf56d665d5185e42a7318f58d38b83d656cd254d8f10b18365b` (routes) |
| Continue peer writes after global refusal | `distinct verified peers cannot fill budget storage after global refusal or lock out a legitimate client` saw 4,096 rows instead of at most 62 | 1 failed / 83 passed, exit 1 | `d64f954578afb04a8dedd7ff174cf44e061d7917ae3bdd24ad98d333efe7685b` (store) |
| Remove callback-path refusal | Five `DCR refuses callback path …` cases received 201 instead of 400 | 5 failed / 79 passed, exit 1 | `cd134cc0b410c76dd81705b82461640f5a210fba912f0eb744a8a0c24f4956b0` (registration) |

**EXECUTED — additional regression catches.** A separate combined injection
restored pending-replacement audit churn, removed the 80% diagnostic, ignored
sweep health, admitted the two internal headers, removed bare-port handling and
bypassed Vite exclusions. Eight named assertions failed across the four owner
suites (171 passed, exit 1). After byte-exact restoration of all five owners,
179/179 tests passed, exit 0. These were assertion failures, not missing
prerequisites, empty selections or timeouts. All mutations were removed.

**EXECUTED — validation.** The foreground excluded-names check passed. After
building Connect declarations, the full `typecheck` aggregate passed all 16
lanes. Repository scans passed 690 tests in 65 files. The combined pairing-route
scopes, runtime HTTP, outside-agent routes/store/concurrency/release guard,
Serve and Vite suites passed 518 tests in ten files. The final restored owner
selection passed 179 tests in four files. Read-only lint passed with existing
repository warnings and informational findings.

The initial code-health attempt was rejected because HEAD changed during its
analysis when the repair was committed; that attempt is invalid evidence and
was not reused as a passing gate. Final documentation, branch-scoped governance,
code-health and normal-hook push results are reported in the implementation
handoff. No auto-merge was armed. This repair did not rerun real native clients,
qualify production/hosted ingress, enable `/mcp`, or change the R4–R6 limits above.

**EXECUTED — final-gate diagnosis.** The first branch-scoped readiness run at
`37f1fae09ad00bd136928909c0ac9635604243aa` failed documentation truth because
three historical R2b consent captures still cited the earlier redirect-validator
bytes. The images were inspected: approval captures show the allowlisted HTTPS
`/callback`, and change shows a literal-loopback `/callback`. Neither uses the
newly refused `/oauth` namespace; their depicted review behavior remains accurate.
The follow-up capture notes record source review only, preserving the original
capture provenance without claiming a new browser/passkey execution.

That same run's optional connected-agent diagnostic passed 1,532 tests and failed
the unchanged high-cardinality EventStore projection test at its explicit
10,000 ms bound (17,771 ms observed test duration under host CPU pressure).
This is retained as a failed diagnostic, not OAuth evidence and not a passing
connected-agent qualification. Its source is unchanged from main; no timeout was
raised and the failed diagnostic was not rerun to green. Governance, lint,
code hygiene, component style and verification policy passed in that run.
