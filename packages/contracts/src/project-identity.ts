/**
 * The portable Project manifest, the per-Station
 * binding store, and resolution-state contracts
 * (`docs/design/portable-project-identity.md` §3.2, §3.4, §3.5, §3.6).
 *
 * These types land ALONGSIDE `ProjectConfig` (`./project.ts`), not in place
 * of it — this module is pure types plus validators; the stores, resolver,
 * and consumer seams live elsewhere in the repo.
 *
 * Load-bearing decisions, copied from the design doc rather than invented
 * here. Every claim below names where it is ENFORCED, and where it is not it
 * says so by name rather than leaving the claim broader than the code
 * (`docs/strategy/multi-agent-delivery-protocol.md` §6, the honesty bar):
 *
 * 1. **The manifest carries no filesystem paths and no secret values**
 *    (§3.2). Everything path-shaped is either Station-managed (resolved
 *    locally) or repo-relative (`{ repoId, path }`); auth is a reference,
 *    never a value (§3.4). Enforcement, exactly:
 *    - {@link ABSOLUTE_OR_TILDE_PATH_PATTERN} (`^[~/]`, a Windows drive
 *      letter, a UNC prefix) is refused in exactly these replicating,
 *      identity-shaped fields: the manifest's `id`, `slug`, `name` and
 *      `icon`; every resource's `label`; a git resource's `canonicalRemote`
 *      and each of its `aliases[]` (a `file://` remote canonicalizes to an
 *      absolute filesystem path — see decision 3); and
 *      `knowledge[].root.path`.
 *    - `knowledge[].root.path` is additionally refused a `..` segment and an
 *      empty segment. §3.2's rule is that every path is relative *to a named
 *      repo*; `../../../etc/passwd` is anchored nowhere and escapes the repo
 *      it names, which matters the moment a binding path is joined to a
 *      root path and hands the result to `KnowledgeService`. One trailing
 *      separator is stripped first (`docs/` means `docs`), and `.`/`./` are
 *      allowed as the repo root — refusing every spelling of "index the whole
 *      repo" was a false rejection, not a guard.
 *    - NOT enforced, named rather than implied, three gaps:
 *      (a) `description` is prose and is deliberately EXEMPT. The pattern is
 *      anchored, so checking it would refuse an ordinary sentence that
 *      happens to begin with a path ("/api/projects/:slug is the route family
 *      we own") while catching nothing a sentence hides mid-string.
 *      (b) `agents[]`, `layouts[]`, `integrations[].id`,
 *      `knowledge[].namespaceId` and `defaultBranch` are type-checked but not
 *      path-checked — they are id-shaped by their own grammars elsewhere.
 *      (c) The credential-prefix signal in decision 5 is AUTH-ONLY. A
 *      `description` reading "the token is ghp_…" is never scanned.
 * 2. **`schemaVersion` GATES parsing; it is never cast.** §2.5 records that
 *    `KnownEnvironment.schemaVersion` is "written by every producer and read
 *    by none" — versioned in name only. This validator RETURNS on an unknown
 *    or absent `schemaVersion` with that one named error and inspects
 *    nothing else, because applying v1 field assertions to a v2 document
 *    reports the v2 producer as malformed when the only true fact is that
 *    this reader cannot read it.
 * 3. **A git repo resource's `id` IS its `canonicalRemote` string, not a
 *    hash** (§9 OQ-1, §3.2). `github.com/kontourai/station` is legible in a
 *    manifest, a log line, and an error message; a hash is opaque and buys
 *    nothing a manifest reader needs. The validator enforces `id ===
 *    canonicalRemote` for every `git` resource, that `canonicalRemote` is
 *    already canonical (re-running `normalizeGitOrigin` on it is a no-op),
 *    and that every declared alias is ALSO already canonical — an alias
 *    pasted verbatim out of `git remote -v`
 *    (`git@git.internal:kontourai/station.git`) validates but can never
 *    intersect a binding's canonicalized remote set (§3.3(b)/(c)), so the
 *    resource silently resolves `unbound` forever and the repair prompt
 *    tells an operator to clone a repo they already have.
 *    A local clone source is refused here rather than accepted as canonical:
 *    `normalizeGitOrigin` strips the scheme, so
 *    `file:///Users/me/dev/acme-client/repo` canonicalizes to an absolute
 *    filesystem path that is idempotent and would otherwise pass. Refused:
 *    an absolute/tilde/drive-letter/UNC form; a `.` or `..` first segment
 *    (`git clone ../mirror/repo`); and a loopback first segment
 *    ({@link LOOPBACK_HOSTS}) — git supports `file://localhost/<abs path>`,
 *    which strips to `localhost/users/me/dev/...` and so escapes the
 *    anchored path pattern entirely.
 *    **The residual, named rather than implied:** a RELATIVE local path with
 *    no dot segments — `git clone mirror/repo` canonicalizing to
 *    `mirror/repo` — is indistinguishable at the string level from a
 *    `host/repo` remote on a single-label host, and is NOT caught. A local
 *    clone source is otherwise a `local-only` resource, not a portable `git`
 *    one.
 * 4. **A `local-only` resource is explicitly non-portable, and it still
 *    REPLICATES** (§3.3 residual case, §9 OQ-8). It is allowed in a
 *    shareable manifest rather than refused at share time, because refusing
 *    it would turn migration into a wall for exactly the projects most
 *    likely to migrate first (Station's own seeded `default` project has no
 *    directory at all). Non-portability describes RESOLUTION — it resolves
 *    for its author and reports `not-portable` (§3.6) to everyone else —
 *    not whether the record travels: the record is in the manifest every
 *    member reads. So its `id` is constrained to
 *    {@link LOCAL_ONLY_ID_PATTERN}, `^local:[A-Za-z0-9._-]+$`, the grammar
 *    the design doc's own schema example uses
 *    (`{ "id": "local:scratch", "kind": "local-only" }`, §3.2). This is
 *    enforcement, not style: §5 turns today's directory-only Project into a
 *    `local-only` resource at migration and the only value on hand for its
 *    id is that directory, so the grammar makes shipping a home directory
 *    as a resource id impossible by construction rather than by
 *    vigilance.
 * 5. **Auth is the datum idiom verbatim** (§3.4): exactly one backend per
 *    `ProjectAuthReference`, never a value. The validator rejects a second
 *    backend key on one reference, and applies two independent checks to the
 *    backend's own value:
 *    - A POSITIVE shape assertion per backend. `env` is a valid environment
 *      variable NAME ({@link ENV_NAME_PATTERN}); `op` starts with `op://`
 *      and names a non-empty path; `station` is a plain integration id
 *      ({@link STATION_INTEGRATION_ID_PATTERN}); a `keychain`
 *      service/account is a plain single-line string.
 *    - A leak signal: a value — or, for `op`, the part after `op://` — that
 *      STARTS WITH a known credential prefix
 *      ({@link SECRET_LITERAL_PREFIXES}: `sk_`/`sk-`, GitHub's
 *      `ghp_`/`gho_`/`ghu_`/`ghs_`/`github_pat_`, AWS's `AKIA`/`ASIA`,
 *      Slack's `xox`, Google's `AIza`) or looks like a JWT header
 *      (`eyJ…` followed by a `.`). Matched case-sensitively, because every
 *      prefix in that list is.
 *    What this does NOT catch, stated rather than implied: **a secret with no
 *    recognizable prefix, in any field.** `hunter2_password` is accepted
 *    everywhere it is well-shaped. A narrower `UPPER_SNAKE_CASE` rule for
 *    `env` was tried and reverted: case is a naming convention, not evidence,
 *    and enforcing it would have refused a legitimate lowercase variable
 *    while catching only lowercase secrets — the same proxy-that-does-not-
 *    discriminate mistake as the heuristic below, presented as a guard. This
 *    narrows the leak surface; it is not a secret
 *    detector. It replaces a length-based heuristic (">= 20 characters and
 *    no whitespace") that was worse than nothing, because every field it
 *    guarded is whitespace-free by construction: it refused
 *    `AWS_SECRET_ACCESS_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`,
 *    `com.kontourai.station.linear`, and
 *    `op://engineering-vault/github-deploy/token` while admitting
 *    `sk_live_9aZ2Kq1x` and `AKIAIOSFODNN7EXAM`.
 * 6. **`ProjectBinding.path` is stored verbatim (tilde-preserving);
 *    `ProjectBinding.remotes` is stored canonicalized** (§3.5). The path
 *    stays exactly as the user gave it and is canonicalized at each READ by
 *    the resolver; the remotes are canonicalized at WRITE because
 *    they are a key used for set-intersection matching against a manifest
 *    resource's `{ canonicalRemote } ∪ aliases` (§3.3(b)).
 * 7. **`ProjectBinding.verifiedAt` is an observation, not a guarantee**
 *    (§3.5). A binding whose `verifiedAt` is old is `stale`, not `bound` —
 *    nothing in this module re-verifies it; that is the resolver's job.
 * 8. **The {@link ResourceResolution} union and its honesty
 *    invariants are enforced by a predicate, not just documented** (§3.5,
 *    §3.6): `state` is a member of {@link RESOURCE_RESOLUTION_STATES}
 *    (checked at runtime, because these are read off disk where the
 *    TypeScript union proves nothing), `resourceId` NAMES the resource for
 *    every state except `ambiguous` — which requires it to be EMPTY, because
 *    no single resource was identified and a non-empty id would claim one the
 *    state says was not found; its candidates live in `reason` (§3.6 rule 3:
 *    an `unresolvable` result NAMES the resource — "a silent skip is a bug"),
 *    `path` is present ONLY when `state === 'bound'`, and `reason` is
 *    REQUIRED for every non-`bound` state. {@link isWellFormedResolution}
 *    exists so a future producer of a {@link ResourceResolutionResult}
 *    cannot silently violate any of them without a caller that checks it
 *    noticing.
 * 9. **A resolution reports the OBSERVATIONS it derived its state from, not
 *    only the derived label** (archive#1594). The resolver knows
 *    two independent facts whenever it answers: whether anything on this
 *    Station *declares* a realization of the resource, and what it *observed*
 *    at the declared place. Reporting only the label discarded both axes and
 *    produced two separate defects — `unbound` meaning both "nothing is
 *    recorded" and "the recorded directory is gone" (archive#1594), and
 *    `stale`/`drifted` refusing to state a path the resolver had already
 *    `existsSync`'d. So
 *    {@link ResourceResolutionResult} is a DISCRIMINATED UNION whose repair
 *    states carry their own observations: `missing` carries `record` +
 *    `declaredPath`, `stale`/`drifted` carry `unverifiedPath`. See that type's
 *    docblock for why `unverifiedPath` does not erode the `path`-only-on-`bound`
 *    invariant.
 * 10. **Referential integrity, and the cardinality §3.5's primary resolution
 *    needs.** §3.5 makes `resolveProjectResource(projectSlug, resourceId?)`
 *    take an optional `resourceId` so existing callers "keep working
 *    unchanged by resolving the `primary` repo" — which is only
 *    deterministic if the manifest guarantees the primary is unambiguous.
 *    The validator enforces the cardinality; the resolver owns the read. The
 *    rule, stated here as contract so the resolver does not re-decide it:
 *    - A single-resource manifest's sole resource IS its primary, whether or
 *      not it declares `role`.
 *    - A manifest with more than one resource MUST declare exactly one
 *      `role: 'primary'`.
 *    - Otherwise there is no primary, and a resolver called without a
 *      `resourceId` reports ambiguity NAMING every candidate rather than
 *      choosing one.
 *    Two integrity checks ride the same pass, following the cross-field
 *    idiom already in `./project-reference-integrity.ts`
 *    (`validateProjectAgentScope`, `validateLayoutAgentReferences`):
 *    resource ids are unique across `repos[]`, and every
 *    `knowledge[].root.repoId` names a resource that actually exists.
 * 11. **A validation failure that makes a manifest UNREADABLE is not the same
 *    as one that makes a resource UNSELECTABLE** (archive#1499).
 *    Every failure this validator reports carries a machine-readable
 *    {@link ProjectManifestDiagnosticCode} alongside its unchanged human
 *    message, because a consumer has to tell those two apart and matching on
 *    message prose is a stringly-typed join between two packages that rots the
 *    first time a sentence is reworded. An unknown `schemaVersion`, a missing
 *    `id`, a non-array `repos`, a malformed resource, a path or credential
 *    leak — the reader genuinely cannot trust the document, and the only
 *    honest answer is to fail closed. The primary-cardinality rules in
 *    decision 10 are different in kind: the document is perfectly readable and
 *    merely cannot name ONE resource, which is exactly the `ambiguous`
 *    resolution §3.6 exists for. Those three carry
 *    {@link ProjectSelectionAmbiguityCode}s, and
 *    {@link isSelectionAmbiguityOnly} is the predicate a consumer classifies
 *    with. {@link selectPrimaryResource} is the same rule as an executable
 *    function, so the resolver applies it rather than re-deciding it.
 */

