# Outside-client passkey consent: R2b evidence

> **Status: implementation evidence, 2026-10-24.** Retained for #4115 and the
> R2b review. The compiled release refusal remains through R6. This is an
> isolated source/test/render receipt, not outside-client feature qualification.

## Boundary reviewed

**REASONED:** [The adapter](../../src-server/services/outside-agent/consent-service.ts)
creates S4 WebAuthn transactions for approval, denial, grant change/revocation,
and redirect/CORS origin add/remove. Its [typed targets](../../src-server/services/outside-agent/consent-targets.ts)
serialize the same canonical target that the
[management service](../../src-server/services/outside-agent/management-service.ts)
uses for host decisions. Commit calls that service under its synchronous SQLite
decision span; it checks the live initiating session again at that mutation seam.
The deciding passkey, rather than an assumed session key, becomes the approval
actor. There is no step-up window or OAuth secret in an effect.

**REASONED:** Approval records intent. Code exchange still owns activation and
supersession. Change updates the existing grant within its original requested
scope and absolute expiry ceiling. The shared target includes sorted requested
scopes; the grant digest binds the complete current authority. Revocation uses
R2a's current-selection fields (`selectedAccessLevel`, `selectedScopes`,
`projectScope`, `expiresAt`) plus reason and expected grant version/digest.
These are the reviewed access being removed, never a replacement grant.

**REASONED:** `outside-agent-denial` is a separate request-bound passkey action.
Confirming **Deny request with passkey** denies the OAuth request through the
shared service. **Cancel review** uses S4's initiating-session cancellation:
it closes only the consent transaction and leaves the OAuth request unchanged.
Selection is frozen before assertion; changing Project, expiry or selected
supersessions requires a new review. Full cannot pass the parsed action schema.

**REASONED:** The runtime guard still refuses `/api/outside-agent/*` before
admission. The production consent listener additionally refuses an outside
transaction on its shared review/decision paths before rendering a nonce,
writing audit or deciding. No environment/configuration switch enables it.
The tests explicitly compose the route registrars without the release wrappers;
no released application mounts the management adapter. This is the intended
R1–R5 non-distributable composition boundary, not production OAuth acceptance.

## Executed boundary checks

**EXECUTED:** At source `56c1f2383139882011cc9099fbb918f574028355`, the following
command passed **372 checks across five files** (32.99 seconds):

```bash
npm run test:focused -- \
  src-server/routes/outside-agent/__tests__/consent-routes.test.ts \
  src-server/routes/outside-agent/__tests__/host-routes.test.ts \
  src-server/runtime/consent/__tests__/operator-sessions.test.ts \
  src-server/runtime/bootstrap/__tests__/outside-agent-release-guard.test.ts \
  src-server/security/__tests__/pairing-route-scopes.test.ts
```

**EXECUTED:** The new file owns **57 checks**, measured at 8.69 seconds in an
isolated run. Eight operation cases each exercise wrong-transaction assertion,
valid commit, replay, five-minute expiry, expected-state refusal, server-side
cancellation, a session ended after revalidation, and refusal of host/Device/raw
operator/generic consent authorities. Additional checks exercise stable Project
identity, comparison-code visibility, exact redirects, remote warnings,
unselected and explicit supersessions, exchange-time activation, 32 KiB caps,
duplicate JSON fields, origin/Fetch Metadata, literal route declarations and
both compiled guards. Policy ABA tests add then remove another origin: restoring
the list's bytes does not restore its reviewed revision.

**EXECUTED:** The fixture uses private temporary homes, real pairing, host-confirmed
software passkey enrollment, real sign-in and `@simplewebauthn/server` signature/UV
verification. The runtime-admission principal stamp is the fixture boundary;
this does not claim a full production HTTP-middleware or browser passkey journey.

**EXECUTED:** Required foreground commands completed: `npm run content:excluded-names`,
`npm run typecheck:server-tests`, `npm run typecheck:ui`,
`npm run typecheck:connect`, `npm run lint:check`, and `npm run test:repo-scans`
(**690 checks / 65 files**, 131.04 seconds). The clean checkout first needed
`npm run build:connect` for its exported declaration files. No e2e spec was added.

