/**
 * Plugin Permission System
 *
 * Three tiers: passive (auto-grant), active (prompt), trusted (prompt + warning).
 * Grants persisted in plugin-grants.json keyed by plugin name.
 *
 * Storage is FAIL-CLOSED (station#1835, via {@link GrantsFileStore}): a
 * missing file reads as "no grants yet", but an unreadable, corrupt, or
 * ill-shaped file throws {@link PluginGrantsUnavailableError} instead of
 * silently reading as `{}` — which previously let `revokeAllGrants` persist a
 * total consent wipe and let a string-valued entry substring-match its way
 * into a grant. Enforcement predicates that must not throw use
 * {@link hasGrant} (deny, loudly); consent/write paths and display surfaces
 * use the throwing forms and surface "grants unavailable".
 *
 * A grant is bound to CONTENT, not to a name (station#4288). See
 * {@link PluginGrantRecord} and {@link readPluginGrantState} for what that
 * means, what an un-bound legacy grant does, and why.
 */

import { join } from 'node:path';
import type {
  PermissionTier,
  PluginManifest,
} from '@kontourai/station-contracts/plugin';
import { permissionTier } from '@kontourai/station-contracts/plugin';
import { createLogger, type Logger } from '../../utils/logger.js';
import {
  GrantsFileStore,
  GrantsStoreUnavailableError,
  isPlainObject,
} from './grants-file-store.js';
import {
  pluginContentDigest,
  refreshPluginContentDigest,
} from './plugin-content-integrity.js';

export type { PermissionTier };

const logger = createLogger({ name: 'plugin-permissions' });

// ── Permission Tiers ───────────────────────────────────

/**
 * Delegates to the contracts-level map (station#3815) so enforcement and the
 * permission review surface cannot disagree about a permission's tier.
 */
export function getPermissionTier(permission: string): PermissionTier {
  return permissionTier(permission);
}

export function needsConsent(permission: string): boolean {
  return getPermissionTier(permission) !== 'passive';
}

// ── Grants Storage ─────────────────────────────────────

/**
 * On-disk entry for one plugin. Two shapes are valid and they mean different
 * things — nothing is coerced between them:
 *
 * - `string[]` — a grant recorded before grants were bound to content
 *   (station#4288). The permissions are real; the tree they were granted
 *   against was never recorded, so it is UNKNOWN, not empty.
 * - `{ permissions, contentDigest }` — a grant bound to exactly the bytes
 *   {@link computePluginContentDigest} saw when consent was given.
 *
 * Anything else is corruption and throws (decision 1 of the store's policy).
 */
type StoredGrantEntry =
  | string[]
  | { permissions: string[]; contentDigest: string };

interface GrantsFile {
  [pluginName: string]: StoredGrantEntry;
}

/**
 * One plugin's grants as recorded, with the content they were recorded
 * against. `contentDigest === null` means the record predates content binding
 * — absence of evidence, deliberately not the same value as a digest that
 * fails to match.
 */
export interface PluginGrantRecord {
  permissions: string[];
  contentDigest: string | null;
}

/**
 * How the recorded grant relates to the tree that is installed right now.
 * Every value is DERIVED from a comparison; none is a stored label.
 *
 * - `none` — nothing is recorded for this plugin, so there is nothing to bind.
 * - `bound` — the recorded digest equals the tree's digest. The grant
 *   describes what is installed.
 * - `unverified` — the record predates content binding (no digest was ever
 *   stored). We know the operator consented; we do not know to what.
 * - `changed` — the tree's digest differs from the recorded one, OR the tree
 *   cannot be digested at all. The grant does not describe what is installed.
 */
export type PluginContentBinding = 'none' | 'bound' | 'unverified' | 'changed';

/**
 * **The one derivation**, as a pure function of the stored record and the
 * digest of the tree installed right now. Every consumer — the read path
 * ({@link readPluginGrantState}) and the write path
 * ({@link grantPermissions}) — goes through here, so a grant can never be
 * recorded as effective on terms the read path would have withheld.
 *
 * On `changed`, NOTHING stays effective. See {@link readPluginGrantState} for
 * why that includes passive permissions.
 */