import { normalizeGitOrigin } from './git-remote-identity.js';

export const PROJECT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PROJECT_BINDING_STORE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Manifest (§3.2) — portable, shared, no paths, no secrets.
// ---------------------------------------------------------------------------

/**
 * A git-backed resource. `id` IS `canonicalRemote` (§9 OQ-1) — see decision 3
 * above. `aliases` are DELIBERATE, shared equivalences authored by whoever
 * wrote the manifest (forge migrations, internal mirrors, §3.3(c)) — never a
 * personal fork, which stays private in a binding's `remotes` set (§3.3(b)).
 */
export interface ProjectGitRepoResource {
  kind: 'git';
  /** Always equal to `canonicalRemote`. Enforced by the validator. */
  id: string;
  /** Already-canonical form, i.e. `normalizeGitOrigin(canonicalRemote) === canonicalRemote`. */
  canonicalRemote: string;
  /**
   * Deliberate, shared equivalent remotes (mirrors, migrations) — §3.3(c).
   * Each MUST already be canonical: matching is set-intersection against a
   * binding's canonicalized remotes, so a non-canonical alias matches
   * nothing (decision 3).
   */
  aliases?: string[];
  role?: 'primary' | 'secondary';
  label?: string;
  defaultBranch?: string;
}

/**
 * A resource with no remote at all — a local-only repository, a plain
 * directory, or Station's seeded `default` project. Explicitly non-portable
 * (§3.3 residual case, §9 OQ-8): it resolves for its author and reports
 * `not-portable` (§3.6) to everyone else. `id` here is manifest-local, not a
 * join key any other Station can use — but the record still replicates, so
 * the id is constrained to `local:<name>` (decision 4).
 */
export interface ProjectLocalOnlyResource {
  kind: 'local-only';
  /** `^local:[A-Za-z0-9._-]+$` — never a filesystem path. Enforced. */
  id: string;
  label?: string;
  /**
   * Present for the same reason it is on a git resource (decision 10): with
   * `role` on git resources only, a manifest holding two local-only resources
   * and no git resource could not declare a primary and would be refused for
   * a shape that is otherwise legal.
   */
  role?: 'primary' | 'secondary';
}

export type ProjectRepoResource =
  | ProjectGitRepoResource
  | ProjectLocalOnlyResource;

/**
 * A knowledge root. `root.path` (when `kind === 'repo'`) is REPO-RELATIVE —
 * never absolute, tilde-prefixed, or `..`-escaping. The validator enforces
 * this; see decision 1 above.
 */
export interface ProjectKnowledgeRef {
  namespaceId: string;
  root:
    | { kind: 'station-managed' }
    | {
        kind: 'repo';
        /** Must name a resource present in the manifest's `repos[]`. */
        repoId: string;
        /** Repo-relative. Never `^[~/]`, a drive-letter/UNC path, or `..`-escaping. */
        path: string;
      };
}

export interface ProjectIntegrationRef {
  id: string;
  kind: 'mcp';
  auth?: ProjectAuthReference;
}

/**
 * Auth by reference — the datum idiom (§3.4), copied verbatim rather than
 * paraphrased. Exactly ONE of these four keys may be present on a given
 * reference; the validator rejects both zero and more than one. A reference
 * is never a value: no field here may ever hold a literal secret.
 */
export type ProjectAuthReference =
  | { env: string }
  | { keychain: { service: string; account?: string } }
  | { op: string }
  /**
   * Station's own addition (§3.4): resolves through the existing
   * `<home>/integrations/<id>/` store. The three datum backends above stay
   * valid for provider auth, where datum is already the resolver.
   */
  | { station: string };

