/**
 * PrincipalRef — the ONE principal vocabulary for "who did this" in Station
 * (docs/design/principals.md, archive#4075 architecture map).
 *
 * There is deliberately no second registry: `UnattendedPrincipal` in
 * `src-server/runtime/types.ts` (voice/scheduled-job/delegated-child) is
 * already principal-shaped, and its stable identity is representable as a
 * `kind: 'agent'` PrincipalRef. The `agent` kind is declared for that
 * future subsumption; no production code
 * builds an `agent`-kind PrincipalRef yet. archive#4075 stage 2
 * threads PrincipalRef through the dispatch/event path and does the actual
 * subsumption.
 *
 * `id` is never invented ad hoc at a call site — see docs/design/
 * principals.md rule C4 and the general "label vs derivation" guidance in
 * docs/guides/code-quality.md: a label with no derivation behind it is a
 * defect class this contract exists to close. Build every `id` with one of
 * the constructors below, never a string literal at the call site.
 *
 * ## Scope note: attribution, not authorization
 *
 * A `PrincipalRef` is descriptive attribution ("who Station believes did
 * this"), never an authorization token. Everything below — the id grammar,
 * the reserved-provider guard, the non-blank-component rules — exists to
 * stop Station from FALSELY ATTRIBUTING an action by construction (a
 * fabricated or colliding id is a lie about who acted). None of it grants,
 * widens, or checks any capability; a well-formed `PrincipalRef` proves
 * nothing about what its holder may do.
 *
 * ## id grammar (collision-free)
 *
 * Every `id` is `<kind>:<components...>`, so no two distinct kinds can ever
 * collide — a bare pre-kind-prefix scheme let `servicePrincipal` collide
 * with a `humanPrincipal` id, which is exactly the identity-fabrication risk
 * this contract exists to prevent.
 *
 * - `human:<provider>:<subject>` — `provider` MUST match
 *   {@link PRINCIPAL_COMPONENT_PATTERN} (no colons, so it can never be
 *   confused with the delimiter); `subject` must contain at least one
 *   non-whitespace character and MAY contain colons, unicode, or uppercase,
 *   because it is always the FINAL segment — the id is parsed by splitting
 *   on the first colon after the `human:` prefix, never on every colon, so a
 *   colon-bearing subject (e.g. an email-shaped tailnet login) round-trips
 *   exactly. A subject that is empty or contains only whitespace is
 *   REJECTED — `'human:a: '` names nobody. A subject containing a control character ANYWHERE — not only a
 *   control-only subject — is ALSO rejected, printable content or not: C0
 *   controls (0x00 through 0x1F), DEL (0x7F), and C1 controls (0x80 through
 *   0x9F) are all banned (see the code-unit range check in this file); an
 *   embedded NUL or other control byte inside an identity id is a downstream
 *   log/serialization hazard, and this repo's own zero-tolerance content
 *   gate (`rename-inventory`) already treats control bytes in tracked text
 *   as banned.
 * - `service:<slug>` / `agent:<slug>` — `slug` MUST match
 *   {@link PRINCIPAL_COMPONENT_PATTERN} in full (no colons at all).
 * - `tenant:<tenantId>` — archive#4075 (the hosted
 *   composition regression this ruling fixed): `tenantId` MUST match
 *   {@link PRINCIPAL_COMPONENT_PATTERN} in full, the SAME grammar as
 *   `service`/`agent`. RESERVED exactly like {@link LOCAL_OPERATOR_PROVIDER}
 *   — see {@link tenantPrincipal}'s docs for why no public constructor ever
 *   mints this kind, and `src-server/services/identity/principal-resolver.ts`
 *   for the one sanctioned mint site.
 *
 * Every constructor below REJECTS a component that does not match its
 * grammar rather than escaping or truncating it — a caller passing
 * `humanPrincipal('a:b', 'c', ...)` gets a thrown
 * {@link InvalidPrincipalComponentError}, never a silently reinterpreted id.
 *
 * ## Validators describe, constructors mint
 *
 * {@link isPrincipalRef} answers "is this a well-shaped `PrincipalRef`?" — a
 * pure, permissive description of the wire/storage shape, used to validate
 * values that already exist (read from disk, received over the wire).
 * {@link humanPrincipal} answers "may I MINT this identity?" — a stricter,
 * intentional gate on who is ALLOWED to construct a given id, used only at
 * the moment of attribution. These are deliberately asymmetric:
 * `isPrincipalRef({id: 'human:local:operator', ...})` returns `true` (it
 * IS a well-shaped human principal), but
 * `humanPrincipal('local', 'operator', ...)` THROWS — `'local'` is reserved
 * for Station's own contract-defined local-operator principal
 * ({@link LOCAL_OPERATOR_PROVIDER}), and the public constructor refuses to
 * mint it for anyone. The ONLY sanctioned mint site for that exact id is the
 * authority-gated resolver
 * (`src-server/services/identity/principal-resolver.ts`), which builds the
 * literal `PrincipalRef` object directly — bypassing `humanPrincipal`'s
 * reservation guard by construction, not by exception — and only after
 * verifying a concrete home-possession authority fact. Before that guard
 * existed, any caller holding `LOCAL_OPERATOR_PROVIDER`/
 * `LOCAL_OPERATOR_SUBJECT` (both exported, both simple constants) could call
 * `humanPrincipal(LOCAL_OPERATOR_PROVIDER, LOCAL_OPERATOR_SUBJECT, 'Forged')`
 * and mint a false "the operator did this" attribution with no authority
 * check at all — the resolver's gate only protected callers who chose to go
 * through it. The reservation closes that: the public constructor is no
 * longer a way to reach that id, voluntarily or not.
 */