function derivePluginGrantBinding(
  record: PluginGrantRecord,
  currentDigest: string | null,
): { binding: PluginContentBinding; granted: string[]; withheld: string[] } {
  if (record.permissions.length === 0) {
    return { binding: 'none', granted: [], withheld: [] };
  }
  const binding: PluginContentBinding =
    currentDigest === null
      ? 'changed'
      : record.contentDigest === null
        ? 'unverified'
        : record.contentDigest === currentDigest
          ? 'bound'
          : 'changed';
  return binding === 'changed'
    ? { binding, granted: [], withheld: [...record.permissions] }
    : { binding, granted: [...record.permissions], withheld: [] };
}

/** The single derivation every consumer of "what may this plugin do" reads. */
export interface PluginGrantState {
  /** Permissions the store records, ignoring content. */
  recorded: string[];
  /** Permissions that are EFFECTIVE right now. */
  granted: string[];
  /** `recorded` minus `granted` — what the binding took away, by name. */
  withheld: string[];
  binding: PluginContentBinding;
  recordedDigest: string | null;
  currentDigest: string | null;
}

/** The plugin grants store cannot be read; nothing may be decided from it. */
export class PluginGrantsUnavailableError extends GrantsStoreUnavailableError {
  constructor(
    storePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(storePath, detail, options);
    this.name = 'PluginGrantsUnavailableError';
  }
}

/**
 * A grant was about to be recorded for a plugin whose installed tree cannot be
 * digested. Consent is consent to bytes; bytes that cannot be read cannot be
 * consented to, so the write is refused rather than stored unbound.
 */
export class PluginContentUnavailableError extends Error {
  readonly pluginName: string;

  constructor(pluginName: string) {
    super(
      `Plugin '${pluginName}' content could not be read, so nothing was granted`,
    );
    this.name = 'PluginContentUnavailableError';
    this.pluginName = pluginName;
  }
}

export function pluginGrantsPath(projectHomeDir: string): string {
  return join(projectHomeDir, 'plugin-grants.json');
}

/**
 * The one place that answers "which tree is a grant for this home bound to".
 *
 * Every caller in the tree already builds `join(projectHomeDir, 'plugins')`
 * for itself (the runtime loader, the subscription service, the route
 * wiring). Deriving it here instead of threading a second parameter through
 * ten call sites removes the only way two callers could disagree about which
 * directory a plugin's consent is bound to.
 */
export function pluginsDirFor(projectHomeDir: string): string {
  return join(projectHomeDir, 'plugins');
}

/** Valid = plain object; every value a legacy array or a bound record. */
function pluginGrantsShapeProblems(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ['must be a plain object keyed by plugin name'];
  }
  const problems: string[] = [];
  const permissionsProblem = (pluginName: string, granted: unknown): void => {
    if (!Array.isArray(granted)) {
      problems.push(
        `${pluginName}: grants must be an array of permission strings`,
      );
      return;
    }
    if (granted.some((permission) => typeof permission !== 'string')) {
      problems.push(`${pluginName}: grants must contain only strings`);
    }
  };
  for (const [pluginName, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      permissionsProblem(pluginName, entry);
      continue;
    }
    if (!isPlainObject(entry)) {
      problems.push(
        `${pluginName}: entry must be an array of permission strings or a { permissions, contentDigest } record`,
      );
      continue;
    }
    permissionsProblem(pluginName, entry.permissions);
    if (typeof entry.contentDigest !== 'string') {
      problems.push(
        `${pluginName}: contentDigest must be the digest string the grant was given against`,
      );
    } else if (entry.contentDigest.length === 0) {
      problems.push(`${pluginName}: contentDigest must not be empty`);
    }
  }
  return problems;
}

/** Reads one entry into the normalized record. Never coerces a bad shape. */
function toGrantRecord(entry: StoredGrantEntry | undefined): PluginGrantRecord {
  if (entry === undefined) return { permissions: [], contentDigest: null };
  if (Array.isArray(entry)) {
    return { permissions: [...entry], contentDigest: null };
  }
  return {
    permissions: [...entry.permissions],
    contentDigest: entry.contentDigest,
  };
}

function toStoredEntry(record: PluginGrantRecord): StoredGrantEntry {
  return record.contentDigest === null
    ? [...record.permissions]
    : {
        permissions: [...record.permissions],
        contentDigest: record.contentDigest,
      };
}