export interface ProjectManifest {
  schemaVersion: typeof PROJECT_MANIFEST_SCHEMA_VERSION;
  /**
   * Portable, opaque, generated once at manifest creation. NEVER derived
    * from a repo, path, or machine — a project may span repos, change repos,
    * or have none. This is the join key archive#1392/archive#1123/archive#1409 need and `slug`
    * (below) is explicitly not (§9 OQ-1, §9 OQ-5).
   */
  id: string;
  /**
   * The LOCAL naming/routing key (§9 OQ-5) — on-disk directory,
   * `/api/projects/:slug/*` routes, `LayoutConfig.projectSlug`. Stays local;
   * NOT the portable join key. Two Stations may use different slugs for the
   * same manifest `id`.
   */
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  repos: ProjectRepoResource[];
  knowledge: ProjectKnowledgeRef[];
  /** Agent slugs. Referenced by id only; agent bodies stay in the agent store. */
  agents: string[];
  integrations: ProjectIntegrationRef[];
  /** Layout ids only; layout bodies stay in the layout store. */
  layouts: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Binding store (§3.5) — private, per-Station, per-member. Never leaves the
// machine (never replicated, never part of a manifest, never what a peer
// reads — see decision 6/7 above).
// ---------------------------------------------------------------------------

export interface ProjectBindingStore {
  schemaVersion: typeof PROJECT_BINDING_STORE_SCHEMA_VERSION;
  /** Reserved; always `"local"` until archive#1392 introduces real membership. */
  memberId: string;
  /**
   * Machine-local SSH host-alias rewriting (`{"github-work": "github.com"}`),
   * applied BEFORE canonicalization when reading a local checkout's remotes
   * (§3.3(a)). Never applied to the manifest side.
   */
  hostAliases: Record<string, string>;
  bindings: ProjectBinding[];
  credentialBindings: ProjectCredentialBinding[];
}

export interface ProjectBinding {
  projectId: string;
  resourceId: string;
  kind: 'git-checkout' | 'local-directory';
  /**
   * Stored EXACTLY as the user gave it, tilde preserved. Canonicalized at
   * each read by the resolver, in one place — see decision 6
   * above.
   */
  path: string;
  /**
   * Canonicalized at WRITE, because this is a key: matching against a
   * manifest resource is set-intersection against `{ canonicalRemote } ∪
   * aliases` (§3.3(b)).
   */
  remotes: string[];
  /** An OBSERVATION, not a guarantee (§3.5 decision 7) — epoch ms. */
  verifiedAt: number;
  state: 'bound' | 'stale' | 'missing' | 'drifted';
}

/** Availability only — never a value (§3.4's projection discipline). */
export interface ProjectCredentialBinding {
  projectId: string;
  integrationId: string;
  available: boolean;
  checkedAt: number;
}

// ---------------------------------------------------------------------------
// Resolution states (§3.6) — a backing Station's view of one resource.
// ---------------------------------------------------------------------------

/**
 * §3.6's states, plus `ambiguous`. They collapse to three UI tones
 * (ready / repairable / not-for-you) but stay distinct in the contract
 * because the repair differs.
 */
export type ResourceResolution =
  | 'bound'
  /**
   * **Nothing on this Station records a realization of this resource** — no
   * binding row, and no declared `workingDirectory` on the compat branch (or,
   * for an explicitly-asked `resourceId`, nothing by that name). The
   * spec-analogue of hachure's `unknown`: no claim exists, so there is nothing
   * to appraise.
   *
    * NARROWED in archive#1594. It previously ALSO covered "a directory is
     * declared and it is gone", which is a claim that failed live verification —
     * a different fact with a different repair, and one the session-cwd seam
     * treats OPPOSITELY (archive#1023 `$HOME` terminus vs archive#791 fail-closed). That case
   * is now `missing`.
   */
  | 'unbound'
  /**
    * **A recorded realization whose path does not exist.** The record is either
    * a binding row or — since archive#1594 — the compat branch's declared
   * `workingDirectory`, which §5 makes the compat-era binding
   * ("`workingDirectory` stays authoritative during compat"). `record` says
   * which, and `declaredPath` says what it said.
   */
  | 'missing'
  | 'drifted'
  | 'stale'
  | 'unresolvable'
  | 'not-portable'
  /**
    * No single resource could be named: a manifest with several resources and
    * no unique `primary`, or one that declares no resources at all
    * (archive#1499), because §3.6's table has no state for it, and the
   * alternatives both lie — `unbound` implies a resource exists that is
   * merely not set up here, and `unresolvable` means "you were denied",
   * which collapses a configuration problem into an access one.
   */
  | 'ambiguous';

/**
 * Every {@link ResourceResolution} member as a runtime value. Resolution
 * results are read
 * off disk, where the TypeScript union proves nothing —
 * {@link isWellFormedResolution} checks membership against this set rather
 * than trusting the declared type.
 *
 * **Adding a union member without adding it here is a silent break**, and it
 * has nearly happened in practice: the array and a new
 * union member arrived on separate branches, and git
 * merged both cleanly. `isWellFormedResolution` would then have rejected
 * every `ambiguous` result — which the resolver asserts on its own output and
 * throws on — with no test on either branch able to see it, because neither
 * branch had both changes. `assertsAllResolutionStates` below is the tripwire.
 */
export const RESOURCE_RESOLUTION_STATES = [
  'bound',
  'unbound',
  'missing',
  'drifted',
  'stale',
  'unresolvable',
  'not-portable',
  'ambiguous',
  // `as const satisfies` and NOT a `readonly ResourceResolution[]` annotation:
  // the annotation widens every element to the full union, which makes
  // `(typeof …)[number]` the union itself and the exhaustiveness proof below
  // `Exclude<X, X> extends never`, i.e. VACUOUSLY true. It was — dropping
  // `'ambiguous'` from this array left `npm run typecheck` green
  // (archive#1499 fault injection N3). `satisfies` keeps the literal tuple type while still
  // checking that every member is a real state.
] as const satisfies readonly ResourceResolution[];

/**
 * Compile-time proof that {@link RESOURCE_RESOLUTION_STATES} covers the whole
 * union: a member added to the type but not to the array makes this a type
 * error. Cheaper than the runtime test, and it fails in the editor.
 */
type _ResolutionStatesAreExhaustive =
  Exclude<
    ResourceResolution,
    (typeof RESOURCE_RESOLUTION_STATES)[number]
  > extends never
    ? true
    : never;
const _resolutionStatesAreExhaustive: _ResolutionStatesAreExhaustive = true;
void _resolutionStatesAreExhaustive;

/**
 * Which record declared the path a `missing` resolution could not find.
 *
 * Both are realizations this Station recorded; they differ in what an operator
 * edits to repair one. A `binding` row is the per-Station store (§3.5); a
 * `working-directory` is the compat-era binding §5 keeps authoritative until
 * real binding rows replace it. Carried as a discriminator rather than as prose
 * because the repair prompt and the surface that owns it differ.
 */
export type ResourceRealizationRecord = 'binding' | 'working-directory';

/**
 * The shape `resolveProjectResource` returns — a DISCRIMINATED UNION
 * on `state` (archive#1594).
 *
 * ## Why a union, and what it forces
 *
 * The pre-union shape was one flat interface with `path?` and `reason?`, which
 * meant every producer could omit any observation and every consumer could
 * read `.path` unguarded. Both happened. The union makes each state carry
 * exactly the fields its own honesty requires, so a producer that omits one
 * and a consumer that reads `.path` without narrowing to `bound` are both
 * COMPILE errors rather than silent behavior. {@link isWellFormedResolution}
 * remains the runtime backstop for producers the type system cannot see
 * (results read off disk, JS callers).
 *
 * ## The two slots, and why `unverifiedPath` is not a hole in the path rule
 *
 * The invariant — "a resolution carrying a path on a non-`bound` state
 * is forbidden" — stands, *as its purpose demands*. Its purpose is that `path`
 * is the **answer slot**: the caller asked "where is the verified checkout of
 * resource X" and only `bound` may answer, because only `bound` performed the
 * live check. That is unchanged; `path` exists on `bound` and nowhere else.
 *
 * `unverifiedPath` is a differently named, per-state-REQUIRED **observation
 * slot**, and its name is the warning. `stale` and `drifted` are only ever
 * emitted AFTER `existsSync` has already passed, so the resolver holds an
 * existing absolute path at the moment it constructs them. A contract
 * that forbade it from saying so structurally while every `reason` already
 * embedded the same path in prose left consumers choosing between
 * parsing prose and 404ing a perfectly good directory. A contract that knows
 * a fact and refuses to state it is lying by
 * omission.
 *
 * **Two questions, one derivation point.** The repo-question ("the verified
 * checkout of X") is `path`, `bound` only. The directory-question ("the
 * project's realized directory, for `.flow`/`.veritas`/session cwd") is the
 * weaker `path ?? unverifiedPath`. Fold it in ONE place in your application
 * and have every seam call that; written per-seam it becomes several
 * independently-drifting opinions about what `drifted` means. (Station itself
 * does this in `project-workspace-path.ts`; that module is not part of this
 * package's public surface, so the discipline is the contract here, not the
 * file.)
 *
 * ## The invariants, all enforced by {@link isWellFormedResolution}
 *
 * - `state` is one of the {@link ResourceResolution} members.
 * - `resourceId` is a non-empty string for every state EXCEPT `ambiguous`
 *   (§3.6 rule 3: the resource is NAMED when `unresolvable` renders).
 *   `ambiguous` is the one state that exists BECAUSE no single resource could
 *   be named, so it is required to be EMPTY there: a non-empty id on an
 *   `ambiguous` result would claim a resource was identified while the state
 *   says the opposite, and the candidates belong in `reason`. This is the
 *   second half of the cross-branch trap {@link RESOURCE_RESOLUTION_STATES}
 *   records — "non-empty, always" was written when the union had no state
 *   for "nothing to name", and `ambiguous` then produced exactly that state.
 * - `path` is present ONLY when `state === 'bound'`.
 * - `reason` is REQUIRED for every non-`bound` state (§3.6 rule 3:
 *   "unresolvable" — and every other non-bound state — "is never an empty
 *   result").
 * - `unverifiedPath` is REQUIRED and non-empty on `stale`/`drifted`, and
 *   FORBIDDEN everywhere else.
 * - `record` and `declaredPath` are REQUIRED on `missing`, and FORBIDDEN
 *   everywhere else.
 *
 * @experimental This vocabulary has changed repeatedly (`ambiguous`
 * added, then the `unbound`/`missing` split and the observation slots).
 * It is published, but it is not settled until real binding rows are
 * written and the remaining seams migrate onto it — treat a minor
 * version of `@kontourai/station-contracts` as able to change it.
 */
export type ResourceResolutionResult =
  | { state: 'bound'; resourceId: string; path: string }
  | { state: 'unbound'; resourceId: string; reason: string }
  | {
      state: 'missing';
      resourceId: string;
      reason: string;
      /** Which record declared {@link declaredPath}. */
      record: ResourceRealizationRecord;
      /**
       * The path as the record STATES it — tilde-preserved and verbatim, the
       * string an operator edits to repair it. Deliberately not the absolutized
       * form: a consumer that needs that already computed it, and re-deriving
       * tilde expansion in two places is how two readers come to disagree
       * about what one record says.
       */
      declaredPath: string;
    }
  | {
      state: 'stale';
      resourceId: string;
      reason: string;
      /** See the type docblock: an OBSERVATION, never the answer. */
      unverifiedPath: string;
    }
  | {
      state: 'drifted';
      resourceId: string;
      reason: string;
      /** See the type docblock: an OBSERVATION, never the answer. */
      unverifiedPath: string;
    }
  /** `resourceId` is required EMPTY — no single resource was named. */
  | { state: 'ambiguous'; resourceId: ''; reason: string }
  | { state: 'unresolvable'; resourceId: string; reason: string }
  | { state: 'not-portable'; resourceId: string; reason: string };

/**
 * Pure predicate enforcing the §3.5/§3.6 honesty invariants documented on
 * {@link ResourceResolutionResult}. A future producer of this shape that
 * silently drops the `reason` on a repair state, leaks a `path` on a
 * non-`bound` state, drops the observation a repair state is required to
 * carry, fails to NAME the resource, or writes a state outside the union,
 * fails this check rather than shipping quietly.
 *
 * The parameter is `unknown` ON PURPOSE. Since archive#1594 the result type is
 * a discriminated union, so an in-repo TypeScript producer of a malformed
 * shape is already a compile error and this predicate would be unreachable for
 * it. What remains is exactly what the check is for: values that arrive
 * WITHOUT a compiler — a result read off disk, a JS caller, a producer built
 * against an older version of this package. Typing the parameter as the union
 * would have made those inexpressible and quietly reduced the predicate to a
 * tautology.
 */
export function isWellFormedResolution(
  result: unknown,
): result is ResourceResolutionResult {
  if (!isPlainObject(result)) return false;
  const { state, resourceId } = result;
  if (
    typeof state !== 'string' ||
    !(RESOURCE_RESOLUTION_STATES as readonly string[]).includes(state)
  ) {
    return false;
  }
  if (typeof resourceId !== 'string') return false;
  if (state === 'ambiguous') {
    // The state means "no single resource could be named". An id here would be
    // a name for something the state says does not exist; the candidates are
    // the `reason`'s job.
    if (resourceId.length > 0) return false;
  } else if (resourceId.length === 0) {
    return false;
  }

  // The ANSWER slot. Only `bound` may answer, and it must.
  if (state === 'bound') {
    if (typeof result.path !== 'string' || result.path.length === 0) {
      return false;
    }
  } else if (result.path !== undefined) {
    return false;
  }

  // Every non-`bound` state carries its repair prompt.
  if (
    state !== 'bound' &&
    (typeof result.reason !== 'string' || result.reason.length === 0)
  ) {
    return false;
  }

  // The OBSERVATION slot: required where the resolver has already seen the
  // directory, forbidden where it has not. Forbidding it elsewhere is the half
  // that matters — a `missing` or `unbound` result carrying one would be
  // exactly the "a path appears on a state that never checked it" leak the
  // path invariant exists to prevent.
  if (state === 'stale' || state === 'drifted') {
    if (
      typeof result.unverifiedPath !== 'string' ||
      result.unverifiedPath.length === 0
    ) {
      return false;
    }
  } else if (result.unverifiedPath !== undefined) {
    return false;
  }

  // The DECLARATION slot: a `missing` result names the record and what it said,
  // because "re-point or re-clone" is unactionable without both.
  if (state === 'missing') {
    if (result.record !== 'binding' && result.record !== 'working-directory') {
      return false;
    }
    if (
      typeof result.declaredPath !== 'string' ||
      result.declaredPath.length === 0
    ) {
      return false;
    }
  } else if (result.record !== undefined || result.declaredPath !== undefined) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// The project-level view (§3.6 preamble, §4.1) — archive#1502.
// ---------------------------------------------------------------------------

/**
 * The three postures a Station can be in with respect to one project, as the
 * surface that renders it must distinguish them. See
 * {@link ProjectResolutionView}.
 */
export type ProjectResolutionPosture = 'not-backing' | 'backing' | 'unreadable';

/**
 * Runtime membership set for {@link ProjectResolutionPosture}, for the same
 * reason {@link RESOURCE_RESOLUTION_STATES} exists: a view read off the wire
 * carries no compiler, so `isWellFormedProjectResolutionView` checks
 * membership against this array rather than trusting the declared type.
 */
export const PROJECT_RESOLUTION_POSTURES = [
  'not-backing',
  'backing',
  'unreadable',
  // `as const satisfies` and NOT a `readonly ProjectResolutionPosture[]`
  // annotation — see the identical comment on RESOURCE_RESOLUTION_STATES. The
  // annotation widens every element to the full union, which makes the
  // exhaustiveness proof below `Exclude<X, X> extends never`, i.e. VACUOUSLY
  // true, and dropping a member from this array stays green.
] as const satisfies readonly ProjectResolutionPosture[];

/**
 * Compile-time proof that {@link PROJECT_RESOLUTION_POSTURES} covers the whole
 * union: a posture added to the type but not to the array is a type error.
 */
type _ProjectResolutionPosturesAreExhaustive =
  Exclude<
    ProjectResolutionPosture,
    (typeof PROJECT_RESOLUTION_POSTURES)[number]
  > extends never
    ? true
    : never;
const _projectResolutionPosturesAreExhaustive: _ProjectResolutionPosturesAreExhaustive = true;
void _projectResolutionPosturesAreExhaustive;

/**
 * What one Station can truthfully say about one project's resources — the
 * shape `GET /api/projects/:slug/resolution` returns and the settings surface
 * renders (archive#1502).
 *
 * ## The discriminator is the Station's POSTURE, not a resource state
 *
 * A {@link ResourceResolutionResult} answers "what happened when this Station
 * tried to resolve resource X". This type answers the question that comes
 * BEFORE it: "is there a resource question to ask at all?" Those are different
 * questions with different audiences, and flattening them is the defect §4.1
 * names.
 *
 * ### `not-backing` is a first-class PROJECT-level outcome, not a resource state
 *
 * §4.1: "A member who brings no resources is a first-class role." Someone who
 * joins a project to collaborate, review, or decide — with no checkout and no
 * local tooling — is **not an empty-bindings edge case to be nudged toward
 * completeness**, and §4.1 enumerates five things they must never be shown: a
 * repair prompt, an "unresolvable for you" badge, a per-resource state table,
 * a clone call-to-action, or any UI that reads as an incomplete setup.
 *
 * That is why this is a posture and not a ninth `ResourceResolution` member.
 * Every member of that union is an ANSWER ABOUT A RESOURCE, and every one of
 * them (except `bound`) carries a `reason` whose §3.6 row is a repair. A
 * "nothing here" resource state would inherit the repair framing structurally
 * — the renderer would reach it through the same per-resource branch, in the
 * same table, next to the same prompts — which is precisely the revision-1
 * mistake §4.1 corrects: "the repair framing is right for a member who *is
 * trying to back* the project and cannot; it is wrong for a member who never
 * intended to."
 *
 * `not-backing` is therefore **unremarkable, and rendered as such** — a fact
 * about this Station, not a deficiency, and not a degenerate or incomplete
 * case of `backing`. It carries no fields at all, deliberately: there is no
 * resource, no path, and nothing to repair, and a field here would be
 * something for a surface to render as a gap.
 *
 * ### `unreadable` exists because "could not read" is not "nothing here"
 *
 * `readProjectManifest` throws for three distinct shapes —
 * `ProjectManifestSchemaVersionError` (a version this Station does not
 * understand), `ProjectManifestUnreadableError` (content that does not parse
 * or does not validate), and `ProjectManifestIncompleteError` (a zero-length
 * sidecar, the signature of an interrupted write). A surface that swallowed
 * those and fell through to `not-backing` would tell an operator that this
 * Station backs nothing, about a project whose manifest merely could not be
 * READ. That is a lie in the most damaging direction available here: it
 * describes a repairable local fault as a settled, unremarkable state, and
 * §4.1 guarantees the `not-backing` rendering shows no repair prompt — so the
 * one thing the operator needs would be structurally suppressed.
 *
 * `reason` is required non-empty for the same reason every non-`bound`
 * resolution's is (§3.6 rule 3): an honest unavailable names what was
 * unavailable. It is the error's message, not a stack trace.
 *
 * ### `resources` is ONE PER DECLARED RESOURCE (archive#1503)
 *
 * An earlier revision of this view shipped a singular `resource`, built from
 * the no-`resourceId`
 * call — "deliberately singular rather than a one-element array so that change
 * is a visible contract change rather than a silent semantic one". This is that
 * visible change. The view now resolves EVERY declared resource by id and
 * carries the results in declaration order, because §10 makes the states "what
 * make a partially-bound multi-repo project legible" and a project with 2 of 3
 * repos bound cannot be described by one result of any kind.
 *
 * `resources` is not a selection: nothing is picked, ranked, or dropped, so the
 * `composeManifest` trap (a candidate manifest returned verbatim when the ONLY
 * failures are §3.5 selection ambiguities) is not reachable through it — two
 * primaries, no primary, and one primary all yield the same id set.
 *
 * ### `primary` is carried separately, because the ambiguity is a separate fact
 *
 * Resolving per id would otherwise SILENCE the ambiguity signal the singular
 * view relied
 * on: a manifest declaring two primaries would render as N healthy rows while
 * every no-`resourceId` consumer in Station (the session cwd, the knowledge
 * scan, the task workspace) still fails `ambiguous`. That is the honesty bar's
 * "a gate reports clean over the scope it can see, and says nothing about the
 * rest" — so the primary selection is its own field, derived by
 * {@link selectPrimaryResource}, and a surface that renders `resources` without
 * it is describing a project that cannot be started in.
 *
 * An empty `resources` is therefore never the signal either: it is only legal
 * alongside `primary.named === false`, which names why, and
 * {@link isWellFormedProjectResolutionView} enforces exactly that.
 *
 * ### What this type deliberately does NOT carry
 *
 * `manifest.repos`. `ProjectManifestStore.composeManifest` returns a candidate
 * manifest VERBATIM, with `repos` populated, even when validation FAILED —
 * whenever the only diagnostics are §3.5 selection ambiguities (its decision
 * 7). The returned object carries no flag and is structurally
 * indistinguishable from a valid one, so a consumer that iterated `repos`
 * would render two resources both marked `primary` as though the project
 * resolved cleanly. `resolveProjectResource` is the ONLY carrier of that
 * signal, as `state: 'ambiguous'`, and this view carries its result and
 * nothing else.
 *
 * @experimental Slice 4's first user-visible surface, over a vocabulary
 * `ResourceResolutionResult` marks `@experimental` for the same reason. Treat
 * a minor version of `@kontourai/station-contracts` as able to change it.
 */
export type ProjectResolutionView =
  /** Nothing declared here and nothing realized here — §4.1, and unremarkable. */
  | { posture: 'not-backing' }
  /** This Station backs the project, or is setting up to (§3.6 preamble). */
  | {
      posture: 'backing';
      /** One per DECLARED resource, in declaration order. Never a selection. */
      resources: ResourceResolutionResult[];
      /** Which resource a no-`resourceId` caller gets, or why none can be named. */
      primary: ProjectPrimaryResourceSelection;
    }
  /** The manifest exists and could not be read. Never rendered as `not-backing`. */
  | { posture: 'unreadable'; reason: string };

/**
 * Which resource answers a request that names none — the fact §3.5's optional
 * `resourceId` parameter turns on, carried on the view because per-resource
 * resolution would otherwise hide it (see
 * {@link ProjectResolutionView}).
 *
 * Deliberately NOT `ProjectPrimarySelection`: that type carries whole
 * `ProjectRepoResource` objects, and this view's contract is that
 * `manifest.repos` never crosses this boundary. It carries the id and the
 * reason, which is what a surface can render and what a caller can act on.
 */
export type ProjectPrimaryResourceSelection =
  | { named: true; resourceId: string }
  /**
   * Required non-empty, for the same reason every non-`bound` resolution's
   * `reason` is (§3.6 rule 3): an honest unavailable names what was unavailable
   * and what the repair is. The candidates belong in here, because the state
   * exists precisely because no single resource could be named.
   */
  | { named: false; reason: string };

/**
 * Runtime backstop for {@link ProjectResolutionView}, in the same style and
 * for the same reason as {@link isWellFormedResolution} — whose docblock
 * explains why the parameter is `unknown` on purpose. In short: the union
 * makes an in-repo TypeScript producer's mistakes compile errors, so what is
 * left for a predicate is exactly the values that arrive WITHOUT a compiler.
 * This one crosses the wire on every settings render, which is the largest
 * such population in the arc.
 *
 * Rejects, specifically:
 * - an unknown (or non-string) `posture`;
 * - `resources` or `primary` on a non-`backing` posture — a `not-backing` view
 *   that carried either would be §4.1's per-resource row smuggled through the
 *   posture that exists to guarantee its absence;
 * - a missing or ill-formed entry in `resources` on `backing` (delegated whole
 *   to {@link isWellFormedResolution}, so the slot invariants have one authority
 *   and cannot drift);
 * - a DUPLICATED `resourceId` across entries — a list keyed by resource that
 *   answers twice for one resource has answered for neither;
 * - an EMPTY `resources` paired with a NAMED primary, and a named primary whose
 *   `resourceId` is not among the resolved entries: both are the list and the
 *   selection disagreeing about what the manifest declares, which is exactly
 *   the fact `primary` is carried in order to expose;
 * - an absent or empty `reason` on `unreadable` or on an unnamed `primary`, and
 *   a `reason` on any other posture.
 */
export function isWellFormedProjectResolutionView(
  value: unknown,
): value is ProjectResolutionView {
  if (!isPlainObject(value)) return false;
  const { posture } = value;
  if (
    typeof posture !== 'string' ||
    !(PROJECT_RESOLUTION_POSTURES as readonly string[]).includes(posture)
  ) {
    return false;
  }

  if (posture === 'backing') {
    if (!Array.isArray(value.resources)) return false;
    for (const entry of value.resources) {
      if (!isWellFormedResolution(entry)) return false;
    }
    const ids = (value.resources as ResourceResolutionResult[]).map(
      (entry) => entry.resourceId,
    );
    if (new Set(ids).size !== ids.length) return false;
    if (!isWellFormedPrimarySelection(value.primary)) return false;
    // The selection must name something the list answered for. A primary
    // pointing outside `resources` would send every no-`resourceId` consumer at
    // a resource this view never resolved — and on an EMPTY list it would claim
    // a primary for a manifest that declares nothing. An unnamed primary
    // alongside an empty list is the one shape in which the empty is legal, and
    // `primary.reason` is what names it, so the empty is never the signal.
    if (value.primary.named && !ids.includes(value.primary.resourceId)) {
      return false;
    }
  } else if (value.resources !== undefined || value.primary !== undefined) {
    return false;
  }

  // The removed singular field is refused on EVERY
  // posture, including `backing`.
  //
  // This predicate is not an exact-key-set check, so when `resource` was
  // renamed
  // to `resources` the old field silently became just another
  // unknown key and started passing — while this docblock still claimed to
  // reject "§4.1's per-resource row smuggled through the posture that exists to
  // guarantee its absence". The guard lost the only field it had ever policed,
  // and it lost it for exactly the producer its own docblock names as its
  // population: "a build against an older version of this package", which is
  // precisely what emits `resource`.
  //
  // An older server's `{posture: 'not-backing', resource: {…}}$ must be
  // refused, not quietly accepted as a view with a stray field — the SDK turns
  // that refusal into a named "this Station is running a newer version than
  // this app" error, which is the honest reading of a shape mismatch.
  if (value.resource !== undefined) return false;

  if (posture === 'unreadable') {
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      return false;
    }
  } else if (value.reason !== undefined) {
    return false;
  }

  return true;
}

/** Runtime backstop for {@link ProjectPrimaryResourceSelection}. */
export function isWellFormedPrimarySelection(
  value: unknown,
): value is ProjectPrimaryResourceSelection {
  if (!isPlainObject(value)) return false;
  if (value.named === true) {
    return (
      typeof value.resourceId === 'string' &&
      value.resourceId.length > 0 &&
      value.reason === undefined
    );
  }
  if (value.named === false) {
    return (
      typeof value.reason === 'string' &&
      value.reason.length > 0 &&
      value.resourceId === undefined
    );
  }
  return false;
}

/**
 * The id a project's single local-only resource carries — before backfill, and
 * after it for a project with no git checkout to derive an identity from.
 *
 * It lives in the contract rather than in the resolver because two independent
 * surfaces must agree on it: the resolver MINTS it, and the settings surface
 * must recognise it in order NOT to print it. `project-resource-resolver.ts`
 * records it as a DISCLOSED GAP — "an id observed in that window is not the id
 * the manifest will settle on" — so it is a transient internal id, and a
 * surface that showed it to an operator would be naming, as the thing that
 * resolves, a string that changes the moment the project gains a remote.
 */
export function localProjectResourceId(projectSlug: string): string {
  return `local:${projectSlug}`;
}

/**
 * `POST /api/projects/:slug/bind`'s answer (archive#1502).
 *
 * ## Why this is not just a {@link ProjectResolutionView}
 *
 * The route does two things in sequence: it WRITES the binding row, and then
 * it re-derives the view. The write is durable the instant it returns; the
 * re-derivation is a fresh read that can fail on its own (an unreadable
 * project record, a resolver throw). Answering that second failure with
 * `success: false` reports a completed write as "that checkout was not
 * recorded" — a false negative about durable state, which is the
 * assert-then-retract inversion in its most damaging direction: the operator
 * is told to retry a repair that already succeeded.
 *
 * So the outcome is a union. `recorded` is `true` on both arms because it is
 * true on both arms — the row exists either way — and the difference is
 * whether this Station can also say what it now resolves to. A `gap` is a
 * NAMED absence, never an empty view and never a guessed one.
 */
export type ProjectResourceBindOutcome =
  /** Recorded, and here is what this Station can now truthfully say. */
  | { recorded: true; view: ProjectResolutionView }
  /** Recorded — and re-reading what it now resolves to failed. `gap` says how. */
  | { recorded: true; gap: string };

/**
 * Runtime backstop for {@link ProjectResourceBindOutcome}, for the same reason
 * {@link isWellFormedProjectResolutionView} exists: this value arrives over
 * the wire without a compiler.
 *
 * Rejects a `recorded` that is not literally `true` (the client must never
 * read "recorded" out of a shape that did not assert it), an outcome carrying
 * BOTH a view and a gap or NEITHER, an ill-formed view (delegated whole to
 * {@link isWellFormedProjectResolutionView}, so the slot invariants keep one
 * authority), and an absent or empty `gap`.
 */
export function isWellFormedProjectResourceBindOutcome(
  value: unknown,
): value is ProjectResourceBindOutcome {
  if (!isPlainObject(value)) return false;
  if (value.recorded !== true) return false;

  const hasView = value.view !== undefined;
  const hasGap = value.gap !== undefined;
  if (hasView === hasGap) return false;

  if (hasView) return isWellFormedProjectResolutionView(value.view);
  return typeof value.gap === 'string' && value.gap.length > 0;
}

// ---------------------------------------------------------------------------
// Primary selection (§3.5) — the same rule the validator enforces, as a
// function a resolver can apply. See decision 11.
// ---------------------------------------------------------------------------

/**
 * A §3.5 primary-cardinality failure: the manifest is READABLE, but no single
 * resource can be selected from it. Every member of this union is a
 * {@link ProjectManifestDiagnosticCode} too, except `no-resources-declared` —
 * a manifest that declares no resources at all is VALID (a project may exist
 * before its resources do), so the validator has nothing to report there while
 * a resolver asked for "the primary" still has nothing to name.
 */
export type ProjectSelectionAmbiguityCode =
  | 'multiple-primaries-declared'
  | 'no-primary-declared'
  | 'sole-resource-declared-secondary';

export type ProjectPrimarySelectionFailureCode =
  | ProjectSelectionAmbiguityCode
  | 'no-resources-declared';

export type ProjectPrimarySelection =
  | { ok: true; resource: ProjectRepoResource }
  | {
      ok: false;
      code: ProjectPrimarySelectionFailureCode;
      /**
       * The resources among which no choice could be made, in declaration
       * order — the set a caller must NAME rather than pick from (§3.6 rule 3,
       * and the honesty bar's "exact match or an honest unavailable"). Empty
       * only for `no-resources-declared`.
       */
      candidates: ProjectRepoResource[];
    };

/**
 * Decision 10's rule, applied. `validateRepoCollection` below enforces the same
 * rule at validation time and keeps its own message wording (which names
 * indexes, and which runs over values that are not yet known to be
 * well-shaped); this function is what a consumer that already HOLDS a manifest
 * calls to select. The two are held in agreement by an explicit table test in
 * `__tests__/project-identity.test.ts` rather than by hope.
 *
 * Never guesses: `repos[0]`, "the newest", or "the only git one" are all coin
 * flips presented as fact.
 */
export function selectPrimaryResource(
  repos: readonly ProjectRepoResource[],
): ProjectPrimarySelection {
  if (repos.length === 0) {
    return { ok: false, code: 'no-resources-declared', candidates: [] };
  }
  // Counted across BOTH kinds: `role` is on `local-only` resources too
  // (decision 10), so a manifest of only local-only resources can name a
  // primary, and a git-only filter here would report a manifest the validator
  // accepts as ambiguous.
  const primaries = repos.filter((repo) => repo.role === 'primary');
  if (primaries.length === 1) return { ok: true, resource: primaries[0] };
  if (primaries.length > 1) {
    return {
      ok: false,
      code: 'multiple-primaries-declared',
      candidates: [...primaries],
    };
  }
  if (repos.length === 1) {
    // §3.5: the sole resource of a single-resource manifest IS its primary —
    // unless it declared otherwise, in which case treating it as the primary
    // would contradict the document rather than read it.
    return repos[0].role === 'secondary'
      ? {
          ok: false,
          code: 'sole-resource-declared-secondary',
          candidates: [repos[0]],
        }
      : { ok: true, resource: repos[0] };
  }
  return { ok: false, code: 'no-primary-declared', candidates: [...repos] };
}

// ---------------------------------------------------------------------------
// Validator (§2.5's KnownEnvironment lesson: fail-closed, no truthy
// coercion, errors accumulate rather than throwing at the first problem).
// ---------------------------------------------------------------------------

/**
 * How a single validation failure should be TREATED, independent of how it
 * reads (decision 11). `manifest-invalid` is the default channel: a document
 * this reader cannot trust. `schema-version-unknown` is called out separately
 * because it gates every other assertion (decision 2) and a consumer may want
 * to say "written by a newer Station" rather than "malformed". The
 * {@link ProjectSelectionAmbiguityCode}s are the readable-but-unselectable
 * class.
 *
 * A `field` is deliberately NOT carried: every message already begins with the
 * field path it concerns, and duplicating it would mean touching ~50 push
 * sites to introduce a second channel that can drift from the first.
 */
export type ProjectManifestDiagnosticCode =
  | 'manifest-invalid'
  | 'schema-version-unknown'
  | ProjectSelectionAmbiguityCode;

export interface ProjectManifestDiagnostic {
  code: ProjectManifestDiagnosticCode;
  /** Byte-identical to the corresponding entry in `errors`. */
  message: string;
}

/**
 * The selection-ambiguity codes as runtime values. A code added to
 * {@link ProjectSelectionAmbiguityCode} but not here would be silently
 * classified as unreadable — fail-closed, but wrongly — so the same
 * compile-time exhaustiveness proof {@link RESOURCE_RESOLUTION_STATES} carries
 * is applied below.
 */
export const SELECTION_AMBIGUITY_CODES = [
  'multiple-primaries-declared',
  'no-primary-declared',
  'sole-resource-declared-secondary',
  // `as const satisfies`, for the reason recorded on
  // {@link RESOURCE_RESOLUTION_STATES}: an annotation here would widen the
  // elements and make the proof below vacuous.
] as const satisfies readonly ProjectSelectionAmbiguityCode[];

type _SelectionCodesAreExhaustive =
  Exclude<
    ProjectSelectionAmbiguityCode,
    (typeof SELECTION_AMBIGUITY_CODES)[number]
  > extends never
    ? true
    : never;
const _selectionCodesAreExhaustive: _SelectionCodesAreExhaustive = true;
void _selectionCodesAreExhaustive;

/** True when this failure leaves the manifest readable but unselectable. */
export function isSelectionAmbiguityDiagnostic(
  diagnostic: ProjectManifestDiagnostic,
): boolean {
  return (SELECTION_AMBIGUITY_CODES as readonly string[]).includes(
    diagnostic.code,
  );
}

/**
 * True when EVERY reported failure is a selection ambiguity — the only case in
 * which a consumer may keep reading the document (decision 11). One
 * `manifest-invalid` alongside them means the document is untrustworthy and the
 * ambiguity is not the interesting fact about it.
 */
export function isSelectionAmbiguityOnly(
  diagnostics: readonly ProjectManifestDiagnostic[],
): boolean {
  return (
    diagnostics.length > 0 && diagnostics.every(isSelectionAmbiguityDiagnostic)
  );
}

export type ProjectManifestValidationResult =
  | { ok: true; manifest: ProjectManifest }
  | {
      ok: false;
      /** Unchanged: one human-readable sentence per failure, in order. */
      errors: string[];
      /** The same failures, classified — decision 11. Same length, same order. */
      diagnostics: ProjectManifestDiagnostic[];
    };

/**
 * Accumulates failures as classified {@link ProjectManifestDiagnostic}s while
 * keeping `push(message)` — the shape every check below already uses — so the
 * default channel stays `manifest-invalid` and only the three §3.5 cardinality
 * checks have to say anything extra. `errors` is DERIVED from this, so the two
 * projections cannot disagree.
 */
class ManifestDiagnosticCollector {
  readonly diagnostics: ProjectManifestDiagnostic[] = [];

