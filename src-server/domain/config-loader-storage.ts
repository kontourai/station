import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import {
  type ACPConfig,
  normalizeACPArgs,
} from '@kontourai/station-contracts/acp';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type {
  SkillCommand,
  SkillOrigin,
  SkillProvenance,
  SkillVariable,
} from '@kontourai/station-contracts/catalog';
import {
  assertToolOAuthClientWritable,
  isSafeToolServerId,
  type ToolDef,
  type ToolMetadata,
} from '@kontourai/station-contracts/tool';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { normalizePersistedToolServerReason } from '../security/tool-server-reason.js';
import { IntegrationIconAssets } from '../services/plugins/integration-icon-assets.js';
import { readIntegrationOrigin } from '../services/plugins/integration-origin.js';
import {
  removePrincipalToolServerCredentials,
  ToolServerCredentialStore,
  toolServerIntegrationMutationLockPath,
} from '../services/plugins/tool-server-credential-store.js';
import { publishJsonFileWithOwnedLock } from './file-storage-helpers.js';
import {
  assertSkillPackageDirectory,
  resolveSkillDirectory,
} from './skill-paths.js';

/**
 * Defense-in-depth (repo review, 2026-07-26; loosened same day after a
 * compat-break re-review): every caller below joins `id` directly into a
 * filesystem path under `<projectHomeDir>/integrations/`. This guard is
 * intentionally SAFETY-only (`isSafeToolServerId` — rejects only path
 * separators, `.`, `..`, and empty) rather than an aesthetic naming pattern:
 * a stricter first pass here made existing on-disk integrations with dots
 * or uppercase in their id silently disappear from listing/load, which is a
 * worse regression than the traversal risk it was meant to close. This
 * loader is reachable from config already on disk (hand-edited, or written
 * before any schema validation existed), so it re-validates independently
 * rather than trusting the caller.
 */
function assertSafeIntegrationId(id: string): void {
  if (!isSafeToolServerId(id)) {
    throw new Error(
      `Invalid tool-server id: ${JSON.stringify(id)} (must not be empty, '.', '..', a dangerous object key, or contain a path separator)`,
    );
  }
}

export interface SkillConfigRecord {
  name: string;
  description?: string;
  source:
    | 'local'
    | 'registry'
    | 'plugin'
    | 'flow-agents'
    | `agent-plugin:${string}`;
  /**
   * When this package was INSTALLED, by whatever installed it.
   *
   * Optional because a package can be discovered without ever having been
   * installed — a `SKILL.md` authored by hand, or dropped into a workspace
   * (#1614) — and the honest answer to "when was this installed" for such a
   * package is nothing at all. A writer that has no install to date must leave
   * it absent rather than stamp the moment it happened to write a record,
   * which would date the record and read as the package.
   */
  installedAt?: string;
  version?: string;
  path: string;
  body?: string;
  tags?: string[];
  category?: string;
  agent?: string;
  global?: boolean;
  provenance?: SkillProvenance;
  /**
   * Station's install record mirrors the `command`/`variables` an author wrote
   * in `SKILL.md` frontmatter so a listing can answer "is this a command?"
   * without parsing every skill body. The frontmatter remains the portable
   * source of truth — on read it wins over this mirror (see
   * `SkillService.getSkill`), exactly as `agent`/`global` already do.
   */
  command?: SkillCommand;
  /** Declared variable metadata; the variable SET is derived from the body. */
  variables?: SkillVariable[];
  /** Legacy UUIDs / `<plugin>:<id>` this skill was migrated from. */
  legacyIds?: string[];
  /** Written by the writer that knows where the skill came from. */
  origin?: SkillOrigin;
}

const integrationEnabledSynthesized = Symbol('integrationEnabledSynthesized');

export function wasIntegrationEnabledExplicit(def: ToolDef): boolean {
  const tracked = def as ToolDef & {
    [integrationEnabledSynthesized]?: boolean;
  };
  return (
    !tracked[integrationEnabledSynthesized] && Object.hasOwn(def, 'enabled')
  );
}

export function markIntegrationEnabledExplicit(def: ToolDef): void {
  delete (def as ToolDef & { [integrationEnabledSynthesized]?: boolean })[
    integrationEnabledSynthesized
  ];
}

