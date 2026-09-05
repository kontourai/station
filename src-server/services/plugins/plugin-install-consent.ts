/**
 * Plugin install consent — the decision, and the check that it precedes the
 * mutation (archive#4288).
 *
 * ## What was wrong
 *
 * Consent used to be requested from the install mutation's `onSuccess`: the
 * plugin was copied into `<home>/plugins`, its agents were written, its
 * integrations were copied, its passive grants were recorded, and only THEN
 * was the operator asked. Declining set an error message and left all of it
 * in place.
 *
 * For the contributions that execute in the browser — `layout`,
 * `workspacePanes`, `entrypoint`, and anything `dependencies` pulls in — that
 * is not a late gate, it is not a gate. An in-process bundle needs no
 * server-side grant to run: it is a `<script>` in the shell's own document,
 * with the shell's origin and session. By the time the prompt renders, the
 * code it asks about can already have run.
 *
 * ## What this module is
 *
 * The install carries the operator's decision as a PARAMETER, and the server
 * re-derives what that decision should have covered from the STAGED copy —
 * before a single byte is written outside the staging directory. A mismatch
 * refuses there, which costs nothing to undo because nothing has happened.
 *
 * A decision names the parent bytes/permissions and its dependency ids. The
 * canonical dependency lifecycle additionally carries one byte/permission
 * approval per executable or lifecycle-bearing dependency. Any supplied
 * dependency approval is checked even for declarative content. They are checked
 * separately because they fail differently:
 *
 * - `permissions` — the derived set the operator was shown. Checked because
 *   the digest cannot catch it: a client that sends the right digest and an
 *   EMPTY permission list has consented to nothing while matching bytes
 *   perfectly.
 * - `contentDigest` — the parent bytes the operator was shown, via
 *   {@link computePluginContentDigest}. Checked because the permission set
 *   cannot catch it: a source can change between preview and install and
 *   derive exactly the same permissions. That is the laundering shape.
 *
 * ## What it does not claim
 *
 * It establishes SEQUENCE and BINDING **for Station's own client**: the
 * operator is asked before anything is written, and the answer is about the
 * bytes that were staged for the decision.
 *
 * "Binding" reaches as far as the staged tree and no further. The digest is
 * taken over `<plugins>/.preview-<name>-<random>`, and the tree at that path
 * is copied to `<plugins>/<name>` only after `buildPlugin` has run in it — an
 * unlocked span. The random suffix removes the COLLISION (a concurrent
 * `/preview` of a same-basename source, or a dependency colliding with its
 * parent), which is what made that span reachable by ordinary traffic. It
 * does not make the staged tree tamper-proof: a same-user process can list
 * `<plugins>`, find the directory and overwrite it — but that process can
 * equally overwrite `<plugins>/<name>` a second after the install returns, so
 * it is not a boundary a staging path can hold. Staging outside `<plugins>`
 * entirely would narrow it further; that is a separate change.
 *
 * It establishes NEITHER against an arbitrary credentialed API caller. The
 * values a decision carries are all readable from `POST /preview` — the
 * derived permission sets, content digests, and dependency ids — so any
 * caller holding a Station credential can call `/preview`, read them back,
 * echo them into `/install`, and install with no operator in the loop. That
 * is not only browser-resident plugin code: a server-side agent with a shell
 * tool, a paired device, and a stolen or exported CLI credential all
 * qualify, and none of them needs a browser. A caller that admits it holds no
 * decision (`no-operator-decision`) is refused anything it could not have
 * disclosed; a caller that CLAIMS one is taken at its word, because nothing
 * in an HTTP request can attest that a human answered.
 *
 * What the gate is therefore worth: it makes the product's own path honest
 * (the plugin is not on disk when the question is asked), and it makes an
 * install that skipped the question distinguishable from one that did not.
 * It is not an authorization boundary against the credential holder.
 *
 * It also does not widen what the derivation can see. `entrypoint`, `layout`,
 * `workspacePanes` and `agents` still derive no permission (archive#3396);
 * that is why {@link PluginInstallConsent} binds the DIGEST rather than only
 * the permission set, and why {@link PluginConsentBasis.undisclosedContributions}
 * names those kinds directly for the callers that hold no decision at all.
 */

import { basename, dirname } from 'node:path';
import type {
  PermissionTier,
  PluginManifest,
} from '@kontourai/station-contracts/plugin';
import { computePluginContentDigest } from './plugin-content-integrity.js';
import {
  getPermissionTier,
  needsConsent,
  requiredPermissionsForManifest,
} from './plugin-permissions.js';