export type PrincipalKind = 'human' | 'agent' | 'service' | 'tenant';

/**
 * A declared principal: someone or something Station attributes an action
 * to. `id` is stable and derivation-backed (see the constructors below);
 * `display` is cosmetic only.
 */
export interface PrincipalRef {
  /** Stable identity. Never fabricated — always built by a constructor here. */
  readonly id: string;
  readonly kind: PrincipalKind;
  /**
   * Human-facing label. Never used to derive `id`, key a store, or
   * participate in an authorization decision — using it that way would be
   * exactly the "default that decides" defect docs/guides/code-quality.md
   * warns against, applied to identity instead of a config value. Must
   * still contain at least one non-whitespace character: an empty or
   * blank display is not a "no label" state Station represents, and
   * accepting one here let a value pass this validator that the durable
   * store's own reader then rejected, bricking the store (archive#4075).
   */
  readonly display: string;
}

const PRINCIPAL_KINDS: readonly PrincipalKind[] = [
  'human',
  'agent',
  'service',
  'tenant',
];

/** Grammar for a `provider` or `slug` component: lowercase, no colons. */
export const PRINCIPAL_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Reserved `provider` value for Station's own contract-defined local
 * single-operator principal — NOT a real identity provider, and never
 * produced by an `IdentitySource`. {@link humanPrincipal} REFUSES to mint a
 * principal for this provider (archive#4075) —
 * the only sanctioned mint site is the authority-gated resolver
 * (`src-server/services/identity/principal-resolver.ts`), which constructs
 * the `human:local:operator` literal directly after verifying mint-time
 * home-possession authority (`CredentialLocality: 'home-possession'`,
 * `src-server/security/runtime-request-security.ts`). Documenting the
 * reservation here — rather than leaving `'local'` as an unexplained string
 * at the call site — is what makes `human:local:operator` a derivation
 * instead of an improvised label: the id still parses as an ordinary
 * `human:<provider>:<subject>` id (`local` satisfies
 * {@link PRINCIPAL_COMPONENT_PATTERN} like any other provider, and
 * {@link isPrincipalRef} accepts it — see "Validators describe, constructors
 * mint" above), but its MEANING — "the operator authority fact was
 * verified, no `VerifiedIdentity` exists to name a subject" — is recorded,
 * and gated, exactly once, here.
 */
export const LOCAL_OPERATOR_PROVIDER = 'local';
/** Paired with {@link LOCAL_OPERATOR_PROVIDER}; see its docs. */
export const LOCAL_OPERATOR_SUBJECT = 'operator';

/**
 * Wire-stable error code for `PrincipalUnresolvedError`
 * (`src-server/services/identity/principal-resolver.ts`) — archive#4518.
 * A caller this resolver cannot place is a DETERMINISTIC authz failure
 * (no verified identity, no home-possession/tenant authority fact), never a
 * transient one; the same request retried with the same credential fails
 * the same way. The client-side error translator
 * (`src-ui/src/utils/chatErrorTranslation.ts`) matches on this code — the
 * same structured-code-before-prose pattern `SESSION_ENDED_REJECTION_CODE`
 * and `ENGINE_SESSION_BINDING_DEAD_CODE` already use — so the rendered copy
 * never tells the user "retrying may help" for a failure retrying cannot
 * fix.
 */
export const PRINCIPAL_UNRESOLVED_CODE = 'principal_unresolved';

export class InvalidPrincipalComponentError extends TypeError {
  constructor(component: string, value: unknown, reason: string) {
    super(
      `Invalid principal ${component} (${reason}): ${JSON.stringify(value)}`,
    );
    this.name = 'InvalidPrincipalComponentError';
  }
}

/**
 * Thrown by {@link humanPrincipal} when asked to mint
 * {@link LOCAL_OPERATOR_PROVIDER}. See "Validators describe, constructors
 * mint" in the module docs above.
 */
export class ReservedPrincipalProviderError extends TypeError {
  constructor(provider: string) {
    super(
      `Principal provider ${JSON.stringify(provider)} is reserved for Station's own contract-defined local-operator principal and cannot be minted via humanPrincipal() by any caller — only the authority-gated resolver (src-server/services/identity/principal-resolver.ts) may construct it`,
    );
    this.name = 'ReservedPrincipalProviderError';
  }
}

/**
 * Thrown by {@link tenantPrincipal} unconditionally — see its docs.
 */
export class ReservedPrincipalKindError extends TypeError {
  constructor(kind: PrincipalKind) {
    super(
      `Principal kind ${JSON.stringify(kind)} is reserved for Station's own contract-defined hosted-tenant attribution and cannot be minted via a public constructor by any caller — only the authority-gated hosted resolution seam (resolveOrchestrationRequestPrincipal, src-server/runtime/routes/runtime-routes.ts, via src-server/services/identity/principal-resolver.ts) may construct it, and only from a middleware-BOUND TenantExecutionContext, never a raw header`,
    );
    this.name = 'ReservedPrincipalKindError';
  }
}

function isValidComponent(value: unknown): value is string {
  return typeof value === 'string' && PRINCIPAL_COMPONENT_PATTERN.test(value);
}

/**
 * Whether a code UNIT (not code point) falls in a control range: C0
 * (0x00 through 0x1F inclusive), DEL (0x7F), or C1 (0x80 through 0x9F
 * inclusive). Implemented as a
 * numeric charCodeAt scan rather than a regex/character-class literal so
 * this source file itself never needs to contain a literal control byte
 * to describe one; every bound below is an ordinary hex number.
 */
function isControlCodeUnit(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x1f) ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f)
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (isControlCodeUnit(value.charCodeAt(index))) return true;
  }
  return false;
}