/** Whether an integration definition file exists on disk (archive#3063). */
export function integrationConfigExists(
  projectHomeDir: string,
  id: string,
): boolean {
  assertSafeIntegrationId(id);
  return existsSync(integrationConfigPath(projectHomeDir, id));
}

export async function loadIntegrationConfig(
  projectHomeDir: string,
  id: string,
): Promise<ToolDef> {
  assertSafeIntegrationId(id);
  const path = join(projectHomeDir, 'integrations', id, 'integration.json');

  if (!existsSync(path)) {
    throw new Error(`Tool '${id}' not found at ${path}`);
  }

  const def = JSON.parse(await readFile(path, 'utf-8')) as ToolDef;
  if (Object.hasOwn(def, 'envCredentialRefs')) {
    throw new Error(
      `Retired tool-server credential format for ${JSON.stringify(id)}: this branch's pre-release envCredentialRefs format changed; clear this developer home and recreate the integration`,
    );
  }
  if (def.storedEnvNames) {
    const store = new ToolServerCredentialStore(projectHomeDir);
    def.env = { ...def.env };
    for (const name of def.storedEnvNames) def.env[name] = store.get(id, name);
  }
  const projected = { ...def, enabled: def.enabled !== false };
  if (!Object.hasOwn(def, 'enabled'))
    Object.defineProperty(projected, integrationEnabledSynthesized, {
      value: true,
      enumerable: true,
    });
  return projected;
}

export async function saveIntegrationConfig(
  projectHomeDir: string,
  id: string,
  def: ToolDef,
): Promise<void> {
  assertSafeIntegrationId(id);
  await mkdir(join(projectHomeDir, 'integrations'), { recursive: true });
  const integrationPath = integrationConfigPath(projectHomeDir, id);
  const release = await acquireFileMutationLockAsync(
    toolServerIntegrationMutationLockPath(projectHomeDir, id),
  );
  try {
    await mkdir(join(projectHomeDir, 'integrations', id), { recursive: true });
    const current = existsSync(integrationPath)
      ? (JSON.parse(readFileSync(integrationPath, 'utf8')) as ToolDef)
      : undefined;
    await writeIntegrationConfigLocked(
      projectHomeDir,
      id,
      integrationPath,
      def,
      current,
    );
  } finally {
    await release();
  }
}

/**
 * Atomically derive and save one integration while holding the exact same
 * cross-runtime lock as ordinary saves. The updater is deliberately
 * synchronous: no caller-controlled await can widen the verified-read/write
 * window while the lock is held.
 */
export async function updateIntegrationConfig(
  projectHomeDir: string,
  id: string,
  update: (current: ToolDef) => ToolDef,
): Promise<ToolDef> {
  assertSafeIntegrationId(id);
  await mkdir(join(projectHomeDir, 'integrations'), { recursive: true });
  const integrationPath = integrationConfigPath(projectHomeDir, id);
  const release = await acquireFileMutationLockAsync(
    toolServerIntegrationMutationLockPath(projectHomeDir, id),
  );
  try {
    if (!existsSync(integrationPath)) {
      throw new Error(`Tool '${id}' not found at ${integrationPath}`);
    }
    const current = JSON.parse(
      readFileSync(integrationPath, 'utf8'),
    ) as ToolDef;
    rejectRetiredIntegrationCredentialFormat(current, id);
    const next = update(current);
    await writeIntegrationConfigLocked(
      projectHomeDir,
      id,
      integrationPath,
      next,
      current,
    );
    return next;
  } finally {
    await release();
  }
}

function integrationConfigPath(projectHomeDir: string, id: string): string {
  return join(projectHomeDir, 'integrations', id, 'integration.json');
}

function rejectRetiredIntegrationCredentialFormat(
  current: ToolDef | undefined,
  id: string,
): void {
  if (current && Object.hasOwn(current, 'envCredentialRefs')) {
    throw new Error(
      `Retired tool-server credential format for ${JSON.stringify(id)}: this branch's pre-release envCredentialRefs format changed; clear this developer home and recreate the integration`,
    );
  }
}

