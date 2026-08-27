/**
 * Workspace Home role — server-side grant store and live-standing derivation
 * (station#3122 stage 3).
 *
 * WHY SERVER-SIDE: the granted party is a `trusted-plugin-react` renderer,
 * which executes as same-origin JavaScript in the app page. Any
 * browser-writable store (localStorage included) is therefore writable by
 * the plugin being granted — a grant record there lets a plugin's
 * `activate()` grant itself Home with no user involved. This store lives
 * under the Station home where plugin page code cannot reach it.
 *
 * NO PRODUCTION WRITER EXISTS on this build — that is deliberate, and load-
 * bearing. Independent re-review showed a same-origin consent page cannot
 * bind an approval to itself (same-origin code can rewrite the page, or
 * POST inside a click's user activation without the page being seen), so
 * the consent decision must be served from a DISTINCT origin — real
 * infrastructure being scoped separately. Until it lands,
 * {@link writeWorkspaceHomeRoleGrant}'s only callers are tests: the grant
 * file can exist only if placed by hand or by that future channel. The
 * mechanism below — derivation, lapse checks, digest, revocation — is
 * complete and proven; granting awaits the distinct-origin consent
 * surface. Do NOT add a convenience CLI/debug writer to fill the gap: any
 * ordinary reachable writer is a new unguarded grant channel.
 *
 * The stored record is a claim; standing is DERIVED on every read against
 * the live installation ({@link deriveWorkspaceHomeRoleStatus}): uninstall,
 * version change, and same-version byte replacement (caught by the install
 * content digest recorded at approval) all read as `lapsed`, and the root
 * route stays on the built-in Home with the concrete reason.
 *
 * Storage follows the plugin consent-store policy ({@link GrantsFileStore},
 * station#1835): fail-closed reads, durable atomic writes, no silent
 * coercion. A grant that fails the contract's own fail-closed reparse reads
 * as no grant — the floor direction — rather than as an error.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseWorkspaceHomeRoleGrant,
  type WorkspaceHomeRoleGrant,
  type WorkspaceHomeRoleStatus,
} from '@kontourai/station-contracts/workspace-home-role';
import type { InstalledPluginWorkspacePaneContribution } from './distribution-profile-service.js';
import {
  GrantsFileStore,
  GrantsStoreUnavailableError,
  isPlainObject,
} from './grants-file-store.js';

/** The Home role store cannot be read; nothing may be decided from it. */
export class WorkspaceHomeRoleUnavailableError extends GrantsStoreUnavailableError {
  constructor(
    storePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(storePath, detail, options);
    this.name = 'WorkspaceHomeRoleUnavailableError';
  }
}

export function workspaceHomeRolePath(projectHomeDir: string): string {
  return join(projectHomeDir, 'workspace-home-role.json');
}

/** The single entry key: this store records one role, not a keyed family. */
const HOME_ROLE_STORE_KEY = 'home-role';

interface StoredWorkspaceHomeRole extends Record<string, unknown> {
  /** Serialized grant; re-derived fail-closed by the contract on every read. */
  grant: unknown;
  /** Install content digest recorded at approval; see {@link computeWorkspaceHomeRoleInstallDigest}. */
  installDigest: string;
}

interface HomeRoleStoreFile {
  [key: string]: unknown;
}

function homeRoleShapeProblems(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ['must be a plain object'];
  }
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key !== HOME_ROLE_STORE_KEY) {
      problems.push(`unexpected entry: ${key}`);
      continue;
    }
    if (!isPlainObject(entry)) {
      problems.push(`${key}: must be an object`);
      continue;
    }
    if (!isPlainObject(entry.grant)) {
      problems.push(`${key}: grant must be an object`);
    }
    if (
      typeof entry.installDigest !== 'string' ||
      entry.installDigest.length === 0
    ) {
      problems.push(`${key}: installDigest must be a non-empty string`);
    }
  }
  return problems;
}

function homeRoleStore(
  projectHomeDir: string,
): GrantsFileStore<HomeRoleStoreFile> {
  return new GrantsFileStore<HomeRoleStoreFile>({
    filePath: workspaceHomeRolePath(projectHomeDir),
    storeLabel: 'workspace-home-role',
    shapeProblems: homeRoleShapeProblems,
    makeUnavailableError: (storePath, detail, cause) =>
      new WorkspaceHomeRoleUnavailableError(storePath, detail, { cause }),
    emptyValue: {},
  });
}

/**
 * SHA-256 over the plugin's installed content that a Home role grant
 * authorizes executing: the manifest (`plugin.json`, which declares the pane
 * descriptor) and the built browser bundle (`dist/bundle.js`, plus
 * `dist/bundle.css` when present). File names are folded into the stream
 * with NUL separators so content cannot shift between files undetected.
 *
 * Returns null when the manifest or bundle cannot be read — a pane whose
 * code is not on disk cannot be granted, and at status time an unreadable
 * install reads as `code-changed` (fail closed), never as still-approved.
 */