function grantsStore(projectHomeDir: string): GrantsFileStore<GrantsFile> {
  return new GrantsFileStore<GrantsFile>({
    filePath: pluginGrantsPath(projectHomeDir),
    storeLabel: 'plugin-grants',
    shapeProblems: pluginGrantsShapeProblems,
    makeUnavailableError: (storePath, detail, cause) =>
      new PluginGrantsUnavailableError(storePath, detail, { cause }),
    emptyValue: {},
  });
}

/**
 * One plugin's record, exactly as stored. Throws
 * {@link PluginGrantsUnavailableError} when the store is unreadable or
 * corrupt. A missing store reads as no grants.
 *
 * This is the RECORD, not the decision — it says what was consented to and
 * against which bytes, and says nothing about whether those bytes are still
 * installed. Use {@link readPluginGrantState} to decide anything.
 */
export function readPluginGrantRecord(
  projectHomeDir: string,
  pluginName: string,
): PluginGrantRecord {
  return toGrantRecord(grantsStore(projectHomeDir).read()[pluginName]);
}

/**
 * **The derivation.** What this plugin may actually do right now, and why.
 *
 * The defect this closes (station#4288): `POST /:name/update` replaces a
 * plugin's code, agents, integrations and providers, and the grants recorded
 * against the reviewed bytes carried over to bytes nobody reviewed. Consent
 * was attached to a permission NAME; the design note
 * (`docs/design/plugin-authority-model.md`, "What consent is attached to")
 * calls that one of three incompatible answers Station holds at once, and
 * names attaching the digest to ordinary grants as the cheapest fix.
 *
 * The policy, per state:
 *
 * - `bound` — everything recorded is effective.
 * - `changed` — **every recorded permission is withheld, passive included.**
 *   Positive evidence that the installed bytes are not the reviewed bytes is
 *   exactly what invalidates a consent, so nothing recorded applies until it
 *   is given again.
 *
 *   The passive half of that is a deliberate reversal of the first draft,
 *   which retained passive permissions on the argument that a passive
 *   permission is not consent (`processInstallPermissions` grants them
 *   without asking anyone) so withholding them would cost capability and
 *   protect nothing.
 *
 *   That argument was originally rebutted by naming a specific escalation:
 *   the isolated frame's `api-request` bridge authorized on any granted NAME,
 *   so one surviving passive grant was a credentialed call to any `/api/`
 *   path. station#4300 DELETED that bridge, and this docblock is restated
 *   rather than left standing on a mechanism that no longer exists — a
 *   comment naming a removed bridge is how the next reader concludes the
 *   decision has lost its reason.
 *
 *   The decision does not depend on that mechanism and is unchanged: a
 *   `changed` binding is positive evidence that the bytes any consent was
 *   given for are gone. Withholding on that evidence is right for every
 *   permission whether or not some particular caller could have spent it,
 *   because the question is what the record still attests to, not what the
 *   holder can currently reach. Restricting the withhold to permissions
 *   someone can name a live consumer for would make this store's answer a
 *   function of the rest of the codebase.
 *
 *   What the first draft's argument DOES still establish is the price:
 *   re-acquiring a passive permission is cheap, because the next update or
 *   re-install auto-grants it again through Station's own path. That is the
 *   right shape — a capability re-acquired by an operator gesture through a
 *   surface that re-binds, rather than inherited by bytes nobody reviewed.
 * - `unverified` — **everything recorded stays effective.** This is the
 *   migration decision for grants that predate content binding, and it is
 *   deliberate rather than convenient. Fail-closed is right for `changed`
 *   because a mismatch is EVIDENCE. A missing digest is the ABSENCE of
 *   evidence: it says the record was written by older code, not that anything
 *   was tampered with. Refusing it would revoke every already-consented
 *   plugin on the upgrade that introduces this file, for no gain — the store
 *   holds nothing to compare against, so failing closed cannot distinguish a
 *   plugin that was quietly laundered before the upgrade from one that never
 *   changed. It would only teach the operator that the re-consent prompt is
 *   noise to click through, which damages the ceremony this mechanism is
 *   protecting. What it must NOT be is invisible: the state is derived, it is
 *   returned on `GET /api/plugins` and `GET /api/plugins/:name/permissions`,
 *   and the permissions panel says so in words. And it closes on first
 *   contact: the next grant ({@link grantPermissions}) or update
 *   ({@link rebindGrantsAfterContentChange}) for that plugin writes a digest,
 *   after which it is bound like anything else. Revocation deliberately does
 *   NOT close it — withdrawing a permission is not a statement about the
 *   bytes the remaining ones were granted against.
 * - `changed` also covers an UNREADABLE tree (`currentDigest === null`): a
 *   tree we cannot digest cannot be shown to be the reviewed one.
 *
 * Cost: `currentDigest` is the memoized {@link pluginContentDigest}, so a
 * plugin with no recorded grants never walks its tree at all, and one with
 * grants walks it once per content mutation rather than once per call.
 */