/**
 * What the operator was shown for one staged plugin, derived from the staged
 * copy alone. Nothing here is stored; it is recomputed at install and
 * compared against what came back.
 */
export interface PluginConsentBasis {
  /** Digest of the staged tree — every contribution, not a manifest projection. */
  contentDigest: string;
  /** {@link requiredPermissionsForManifest}, sorted. */
  required: string[];
  /** The passive subset: granted by installing, never prompted for. */
  autoGranted: string[];
  /** The subset an operator has to answer for, with each one's tier. */
  pendingConsent: Array<{ permission: string; tier: PermissionTier }>;
  /** Plugin ids this install would install alongside the plugin itself. */
  dependencies: string[];
  /**
   * Manifest fields this plugin declares that {@link
   * requiredPermissionsForManifest} emits NOTHING for (archive#4288, review
   * HIGH 1). Named by their manifest field so the refusal can say which one.
   *
   * This is the axis `pendingConsent` cannot see, and it is the dangerous
   * one: `entrypoint`, `layout`/`layouts` and `workspacePanes` load code into
   * the shell's own document, `agents` writes agent definitions into
   * `<home>/agents`, and `dependencies` installs further plugins under the
   * same gesture. A caller that consults only `pendingConsent` when deciding
   * whether it had anything to disclose consults the one axis that is blind
   * to all five.
   */
  undisclosedContributions: string[];
}

/**
 * Manifest fields whose contribution the permission derivation cannot
 * express, in the order a refusal should list them: the browser-resident ones
 * first, because they need no server-side grant to run at all.
 */
const UNDISCLOSABLE_CONTRIBUTION_FIELDS = [
  'entrypoint',
  'layout',
  'layouts',
  'workspacePanes',
  'agents',
  'dependencies',
] as const;

type UndisclosableContributionField =
  (typeof UNDISCLOSABLE_CONTRIBUTION_FIELDS)[number];

function declaredUndisclosableContributions(
  manifest: Partial<Pick<PluginManifest, UndisclosableContributionField>>,
): string[] {
  return UNDISCLOSABLE_CONTRIBUTION_FIELDS.filter((field) => {
    const value = manifest[field];
    if (value === undefined || value === null) return false;
    return Array.isArray(value) ? value.length > 0 : true;
  });
}

/**
 * The operator's answer, or the honest statement that no answer was taken.
 *
 * There is deliberately no third member meaning "skip the check". A caller
 * that holds no decision says so, and
 * {@link assertPluginInstallConsent} refuses whatever that caller could not
 * have disclosed.
 */
export type PluginInstallConsent =
  | {
      kind: 'operator-decision';
      /** Permission decision observed before preview acquisition. */
      grantRevision?: string;
      /** The derived set the operator answered for. */
      permissions: string[];
      /** The digest of the tree the operator answered about. */
      contentDigest: string;
      /** The dependency ids the operator was shown. */
      dependencies: string[];
      /** Per-dependency bytes and permissions shown by preview. */
      dependencyApprovals?: Array<{
        id: string;
        grantRevision?: string;
        permissions: string[];
        contentDigest: string;
        dependencies: string[];
      }>;
    }
  | {
      kind: 'no-operator-decision';
      /** Which caller holds no decision, for the refusal message. */
      caller: string;
    };

export type PluginConsentRefusalReason =
  | 'undisclosed-permissions'
  | 'undisclosed-contributions'
  | 'permissions'
  | 'content'
  | 'dependencies';

/**
 * Refused BEFORE the install mutated anything. Carries the reason as data so
 * a route can answer with something better than a sentence, and so a test can
 * assert which of the three checks fired rather than matching prose.
 */
export class PluginConsentRefusedError extends Error {
  readonly pluginName: string;
  readonly reason: PluginConsentRefusalReason;
  readonly required: string[];
  readonly consented: string[];

  constructor(options: {
    pluginName: string;
    reason: PluginConsentRefusalReason;
    message: string;
    required?: string[];
    consented?: string[];
  }) {
    super(options.message);
    this.name = 'PluginConsentRefusedError';
    this.pluginName = options.pluginName;
    this.reason = options.reason;
    this.required = options.required ?? [];
    this.consented = options.consented ?? [];
  }
}