export function computeWorkspaceHomeRoleInstallDigest(
  pluginsDir: string,
  pluginName: string,
): string | null {
  const pluginRoot = join(pluginsDir, pluginName);
  const hash = createHash('sha256');
  const required = ['plugin.json', join('dist', 'bundle.js')];
  for (const relative of required) {
    try {
      hash.update(relative);
      hash.update('\0');
      hash.update(readFileSync(join(pluginRoot, relative)));
      hash.update('\0');
    } catch {
      return null;
    }
  }
  try {
    const css = readFileSync(join(pluginRoot, join('dist', 'bundle.css')));
    hash.update('dist/bundle.css');
    hash.update('\0');
    hash.update(css);
  } catch {
    // An absent stylesheet is a legitimate install shape, not a failure.
  }
  return `sha256:${hash.digest('hex')}`;
}

export interface StoredWorkspaceHomeRoleRecord {
  grant: WorkspaceHomeRoleGrant;
  installDigest: string;
}

/**
 * Reads the stored record, re-deriving the grant fail-closed through the
 * contract constructor. Absent store or entry → null. A structurally valid
 * entry whose grant fails the current contract (tampered, or granted under a
 * wider eligibility policy) also reads null — the floor direction. An
 * unreadable or corrupt store throws {@link WorkspaceHomeRoleUnavailableError}.
 */
export function readStoredWorkspaceHomeRole(
  projectHomeDir: string,
): StoredWorkspaceHomeRoleRecord | null {
  const stored = homeRoleStore(projectHomeDir).read()[HOME_ROLE_STORE_KEY];
  if (!isPlainObject(stored)) return null;
  const entry = stored as StoredWorkspaceHomeRole;
  const grant = parseWorkspaceHomeRoleGrant(entry.grant);
  if (!grant) return null;
  return { grant, installDigest: entry.installDigest };
}

export async function writeWorkspaceHomeRoleGrant(
  projectHomeDir: string,
  grant: WorkspaceHomeRoleGrant,
  installDigest: string,
): Promise<void> {
  await homeRoleStore(projectHomeDir).mutate(HOME_ROLE_STORE_KEY, (store) => {
    store[HOME_ROLE_STORE_KEY] = {
      grant: JSON.parse(JSON.stringify(grant)),
      installDigest,
    } satisfies StoredWorkspaceHomeRole;
    return store;
  });
}

/** Revocation: remove the record; the built-in Home is what remains. */
export async function clearWorkspaceHomeRole(
  projectHomeDir: string,
): Promise<void> {
  await homeRoleStore(projectHomeDir).mutate(HOME_ROLE_STORE_KEY, (store) => {
    delete store[HOME_ROLE_STORE_KEY];
    return store;
  });
}

export interface WorkspaceHomeRoleStatusDeps {
  projectHomeDir: string;
  pluginsDir: string;
  listContributions: () => InstalledPluginWorkspacePaneContribution[];
}

/**
 * Derives the role's current standing against the live installation. Every
 * `lapsed` reason is the concrete comparison that failed, in check order:
 * plugin present → pane declared → pane enabled → version unchanged →
 * install content digest unchanged. Only a record passing all five is
 * `granted`.
 */
export function deriveWorkspaceHomeRoleStatus(
  deps: WorkspaceHomeRoleStatusDeps,
): WorkspaceHomeRoleStatus {
  const stored = readStoredWorkspaceHomeRole(deps.projectHomeDir);
  if (!stored) return { state: 'none' };
  const { grant, installDigest } = stored;
  const pluginId = grant.descriptor.provenance.pluginId;
  if (typeof pluginId !== 'string' || pluginId.length === 0) {
    // Unreachable for a grant the contract constructor produced; typed
    // fail-closed landing rather than a non-null assertion.
    return { state: 'none' };
  }
  const lapsed = (
    reason: Extract<WorkspaceHomeRoleStatus, { state: 'lapsed' }>['reason'],
  ): WorkspaceHomeRoleStatus => ({
    state: 'lapsed',
    reason,
    paneName: grant.descriptor.name,
    pluginId,
  });
  const contributions = deps.listContributions();
  const pluginEntries = contributions.filter(
    (entry) => entry.pluginName === pluginId,
  );
  if (pluginEntries.length === 0) {
    // Zero contributions cannot distinguish "uninstalled" from "installed
    // but no longer declaring any pane" — both must lapse, but the reason
    // shown to the user should be the true one. The manifest's presence is
    // the discriminating fact.
    return lapsed(
      existsSync(join(deps.pluginsDir, pluginId, 'plugin.json'))
        ? 'pane-missing'
        : 'plugin-missing',
    );
  }
  const live = pluginEntries.find(
    (entry) => entry.descriptor.id === grant.descriptor.id,
  );
  if (!live) return lapsed('pane-missing');
  if (!live.enabled) return lapsed('pane-disabled');
  const approved = grant.instance.boundContext?.contribution;
  if (
    !approved ||
    live.contribution.id !== approved.id ||
    live.contribution.sourceIdentity.id !== approved.sourceIdentity?.id ||
    live.contribution.sourceIdentity.source !==
      approved.sourceIdentity?.source ||
    live.contribution.sourceIdentity.kind !== approved.sourceIdentity?.kind
  ) {
    return lapsed('pane-missing');
  }
  if (live.contribution.version !== approved.version) {
    return lapsed('version-changed');
  }
  const currentDigest = computeWorkspaceHomeRoleInstallDigest(
    deps.pluginsDir,
    pluginId,
  );
  if (currentDigest === null || currentDigest !== installDigest) {
    return lapsed('code-changed');
  }
  return { state: 'granted', grant };
}
