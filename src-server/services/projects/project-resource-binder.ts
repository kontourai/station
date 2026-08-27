/**
 * station#1502 slice 4 — the explicit bind repair action
 * (`docs/design/portable-project-identity.md` §3.5, §3.6).
 *
 * This is the write half of the resolution surface: `describeProjectResolution`
 * reports that a resource is `unbound`, `missing`, or `drifted`, and this
 * records the checkout an operator points at. It is the first thing in the arc
 * to write a binding row — `project-binding-store.ts`'s KNOWN LIMITATION says
 * so explicitly ("the write path exists for the explicit, operator-initiated
 * bind action that lands in slice 4").
 *
 * Load-bearing decisions:
 *
 * 1. **IT VERIFIES BEFORE IT RECORDS, and refuses otherwise.** §3.6's `missing`
 *    row is "re-point or re-clone; **never silently re-bind**", and a bind that
 *    recorded whatever path it was handed would be exactly the silent re-bind
 *    with an extra click in front of it. So the candidate must EXIST, and for a
 *    `git` resource its checkout's canonicalized remote set must INTERSECT the
 *    manifest's — the same test `ProjectResourceResolver.verifyGitCheckout`
 *    applies to decide `bound` vs `drifted`. A refusal returns the reason and
 *    writes NOTHING; it never records a weaker `state` as a consolation
 *    ("exact match or an honest unavailable" — the arc's standing idiom).
 * 2. **The path is the OPERATOR'S, never derived.** This function takes a path
 *    it was given. It does not fall back to `project.workingDirectory`, does
 *    not search, and does not guess — deriving one here would re-point a
 *    broken record somewhere the operator never chose, which is decision 5 of
 *    the resolver from the write side.
 * 3. **Stored verbatim, canonicalized at the key.** The path is persisted
 *    exactly as supplied (a leading `~` preserved) per §3.5 decision 4; only
 *    the absolutized copy is used for the filesystem and git reads. The
 *    remotes are passed RAW to `upsertProjectBinding`, which canonicalizes
 *    them because they are the matching key — re-canonicalizing here would be
 *    a second opinion about the same normalization.
 * 4. **Remote canonicalization is reused, never re-derived.** The checkout's
 *    remotes go through `readCheckoutRemotes` +
 *    `canonicalizeCheckoutRemotes(…, hostAliases)` — the resolver's own
 *    helpers, with §3.3(a)'s rule that aliases rewrite the CHECKOUT side only
 *    and the manifest's values are compared verbatim. A private copy of that
 *    logic here would be a second answer to "is this the same repository",
 *    which is the one question the binding store exists to settle.
 * 5. **A refusal is CLASSIFIED, not just prose.** Each outcome carries a
 *    bounded `code` so the route can map it to a status and the metric can
 *    count it without ever putting a path, slug, or remote in an attribute.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  type ProjectBinding,
  type ProjectManifest,
  type ProjectRepoResource,
  selectPrimaryResource,
} from '@kontourai/station-contracts/project-identity';
import { expandTilde } from '../../utils/paths.js';
import type { CheckoutRemoteReader } from './checkout-remote-reader.js';
import { canonicalizeCheckoutRemotes } from './project-binding-store.js';
import { describeCheckoutRemotes } from './project-resource-resolver.js';

/**
 * Every way a bind can be refused. Bounded on purpose: it is the metric's
 * attribute domain as well as the route's status map (decision 5).
 */
export type BindProjectResourceRefusalCode =
  /** The project declares no resources, so there is no resource to bind to. */
  | 'no-resources-declared'
  /** §3.5 cardinality: no single resource could be named to bind. */
  | 'ambiguous'
  /**
   * A `resourceId` was named and this project does not declare it
   * (station#1503). Never answered by binding the primary instead: that would
   * write a record for a resource the operator did not name, which is decision
   * 2 from the other end.
   */
  | 'unknown-resource'
  /** The supplied path does not exist. */
  | 'path-not-found'
  /**
   * The supplied path is relative, so it names nothing the operator chose:
   * `resolve()` would evaluate it against the SERVER PROCESS's cwd. A
   * `~`-prefixed path is absolute after `expandTilde` and is NOT this.
   */
  | 'path-not-absolute'
  /** It exists and it is not a directory (a file, or a symlink to one). */
  | 'path-not-a-directory'
  /** The checkout could not be read at all, so nothing was verified. */
  | 'unverifiable'
  /**
   * Its remote set does not intersect the manifest's. Literally true of an
   * EMPTY checkout set too, which is why the reason — not the code — is what
   * distinguishes "a different repository" from "no identity to compare".
   */
  | 'remotes-do-not-intersect';

export type BindProjectResourceResult =
  | { ok: true; binding: ProjectBinding }
  | { ok: false; code: BindProjectResourceRefusalCode; reason: string };