export function readPluginGrantState(
  projectHomeDir: string,
  pluginName: string,
): PluginGrantState {
  const record = readPluginGrantRecord(projectHomeDir, pluginName);
  // A plugin with no recorded grants has nothing to bind, so it never walks
  // its tree at all.
  const currentDigest =
    record.permissions.length === 0
      ? null
      : pluginContentDigest(pluginsDirFor(projectHomeDir), pluginName);
  const { binding, granted, withheld } = derivePluginGrantBinding(
    record,
    currentDigest,
  );
  return {
    recorded: [...record.permissions],
    granted,
    withheld,
    binding,
    recordedDigest: record.contentDigest,
    currentDigest,
  };
}

/**
 * EFFECTIVE grants — what the plugin may do, after the content binding is
 * applied. Every enforcement predicate and every display surface reads this,
 * so none of them can disagree about whether a changed tree still holds a
 * grant.
 *
 * Throws {@link PluginGrantsUnavailableError} when the store is unreadable or
 * corrupt. A missing store reads as no grants.
 */
export function getPluginGrants(
  projectHomeDir: string,
  pluginName: string,
): string[] {
  return readPluginGrantState(projectHomeDir, pluginName).granted;
}

/**
 * Records consent, bound to the bytes on disk at this instant.
 *
 * **What carries over is the EFFECTIVE set, never the recorded one**
 * (station#4288, review HIGH 1). The first draft unioned the whole stored
 * record with the new permissions and stamped the result with the current
 * digest, so granting *anything* re-blessed *everything* already recorded
 * against bytes nobody had reviewed. That laundered consent straight past
 * this route's own ceremony: `POST /:name/grant` refuses `trusted`
 * permissions outright ("Trusted plugin permissions require an isolated host
 * approval channel"), yet a plugin whose tree had been replaced could get its
 * withheld `plugin.server` back by having the operator approve `ui.confirm`.
 *
 * Running the record through {@link derivePluginGrantBinding} first means the
 * new entry is exactly "what this plugin may do right now, plus what is being
 * consented to right now". From `bound` or `unverified` that is the old
 * union, unchanged. From `changed` it is only the new permissions, because a
 * `changed` binding grants nothing — re-consent has to be asked for, one
 * permission at a time, through the surface that is allowed to ask.
 *
 * The digest is REFRESHED rather than read from the memo: a grant commits
 * immediately after an install or a build wrote the tree, and pinning a value
 * cached before those writes would bind consent to a tree that no longer
 * exists — which the very next load would read as a mismatch and withhold.
 *
 * A tree that cannot be digested refuses the write
 * ({@link PluginContentUnavailableError}) instead of storing an unbound grant.
 * The trusted-tier host-approval path already refuses on the same condition
 * (`derivePluginTrustTarget` returns null on a null digest); this makes the
 * ordinary path agree with it.
 *
 * **It returns what it derived, not what it was asked for** (station#4288,
 * delta review MEDIUM 2). Withdrawing the rest of a `changed` record is the
 * correct behaviour; doing it silently is not. Granting one permission from a
 * `changed` binding deletes every other recorded permission — `trusted` ones
 * included, which are re-acquirable only through the isolated host-approval
 * channel — so the caller has to be able to say so. `withdrawn` is the
 * recorded set minus the set that was actually written; `granted` is what the
 * plugin holds now. This route's own install path already established the
 * standard: a capability that disappears without a word is its own defect.
 */
