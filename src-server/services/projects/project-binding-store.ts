/**
 * station#1499 slice 2 — the per-Station binding store
 * (`docs/design/portable-project-identity.md` §3.5).
 *
 * `<home>/config/project-bindings.json` records which local checkout satisfies
 * which manifest resource. It is private to this Station: never replicated,
 * never exported, never part of a manifest, and never what a peer reads (§3.5).
 *
 * Naming note: the CONTRACT type `ProjectBindingStore`
 * (`@kontourai/station-contracts/project-identity`) is the shape of the FILE;
 * {@link ProjectBindingsStore} below is the reader/writer over that file.
 *
 * Load-bearing decisions:
 *
 * 1. **`onCorruption: 'throw'`, not the configured empty default.** A corrupt
 *    binding store that silently reads as `{ bindings: [] }` turns every bound
 *    resource into `unbound` — a silent capability loss presented as a clean
 *    "not set up here" — and the very next write would overwrite the corrupt
 *    (but possibly hand-recoverable) file with an empty one. `durableAtomicWrite`
 *    is on for the same reason: a torn write must never be the thing that
 *    produces that state.
 * 2. **A MISSING file is not a corrupt file.** Absence is the ordinary
 *    pre-first-bind state and reads as the empty store; only unparseable or
 *    ill-shaped content throws. That distinction is why the fallback here is
 *    not "a default that decides" (`docs/guides/code-quality.md`): it encodes a
 *    fact ("no bindings have ever been written"), not an unknown.
 * 3. **The read validates and refuses; it never coerces and never drops a
 *    row.** `schemaVersion` gates parsing with a named error (§2.5's
 *    `KnownEnvironment` lesson), `available` must be a real boolean rather than
 *    truthy, and one malformed binding fails the whole read rather than
 *    quietly disappearing — a dropped row is exactly the silent capability
 *    loss decision 1 is about.
 * 4. **`path` is stored verbatim (tilde preserved); `remotes` are
 *    canonicalized at WRITE** (§3.5). The path is the user's; it is expanded
 *    at each read by the resolver, in one place. The remotes are a KEY —
 *    matching a manifest resource is set-intersection against
 *    `{ canonicalRemote } ∪ aliases` (§3.3(b)) — so they are normalized once,
 *    where they enter the store.
 * 5. **`hostAliases` rewrite the LOCAL CHECKOUT side only, before
 *    canonicalization, and are NEVER applied to a manifest value** (§3.3(a)).
 *    A member whose ssh config maps `github-work` to `github.com` has a purely
 *    machine-local fact; rewriting the manifest side with it would let one
 *    member's local config change what the shared manifest is understood to
 *    mean.
 * 6. **`verifiedAt` and `state` are REQUIRED inputs to a write, not
 *    defaulted.** Defaulting `state` to `'bound'` or `verifiedAt` to
 *    `Date.now()` would let the store manufacture an observation nobody made —
 *    §3.5's "an observation, not a guarantee" only holds if the observer
 *    supplies it.
 *
 * 7. **Writes serialize a fresh read/validate/write transaction.** The
 *    operator-facing bind route can receive concurrent requests. A
 *    cross-process mutation lock means each writer re-reads the complete,
 *    validated store after it owns the lock, so distinct resource bindings
 *    cannot clobber one another. Lock acquisition failures refuse the bind;
 *    they never manufacture an empty or stale replacement store.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeGitOrigin } from '@kontourai/station-contracts/git-remote-identity';
import {
  PROJECT_BINDING_STORE_SCHEMA_VERSION,
  type ProjectBinding,
  type ProjectBindingStore,
} from '@kontourai/station-contracts/project-identity';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { JsonFileStore } from '../infra/json-store.js';

/** Reserved until #1392 introduces real membership (§3.5). */
export const LOCAL_MEMBER_ID = 'local';

export class ProjectBindingStoreShapeError extends Error {
  constructor(filePath: string, problems: string[]) {
    super(
      `Project binding store is not readable as schema v${PROJECT_BINDING_STORE_SCHEMA_VERSION}: ${filePath}\n- ${problems.join('\n- ')}`,
    );
    this.name = 'ProjectBindingStoreShapeError';
  }
}

export function projectBindingStorePath(homeDir: string): string {
  return join(homeDir, 'config', 'project-bindings.json');
}

export function emptyProjectBindingStore(): ProjectBindingStore {
  return {
    schemaVersion: PROJECT_BINDING_STORE_SCHEMA_VERSION,
    memberId: LOCAL_MEMBER_ID,
    hostAliases: {},
    bindings: [],
    credentialBindings: [],
  };
}