/** True for a value thrown across a module boundary by this module. */
export function isPluginConsentRefusedError(
  error: unknown,
): error is PluginConsentRefusedError {
  return error instanceof PluginConsentRefusedError;
}

/** Recover a refusal through ordinary dependency wrappers, not failed rollback aggregates. */
export function findPluginConsentRefusedError(
  error: unknown,
): PluginConsentRefusedError | null {
  const seen = new Set<object>();
  try {
    for (let depth = 0; depth < 32 && error instanceof Error; depth++) {
      if (error instanceof AggregateError || seen.has(error)) return null;
      if (isPluginConsentRefusedError(error)) return error;
      seen.add(error);
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      error = cause && 'value' in cause ? cause.value : undefined;
    }
  } catch {
    // A hostile reflection trap cannot prove a simple consent refusal.
  }
  return null;
}

/**
 * Everything a consent prompt needs, from a staged copy — no install, no
 * grant, no write. `stagedDir` is the directory `fetchPluginSource` produced,
 * and the digest is taken by the same walk {@link computePluginContentDigest}
 * runs over an installed tree.
 *
 * Same METHOD, and — worth saying because a reader will otherwise assume the
 * opposite — usually a different VALUE from the digest the grant record ends
 * up holding. `buildPlugin` and `ensurePluginDeps` run against the staged
 * tree between this call and the copy into `<plugins>/<name>`, writing bundle
 * output and `node_modules` into it, so for any plugin with a build the
 * consented digest and the digest `grantPermissions` records are not equal
 * and must not be compared. What the consented digest attests is the SOURCE
 * as reviewed; what the grant's digest binds is the tree as installed. Two
 * different questions, answered by the same function at two different
 * moments.
 *
 * Returns `null` when the staged tree cannot be digested. A basis that cannot
 * name the bytes is not a basis for consenting to them.
 */
export function derivePluginConsentBasis(
  stagedDir: string,
  manifest: Pick<
    PluginManifest,
    | 'permissions'
    | 'providers'
    | 'serverModule'
    | 'operationalEventSubscriptions'
    | 'dependencies'
  > &
    Partial<Pick<PluginManifest, UndisclosableContributionField>>,
): PluginConsentBasis | null {
  const contentDigest = computePluginContentDigest(
    dirname(stagedDir),
    basename(stagedDir),
  );
  if (contentDigest === null) return null;
  const required = [...requiredPermissionsForManifest(manifest)].sort();
  return {
    contentDigest,
    required,
    autoGranted: required.filter((permission) => !needsConsent(permission)),
    pendingConsent: required
      .filter((permission) => needsConsent(permission))
      .map((permission) => ({
        permission,
        tier: getPermissionTier(permission),
      })),
    dependencies: (manifest.dependencies ?? []).map(
      (dependency) => dependency.id,
    ),
    undisclosedContributions: declaredUndisclosableContributions(manifest),
  };
}

/**
 * Refuses unless the decision covers what the staged copy actually derives.
 *
 * Called from `installPluginFromSource` after the staged manifest is read and
 * before anything outside the staging directory is touched, so every refusal
 * here leaves the home exactly as it found it.
 *
 * Dependencies are checked as a NAMED LIST rather than one prompt each. A
 * declared dependency is not optional — declining one fails the install — so
 * an individual prompt would offer a choice between "yes" and "the install
 * fails", which is a worse spelling of the single decision. What the list
 * buys is that the operator's answer NAMES plugin ids instead of leaving them
 * implicit inside a hash: the refusal can then say which id was not approved.
 *
 * Two limits, both stated because both are easy to over-read:
 *
 * 1. This check is one-way, and DIRECT-ONLY. `basis.dependencies` is what the
 *    staged manifest declares; the recursion into each dependency's own
 *    manifest happens later, inside `installPluginDependency`, against
 *    manifests this module never saw. So the check here does not by itself
 *    enumerate the ids that will land — a dependency that gained a dependency
 *    of its own after the preview passes it. That gap is closed at the fetch
 *    instead: `installPluginFromSource` threads the approved id set down the
 *    recursion, and an id nobody named is refused before it is fetched.
 * 2. It binds dependency IDENTITY, not dependency CONTENT. A dependency is
 *    fetched from its own source or registry at install time and its bytes
 *    were never staged here, so nothing in this module attests to them.
 */
