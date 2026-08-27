/**
 * Resolves a request/session into a declared `PrincipalRef` (station#4075
 * stage 1; docs/design/principals.md). This is identity resolution only —
 * stage 2 threads the resolved principal through the dispatch/event path;
 * nothing here calls dispatch or mutates any event.
 *
 * Fail-closed by construction: a caller this resolver cannot place throws
 * {@link PrincipalUnresolvedError}, never a default ("unknown-user")
 * fabrication — the label-vs-derivation defect docs/design/principals.md
 * and docs/guides/code-quality.md both warn against.
 *
 * The one case that is NOT a failure is Station's local single-operator
 * mode with no `VerifiedIdentity` presented — but (station#4075 stage 1
 * review, FINDING 2) that case is gated on a VERIFIED AUTHORITY FACT, never
 * on the `authorityMode` label alone. The mode string is caller-supplied
 * context, not proof; treating it as proof was the defect. The fact this
 * resolver requires is {@link OperatorAuthorityFact} — EITHER the mint-time
 * `locality: 'home-possession'` stamp `isLocalRuntimeCaller` reads
 * (`src-server/security/runtime-request-security.ts`), OR (station#4529,
 * added alongside #4537's paired-device journey coverage) a VERIFIED
 * operator credential (`authority === 'operator-credential'`) regardless of
 * locality — see {@link OperatorAuthorityFact}'s own doc for why a remote
 * holder of the operator secret deliberately collapses to the same
 * principal. Either fact is passed in by a caller that already computed it
 * at the auth boundary; this module never re-derives either one from a
 * socket, header, or credential text itself — doing so here would be a
 * second, divergent derivation of the same authority.
 *
 * With the fact present (and `authorityMode === 'personal'`), this resolves
 * the contract-defined local-operator principal
 * (`human:local:operator` — see `LOCAL_OPERATOR_PROVIDER`/
 * `LOCAL_OPERATOR_SUBJECT` in `packages/contracts/src/principal.ts` for why
 * that id is a derivation, not an improvised label). Without the fact, this
 * throws in BOTH modes — a personal-mode request that cannot evidence the
 * fact is exactly as unresolvable as a hosted request with no identity.
 *
 * station#4075 stage 1 review round 2, N1: the two checks above are the
 * ONLY gate on minting `human:local:operator` — `humanPrincipal()` itself
 * now refuses to build that id for anyone (`LOCAL_OPERATOR_PROVIDER` is
 * reserved), so this resolver constructs the literal `PrincipalRef` object
 * directly rather than calling `humanPrincipal`. See "Validators describe,
 * constructors mint" in `packages/contracts/src/principal.ts` for the full
 * asymmetry: `isPrincipalRef` still accepts the shape (it describes), the
 * public constructor still refuses to build it (it mints), and this
 * resolver is the one place authorized to do both — check authority, then
 * construct.
 *
 * This is explicitly NOT `getCachedUser().alias` reused as an id.
 * `getCachedUser().alias` is cosmetic OS/display data
 * (`src-server/routes/system/auth.ts`, principals.md §1: "`/api/users` and
 * `/api/auth` are cosmetic... do not mistake them for an identity system")
 * and is never read by this module. A caller MAY supply a display string for
 * the local-operator principal via `resolveOperatorDisplay` — that value
 * only ever reaches the `display` field, never `id`.
 *
 * ## The third outcome: hosted, no identity, a bound tenant (station#4075
 * stage 2 review round 3)
 *
 * Stage 2's original hosted branch had only two outcomes — a verified
 * `VerifiedIdentity` resolves a `human` principal, anything else throws —
 * which broke a real, currently-supported deployment shape: a hosted
 * tenant fronted purely by hostname-based tenant routing (no per-caller
 * identity provider such as Tailscale Serve WhoIs in the loop) resolves a
 * TENANT (via `createHostedTenantMiddleware`,
 * `src-server/runtime/bootstrap/runtime-tenant-context.ts:101-155`) with
 * no individual behind it. Refusing that request outright regressed a
 * working deployment; silently attributing it to the SERVER OPERATOR (the
 * pre-stage-2 behavior) was the standing attribution lie this whole epic
 * exists to close. `kind: 'tenant'` (`packages/contracts/src/principal.ts`)
 * is the honest middle ground — see its own docs for the full reasoning.
 *
 * The bound tenant fact this resolver requires is `hostedTenant`: a
 * `TenantExecutionContext`, and it must be the one the REQUEST'S OWN
 * `createHostedTenantMiddleware` already verified (host binding +
 * per-boot internal-token attestation) — never re-derived from a raw
 * header at this seam. Precedence is unambiguous: a caller presenting BOTH
 * a `VerifiedIdentity` and a bound tenant still resolves the `human`
 * principal (identity is always the finer-grained fact when it exists);
 * `hostedTenant` only matters when `identity` is `null`.
 */