export interface UpsertProjectBindingInput {
  projectId: string;
  resourceId: string;
  kind: ProjectBinding['kind'];
  /** Stored verbatim — a leading `~` is preserved, never expanded here. */
  path: string;
  /** Raw remote URLs from the local checkout; canonicalized by this method. */
  remotes: string[];
  /** When the caller OBSERVED this binding. Never defaulted (decision 6). */
  verifiedAt: number;
  /** The state the caller observed. Never defaulted (decision 6). */
  state: ProjectBinding['state'];
}

// Async-compatible seam (#2646): the default is the ASYNC cross-process lock
// so a contended acquisition yields the event loop; sync test fakes remain
// assignable (awaiting a non-promise is a no-op).
type ProjectBindingMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

export interface ProjectBindingsStoreOptions {
  /** Injectable only for deterministic store concurrency tests. */
  acquireMutationLock?: ProjectBindingMutationLock;
}

/**
 * Rewrites a remote URL's host through the machine-local alias map, BEFORE
 * canonicalization (§3.3(a)). Handles the three shapes git accepts:
 * `scheme://[user@]host/…`, `[user@]host:path`, and a bare path (returned
 * unchanged — a filesystem path has no host to alias).
 */
export function applyHostAlias(
  remoteUrl: string,
  hostAliases: Record<string, string>,
): string {
  if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) return remoteUrl;
  const aliasEntries = Object.entries(hostAliases);
  if (aliasEntries.length === 0) return remoteUrl;

  let rest = remoteUrl;
  let scheme = '';
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[0];
    rest = rest.slice(scheme.length);
  }
  let userInfo = '';
  const userMatch = /^[^@/]+@/.exec(rest);
  if (userMatch) {
    userInfo = userMatch[0];
    rest = rest.slice(userInfo.length);
  }
  const hostMatch = /^[^:/]+/.exec(rest);
  if (!hostMatch) return remoteUrl;
  const host = hostMatch[0];

  const replacement = aliasEntries.find(
    ([alias]) => alias.toLowerCase() === host.toLowerCase(),
  )?.[1];
  if (replacement === undefined) return remoteUrl;
  return `${scheme}${userInfo}${replacement}${rest.slice(host.length)}`;
}

/**
 * Canonicalizes a local checkout's remote URLs for storage/matching: host
 * aliases first (§3.3(a)), then `normalizeGitOrigin` (§3.3). Empty results are
 * dropped and duplicates collapse, preserving first-seen order.
 */
export function canonicalizeCheckoutRemotes(
  remoteUrls: string[],
  hostAliases: Record<string, string>,
): string[] {
  const canonical: string[] = [];
  for (const url of remoteUrls) {
    const value = normalizeGitOrigin(applyHostAlias(url, hostAliases));
    if (value.length === 0) continue;
    if (canonical.includes(value)) continue;
    canonical.push(value);
  }
  return canonical;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  problems: string[],
): void {
  if (typeof value !== 'string' || value.length === 0) {
    problems.push(`${field}: must be a non-empty string`);
  }
}

const BINDING_KINDS = new Set(['git-checkout', 'local-directory']);
const BINDING_STATES = new Set(['bound', 'stale', 'missing', 'drifted']);