/** The subset of `ProjectBindingsStore` this action writes through. */
export interface ProjectBindingWriter {
  hostAliases(): Record<string, string>;
  upsertProjectBinding(input: {
    projectId: string;
    resourceId: string;
    kind: ProjectBinding['kind'];
    path: string;
    remotes: string[];
    verifiedAt: number;
    state: ProjectBinding['state'];
  }): Promise<ProjectBinding>;
}

/** The subset of `ProjectManifestStore` this action reads. */
export interface ProjectManifestReader {
  readProjectManifest(slug: string): ProjectManifest | undefined;
}

export interface BindProjectResourceDeps {
  manifests: ProjectManifestReader;
  bindings: ProjectBindingWriter;
  readRemotes: CheckoutRemoteReader;
  /** Injected for tests; the observation's timestamp is never defaulted inside the store (§3.5 decision 6). */
  now?: () => number;
}

/**
 * `statSync` follows symlinks on purpose: a symlink to a directory IS a usable
 * workspace directory, and one to a file is not. A throw (a race against a
 * delete, a permission wall) is answered `false` — the point of the check is
 * that nothing is recorded unless a directory was positively observed.
 */
function isDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function selectBindTarget(
  manifest: ProjectManifest,
  resourceId: string | undefined,
):
  | { ok: true; resource: ProjectRepoResource }
  | { ok: false; code: BindProjectResourceRefusalCode; reason: string } {
  // station#1503 slice 5: an explicitly named resource is bound EXACTLY, or
  // refused by name. Falling back to the primary would record a checkout
  // against a resource the operator never named — and on a multi-repo project
  // that is the ordinary case, not an edge one: the repair form for the third
  // repo would silently re-point the first.
  if (resourceId !== undefined) {
    const found = manifest.repos.find((repo) => repo.id === resourceId);
    if (found) return { ok: true, resource: found };
    return {
      ok: false,
      code: 'unknown-resource',
      reason: `Project "${manifest.slug}" does not declare a resource named "${resourceId}". Its resources are: ${manifest.repos.map((repo) => repo.id).join(', ') || '(none)'}. Nothing was recorded.`,
    };
  }
  const selection = selectPrimaryResource(manifest.repos);
  if (selection.ok) return { ok: true, resource: selection.resource };
  if (selection.code === 'no-resources-declared') {
    return {
      ok: false,
      code: 'no-resources-declared',
      reason: `Project "${manifest.slug}" declares no resources, so there is nothing here to bind a checkout to.`,
    };
  }
  // §3.5's cardinality rule, applied — not re-decided. Binding "the primary"
  // when the manifest names several and marks none (or two) would be the coin
  // flip presented as fact that `ambiguous` exists to refuse.
  return {
    ok: false,
    code: 'ambiguous',
    reason: `Project "${manifest.slug}" names no single resource to bind (${selection.code}); candidates: ${selection.candidates.map((repo) => repo.id).join(', ') || '(none)'}. Declare exactly one primary first.`,
  };
}

/**
 * Records the binding for one of a project's resources at an operator-supplied
 * path — or refuses, with the reason, having written nothing.
 *
 * `resourceId` names WHICH resource (station#1503 slice 5). Omitting it keeps
 * slice 4's behaviour byte-for-byte: the primary, or a refusal when no single
 * resource can be named. It is optional rather than required because a
 * single-repo project's repair form has nothing to name and every existing
 * caller means the primary.
 *
 * Throws only what its dependencies throw (an unknown project, an unreadable
 * manifest); the route classifies those.
 */