async function writeIntegrationConfigLocked(
  projectHomeDir: string,
  id: string,
  integrationPath: string,
  def: ToolDef,
  current: ToolDef | undefined,
): Promise<void> {
  rejectRetiredIntegrationCredentialFormat(current, id);
  assertToolOAuthClientWritable(current, def);
  const persisted = { ...def };
  delete persisted.secretEnv;
  delete persisted.removeSecretEnvKeys;
  const explicitlyEdited = Object.hasOwn(def, 'secretEnv');
  const inboundSecrets = explicitlyEdited ? (def.secretEnv ?? {}) : {};
  const removals = new Set(def.removeSecretEnvKeys ?? []);
  const refs = new Set([
    ...(current?.storedEnvNames ?? []),
    ...(persisted.storedEnvNames ?? []),
  ]);
  const needsStore =
    Object.keys(inboundSecrets).length > 0 || removals.size > 0;
  const store = needsStore
    ? new ToolServerCredentialStore(projectHomeDir)
    : null;
  // Commit order is intentional: material first, marker-bearing config second,
  // removals last. A crash between the store write and config write leaves an
  // unreferenced credential record that nothing currently collects. This is a
  // disclosed accepted gap pending a separately-authorized maintenance sweep.
  for (const [name, secret] of Object.entries(inboundSecrets)) {
    await store!.upsert(id, name, secret);
    refs.add(name);
  }
  for (const name of removals) {
    refs.delete(name);
    // A removal can be part of a binding migration. The loaded definition may
    // contain the legacy credential materialized from the store, so removing
    // only its marker would otherwise persist that value inline.
    if (persisted.env) delete persisted.env[name];
  }
  if (refs.size > 0) {
    persisted.storedEnvNames = [...refs].sort();
    persisted.env = { ...persisted.env };
    for (const name of refs) delete persisted.env[name];
    if (Object.keys(persisted.env).length === 0) delete persisted.env;
  } else delete persisted.storedEnvNames;
  // Legacy inline material is migrated only when this server's secrets are
  // explicitly edited. Unrelated saves preserve its existing bytes/shape.
  if (explicitlyEdited) {
    persisted.env = { ...persisted.env };
    for (const name of Object.keys(inboundSecrets)) delete persisted.env[name];
    if (Object.keys(persisted.env).length === 0) delete persisted.env;
  }
  const synthesized = (
    def as ToolDef & { [integrationEnabledSynthesized]?: boolean }
  )[integrationEnabledSynthesized];
  if (synthesized && def.enabled === true) delete persisted.enabled;
  await publishJsonFileWithOwnedLock(integrationPath, persisted);
  ensureIntegrationInstanceIdLocked(projectHomeDir, id);
  // One credential-store publication retains the referenced set while
  // removing a migrated set. Splitting this into removeMany then reconcile
  // admitted a partial delete if the second write failed after the first.
  if (store) await store.reconcileServer(id, [...refs], [...removals]);
}

/**
 * #4279: a server-created identity for one integration's existence, kept
 * beside `integration.json` so no definition, writer, registry, plugin or
 * import can set it. The locked writer creates it on first write and never
 * replaces it; deleting the integration removes it with the directory, so an
 * integration recreated under the same id is a new instance. OAuth
 * client-secret grants record it, so a deleted integration's grants cannot
 * authorize its replacement.
 */
export const INTEGRATION_INSTANCE_FILE = '.station-instance';
const INTEGRATION_INSTANCE_ID = /^[0-9a-f-]{36}$/;

const RESERVED_SIDECAR_KEYS = new Set(
  ['.station-instance', '.station-oauth-issuer'].map(sidecarNameKey),
);

/** Case- and Unicode-folded, as case-insensitive filesystems compare names. */
function sidecarNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().normalize('NFKC');
}

/** Whether a file name could resolve to one of Station's own sidecars. */
export function isReservedIntegrationSidecarName(name: string): boolean {
  return RESERVED_SIDECAR_KEYS.has(sidecarNameKey(name));
}

/**
 * A sidecar is trusted only as a regular file whose directory entry is
 * spelled exactly as Station writes it. On a case-insensitive filesystem a
 * differently cased file resolves to the same path; it was not written by
 * Station, so it reads as absent.
 */
function sidecarPresentExactly(path: string): boolean {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return false;
  const name = path.slice(path.lastIndexOf(sep) + 1);
  return readdirSync(dirname(path)).includes(name);
}