function validateBindingStore(
  value: unknown,
  filePath: string,
): ProjectBindingStore {
  const problems: string[] = [];
  if (!isPlainObject(value)) {
    throw new ProjectBindingStoreShapeError(filePath, ['must be an object']);
  }
  // schemaVersion gates everything else and is never cast (§2.5).
  if (value.schemaVersion !== PROJECT_BINDING_STORE_SCHEMA_VERSION) {
    throw new ProjectBindingStoreShapeError(filePath, [
      `schemaVersion: unknown or absent (expected ${PROJECT_BINDING_STORE_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    ]);
  }
  requireNonEmptyString(value.memberId, 'memberId', problems);

  if (!isPlainObject(value.hostAliases)) {
    problems.push('hostAliases: must be an object');
  } else {
    for (const [alias, host] of Object.entries(value.hostAliases)) {
      requireNonEmptyString(
        alias,
        `hostAliases key ${JSON.stringify(alias)}`,
        problems,
      );
      requireNonEmptyString(host, `hostAliases.${alias}`, problems);
    }
  }

  if (!Array.isArray(value.bindings)) {
    problems.push('bindings: must be an array');
  } else {
    value.bindings.forEach((binding, index) => {
      const at = `bindings[${index}]`;
      if (!isPlainObject(binding)) {
        problems.push(`${at}: must be an object`);
        return;
      }
      requireNonEmptyString(binding.projectId, `${at}.projectId`, problems);
      requireNonEmptyString(binding.resourceId, `${at}.resourceId`, problems);
      requireNonEmptyString(binding.path, `${at}.path`, problems);
      if (
        typeof binding.kind !== 'string' ||
        !BINDING_KINDS.has(binding.kind)
      ) {
        problems.push(
          `${at}.kind: must be one of ${[...BINDING_KINDS].join(', ')}`,
        );
      }
      if (
        typeof binding.state !== 'string' ||
        !BINDING_STATES.has(binding.state)
      ) {
        problems.push(
          `${at}.state: must be one of ${[...BINDING_STATES].join(', ')}`,
        );
      }
      if (
        typeof binding.remotes !== 'object' ||
        !Array.isArray(binding.remotes) ||
        binding.remotes.some((remote) => typeof remote !== 'string')
      ) {
        problems.push(`${at}.remotes: must be a string array`);
      }
      if (
        typeof binding.verifiedAt !== 'number' ||
        !Number.isFinite(binding.verifiedAt)
      ) {
        problems.push(`${at}.verifiedAt: must be a finite epoch-ms number`);
      }
    });
  }

  if (!Array.isArray(value.credentialBindings)) {
    problems.push('credentialBindings: must be an array');
  } else {
    value.credentialBindings.forEach((credential, index) => {
      const at = `credentialBindings[${index}]`;
      if (!isPlainObject(credential)) {
        problems.push(`${at}: must be an object`);
        return;
      }
      requireNonEmptyString(credential.projectId, `${at}.projectId`, problems);
      requireNonEmptyString(
        credential.integrationId,
        `${at}.integrationId`,
        problems,
      );
      // A real boolean, never truthy coercion: "available" is an authorization
      // -adjacent claim and a truthy string would read as available.
      if (typeof credential.available !== 'boolean') {
        problems.push(`${at}.available: must be a boolean`);
      }
      if (
        typeof credential.checkedAt !== 'number' ||
        !Number.isFinite(credential.checkedAt)
      ) {
        problems.push(`${at}.checkedAt: must be a finite epoch-ms number`);
      }
    });
  }

  if (problems.length > 0) {
    throw new ProjectBindingStoreShapeError(filePath, problems);
  }
  return value as unknown as ProjectBindingStore;
}

export class ProjectBindingsStore {
  private readonly filePath: string;
  private readonly store: JsonFileStore<ProjectBindingStore>;
  private readonly acquireMutationLock: ProjectBindingMutationLock;

  constructor(homeDir: string, options: ProjectBindingsStoreOptions = {}) {
    this.filePath = projectBindingStorePath(homeDir);
    this.store = new JsonFileStore<ProjectBindingStore>(
      this.filePath,
      emptyProjectBindingStore(),
      { onCorruption: 'throw', durableAtomicWrite: true },
    );
    this.acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
  }

  get path(): string {
    return this.filePath;
  }

  /** Validated read. Throws on corrupt or ill-shaped content; never coerces. */
  read(): ProjectBindingStore {
    return validateBindingStore(this.store.read(), this.filePath);
  }

  /** Machine-local ssh host aliases (§3.3(a)). Checkout side only. */
  hostAliases(): Record<string, string> {
    return this.read().hostAliases;
  }

  findBinding(
    projectId: string,
    resourceId: string,
  ): ProjectBinding | undefined {
    return this.read().bindings.find(
      (binding) =>
        binding.projectId === projectId && binding.resourceId === resourceId,
    );
  }

  /**
   * Records (or replaces) the binding for one `(projectId, resourceId)` pair.
   * `path` is stored verbatim; `remotes` are canonicalized here because they
   * are the matching key (decision 4). The fresh read is deliberately inside
   * the cross-process mutation lock: moving it above lock acquisition would
   * turn concurrent distinct-resource binds into last-writer data loss.
   */
  async upsertProjectBinding(
    input: UpsertProjectBindingInput,
  ): Promise<ProjectBinding> {
    if (typeof input.path !== 'string' || input.path.length === 0) {
      throw new Error('A project binding requires a non-empty path');
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const release = await this.acquireMutationLock(`${this.filePath}.mutation`);
    try {
      const current = this.read();
      const binding: ProjectBinding = {
        projectId: input.projectId,
        resourceId: input.resourceId,
        kind: input.kind,
        path: input.path,
        remotes: canonicalizeCheckoutRemotes(
          input.remotes,
          current.hostAliases,
        ),
        verifiedAt: input.verifiedAt,
        state: input.state,
      };
      const index = current.bindings.findIndex(
        (existing) =>
          existing.projectId === binding.projectId &&
          existing.resourceId === binding.resourceId,
      );
      const bindings =
        index === -1
          ? [...current.bindings, binding]
          : current.bindings.map((existing, at) =>
              at === index ? binding : existing,
            );
      this.store.write({ ...current, bindings });
      return binding;
    } finally {
      await release();
    }
  }
}