  push(message: string): void {
    this.diagnostics.push({ code: 'manifest-invalid', message });
  }

  pushCoded(code: ProjectManifestDiagnosticCode, message: string): void {
    this.diagnostics.push({ code, message });
  }

  get length(): number {
    return this.diagnostics.length;
  }

  failure(): ProjectManifestValidationResult {
    return {
      ok: false,
      errors: this.diagnostics.map((diagnostic) => diagnostic.message),
      diagnostics: this.diagnostics,
    };
  }
}

/** `^[~/]`, a Windows drive letter, or a UNC prefix — never a valid value in any replicating manifest field (§3.2, decision 1). */
const ABSOLUTE_OR_TILDE_PATH_PATTERN = /^(?:[~/]|[A-Za-z]:[\\/]|\\\\)/;

/**
 * A remote reached over loopback is a local mirror wearing a hostname.
 * `git clone file://localhost/Users/alice/dev/acme` is supported by git and
 * canonicalizes to `localhost/users/alice/dev/acme` — which no longer starts
 * with `/`, so the path pattern alone misses it and the member's home
 * directory replicates in the manifest's most-displayed field.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Is this canonical remote a local clone source rather than a portable one?
 *
 * **Exported because the rule must exist exactly once.** The write side (the
 * backfill, which decides whether a derived remote becomes a `git` or a
 * `local-only` resource) and the read side (this validator) previously had
 * separate implementations, and they were measured diverging in BOTH
 * directions: the writer refused `localhost:2222/org/repo` that the validator
 * accepted (a leak), and the validator refused `.\mirror\repo` that the
 * writer accepted — which persists a manifest that can never be read back,
 * because `ensureProjectManifest` returns the existing record and nothing
 * repairs it. A permanent brick from two functions that were documented as
 * refusing "the same shape". Same fix as `selectPrimaryResource`: one rule,
 * one implementation, both callers.
 *
 * DISCLOSED RESIDUAL: a relative local path with no dot segments — `git clone
 * mirror/repo` records `mirror/repo` — is indistinguishable at the string
 * level from `host/repo` on a single-label host and is NOT caught. Refusing it
 * would need filesystem probing, which is a different kind of check than this
 * pure string rule (§3.3 requires canonicalization to stay pure).
 */
export function isLocalCloneSource(canonicalRemote: string): boolean {
  if (ABSOLUTE_OR_TILDE_PATH_PATTERN.test(canonicalRemote)) return true;
  // Split on BOTH separators: a Windows-style `.\mirror\repo` has no forward
  // slash at all, so a `/`-only split would see the whole string as one
  // segment and miss the leading dot.
  const firstSegment = canonicalRemote.split(/[\\/]/)[0] ?? '';
  if (firstSegment === '.' || firstSegment === '..') return true;
  // Strip a port before comparing, keeping a bracketed IPv6 literal intact —
  // `localhost:2222/org/repo` is as local as `localhost/org/repo`.
  const bracketed = /^\[([^\]]*)\]/.exec(firstSegment);
  const host = bracketed ? bracketed[1] : (firstSegment.split(':')[0] ?? '');
  return LOOPBACK_HOSTS.has(host);
}