/**
 * Before Station writes a sidecar, remove any entry spelled differently that
 * the filesystem would resolve to it, so the written file carries Station's
 * exact name.
 */
function removeVariantSidecars(path: string): void {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const dir = dirname(path);
  for (const entry of readdirSync(dir))
    if (entry !== name && sidecarNameKey(entry) === sidecarNameKey(name))
      rmSync(join(dir, entry), { force: true });
}

function integrationInstancePath(projectHomeDir: string, id: string): string {
  assertSafeIntegrationId(id);
  return join(projectHomeDir, 'integrations', id, INTEGRATION_INSTANCE_FILE);
}

/** The integration's instance id, or undefined when absent or malformed. */
export function readIntegrationInstanceId(
  projectHomeDir: string,
  id: string,
): string | undefined {
  const path = integrationInstancePath(projectHomeDir, id);
  if (!sidecarPresentExactly(path)) return undefined;
  const value = readFileSync(path, 'utf8').trim();
  return INTEGRATION_INSTANCE_ID.test(value) ? value : undefined;
}

function ensureIntegrationInstanceIdLocked(
  projectHomeDir: string,
  id: string,
): string {
  const existing = readIntegrationInstanceId(projectHomeDir, id);
  if (existing) return existing;
  const minted = randomUUID();
  removeVariantSidecars(integrationInstancePath(projectHomeDir, id));
  writeFileSync(integrationInstancePath(projectHomeDir, id), minted, {
    mode: 0o600,
  });
  return minted;
}

/**
 * The instance id of an existing integration, created under the
 * integration's mutation lock if an older or externally written definition
 * has none yet.
 */
export async function ensureIntegrationInstanceId(
  projectHomeDir: string,
  id: string,
): Promise<string> {
  assertSafeIntegrationId(id);
  const release = await acquireFileMutationLockAsync(
    toolServerIntegrationMutationLockPath(projectHomeDir, id),
  );
  try {
    if (!existsSync(integrationConfigPath(projectHomeDir, id)))
      throw new Error(`Tool '${id}' not found`);
    return ensureIntegrationInstanceIdLocked(projectHomeDir, id);
  } finally {
    await release();
  }
}

/**
 * #4279: the authorization server an integration without a declared issuer
 * was first registered with, for one MCP resource. Kept beside
 * `integration.json` (no writer, registry, plugin or import can set it),
 * shared by every person's sign-in, and removed with the integration.
 * Changing the endpoint changes the resource, which starts a new pin.
 */
export const INTEGRATION_OAUTH_ISSUER_FILE = '.station-oauth-issuer';

function integrationOAuthIssuerPath(projectHomeDir: string, id: string) {
  assertSafeIntegrationId(id);
  return join(
    projectHomeDir,
    'integrations',
    id,
    INTEGRATION_OAUTH_ISSUER_FILE,
  );
}

/** The pinned issuer for this resource, or undefined. */
export function readIntegrationOAuthIssuerPin(
  projectHomeDir: string,
  id: string,
  resource: string,
): string | undefined {
  const path = integrationOAuthIssuerPath(projectHomeDir, id);
  if (!sidecarPresentExactly(path)) return undefined;
  try {
    const pin = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion?: unknown;
      resource?: unknown;
      issuer?: unknown;
    };
    return pin.schemaVersion === 1 &&
      pin.resource === resource &&
      typeof pin.issuer === 'string'
      ? pin.issuer
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pin `issuer` for this resource unless one is already pinned, under the
 * integration's mutation lock. Returns the pinned issuer, which differs from
 * `issuer` when another server was pinned first. An integration that no
 * longer exists pins nothing.
 */
const oauthPinQueues = new Map<string, Promise<void>>();

/**
 * One integration's OAuth pin lock. Establishing the pin and every outbound
 * authorization-server request (registration, code exchange, refresh) hold
 * it, so a request's issuer check and its send cannot be split by another
 * sign-in pinning a different server. In-process callers queue in order; the
 * file lock covers other processes sharing the home. A request held under it
 * is bounded by its caller.
 */
export async function withIntegrationOAuthPinLock<T>(
  projectHomeDir: string,
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  assertSafeIntegrationId(id);
  const path = join(
    projectHomeDir,
    'integrations',
    `.${id}.oauth-pin.mutation`,
  );
  const previous = oauthPinQueues.get(path) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => turn);
  oauthPinQueues.set(path, tail);
  await previous;
  try {
    await mkdir(join(projectHomeDir, 'integrations'), { recursive: true });
    const unlock = await acquireFileMutationLockAsync(path, {
      timeoutMs: 45_000,
    });
    try {
      return await action();
    } finally {
      await unlock();
    }
  } finally {
    releaseQueue();
    if (oauthPinQueues.get(path) === tail) oauthPinQueues.delete(path);
  }
}