export function assertPluginInstallConsent(input: {
  pluginName: string;
  consent: PluginInstallConsent;
  basis: PluginConsentBasis;
}): void {
  const { pluginName, consent, basis } = input;

  if (consent.kind === 'no-operator-decision') {
    // Not "no consent needed" — no consent TAKEN. So the question is what
    // this caller could not have disclosed, and it is asked on BOTH axes,
    // because each is blind to what the other sees:
    //
    // - `pendingConsent` names the permissions a prompt would have listed. It
    //   is derived from `requiredPermissionsForManifest`, which emits nothing
    //   for eight of eleven contribution kinds.
    // - `undisclosedContributions` names those kinds directly. Consulting
    //   only the first arm is what let a registry plugin declaring nothing
    //   but `workspacePanes` + `entrypoint` — a `<script>` in the shell's own
    //   document — install on one click with no preview and no prompt
    //   (archive#4288, review HIGH 1).
    //
    // Only a plugin that declares neither goes through: a passive-permission,
    // server-side-only plugin, whose whole contribution the derivation CAN
    // express. Both sets are derived here, so neither can disagree with what
    // a prompt would have listed.
    const undisclosed = basis.undisclosedContributions;
    if (basis.pendingConsent.length === 0 && undisclosed.length === 0) return;
    const alsoContributes =
      undisclosed.length > 0
        ? `, and contributes ${undisclosed.join(', ')} — which no permission expresses —`
        : '';
    if (basis.pendingConsent.length > 0) {
      throw new PluginConsentRefusedError({
        pluginName,
        reason: 'undisclosed-permissions',
        required: basis.required,
        message:
          `Plugin '${pluginName}' requires permissions that must be approved before it is installed ` +
          `(${basis.pendingConsent.map((entry) => entry.permission).join(', ')})${alsoContributes}, ` +
          `and ${consent.caller} installs without asking. Install it from the Plugins page, ` +
          `where the approval happens before anything is written.`,
      });
    }
    throw new PluginConsentRefusedError({
      pluginName,
      reason: 'undisclosed-contributions',
      required: basis.required,
      message:
        `Plugin '${pluginName}' contributes ${undisclosed.join(', ')} — code that runs in Station's ` +
        `own page, agent definitions, or further plugins — and no permission expresses any of it, ` +
        `so it cannot be installed without a decision taken on a preview. ` +
        `${consent.caller} installs without asking. Install it from the Plugins page, ` +
        `where the approval happens before anything is written.`,
    });
  }

  const consented = [...new Set(consent.permissions)].sort();
  const required = [...basis.required].sort();

  // Content first, deliberately. When the bytes moved, every other
  // difference is a CONSEQUENCE of that — `plugin.json` is inside the digest,
  // so a changed manifest changes both the derived set and the hash — and
  // reporting the derived-set difference would name a symptom while the
  // reader needs the cause.
  if (consent.contentDigest !== basis.contentDigest) {
    throw new PluginConsentRefusedError({
      pluginName,
      reason: 'content',
      required,
      consented,
      message:
        `Plugin '${pluginName}' was not installed: its files changed after it was reviewed. ` +
        `The approval was for ${consent.contentDigest}, and the source now reads ` +
        `${basis.contentDigest}. Preview it again before installing.`,
    });
  }

  // Reachable with a MATCHING digest, which is the whole reason it is a
  // separate check: a caller that echoes the right hash and an empty list has
  // consented to nothing at all while proving the bytes perfectly.
  if (
    consented.length !== required.length ||
    consented.some((permission, index) => permission !== required[index])
  ) {
    throw new PluginConsentRefusedError({
      pluginName,
      reason: 'permissions',
      required,
      consented,
      message:
        `Plugin '${pluginName}' was not installed: it needs ` +
        `${required.length > 0 ? required.join(', ') : 'no permissions'}, ` +
        `but the approval covered ` +
        `${consented.length > 0 ? consented.join(', ') : 'none'}. ` +
        `Preview it again and approve what it actually asks for.`,
    });
  }

  const approvedDependencies = new Set(consent.dependencies);
  const unapproved = basis.dependencies.filter(
    (id) => !approvedDependencies.has(id),
  );
  if (unapproved.length > 0) {
    throw new PluginConsentRefusedError({
      pluginName,
      reason: 'dependencies',
      required,
      consented,
      message:
        `Plugin '${pluginName}' was not installed: it would also install ` +
        `${unapproved.join(', ')}, which the approval did not name. ` +
        `Preview it again before installing.`,
    });
  }
}