/**
 * An `env` reference names an environment variable, so it must be a valid
 * variable name — nothing more.
 *
 * A narrower `UPPER_SNAKE_CASE` rule was tried and reverted. It was reaching
 * for a secret-detection result it cannot honestly deliver: case is a naming
 * convention, not evidence, and enforcing it here would refuse a legitimate
 * lowercase variable while catching only secrets that happen to be lowercase.
 * That is the same shape as the length heuristic decision 5 replaced — a proxy
 * that does not discriminate, presented as a guard. An `env` value is a
 * variable NAME either way; the secret itself never enters the manifest.
 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A `station` reference names an integration id in `<home>/integrations/<id>/` (§3.4). */
const STATION_INTEGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `local:<name>` — the design doc's own §3.2 example grammar (decision 4). */
const LOCAL_ONLY_ID_PATTERN = /^local:[A-Za-z0-9._-]+$/;

/**
 * Known credential prefixes, matched CASE-SENSITIVELY at the start of an
 * auth value because every one of them is case-sensitive in its issuing
 * system. This is a leak signal, not a secret detector — decision 5 states
 * exactly what it does and does not catch.
 */
const SECRET_LITERAL_PREFIXES: readonly string[] = [
  'sk_',
  'sk-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'github_pat_',
  'AKIA',
  'ASIA',
  'xox',
  'AIza',
];