export async function claimIntegrationOAuthIssuerPin(
  projectHomeDir: string,
  id: string,
  resource: string,
  issuer: string,
): Promise<string> {
  return withIntegrationOAuthPinLock(projectHomeDir, id, async () => {
    const existing = readIntegrationOAuthIssuerPin(
      projectHomeDir,
      id,
      resource,
    );
    if (existing) return existing;
    if (!existsSync(integrationConfigPath(projectHomeDir, id))) return issuer;
    removeVariantSidecars(integrationOAuthIssuerPath(projectHomeDir, id));
    writeFileSync(
      integrationOAuthIssuerPath(projectHomeDir, id),
      JSON.stringify({ schemaVersion: 1, resource, issuer }),
      { mode: 0o600 },
    );
    return issuer;
  });
}

export async function deleteIntegrationConfig(
  projectHomeDir: string,
  id: string,
): Promise<void> {
  assertSafeIntegrationId(id);
  await mkdir(join(projectHomeDir, 'integrations'), { recursive: true });
  const integrationDir = join(projectHomeDir, 'integrations', id);
  const release = await acquireFileMutationLockAsync(
    toolServerIntegrationMutationLockPath(projectHomeDir, id),
  );
  try {
    if (existsSync(integrationDir)) {
      rmSync(integrationDir, { recursive: true, force: true });
    }
    const store = new ToolServerCredentialStore(projectHomeDir);
    await store.removeServer(id);
    // #3279: people's own connected accounts for this server go with it.
    await removePrincipalToolServerCredentials(projectHomeDir, id);
  } finally {
    await release();
  }
}

export async function listIntegrationMetadata(
  projectHomeDir: string,
  logger: {
    error: (message: string, fields?: Record<string, unknown>) => void;
  },
): Promise<ToolMetadata[]> {
  const integrationsDir = join(projectHomeDir, 'integrations');
  if (!existsSync(integrationsDir)) {
    return [];
  }

  const entries = await readdir(integrationsDir, { withFileTypes: true });
  const tools: ToolMetadata[] = [];
  const iconAssets = new IntegrationIconAssets(projectHomeDir);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const integrationPath = join(
      integrationsDir,
      entry.name,
      'integration.json',
    );
    if (!existsSync(integrationPath)) continue;

    try {
      const def = await loadIntegrationConfig(projectHomeDir, entry.name);
      const iconAsset = await iconAssets.resolve(entry.name);
      tools.push({
        id: def.id,
        kind: def.kind,
        displayName: def.displayName,
        description: def.description,
        // A malformed disk manifest (e.g. hand-edited `"icon": 123`) must
        // not flow a non-string through to the UI's icon renderer — guard
        // the same way `readDiskIntegrations` does.
        icon: typeof def.icon === 'string' ? def.icon : undefined,
        ...(iconAsset.status === 'found'
          ? { iconUrl: `/integrations/${encodeURIComponent(entry.name)}/icon` }
          : {}),
        transport: def.transport,
        source: def.command || def.endpoint,
        origin: readIntegrationOrigin(projectHomeDir, def),
        credentialOwnership: def.credentialOwnership,
        enabled: def.enabled !== false,
        disabledTools: def.disabledTools,
        probe: sanitizeProbeProjection(def.probe),
        requiresEnvSecrets: Boolean(
          (def.env && Object.keys(def.env).length > 0) ||
            (def.storedEnvNames && def.storedEnvNames.length > 0) ||
            Object.keys(def.secretEnvRefs ?? {}).length > 0,
        ),
      });
    } catch (error) {
      logger.error('Failed to load tool', { tool: entry.name, error });
    }
  }

  return tools;
}

