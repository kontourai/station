import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ACPConfig } from '@kontourai/station-contracts/acp';
import {
  engineConnectionId,
  engineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  SkillCommand,
  SkillOrigin,
  SkillProvenance,
  SkillVariable,
} from '@kontourai/station-contracts/catalog';
import {
  isSafeToolServerId,
  type ToolDef,
  type ToolMetadata,
} from '@kontourai/station-contracts/tool';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { normalizePersistedToolServerReason } from '../security/tool-server-reason.js';
import { IntegrationIconAssets } from '../services/plugins/integration-icon-assets.js';
import {
  ToolServerCredentialStore,
  toolServerIntegrationMutationLockPath,
} from '../services/plugins/tool-server-credential-store.js';
import { publishJsonFileWithOwnedLock } from './file-storage-helpers.js';
import { resolveSkillDirectory } from './skill-paths.js';

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
  source: 'local' | 'registry' | 'plugin' | 'flow-agents';
  installedAt: string;
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

/** Whether an integration definition file exists on disk (station#3063). */
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
  // One credential-store publication retains the referenced set while
  // removing a migrated set. Splitting this into removeMany then reconcile
  // admitted a partial delete if the second write failed after the first.
  if (store) await store.reconcileServer(id, [...refs], [...removals]);
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

export async function loadSkillConfig(
  projectHomeDir: string,
  name: string,
): Promise<SkillConfigRecord> {
  const path = join(resolveSkillDirectory(projectHomeDir, name), 'skill.json');
  if (!existsSync(path)) throw new Error(`Skill '${name}' not found`);
  return JSON.parse(await readFile(path, 'utf-8'));
}

export async function saveSkillConfig(
  projectHomeDir: string,
  name: string,
  config: SkillConfigRecord,
): Promise<void> {
  const dir = resolveSkillDirectory(projectHomeDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'skill.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

export async function deleteSkillConfig(
  projectHomeDir: string,
  name: string,
): Promise<void> {
  const dir = resolveSkillDirectory(projectHomeDir, name);
  if (!existsSync(dir)) throw new Error(`Skill '${name}' not found`);
  await rm(dir, { recursive: true, force: true });
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
  return parsed;
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
    engineRuntimeId(connection.id);
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