export async function grantPermissions(
  projectHomeDir: string,
  pluginName: string,
  permissions: string[],
): Promise<{ granted: string[]; withdrawn: string[] }> {
  let outcome: { granted: string[]; withdrawn: string[] } = {
    granted: [],
    withdrawn: [],
  };
  await grantsStore(projectHomeDir).mutate(pluginName, (grants) => {
    // Inside the updater on purpose: the store's own read has already
    // succeeded and its lock is held, so an unreadable grants store reports
    // itself as such rather than being masked by whatever the tree read says,
    // and the digest is taken with the write serialized behind it.
    const contentDigest = refreshPluginContentDigest(
      pluginsDirFor(projectHomeDir),
      pluginName,
    );
    if (contentDigest === null) {
      throw new PluginContentUnavailableError(pluginName);
    }
    const record = toGrantRecord(grants[pluginName]);
    // The EFFECTIVE set under the binding this write is about to replace —
    // see the note above. On `changed` this is empty, so the withheld
    // permissions are withdrawn here rather than re-blessed.
    const { granted: carried } = derivePluginGrantBinding(
      record,
      contentDigest,
    );
    const next = new Set(carried);
    for (const p of permissions) next.add(p);
    outcome = {
      granted: [...next],
      withdrawn: record.permissions.filter(
        (permission) => !next.has(permission),
      ),
    };
    grants[pluginName] = toStoredEntry({
      permissions: [...next],
      contentDigest,
    });
    return grants;
  });
  // Read only after `mutate` resolved: the updater runs before the write, and
  // a write that threw must not report a grant that never landed.
  return outcome;
}

/**
 * Re-binds a plugin's grants after Station itself replaced its content
 * (station#4288, acceptance 3). Called inside the content lock by BOTH paths
 * that replace an installed plugin's tree — `POST /:name/update` and
 * `installPluginFromSource` when it installs over an existing plugin (review
 * HIGH 2) — once the new tree is final (post-build, post-integration-copy)
 * and before anything reads a grant from it.
 *
 * What it does, and why it is a WRITE rather than the read-path withholding
 * above: a Station-mediated replacement is positive knowledge that the
 * reviewed bytes are gone. Leaving the old permissions recorded-but-ineffective would give the
 * store one truth and the derivation another; withdrawing them makes
 * re-consent an ordinary grant through the ordinary surfaces.
 *
 * Retained: passive permissions the NEW manifest still declares — re-derived
 * from `requiredPermissionsForManifest`, so a permission the new version no
 * longer asks for is dropped too. Everything else is withdrawn, including a
 * permission the new version newly derives (a version that contributes a
 * `serverModule` where the old one did not cannot inherit a `plugin.server`
 * grant that predates it — it was never granted for this code).
 */
export async function rebindGrantsAfterContentChange(
  projectHomeDir: string,
  pluginName: string,
  manifest: Pick<
    PluginManifest,
    | 'permissions'
    | 'providers'
    | 'serverModule'
    | 'operationalEventSubscriptions'
  >,
): Promise<{ retained: string[]; withdrawn: string[] }> {
  const before = readPluginGrantRecord(projectHomeDir, pluginName);
  if (before.permissions.length === 0) return { retained: [], withdrawn: [] };
  // Read AFTER the store read succeeded, for the same reason
  // `grantPermissions` takes it inside the updater: an unreadable grants
  // store must report itself rather than be masked by the tree read.
  const contentDigest = refreshPluginContentDigest(
    pluginsDirFor(projectHomeDir),
    pluginName,
  );
  if (contentDigest === null) {
    throw new PluginContentUnavailableError(pluginName);
  }
  const declared = new Set(requiredPermissionsForManifest(manifest));
  const retained = before.permissions.filter(
    (permission) => declared.has(permission) && !needsConsent(permission),
  );
  const keep = new Set(retained);
  const withdrawn = before.permissions.filter(
    (permission) => !keep.has(permission),
  );
  if (withdrawn.length === 0) {
    // Nothing to withdraw, but the binding still has to move to the new
    // bytes or the next read would report `changed` forever.
    await grantsStore(projectHomeDir).mutate(pluginName, (grants) => {
      grants[pluginName] = toStoredEntry({
        permissions: retained,
        contentDigest,
      });
      return grants;
    });
    return { retained, withdrawn };
  }
  await grantsStore(projectHomeDir).mutate(pluginName, (grants) => {
    // Matches `revokeGrants`: an empty remainder drops the key rather than
    // persisting an entry that grants nothing.
    if (retained.length === 0) delete grants[pluginName];
    else
      grants[pluginName] = toStoredEntry({
        permissions: retained,
        contentDigest,
      });
    return grants;
  });
  return { retained, withdrawn };
}