export async function bindProjectResource(
  projectSlug: string,
  requestedPath: string,
  deps: BindProjectResourceDeps,
  resourceId?: string,
): Promise<BindProjectResourceResult> {
  const manifest = deps.manifests.readProjectManifest(projectSlug);
  if (!manifest) {
    // A binding row is keyed by the manifest's portable `id`; with no manifest
    // there is no key and nothing to bind TO. The compat path is the project's
    // own working directory, which is edited on the project, not here.
    return {
      ok: false,
      code: 'no-resources-declared',
      reason: `Project "${projectSlug}" has no manifest yet, so it declares no resources to bind. It resolves through its working directory until its resources are declared.`,
    };
  }

  const target = selectBindTarget(manifest, resourceId);
  if (!target.ok) return target;
  const resource = target.resource;

  // Decision 2: the operator's path. Decision 3: absolutized for the reads,
  // stored verbatim below.
  const expanded = expandTilde(requestedPath);
  if (!isAbsolute(expanded)) {
    // `resolve()` below would silently base a relative value on the SERVER
    // PROCESS's cwd — a directory the operator never chose and cannot see. A
    // bare `station` would land on this repo's own CLI script. The resolver
    // makes the same point from the read side (its decision 8); here it must
    // be a REFUSAL rather than a resolution, because this path is about to be
    // persisted as a record of where a resource lives.
    return {
      ok: false,
      code: 'path-not-absolute',
      reason: `"${requestedPath}" is a relative path, so what it names depends on where this Station's server process happens to be running. Give the full path to the checkout. Nothing was recorded.`,
    };
  }
  const absolute = resolvePath(expanded);
  if (!existsSync(absolute)) {
    return {
      ok: false,
      code: 'path-not-found',
      reason: `"${requestedPath}" does not exist, so there is nothing there to verify as "${resource.id}". Nothing was recorded.`,
    };
  }
  if (!isDirectory(absolute)) {
    // `existsSync` is true for a regular file and for a symlink to one. A
    // binding is a claim about a WORKSPACE DIRECTORY: `project-workspace-path.
    // ts` hands the recorded path to seams as one, and `resolveProjectResource`
    // would return it under the `bound` ANSWER slot. Recording a file there
    // makes every one of those consumers wrong, and it would be a `bound`
    // claim — "the live check passed just now" — about a check that only ever
    // asked whether the inode exists.
    return {
      ok: false,
      code: 'path-not-a-directory',
      reason: `"${requestedPath}" exists but is not a directory, so it cannot be the checkout for "${resource.id}". Nothing was recorded.`,
    };
  }

  const now = deps.now ?? Date.now;

  if (resource.kind !== 'git') {
    // A `local-only` resource carries no portable identity to check the
    // directory against (§3.2), so DIRECTORY existence is the whole of the
    // available verification — the same bar `ProjectResourceResolver` applies
    // when it returns `bound` for one.
    const binding = await deps.bindings.upsertProjectBinding({
      projectId: manifest.id,
      resourceId: resource.id,
      kind: 'local-directory',
      path: requestedPath,
      remotes: [],
      verifiedAt: now(),
      state: 'bound',
    });
    return { ok: true, binding };
  }

  const remotes = await deps.readRemotes(absolute);
  if (!remotes.ok) {
    // Decision 1: an unverifiable candidate is refused, not recorded as
    // `stale`. `stale` is an observation about a binding that already exists;
    // manufacturing one at CREATE time would record a claim nobody made.
    return {
      ok: false,
      code: 'unverifiable',
      reason: `The checkout at "${requestedPath}" could not be verified as "${resource.id}" (${remotes.reason}). Nothing was recorded.`,
    };
  }

  // Decision 4: aliases rewrite the checkout side only (§3.3(a)); the
  // manifest's values are compared verbatim.
  const checkoutRemotes = canonicalizeCheckoutRemotes(
    remotes.remotes.map((remote) => remote.url),
    deps.bindings.hostAliases(),
  );
  const manifestRemotes = [
    resource.canonicalRemote,
    ...(resource.aliases ?? []),
  ];
  if (!checkoutRemotes.some((remote) => manifestRemotes.includes(remote))) {
    // Decision 4 applies to the DESCRIPTION as well as the comparison. An
    // empty canonical set has two causes and NEITHER supports a positive
    // identity claim: `readCheckoutRemotes` returns `{ok: true, remotes: []}`
    // both for a directory that is not a repository at all (exit 128, no
    // `.git` above it) and for a real repository with no remote configured
    // yet; and a repository whose remote URLs all canonicalize to nothing has
    // remotes that cannot be compared. Saying "it is a different repository"
    // there asserts an identity that was never established, and offering to
    // "bind it to the resource it actually is" names an action that does not
    // apply to a directory with no identity to bind.
    const observed = describeCheckoutRemotes(remotes.remotes, checkoutRemotes);
    const reason =
      checkoutRemotes.length === 0
        ? `The checkout at "${requestedPath}" advertises ${observed}, so this Station could not establish which repository it is and cannot confirm it as "${resource.id}" (which is identified by [${manifestRemotes.join(', ')}]). Nothing was recorded.`
        : `The checkout at "${requestedPath}" advertises ${observed}, which does not intersect "${resource.id}"'s [${manifestRemotes.join(', ')}]. It is a different repository, so nothing was recorded — re-point it, or bind it to the resource it actually is.`;
    return { ok: false, code: 'remotes-do-not-intersect', reason };
  }

  const binding = await deps.bindings.upsertProjectBinding({
    projectId: manifest.id,
    resourceId: resource.id,
    kind: 'git-checkout',
    // Decision 3: verbatim. `remotes` raw — the store canonicalizes them
    // because they are the matching key.
    path: requestedPath,
    remotes: remotes.remotes.map((remote) => remote.url),
    verifiedAt: now(),
    state: 'bound',
  });
  return { ok: true, binding };
}