/**
 * A valid opaque subject: at least one non-whitespace character, AND no
 * control character anywhere in the string - not only a control-only
 * subject. A subject consisting of nothing but a single NUL, or a
 * printable subject with a NUL (or other control byte) embedded between
 * two ordinary characters, are BOTH rejected (a plain trim()-only check
 * does not strip control characters,
 * so it lets both through while minting a genuinely control-byte-bearing
 * principal id - a downstream log/serialization hazard, and this repo's
 * own zero-tolerance content gate (rename-inventory) already treats
 * control bytes in tracked text as banned).
 */
function isValidSubject(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !containsControlCharacter(value)
  );
}
function isNonBlankDisplay(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireNonBlankDisplay(display: string): void {
  if (!isNonBlankDisplay(display)) {
    throw new InvalidPrincipalComponentError(
      'display',
      display,
      'must be a non-empty, non-whitespace-only string',
    );
  }
}

/**
 * Build a human principal. `provider`/`subject` come from a verified
 * identity's own fields (`VerifiedIdentity.provider`/`.subject` —
 * `src-server/services/identity/identity-source.ts`) — never a display name,
 * alias, or any other cosmetic value (principals.md rule C4: "human
 * principals bind to `VerifiedIdentity.subject`").
 *
 * `provider` must match {@link PRINCIPAL_COMPONENT_PATTERN} (no colons —
 * see the module-level grammar docs) AND must NOT be
 * {@link LOCAL_OPERATOR_PROVIDER} — that provider is reserved; this
 * constructor throws {@link ReservedPrincipalProviderError} for it
 * regardless of caller (see "Validators describe, constructors mint"
 * above).
 *
 * `subject` accept/reject contract (N5): ACCEPTED — at least one non-whitespace, non-control character, and
 * otherwise any content at all: colons, unicode, uppercase, mixed case, all
 * allowed, since it is always the id's final segment. REJECTED — empty,
 * whitespace-only, OR containing a control character ANYWHERE in the string
 * (C0 0x00–0x1F, DEL 0x7F, C1 0x80–0x9F) even alongside otherwise-printable
 * content — an embedded NUL is a downstream log/serialization hazard, not
 * just a display nuisance, so it is rejected the same as a control-only
 * subject. `display` must also contain at least one non-whitespace
 * character.
 */
export function humanPrincipal(
  provider: string,
  subject: string,
  display: string,
): PrincipalRef {
  if (!isValidComponent(provider)) {
    throw new InvalidPrincipalComponentError(
      'provider',
      provider,
      `must match ${PRINCIPAL_COMPONENT_PATTERN} — no colons`,
    );
  }
  if (provider === LOCAL_OPERATOR_PROVIDER) {
    throw new ReservedPrincipalProviderError(provider);
  }
  if (!isValidSubject(subject)) {
    throw new InvalidPrincipalComponentError(
      'subject',
      subject,
      'must contain at least one non-whitespace character and no control characters',
    );
  }
  requireNonBlankDisplay(display);
  return Object.freeze({
    id: `human:${provider}:${subject}`,
    kind: 'human' as const,
    display,
  });
}

/**
 * Build a service principal from a stable, self-describing slug — a
 * constant declared once, never a string improvised per call site.
 * `slug` must match {@link PRINCIPAL_COMPONENT_PATTERN} in full (no
 * colons — a colon-bearing value could otherwise be crafted to collide
 * with a `human:`-prefixed id's internal structure once concatenated).
 * `display` must contain at least one non-whitespace character.
 *
 * The `service:` prefix is deliberate (archive#4075
 * superseded the original "bare
 * wire-value id" design): a `service:` prefix is now always added, so a
 * caller that previously fed a raw `userId` string (e.g. `'invoke-user'`)
 * into a monitoring join now gets `'service:invoke-user'` instead — a
 * disclosed, deliberate break of "byte-identical wire value" in favor of
 * collision-free identity. The join KEY (`station.user.id`) is unchanged;
 * only the value changes, and only forward — no compat shim, per this
 * being a pre-release contract.
 */
export function servicePrincipal(slug: string, display: string): PrincipalRef {
  if (!isValidComponent(slug)) {
    throw new InvalidPrincipalComponentError(
      'slug',
      slug,
      `must match ${PRINCIPAL_COMPONENT_PATTERN}`,
    );
  }
  requireNonBlankDisplay(display);
  return Object.freeze({
    id: `service:${slug}`,
    kind: 'service' as const,
    display,
  });
}

/**
 * Build an agent principal from a stable slug — same grammar as
 * {@link servicePrincipal}. Reserved for
 * `UnattendedPrincipal` subsumption; no production code calls this yet.
 */
export function agentPrincipal(slug: string, display: string): PrincipalRef {
  if (!isValidComponent(slug)) {
    throw new InvalidPrincipalComponentError(
      'slug',
      slug,
      `must match ${PRINCIPAL_COMPONENT_PATTERN}`,
    );
  }
  requireNonBlankDisplay(display);
  return Object.freeze({
    id: `agent:${slug}`,
    kind: 'agent' as const,
    display,
  });
}

/**
 * `tenant` — the hosted-tenant principal kind (archive#4075).
 *
 * ## Why this kind exists
 *
 * Before this kind existed, a hosted-tenant request Station could not tie to a specific
 * human was stamped with the SERVER OPERATOR's own OS alias — a standing
 * attribution lie (every unidentified caller in every tenant read as the
 * SAME "operator" identity, which is not who acted and not even a real
 * person the tenant knows). The fail-closed resolver correctly
 * refuses to keep doing that, which exposed the lie as a hard failure
 * instead of a silent one — but a hosted deployment fronted purely by
 * hostname-based tenant routing (no per-caller identity provider such as
 * Tailscale Serve WhoIs in the loop) has NO verified individual to name
 * either. `tenant` is the honest middle ground: **the finest honest
 * attribution available — a verified tenant binding with no verified
 * individual.** Per-user hosted identity (archive#1859, the tenancy/grants
 * track) upgrades these to real `human` principals once it exists; nothing
 * about this kind is meant to be a permanent ceiling.
 *
 * ## Reserved mint, exactly like {@link LOCAL_OPERATOR_PROVIDER}
 *
 * No public constructor mints a `tenant` principal — this function exists
 * only so a caller reaching for "the obvious constructor" finds a clear,
 * typed refusal ({@link ReservedPrincipalKindError}) instead of a way to
 * fabricate one. The ONLY sanctioned mint site is the hosted resolution
 * seam (`resolveOrchestrationRequestPrincipal`,
 * `src-server/runtime/routes/runtime-routes.ts`), which passes the
 * middleware-BOUND `TenantExecutionContext` into
 * `src-server/services/identity/principal-resolver.ts`'s `resolvePrincipal`
 * — the tenant id that mints this principal is the one
 * `createHostedTenantMiddleware` already verified (host binding +
 * per-boot internal-token attestation,
 * `src-server/runtime/bootstrap/runtime-tenant-context.ts:101-155`), NEVER
 * a raw header re-read independently at the mint site. A raw-header mint
 * would let any caller who can forge the tenant header (rather than pass
 * the middleware's own loopback + token attestation) mint an attribution
 * for a tenant it was never verified into — exactly the id-forgery class
 * {@link LOCAL_OPERATOR_PROVIDER}'s reservation exists to prevent, applied
 * to tenant identity instead of operator identity.
 */
export function tenantPrincipal(_tenantId: string, _display: string): never {
  throw new ReservedPrincipalKindError('tenant');
}

/**
 * Parses `id` against the grammar for `kind` (see the module-level docs).
 * Used by {@link isPrincipalRef}; exported so a store's read-time validator
 * can report a grammar mismatch with a specific message instead of a bare
 * boolean.
 */
export function principalIdMatchesKind(
  id: string,
  kind: PrincipalKind,
): boolean {
  const prefix = `${kind}:`;
  if (!id.startsWith(prefix)) return false;
  const rest = id.slice(prefix.length);
  if (rest.length === 0) return false;
  if (kind === 'human') {
    // Split on the FIRST colon only — the subject is always the final
    // segment and may itself contain colons (see module docs).
    const colonIndex = rest.indexOf(':');
    if (colonIndex <= 0) return false; // need a non-empty provider + subject
    const provider = rest.slice(0, colonIndex);
    const subject = rest.slice(colonIndex + 1);
    // N5: a whitespace-only subject (e.g. 'human:a: ') names nobody, and
    // a subject carrying a control character anywhere — even
    // alongside printable content — is also rejected; see isValidSubject.
    return isValidComponent(provider) && isValidSubject(subject);
  }
  // service / agent / tenant: the remainder is a single component, in full.
  return isValidComponent(rest);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime guard for a `PrincipalRef` read from storage or the wire.
 * Validates that `id` actually parses under `kind`'s grammar (a bare
 * shape sniff would accept any
 * non-empty string as `id`), that `display` is non-blank (N2 — this must
 * match the durable store's own reader exactly, or a value can pass here
 * and brick the store on its next read), and rejects unknown extra fields
 * AND non-plain-object values such as arrays (N4 — `Object.assign([], {id,
 * kind, display})` previously passed the bare `typeof value === 'object'`
 * check). This function DESCRIBES a shape; it never decides who may MINT
 * one — see "Validators describe, constructors mint" in the module docs.
 */
export function isPrincipalRef(value: unknown): value is PrincipalRef {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    keys.some((key) => !['id', 'kind', 'display'].includes(key))
  ) {
    return false;
  }
  if (!isNonBlankDisplay(value.display)) return false;
  if (
    typeof value.kind !== 'string' ||
    !PRINCIPAL_KINDS.includes(value.kind as PrincipalKind)
  ) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    principalIdMatchesKind(value.id, value.kind as PrincipalKind)
  );
}