export function requiredPermissionsForManifest(
  manifest: Pick<
    PluginManifest,
    | 'permissions'
    | 'providers'
    | 'serverModule'
    | 'operationalEventSubscriptions'
  >,
): string[] {
  const permissions = new Set(manifest.permissions ?? []);
  if (manifest.providers?.length) {
    permissions.add('providers.register');
  }
  if (manifest.serverModule) {
    permissions.add('plugin.server');
  }
  if (manifest.operationalEventSubscriptions?.length) {
    permissions.add('events.subscribe');
    if (
      manifest.operationalEventSubscriptions.some(
        (subscription) => subscription.projection === 'envelope',
      )
    ) {
      permissions.add('events.read-payload');
    }
  }
  return [...permissions];
}

export function assertGrantablePermissions(
  manifest: Pick<
    PluginManifest,
    | 'permissions'
    | 'providers'
    | 'serverModule'
    | 'operationalEventSubscriptions'
  >,
  requested: string[],
): void {
  const declared = new Set(requiredPermissionsForManifest(manifest));
  for (const permission of requested) {
    if (!declared.has(permission)) {
      throw new Error(`Permission '${permission}' is not declared by plugin`);
    }
  }
}

/**
 * Snapshot of ONE plugin's grants entry for install/uninstall rollback flows
 * (#1835 finding 2): `null` = no entry existed. Throws when the store is
 * unavailable — a rollback baseline must never be fabricated from a failed
 * read.
 */
export function snapshotPluginGrantEntry(
  projectHomeDir: string,
  pluginName: string,
): PluginGrantRecord | null {
  const grants = grantsStore(projectHomeDir).read();
  // The RECORD, digest included: a rollback that restored the permissions
  // but not the digest they were granted against would leave the entry
  // reading `unverified` forever, which is a state nobody chose.
  return Object.hasOwn(grants, pluginName)
    ? toGrantRecord(grants[pluginName])
    : null;
}

/**
 * Restores exactly one plugin's grants entry to a snapshot taken by
 * {@link snapshotPluginGrantEntry}, through the store's locked mutate — never
 * a raw file copy — so consent recorded for OTHER plugins between snapshot
 * and rollback survives the rollback. Throws the typed unavailable error when
 * the store cannot be read or written; callers must let that surface rather
 * than fall back to copying bytes.
 */
export async function restorePluginGrantEntry(
  projectHomeDir: string,
  pluginName: string,
  entry: PluginGrantRecord | null,
): Promise<void> {
  await grantsStore(projectHomeDir).mutate(pluginName, (grants) => {
    if (entry === null) {
      delete grants[pluginName];
    } else {
      grants[pluginName] = toStoredEntry(entry);
    }
    return grants;
  });
}

/**
 * Withdraws specific permissions from a plugin (station#3815).
 *
 * Granting was already trustworthy — a decision surface plugin code cannot
 * script, one-use nonces, target revalidation, an audit trail — but all of
 * that governed the MOMENT of grant, after which a grant was invisible and
 * permanent until uninstall. The strongest guarantees in the system were
 * protecting a door that could not afterwards be closed.
 *
 * Withdrawal is deliberately unceremonious: it only ever narrows what a
 * plugin may do, so making it easy is the safe direction. It writes through
 * the same per-plugin persistence queue `grantPermissions` uses, so a
 * concurrent grant and revoke cannot interleave into a half-written set.
 * Revoking something never granted is a no-op, not an error — the caller's
 * intent ("this plugin should not hold that") is already satisfied.
 */
export async function revokeGrants(
  projectHomeDir: string,
  pluginName: string,
  permissions: readonly string[],
): Promise<void> {
  const withdrawn = new Set(permissions);
  if (withdrawn.size === 0) return;
  await grantsStore(projectHomeDir).mutate(pluginName, (grants) => {
    const record = toGrantRecord(grants[pluginName]);
    const remaining = record.permissions.filter(
      (permission) => !withdrawn.has(permission),
    );
    // An empty remainder drops the key rather than persisting `[]`, so the
    // stored shape matches what `revokeAllGrants` leaves behind.
    if (remaining.length === 0) delete grants[pluginName];
    else
      grants[pluginName] = toStoredEntry({
        permissions: remaining,
        // Narrowing never re-binds: withdrawing a permission says nothing
        // about the bytes the surviving ones were granted against, so a
        // legacy entry stays `unverified` and a bound one keeps its digest.
        contentDigest: record.contentDigest,
      });
    return grants;
  });
}