function sanitizeProbeProjection(probe: ToolDef['probe']): ToolDef['probe'] {
  if (!probe) return undefined;
  return {
    ...probe,
    ...(probe.error
      ? { error: normalizePersistedToolServerReason(probe.error) }
      : {}),
    ...(probe.authorization && 'reason' in probe.authorization
      ? {
          authorization: {
            ...probe.authorization,
            reason: normalizePersistedToolServerReason(
              probe.authorization.reason,
            ),
          },
        }
      : {}),
  };
}

export async function listSkillConfigs(
  projectHomeDir: string,
  logger: { warn: (message: string, fields?: Record<string, unknown>) => void },
): Promise<SkillConfigRecord[]> {
  const dir = join(projectHomeDir, 'skills');
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const results: SkillConfigRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cfgPath = join(dir, entry.name, 'skill.json');
    if (!existsSync(cfgPath)) continue;
    try {
      results.push(JSON.parse(await readFile(cfgPath, 'utf-8')));
    } catch {
      logger.warn('Failed to read skill config', { path: cfgPath });
    }
  }
  return results;
}

/**
 * Does this install record answer for `name`?
 *
 * A package copied into a new directory carries the record it was copied with,
 * and that record's `legacyIds`, `provenance` and `installedAt` belong to the
 * skill it was written for. Answering the new name with them hands a caller
 * another skill's identity — `resolveSkillName` would route that skill's legacy
 * ids to it, and an update reads `name` back off the record, so a record
 * claiming `foo` under `<home>/skills/bar` renamed `bar` to `foo` on a request
 * that asked for no rename at all.
 *
 * THE rule, exported so both readers share it rather than restate it: this
 * loader, and `SkillService`'s read of the record beside a discovered body.
 */
export function skillRecordClaimsName(
  record: Pick<SkillConfigRecord, 'name'>,
  name: string,
): boolean {
  return record.name === name;
}

export async function loadSkillConfig(
  projectHomeDir: string,
  name: string,
): Promise<SkillConfigRecord> {
  const path = join(resolveSkillDirectory(projectHomeDir, name), 'skill.json');
  if (!existsSync(path)) throw new Error(`Skill '${name}' not found`);
  const record = JSON.parse(await readFile(path, 'utf-8')) as SkillConfigRecord;
  // A record that names another skill is not this skill's record; a name with
  // no record of its own is the same answer either way.
  if (!skillRecordClaimsName(record, name))
    throw new Error(`Skill '${name}' not found`);
  return record;
}

/**
 * Write a package's record INTO the package's own directory.
 *
 * The name-addressed `saveSkillConfig`/`deleteSkillConfig` this replaced
 * resolved that directory from the name and a project slug they were never
 * given, so a scoped write put `SKILL.md` in the project directory and
 * `skill.json` in `<home>/skills/<name>` — one package in two roots, each half
 * telling a different story about where the other is (#1619). They are gone
 * rather than left for the next writer to reach for: the caller that already
 * knows the directory passes it, which is the only way the two files cannot
 * diverge. It asserts containment through
 * `assertSkillPackageDirectory`, because a directory that did not come from
 * `resolveSkillDirectory` has not been through its guarantees.
 */