/** A JWT's base64url-encoded header followed by its first `.` separator. */
const JWT_HEADER_PATTERN = /^eyJ[A-Za-z0-9_-]*\./;

function looksLikeSecretLiteral(value: string): boolean {
  if (SECRET_LITERAL_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return true;
  }
  return JWT_HEADER_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-empty and free of control characters — a name, not a blob. */
function isPlainSingleLineString(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Refuses a filesystem path in a field that REPLICATES (decision 1). Applied
 * to free-text and identity fields where the field IS the path; a path
 * mentioned inside prose is out of scope and stated as such.
 */
function rejectFilesystemPath(
  value: unknown,
  fieldPath: string,
  errors: ManifestDiagnosticCollector,
): void {
  if (typeof value !== 'string') return;
  if (ABSOLUTE_OR_TILDE_PATH_PATTERN.test(value)) {
    errors.push(
      `${fieldPath}: must not be a filesystem path — absolute, tilde-prefixed, drive-letter, and UNC values are refused in a replicated manifest field (§3.2)`,
    );
  }
}

/**
 * Why a value is not a usable repo-relative path, or `undefined` when it is one.
 *
 * ONE authority for a rule with two callers on two sides of a boundary
 * (archive#1503): {@link validatePathField} below refuses a manifest
 * that declares a bad path, and Station's knowledge scanner refuses to JOIN one
 * onto a resolved checkout. Two copies of a path-escape rule is the shape
 * `isLocalCloneSource`'s docblock records diverging in BOTH directions —
 * including one that let a write persist a manifest the read side then refused
 * forever. A `path` from a manifest reaches `join(checkoutPath, path)`, so the
 * copy that drifts is a directory traversal out of the repo the operator named.
 */
export type RepoRelativePathProblem =
  | 'not-a-string'
  | 'not-relative'
  | 'escapes-repo'
  | 'empty-segment';

export function repoRelativePathProblem(
  value: unknown,
): RepoRelativePathProblem | undefined {
  if (typeof value !== 'string' || value.length === 0) return 'not-a-string';
  if (ABSOLUTE_OR_TILDE_PATH_PATTERN.test(value)) return 'not-relative';
  // §3.2: every path is relative TO A NAMED REPO. `..` leaves that repo, so
  // it is refused alongside the absolute forms above; both separators are
  // split because a Windows-authored manifest replicates verbatim.
  // One trailing separator is stripped first: `docs/` is an ordinary way to
  // write a directory root and means exactly what the accepted `docs` means.
  // Refusing it for an "empty path segment" the author never perceived writing
  // is a false rejection, not a guard.
  const segments = value.replace(/[\\/]$/, '').split(/[\\/]/);
  if (segments.some((segment) => segment === '..')) return 'escapes-repo';
  // `.` and `./` name the repo root, which is a legitimate knowledge scope
  // ("index the whole repo") and was previously unrepresentable — every
  // spelling of it was refused. It is inside the repo, which is all this
  // check is for.
  if (segments.every((segment) => segment === '.')) return undefined;
  if (segments.some((segment) => segment.length === 0)) return 'empty-segment';
  return undefined;
}

/** {@link repoRelativePathProblem} as a predicate, for a caller with no message to write. */
export function isRepoRelativePath(value: unknown): value is string {
  return repoRelativePathProblem(value) === undefined;
}

function validatePathField(
  value: unknown,
  fieldPath: string,
  errors: ManifestDiagnosticCollector,
): value is string {
  // The MESSAGES stay here, byte-identical to what they were before the rule
  // was extracted: they name a manifest field path, which a knowledge scanner
  // has no business emitting.
  switch (repoRelativePathProblem(value)) {
    case undefined:
      return true;
    case 'not-a-string':
      errors.push(`${fieldPath}: must be a non-empty string`);
      return false;
    case 'not-relative':
      errors.push(
        `${fieldPath}: must be repo-relative — absolute, tilde-prefixed, drive-letter, and UNC paths are refused`,
      );
      return false;
    case 'escapes-repo':
      errors.push(
        `${fieldPath}: must stay inside the named repo — a ".." path segment is refused`,
      );
      return false;
    case 'empty-segment':
      errors.push(`${fieldPath}: must not contain an empty path segment`);
      return false;
  }
}

/**
 * Validates a {@link ProjectAuthReference}. Enforces: exactly one backend key
 * present, each backend's own value matches its expected shape, and no value
 * starts with a known credential prefix (§3.4, decision 5).
 */
function validateAuthReference(
  value: unknown,
  fieldPath: string,
  errors: ManifestDiagnosticCollector,
): void {
  if (!isPlainObject(value)) {
    errors.push(
      `${fieldPath}: must be an object naming exactly one auth backend`,
    );
    return;
  }
  const backendKeys = (['env', 'keychain', 'op', 'station'] as const).filter(
    (key) => key in value,
  );
  if (backendKeys.length === 0) {
    errors.push(`${fieldPath}: must name exactly one auth backend, found none`);
    return;
  }
  if (backendKeys.length > 1) {
    errors.push(
      `${fieldPath}: must name exactly one auth backend, found ${backendKeys.length} (${backendKeys.join(', ')})`,
    );
    return;
  }

  const backend = backendKeys[0];
  if (backend === 'env') {
    const envName = value.env;
    if (typeof envName !== 'string' || !ENV_NAME_PATTERN.test(envName)) {
      errors.push(
        `${fieldPath}.env: must look like an environment-variable name (letters, digits and underscores, not starting with a digit)`,
      );
      return;
    }
    if (looksLikeSecretLiteral(envName)) {
      errors.push(
        `${fieldPath}.env: starts with a known credential prefix — a reference names a variable, it is never the value`,
      );
    }
    return;
  }
  if (backend === 'op') {
    const opRef = value.op;
    if (typeof opRef !== 'string' || !opRef.startsWith('op://')) {
      errors.push(`${fieldPath}.op: must start with "op://"`);
      return;
    }
    const opPath = opRef.slice('op://'.length);
    if (!isPlainSingleLineString(opPath)) {
      errors.push(`${fieldPath}.op: must name a non-empty "op://" path`);
      return;
    }
    if (looksLikeSecretLiteral(opPath)) {
      errors.push(
        `${fieldPath}.op: starts with a known credential prefix — a reference names a vault item, it is never the value`,
      );
    }
    return;
  }
  if (backend === 'station') {
    const integrationId = value.station;
    if (
      typeof integrationId !== 'string' ||
      !STATION_INTEGRATION_ID_PATTERN.test(integrationId)
    ) {
      errors.push(`${fieldPath}.station: must be a plain integration id`);
      return;
    }
    if (looksLikeSecretLiteral(integrationId)) {
      errors.push(
        `${fieldPath}.station: starts with a known credential prefix — a reference names an integration, it is never the value`,
      );
    }
    return;
  }
  // backend === 'keychain'
  const keychain = value.keychain;
  if (
    !isPlainObject(keychain) ||
    typeof keychain.service !== 'string' ||
    !isPlainSingleLineString(keychain.service)
  ) {
    errors.push(`${fieldPath}.keychain.service: must be a plain service name`);
    return;
  }
  if (looksLikeSecretLiteral(keychain.service)) {
    errors.push(
      `${fieldPath}.keychain.service: starts with a known credential prefix — a reference names a keychain entry, it is never the value`,
    );
  }
  if (keychain.account !== undefined) {
    if (
      typeof keychain.account !== 'string' ||
      !isPlainSingleLineString(keychain.account)
    ) {
      errors.push(
        `${fieldPath}.keychain.account: must be a plain string when present`,
      );
    } else if (looksLikeSecretLiteral(keychain.account)) {
      errors.push(
        `${fieldPath}.keychain.account: starts with a known credential prefix — a reference names a keychain entry, it is never the value`,
      );
    }
  }
}

function validateRepoResource(
  value: unknown,
  index: number,
  errors: ManifestDiagnosticCollector,
): void {
  const fieldPath = `repos[${index}]`;
  if (!isPlainObject(value)) {
    errors.push(`${fieldPath}: must be an object`);
    return;
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errors.push(`${fieldPath}.id: missing`);
  }
  if (value.label !== undefined) {
    if (typeof value.label !== 'string') {
      errors.push(`${fieldPath}.label: must be a string when present`);
    } else {
      rejectFilesystemPath(value.label, `${fieldPath}.label`, errors);
    }
  }
  // Checked for BOTH kinds: `role` participates in the primary-cardinality
  // rule below, which counts every resource regardless of kind.
  if (
    value.role !== undefined &&
    value.role !== 'primary' &&
    value.role !== 'secondary'
  ) {
    errors.push(
      `${fieldPath}.role: must be "primary" or "secondary" when present`,
    );
  }
  if (value.kind === 'git') {
    const canonicalRemote = value.canonicalRemote;
    if (typeof canonicalRemote !== 'string' || canonicalRemote.length === 0) {
      errors.push(`${fieldPath}.canonicalRemote: missing`);
    } else {
      if (typeof value.id === 'string' && value.id !== canonicalRemote) {
        errors.push(
          `${fieldPath}.id: must equal canonicalRemote for a git resource (§9 OQ-1)`,
        );
      }
      if (normalizeGitOrigin(canonicalRemote) !== canonicalRemote) {
        errors.push(`${fieldPath}.canonicalRemote: is not already canonical`);
      }
      rejectLocalRemote(
        canonicalRemote,
        `${fieldPath}.canonicalRemote`,
        errors,
      );
    }
    if (value.aliases !== undefined) {
      if (
        !Array.isArray(value.aliases) ||
        value.aliases.some((a) => typeof a !== 'string')
      ) {
        errors.push(
          `${fieldPath}.aliases: must be a string array when present`,
        );
      } else {
        value.aliases.forEach((alias: string, aliasIndex: number) => {
          const aliasPath = `${fieldPath}.aliases[${aliasIndex}]`;
          if (alias.length === 0) {
            errors.push(`${aliasPath}: must be a non-empty string`);
            return;
          }
          if (normalizeGitOrigin(alias) !== alias) {
            errors.push(
              `${aliasPath}: is not already canonical — a non-canonical alias can never intersect a binding's canonicalized remotes (§3.3(b)/(c)) and would resolve "unbound" forever`,
            );
          }
          rejectLocalRemote(alias, aliasPath, errors);
        });
      }
    }
    if (value.defaultBranch !== undefined) {
      if (
        typeof value.defaultBranch !== 'string' ||
        value.defaultBranch.length === 0
      ) {
        errors.push(
          `${fieldPath}.defaultBranch: must be a non-empty string when present`,
        );
      }
    }
  } else if (value.kind === 'local-only') {
    // The record is non-portable but it REPLICATES (decision 4), so its id
    // is grammar-constrained rather than free-form — this is the check that
    // stops §5's migration from shipping a home directory as a resource id.
    if (
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      !LOCAL_ONLY_ID_PATTERN.test(value.id)
    ) {
      errors.push(
        `${fieldPath}.id: a local-only resource id must match local:<name> (§3.2 schema example) — a filesystem path is never a resource id`,
      );
    }
  } else {
    errors.push(`${fieldPath}.kind: must be "git" or "local-only"`);
  }
}

/**
 * A `file://` (or bare local path) remote canonicalizes to an absolute
 * filesystem path — `normalizeGitOrigin` strips the scheme — which is
 * idempotent and so passes the already-canonical check. Refused here so a
 * member who cloned from a local mirror cannot ship their home directory in
 * the manifest's most-displayed field (decision 3).
 */
function rejectLocalRemote(
  value: string,
  fieldPath: string,
  errors: ManifestDiagnosticCollector,
): void {
  if (isLocalCloneSource(value)) {
    errors.push(
      `${fieldPath}: a "file://" or local filesystem path is a "local-only" resource, not a portable "git" one (§3.2: no absolute or tilde-prefixed paths, anywhere)`,
    );
  }
}

/**
 * Per-resource validation plus the cross-`repos[]` facts decision 10 names:
 * unique ids and unambiguous primary cardinality. Returns the set of ids
 * declared, so `knowledge[].root.repoId` can be checked against it.
 */
function validateRepoCollection(
  repos: unknown[],
  errors: ManifestDiagnosticCollector,
): Set<string> {
  const declaredIds = new Set<string>();
  const primaryIndexes: number[] = [];

  repos.forEach((repo, index) => {
    validateRepoResource(repo, index, errors);
    if (!isPlainObject(repo)) return;
    const id = repo.id;
    if (typeof id === 'string' && id.length > 0) {
      if (declaredIds.has(id)) {
        errors.push(
          `repos[${index}].id: duplicate resource id ${JSON.stringify(id)} — ids must be unique across repos[]`,
        );
      }
      declaredIds.add(id);
    }
    if (repo.role === 'primary') primaryIndexes.push(index);
  });

  if (primaryIndexes.length > 1) {
    errors.pushCoded(
      'multiple-primaries-declared',
      `repos: at most one resource may declare role "primary" (found ${primaryIndexes.length}, at indexes ${primaryIndexes.join(', ')}) — §3.5 resolves an omitted resourceId to THE primary repo`,
    );
  } else if (repos.length > 1 && primaryIndexes.length === 0) {
    errors.pushCoded(
      'no-primary-declared',
      'repos: a manifest with more than one resource must declare exactly one role "primary" — §3.5 resolves an omitted resourceId to the primary repo, and with no primary that resolution is ambiguous',
    );
  } else if (
    repos.length === 1 &&
    primaryIndexes.length === 0 &&
    isPlainObject(repos[0]) &&
    repos[0].role === 'secondary'
  ) {
    // §3.5: a single-resource manifest's sole resource IS its primary.
    // Accepting an explicit `secondary` here would force a resolver to treat
    // a resource that declared itself non-primary as the primary — a
    // contradiction the manifest should never be able to express.
    errors.pushCoded(
      'sole-resource-declared-secondary',
      'repos: the sole resource of a single-resource manifest is its primary and must not declare role "secondary" (§3.5)',
    );
  }

  return declaredIds;
}

function validateKnowledgeRef(
  value: unknown,
  index: number,
  declaredRepoIds: ReadonlySet<string> | undefined,
  errors: ManifestDiagnosticCollector,
): void {
  const fieldPath = `knowledge[${index}]`;
  if (!isPlainObject(value)) {
    errors.push(`${fieldPath}: must be an object`);
    return;
  }
  if (typeof value.namespaceId !== 'string' || value.namespaceId.length === 0) {
    errors.push(`${fieldPath}.namespaceId: missing`);
  }
  const root = value.root;
  if (!isPlainObject(root)) {
    errors.push(`${fieldPath}.root: must be an object`);
    return;
  }
  if (root.kind === 'station-managed') {
    return;
  }
  if (root.kind === 'repo') {
    if (typeof root.repoId !== 'string' || root.repoId.length === 0) {
      errors.push(`${fieldPath}.root.repoId: missing`);
    } else if (declaredRepoIds && !declaredRepoIds.has(root.repoId)) {
      errors.push(
        `${fieldPath}.root.repoId: names no resource in repos[] (${JSON.stringify(root.repoId)})`,
      );
    }
    validatePathField(root.path, `${fieldPath}.root.path`, errors);
    return;
  }
  errors.push(`${fieldPath}.root.kind: must be "station-managed" or "repo"`);
}

function validateIntegrationRef(
  value: unknown,
  index: number,
  errors: ManifestDiagnosticCollector,
): void {
  const fieldPath = `integrations[${index}]`;
  if (!isPlainObject(value)) {
    errors.push(`${fieldPath}: must be an object`);
    return;
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errors.push(`${fieldPath}.id: missing`);
  }
  if (value.kind !== 'mcp') {
    errors.push(`${fieldPath}.kind: must be "mcp"`);
  }
  if (value.auth !== undefined) {
    validateAuthReference(value.auth, `${fieldPath}.auth`, errors);
  }
}

/**
 * Fail-closed manifest validator (§2.5's `KnownEnvironment` lesson, §3.2,
 * §3.4). Never throws, never casts, accumulates every violation into
 * `errors` rather than stopping at the first — with one deliberate
 * exception: an unreadable `schemaVersion` returns immediately (decision 2),
 * because v1 field assertions applied to a v2 document are not findings
 * about that document.
 */
export function validateProjectManifest(
  value: unknown,
): ProjectManifestValidationResult {
  const errors = new ManifestDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('manifest: must be an object');
    return errors.failure();
  }

  // schemaVersion GATES everything else — an unknown/absent version is
  // refused with a NAMED error and nothing else is inspected (decision 2).
  if (value.schemaVersion !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${PROJECT_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  if (typeof value.id !== 'string' || value.id.length === 0) {
    errors.push('id: missing');
  } else {
    rejectFilesystemPath(value.id, 'id', errors);
  }
  if (typeof value.slug !== 'string' || value.slug.length === 0) {
    errors.push('slug: missing');
  } else {
    rejectFilesystemPath(value.slug, 'slug', errors);
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    errors.push('name: missing');
  } else {
    rejectFilesystemPath(value.name, 'name', errors);
  }
  if (value.icon !== undefined) {
    if (typeof value.icon !== 'string') {
      errors.push('icon: must be a string when present');
    } else {
      // Path-checked, unlike `description`: `icon` is a free-text field in
      // ProjectSettings that §5 copies verbatim into the manifest, and
      // `project-icon-discovery.ts` is the subsystem that produces
      // workspace-relative artwork references. It is identity-shaped, not
      // prose.
      rejectFilesystemPath(value.icon, 'icon', errors);
    }
  }
  // `description` is deliberately NOT path-checked: it is prose, and the
  // pattern is anchored, so it refuses an ordinary sentence that happens to
  // BEGIN with a path ("/api/projects/:slug is the route family we own",
  // "~/.station is where this Station keeps state") while catching nothing a
  // sentence hides mid-string. The migration leak §5 describes lands in
  // identity-shaped fields, which are checked.
  if (
    value.description !== undefined &&
    typeof value.description !== 'string'
  ) {
    errors.push('description: must be a string when present');
  }

  let declaredRepoIds: Set<string> | undefined;
  if (!Array.isArray(value.repos)) {
    errors.push('repos: must be an array');
  } else {
    declaredRepoIds = validateRepoCollection(value.repos, errors);
  }

  if (!Array.isArray(value.knowledge)) {
    errors.push('knowledge: must be an array');
  } else {
    value.knowledge.forEach((ref, index) =>
      validateKnowledgeRef(ref, index, declaredRepoIds, errors),
    );
  }

  if (
    !Array.isArray(value.agents) ||
    value.agents.some((a) => typeof a !== 'string')
  ) {
    errors.push('agents: must be a string array');
  }

  if (!Array.isArray(value.integrations)) {
    errors.push('integrations: must be an array');
  } else {
    value.integrations.forEach((ref, index) =>
      validateIntegrationRef(ref, index, errors),
    );
  }

  if (
    !Array.isArray(value.layouts) ||
    value.layouts.some((l) => typeof l !== 'string')
  ) {
    errors.push('layouts: must be a string array');
  }

  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
    errors.push('createdAt: missing');
  }
  if (typeof value.updatedAt !== 'string' || value.updatedAt.length === 0) {
    errors.push('updatedAt: missing');
  }

  if (errors.length > 0) {
    return errors.failure();
  }

  return { ok: true, manifest: value as unknown as ProjectManifest };
}