import {
  humanPrincipal,
  isPrincipalRef,
  LOCAL_OPERATOR_PROVIDER,
  LOCAL_OPERATOR_SUBJECT,
  PRINCIPAL_UNRESOLVED_CODE,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { CredentialLocality } from '../../security/runtime-request-security.js';
import type { VerifiedIdentity } from './identity-source.js';

/**
 * Thrown when a caller cannot be resolved to a principal. Never a default.
 *
 * `code` carries {@link PRINCIPAL_UNRESOLVED_CODE} (station#4518) — this is
 * always a deterministic authz failure (missing identity/authority fact),
 * never a transient one, so `orchestration.ts`'s route catch already
 * forwards any `error.code` it finds onto the JSON response
 * (`errorCode(error)`), and the client-side translator matches on it to
 * avoid telling the user "retrying may help" for a failure retrying cannot
 * fix — see `src-ui/src/utils/chatErrorTranslation.ts`.
 */
export class PrincipalUnresolvedError extends Error {
  readonly code = PRINCIPAL_UNRESOLVED_CODE;
  constructor(reason: string) {
    super(`Unable to resolve a principal: ${reason}`);
    this.name = 'PrincipalUnresolvedError';
  }
}

/**
 * Verified authority fact required to resolve Station's local
 * single-operator principal — two independent, sufficient facts, either one
 * alone is enough:
 *
 * - `locality: 'home-possession'` — `CredentialLocality`, the exact type
 *   `src-server/security/runtime-request-security.ts` already uses on
 *   `RuntimeAuthenticatedRequestPrincipal.locality` and reads via
 *   `isLocalRuntimeCaller`. Unchanged since station#4075.
 * - `verifiedOperatorCredential: true` — station#4529/#4537: a caller whose
 *   credential was VERIFIED as the operator secret itself
 *   (`authority === 'operator-credential'`, `runtime-http.ts`'s auth
 *   middleware, never re-checked here), regardless of transport locality.
 *
 *   Fix round (review MED-4): the operator secret did NOT already carry
 *   full API authority everywhere else this request goes — that overstated
 *   the prior state. Before this fix, this principal gate was the SOLE
 *   refusal standing between a remote holder of the operator secret and
 *   chat send, ownership stamping, `/api/orchestration/events`,
 *   `/api/orchestration/commands`, attachment staging, and operator-level
 *   Task-room participation — all of those routes reach a principal through
 *   this exact resolver, and all of them threw `PrincipalUnresolvedError`
 *   for this caller.
 *
 *   What WAS already true, and is the actual reason refusing this caller was
 *   incoherent rather than protective: the operator secret carries
 *   `access:manage` in the frozen `DEFAULT_GRANT_PAIRING_SCOPE`
 *   (`environment-security-service.ts`'s `consentDecisionAuthority`, "the
 *   operator bootstrap credential resolves to the frozen
 *   `DEFAULT_GRANT_PAIRING_SCOPE`") — the SAME scope that approves a new
 *   device pairing. A remote holder could therefore already self-approve a
 *   device pairing for itself with that secret, then chat through the
 *   resulting device credential exactly like any other paired device
 *   (`deviceSessionIdentity`, unaffected by this fix). The principal gate
 *   this fact widens was a SPEED BUMP — one extra self-pairing round trip —
 *   never a real boundary; nothing this fix grants was previously
 *   unreachable, only previously reachable in one more step.
 *
 *   What this fix newly grants DIRECTLY, skipping that self-pairing step:
 *   chat send, ownership stamping, `/api/orchestration/events`,
 *   `/api/orchestration/commands`, attachment staging, and operator-level
 *   Task-room participation, all attributed to the shared
 *   `human:local:operator` principal rather than a distinct per-device one.
 *   Possession of the operator secret IS operator identity; a remote holder
 *   of that secret therefore shares the LOCAL operator's identity and
 *   session namespace: same secret, same principal — deliberate, not an
 *   oversight. (Whether a remote holder should instead get its own,
 *   per-device identity — collapsing this speed bump into an explicit
 *   design decision rather than leaving it implicit — is a separate, harder
 *   question — station#4531.)
 *
 * Neither fact is re-derived here: a caller of `resolvePrincipal` is
 * expected to have already computed whichever one applies the same way the
 * corresponding predicate does (`isLocalRuntimeCaller` for the first,
 * `resolveCredentialAuthority` for the second) — this resolver only ever
 * reads the fields.
 *
 * Fix round (review MED-3): a plain interface with BOTH fields optional lets
 * `{}` typecheck as a fully-formed `OperatorAuthorityFact` — a caller that
 * meant to pass a real fact and instead passed an empty object (a
 * construction bug, not a "no fact" caller) would silently fail closed
 * rather than get a compile error naming the mistake. A DISCRIMINATED union
 * — exactly one field, always present when its branch is chosen — makes `{}`
 * (and any other partial shape) a type error instead: every caller must
 * commit to a real fact or pass `undefined`, never a structurally-valid but
 * semantically-empty stand-in for one.
 */
export type OperatorAuthorityFact =
  | { readonly locality: CredentialLocality }
  | { readonly verifiedOperatorCredential: true };

/**
 * The single, well-known principal id for Station's local single-operator
 * mode. Computed from the reserved `LOCAL_OPERATOR_PROVIDER`/
 * `LOCAL_OPERATOR_SUBJECT` pair (`packages/contracts/src/principal.ts`),
 * which documents why this id is a derivation rather than an improvised
 * fallback. Mirrors the existing `LOCAL_MEMBER_ID = 'local'` precedent in
 * `services/projects/project-binding-store.ts`: an explicit, fixed
 * identity — reserved until a real membership/account model exists.
 */
export const LOCAL_OPERATOR_PRINCIPAL_ID = `human:${LOCAL_OPERATOR_PROVIDER}:${LOCAL_OPERATOR_SUBJECT}`;

const DEFAULT_OPERATOR_DISPLAY = 'Operator';

export interface ResolvePrincipalOptions {
  /**
   * Cosmetic display only (never the id) for the local single-operator
   * principal. Optional and defaulted so this resolver adds minimal
   * required plumbing to existing callers/tests — the same shape as the
   * optional `logger.child?` injectors in `utils/logger-correlation.ts`.
   */
  resolveOperatorDisplay?: () => string;
  /**
   * Cosmetic display only (never the id) for the hosted-tenant principal
   * (station#4075 stage 2 review round 3). Optional, defaulting to the
   * bare tenant id — a real display name belongs to a real individual,
   * which this principal by construction does not have.
   */
  resolveTenantDisplay?: (tenantId: string) => string;
}

/**
 * @param identity The verified identity presented with this request/session,
 *   or `null` when none was presented — the ordinary case for a
 *   direct-loopback local request.
 * @param authorityMode `SessionReadAuthority.mode` for this request/session
 *   (`@kontourai/station-contracts/tenancy`). Accepted as the bare literal
 *   rather than the full branded `SessionReadAuthority` so this resolver
 *   stays trivially testable without constructing one. Necessary but NOT
 *   sufficient for the local-operator path — see `operatorAuthority`.
 * @param operatorAuthority The verified authority fact for this request —
 *   home-possession locality OR a verified operator credential (either is
 *   sufficient; see {@link OperatorAuthorityFact}) — or `undefined` when the
 *   caller never presented either. REQUIRED (not defaulted) so every call
 *   site makes an explicit choice about what it is asserting, rather than
 *   silently omitting proof.
 * @param hostedTenant The request's middleware-BOUND `TenantExecutionContext`
 *   (`createHostedTenantMiddleware`,
 *   `src-server/runtime/bootstrap/runtime-tenant-context.ts:101-155`), or
 *   `undefined` when no tenant was bound. REQUIRED (not defaulted), same
 *   reasoning as `operatorAuthority`. Only consulted when `identity` is
 *   `null` AND `authorityMode === 'hosted'` — see the module docs' "third
 *   outcome" section for the full precedence argument. This resolver never
 *   re-derives a tenant binding from a header itself; it only ever reads
 *   the fact a caller already verified.
 */
export function resolvePrincipal(
  identity: VerifiedIdentity | null,
  authorityMode: 'hosted' | 'personal',
  operatorAuthority: OperatorAuthorityFact | undefined,
  hostedTenant: TenantExecutionContext | undefined,
  options: ResolvePrincipalOptions = {},
): PrincipalRef {
  if (identity) {
    return humanPrincipal(
      identity.provider,
      identity.subject,
      identity.displayName ?? identity.subject,
    );
  }
  if (
    authorityMode === 'personal' &&
    operatorAuthority !== undefined &&
    // `OperatorAuthorityFact` is a discriminated union (review MED-3) — one
    // field or the other, never both, never neither — so a plain `.locality`/
    // `.verifiedOperatorCredential` access does not typecheck across it
    // without first narrowing on which one is present.
    ('locality' in operatorAuthority
      ? operatorAuthority.locality === 'home-possession'
      : operatorAuthority.verifiedOperatorCredential === true)
  ) {
    // station#4075 stage 1 review round 2, N1: `humanPrincipal` REFUSES to
    // mint `LOCAL_OPERATOR_PROVIDER` for any caller — that reservation is
    // exactly what stops an unauthenticated call from forging
    // `human:local:operator` via the public constructor. This resolver is
    // the ONE sanctioned mint site: it constructs the literal directly,
    // only after the two checks above (authority fact + personal mode)
    // both passed, and validates the result with `isPrincipalRef` — the
    // permissive shape check, not a mint gate (see "Validators describe,
    // constructors mint" in principal.ts). That validation is defense in
    // depth against a future edit to this literal breaking its own shape
    // silently; it is not what authorizes minting it — the authority-fact
    // check above is.
    const operatorPrincipal: PrincipalRef = Object.freeze({
      id: LOCAL_OPERATOR_PRINCIPAL_ID,
      kind: 'human' as const,
      display: options.resolveOperatorDisplay?.() ?? DEFAULT_OPERATOR_DISPLAY,
    });
    if (!isPrincipalRef(operatorPrincipal)) {
      // Unreachable in practice — the literal is fixed and well-formed —
      // but a thrown, typed failure is still correct: never return a value
      // this module's own validator would reject.
      throw new PrincipalUnresolvedError(
        'internal: the contract-defined local-operator principal failed its own shape validation',
      );
    }
    return operatorPrincipal;
  }
  if (authorityMode === 'hosted' && hostedTenant) {
    // station#4075 stage 2 review round 3: the third hosted outcome — see
    // the module docs' "third outcome" section. `tenantPrincipal()` itself
    // is reserved (always throws), so — exactly like the local-operator
    // literal above — this resolver constructs the literal `PrincipalRef`
    // object directly, only after the middleware already verified the
    // tenant binding (never re-derived from a header here), and validates
    // the result with `isPrincipalRef`. Unlike the local-operator literal,
    // this ISN'T unreachable in practice: a tenant id that satisfies
    // `TENANT_ID_PATTERN` (tenancy's own grammar — allows uppercase and
    // underscores) but not `PRINCIPAL_COMPONENT_PATTERN` (stricter:
    // lowercase, hyphens only) fails validation here and this request
    // fails closed rather than minting an ill-formed id.
    const tenantPrincipalRef: PrincipalRef = Object.freeze({
      id: `tenant:${hostedTenant.tenantId}`,
      kind: 'tenant' as const,
      display:
        options.resolveTenantDisplay?.(hostedTenant.tenantId) ??
        hostedTenant.tenantId,
    });
    if (!isPrincipalRef(tenantPrincipalRef)) {
      throw new PrincipalUnresolvedError(
        `hosted tenant id ${JSON.stringify(hostedTenant.tenantId)} does not match the principal id grammar`,
      );
    }
    return tenantPrincipalRef;
  }
  throw new PrincipalUnresolvedError(
    authorityMode === 'personal'
      ? 'personal-mode request carries no verified identity and no home-possession authority fact'
      : 'hosted request carries no verified identity and no bound tenant context',
  );
}