**EXECUTED:** The branch code-health gate against R2a reported no introduced dead
code or duplication and six advisory complexity findings. **REASONED:** The
new route checks deliberately keep independent authority, origin, bounded-input,
path/operation and service-refusal branches at the owning route; the description
covers six distinct target kinds, and the shared fixture owns their private
stores and real authentication setup. These findings remain advisory; estimated
coverage is not executed coverage.

## Fault injection from a clean commit

**EXECUTED:** Before injection, HEAD was
`56c1f2383139882011cc9099fbb918f574028355`, `git status --porcelain` was empty,
and the new file passed 57/57. Every variant ran that exact file through
`npm run test:focused`; it failed at the named assertion, rather than import,
selection, compilation or timeout. Each restoration compared current bytes with
the injected bytes before writing the saved original, compared the result with
`git show HEAD:<path>`, reran 57/57 green and confirmed a clean tree. The preceding
restoration was the next fault's identical-source baseline. No fault was committed.

| EXECUTED fault | Boundary assertion that failed | Injected outcome | Restored outcome |
| --- | --- | --- | --- |
| Replace approval's Project fingerprint binding with `null` | `Project slug reuse after review refuses at the actual passkey commit` | Unreviewed replacement Project committed: expected 409, received 200. Two assertions failed, exit 1. | Byte-exact, 57/57 green, exit 0 |
| Ignore reviewed policy revision and fingerprint the supplied old revision | Both `policy revision alone invalidates an otherwise identical review` cases | Stale redirect/CORS action committed after ABA: expected 409, received 200. Two assertions failed, exit 1. | Byte-exact, 57/57 green, exit 0 |
| Bypass outside-target refusal on the production consent listener | `compiled guard refuses new consent review/decision routes with no nonce, audit or domain writes` | A blocked review rendered: expected 404, received 200. One assertion failed, exit 1. | Byte-exact, 57/57 green, exit 0 |

**EXECUTED:** Restored SHA-256:

- `src-server/services/outside-agent/management-service.ts`:
  `f6813307917160691badcae605b8c314dc65a18d40a0b622a4db4f31e2f1a16d`
- `src-server/security/outside-agent-release-guard.ts`:
  `a5061dc85cbe43963da737b6279d9aeb2d94b1709dd84211465a3f5e3c5e1aeb`

## Rendered review pages

**EXECUTED:** These unedited Chromium captures render actual review HTML returned
by the consent registrar, with real private stores and synthetic clients, from
`56c1f2383139882011cc9099fbb918f574028355`. A temporary loopback snapshot server
served those HTML bytes on non-default port 43490; it did not expose an OAuth
service or authorize a client. All eight 390px pages and the 1280px approval
page were opened and visually inspected. Layout measurements found no horizontal
overflow after long identifiers were wrapped. The screenshots establish rendered
review content, not browser assertions or a real OAuth login.

**EXECUTED:** The collaborative preview returned
`Preview automation snapshot timed out after 15000ms.` twice on the same open
tab. Playwright captured the retained images after that fallback. The fixture
uses no real provider, operator data, everyday home or default application port.

| EXECUTED review | Inspected capture |
| --- | --- |
| Approval, remote redirect, code and unselected supersession | [390px](../learn/media/outside-agent-r2b-approve.png), [desktop](../learn/media/outside-agent-r2b-approve-desktop.png) |
| Pending-request denial | [390px](../learn/media/outside-agent-r2b-deny.png) |
| Grant revocation | [390px](../learn/media/outside-agent-r2b-revoke.png) |
| In-place Project/expiry change | [390px](../learn/media/outside-agent-r2b-change.png) |
| Redirect origin add | [390px](../learn/media/outside-agent-r2b-redirect-add.png) |
| Redirect origin remove | [390px](../learn/media/outside-agent-r2b-redirect-remove.png) |
| CORS origin add | [390px](../learn/media/outside-agent-r2b-cors-add.png) |
| CORS origin remove | [390px](../learn/media/outside-agent-r2b-cors-remove.png) |

## Remaining qualification

**REASONED — not executed here:** R3–R6 still own the exposed OAuth server,
Connections entry/selection flow, real Claude/Codex login and timed completion,
transport cancellation, physical/synced/hybrid passkeys, real DNS/TLS, hosted,
native, release and production qualification. The compiled refusal remains.
There is no unresolved R2b decision: denial versus cancellation follows S4,
and all access-change semantics remain those of the shared R2a service.