export async function revokeAllGrants(
  projectHomeDir: string,
  pluginName: string,
): Promise<void> {
  await grantsStore(projectHomeDir).mutate(pluginName, (grants) => {
    delete grants[pluginName];
    return grants;
  });
}

/**
 * Enforcement check for consent/write paths and permission gates: throws
 * {@link PluginGrantsUnavailableError} when the store cannot be read, so the
 * caller can surface "grants unavailable" instead of treating the failure as
 * "not granted" silently.
 */
export function hasGrantOrThrow(
  projectHomeDir: string,
  pluginName: string,
  permission: string,
): boolean {
  return getPluginGrants(projectHomeDir, pluginName).includes(permission);
}

/**
 * Non-throwing enforcement predicate (e.g. the runtime plugin loader, where a
 * throw would abort provider loading for every plugin): when the store is
 * unavailable it DENIES, loudly — an error-level log naming the grants path —
 * and returns false. Never fails open.
 */
export function hasGrant(
  projectHomeDir: string,
  pluginName: string,
  permission: string,
  deniedLogger: Pick<Logger, 'error'> = logger,
): boolean {
  try {
    return hasGrantOrThrow(projectHomeDir, pluginName, permission);
  } catch (error) {
    if (error instanceof PluginGrantsUnavailableError) {
      deniedLogger.error(
        'Plugin grants store unavailable; denying permission check',
        {
          path: error.storePath,
          plugin: pluginName,
          permission,
          error: error.message,
        },
      );
      return false;
    }
    throw error;
  }
}

// ── Install-time helpers ───────────────────────────────

export interface PermissionRequest {
  permission: string;
  tier: PermissionTier;
}

/**
 * Given a plugin's declared permissions, auto-grant passive ones
 * and return the list that needs user consent.
 *
 * Throws {@link PluginGrantsUnavailableError} when passive permissions need
 * to be granted but the store cannot be read, or
 * {@link PluginContentUnavailableError} when the installed tree cannot be
 * digested — installation must not proceed as if consent bookkeeping
 * succeeded.
 *
 * `withdrawn` is whatever the auto-grant took away, passed straight through
 * from {@link grantPermissions} rather than assumed empty (station#4288,
 * delta review). A FIRST install can reach a non-empty value: a leftover
 * grants entry for a name that was uninstalled by hand, or whose uninstall
 * failed after the tree went, is `changed` against the freshly installed
 * tree, so auto-granting the new manifest's passive permissions drops
 * everything the old entry held.
 *
 * `consented` is what the operator approved BEFORE the install ran
 * (station#4288) — the decision the installer already refused to proceed
 * without. Active-tier members of it are recorded here, bound to the tree
 * that just landed, rather than left for a second round trip after the
 * mutation. Trusted-tier members are NOT: a same-origin click cannot
 * authorize the trusted tier by design, so they stay in `pendingConsent` for
 * the distinct-origin host review, which revalidates against the installed
 * tree.
 *
 * `autoGranted` keeps meaning "granted without asking anyone" and
 * `consentGranted` means "granted because the operator said so". Folding the
 * second into the first would make the name a lie on a permission surface,
 * which is the one place a reader has to be able to trust a word.
 */
export async function processInstallPermissions(
  projectHomeDir: string,
  pluginName: string,
  declaredPermissions: string[],
  options?: { consented?: readonly string[] },
): Promise<{
  autoGranted: string[];
  consentGranted: string[];
  pendingConsent: PermissionRequest[];
  withdrawn: string[];
}> {
  const consented = new Set(options?.consented ?? []);
  const autoGranted: string[] = [];
  const consentGranted: string[] = [];
  const pendingConsent: PermissionRequest[] = [];

  for (const perm of declaredPermissions) {
    if (!needsConsent(perm)) {
      autoGranted.push(perm);
    } else if (getPermissionTier(perm) !== 'trusted' && consented.has(perm)) {
      consentGranted.push(perm);
    } else {
      pendingConsent.push({ permission: perm, tier: getPermissionTier(perm) });
    }
  }

  // One write, not two: passive and operator-approved permissions land in the
  // same locked mutate against the same freshly refreshed digest, so there is
  // no window where a plugin holds half of what it was granted.
  const granting = [...autoGranted, ...consentGranted];
  const withdrawn =
    granting.length > 0
      ? (await grantPermissions(projectHomeDir, pluginName, granting)).withdrawn
      : [];

  return { autoGranted, consentGranted, pendingConsent, withdrawn };
}