export async function saveSkillConfigIn(
  projectHomeDir: string,
  directory: string,
  config: SkillConfigRecord,
): Promise<void> {
  assertSkillPackageDirectory(projectHomeDir, config.name, directory);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'skill.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

/** Remove a package by its own directory. See `saveSkillConfigIn`. */
export async function deleteSkillPackageAt(
  projectHomeDir: string,
  name: string,
  directory: string,
): Promise<void> {
  assertSkillPackageDirectory(projectHomeDir, name, directory);
  if (!existsSync(directory)) throw new Error(`Skill '${name}' not found`);
  await rm(directory, { recursive: true, force: true });
}

export function skillConfigExists(
  projectHomeDir: string,
  name: string,
): boolean {
  return existsSync(
    join(resolveSkillDirectory(projectHomeDir, name), 'skill.json'),
  );
}

export async function loadACPConfigFile(
  projectHomeDir: string,
): Promise<ACPConfig> {
  const path = join(projectHomeDir, 'config', 'acp.json');
  if (!existsSync(path)) return { connections: [] };
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  assertACPConfig(parsed);
  return {
    ...parsed,
    connections: parsed.connections.map((connection) =>
      connection.args
        ? { ...connection, args: normalizeACPArgs(connection.args) }
        : connection,
    ),
  };
}

function assertACPConfig(value: unknown): asserts value is ACPConfig {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { connections?: unknown }).connections)
  ) {
    throw new Error('ACP configuration is invalid.');
  }
  const ids = new Set<string>();
  for (const candidate of (value as { connections: unknown[] }).connections) {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('ACP configuration contains an invalid connection.');
    }
    const connection = candidate as Record<string, unknown>;
    const optionalStrings = ['icon', 'cwd'] as const;
    const interactiveArgs =
      connection.interactive && typeof connection.interactive === 'object'
        ? (connection.interactive as Record<string, unknown>).args
        : undefined;
    if (
      typeof connection.id !== 'string' ||
      typeof connection.name !== 'string' ||
      typeof connection.command !== 'string' ||
      typeof connection.enabled !== 'boolean' ||
      optionalStrings.some(
        (field) =>
          connection[field] !== undefined &&
          typeof connection[field] !== 'string',
      ) ||
      (connection.source !== undefined &&
        connection.source !== 'user' &&
        connection.source !== 'plugin') ||
      (connection.args !== undefined &&
        (!Array.isArray(connection.args) ||
          !connection.args.every((arg) => typeof arg === 'string'))) ||
      (connection.provideToolServers !== undefined &&
        (!Array.isArray(connection.provideToolServers) ||
          !connection.provideToolServers.every(
            (id) => typeof id === 'string' && isSafeToolServerId(id),
          ))) ||
      (Array.isArray(connection.provideToolServers) &&
        new Set(connection.provideToolServers).size !==
          connection.provideToolServers.length) ||
      (connection.interactive !== undefined &&
        (!Array.isArray(interactiveArgs) ||
          !interactiveArgs.every((arg) => typeof arg === 'string')))
    ) {
      throw new Error('ACP configuration contains an invalid connection.');
    }
    engineConnectionId(connection.id);
    if (ids.has(connection.id)) {
      throw new Error('ACP configuration has duplicate connection identities.');
    }
    ids.add(connection.id);
  }
}

export async function saveACPConfigFile(
  projectHomeDir: string,
  config: ACPConfig,
): Promise<void> {
  assertACPConfig(config);
  const path = join(projectHomeDir, 'config', 'acp.json');
  await mkdir(join(projectHomeDir, 'config'), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * `copyPluginIntegrations` publishes a plugin's bundled integration
 * directories itself rather than through `writeIntegrationConfigLocked`. Its
 * callers run this first, so a bundled definition meets the same OAuth client
 * rules (`assertToolOAuthClientWritable`) against the definition it would
 * replace, and never carries a secret-binding reference. Symlinked or
 * unreadable entries are left to the copy, which refuses them.
 */
export function assertPluginIntegrationsWritable(
  pluginDir: string,
  projectHomeDir: string,
): void {
  const bundled = join(pluginDir, 'integrations');
  if (!existsSync(bundled) || lstatSync(bundled).isSymbolicLink()) return;
  const readDefinition = (path: string): ToolDef | undefined =>
    existsSync(path) && !lstatSync(path).isSymbolicLink()
      ? (JSON.parse(readFileSync(path, 'utf8')) as ToolDef)
      : undefined;
  for (const entry of readdirSync(bundled, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assertSafeIntegrationId(entry.name);
    // A bundle cannot bring Station's own sidecars in any spelling the
    // filesystem may resolve to them; the copy would carry them.
    if (
      readdirSync(join(bundled, entry.name)).some((name) =>
        isReservedIntegrationSidecarName(String(name)),
      )
    )
      throw new Error(
        `Plugin integration '${entry.name}' contains Station's instance identity file.`,
      );
    const next = readDefinition(join(bundled, entry.name, 'integration.json'));
    if (!next) continue;
    if (
      Object.keys(next.secretEnvRefs ?? {}).length > 0 ||
      next.oauthClient?.clientSecretRef !== undefined
    )
      throw new Error(
        `Plugin integration '${entry.name}' contains secret binding references; bind secrets through Station's operator binding flow.`,
      );
    assertToolOAuthClientWritable(
      readDefinition(integrationConfigPath(projectHomeDir, entry.name)),
      next,
    );
  }
}
