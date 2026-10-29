import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
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
  DEFAULT_EXTERNAL_CONTENT_TRUST,
  isSafeToolServerId,
  personOwnedUntrustedContentFields,
  type ToolDef,
  type ToolMetadata,
  withStationIntegrationTrustDefaults,
  withUntrustedContentChange,
} from '@kontourai/station-contracts/tool';
import {
  applyIntegrationTrustOverlay,
  deleteIntegrationTrustOverlay,
  migrateIntegrationTrustOverlay,
  writeIntegrationTrustOverlay,
} from '@kontourai/station-shared/integration-trust-overlay';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { stationCuratedContentTrust } from '@kontourai/station-shared/station-curation';
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

  const release = await acquireFileMutationLockAsync(
    toolServerIntegrationMutationLockPath(projectHomeDir, id),
  );
  let def: ToolDef;
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as ToolDef;
    def = applyIntegrationTrustOverlay(
      {
        ...raw,
        contentTrust:
          stationCuratedContentTrust(raw) ?? DEFAULT_EXTERNAL_CONTENT_TRUST,
      },
      migrateIntegrationTrustOverlay(projectHomeDir, id, raw),
    );
  } finally {
    await release();
  }
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
  /** #3483: who an untrusted-content permission change is attributed to. */
  options: {
    changedBy?: string;
    personChange?: boolean;
    explicitFields?: readonly (
      | 'contentTrust'
      | 'permissions'
      | 'trustReadOnlyHints'
    )[];
    externalDefaults?: boolean;
    stationCuratedTrust?: 'trusted' | 'untrusted';
  } = {},
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
    const overlay = migrateIntegrationTrustOverlay(projectHomeDir, id, current);
    const effectiveCurrent =
      current || overlay
        ? applyIntegrationTrustOverlay(current ?? def, overlay)
        : undefined;
    await writeIntegrationConfigLocked(
      projectHomeDir,
      id,
      integrationPath,
      options.externalDefaults
        ? withStationIntegrationTrustDefaults(
            def,
            effectiveCurrent,
            stationCuratedContentTrust(def) ?? options.stationCuratedTrust,
          )
        : def,
      current,
      options.changedBy,
      options.personChange,
      options.explicitFields,
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
    const effective = applyIntegrationTrustOverlay(
      current,
      migrateIntegrationTrustOverlay(projectHomeDir, id, current),
    );
    return await writeIntegrationConfigLocked(
      projectHomeDir,
      id,
      integrationPath,
      update(effective),
      current,
      undefined,
    );
  } finally {
    await release();
  }
}

/**
 * A rule a plugin's integration definition must satisfy before it is
 * published, checked under the integration's mutation lock with the stored
 * definition it replaces. Throwing refuses the whole publication and changes
 * nothing. Other owners (for example tool-server OAuth client rules) add
 * theirs here rather than checking before the copy.
 */
export type PluginIntegrationValidator = (input: {
  id: string;
  next: ToolDef;
  current: ToolDef | undefined;
}) => void;

// Invariants owned by Station run on both plugin publication and restoration.
// Add shared rules here, not at individual callers.
const pluginIntegrationValidators: readonly PluginIntegrationValidator[] = [
  ({ id, current, next }) => {
    rejectRetiredIntegrationCredentialFormat(current, id);
    rejectRetiredIntegrationCredentialFormat(next, id);
  },
];

/**
 * The person-facing untrusted-content settings a stored definition holds win
 * over a plugin's: a plugin update cannot downgrade a classification or
 * reopen a tool the person closed.
 */
function storedIntegration(path: string): ToolDef | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ToolDef;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Publish a plugin's integrations, and retire the ones it no longer ships,
 * as one locked operation (#3483). The only path a plugin's install, update
 * and rollback write integration definitions through.
 *
 * `stage` copies the plugin's integration trees into a private directory no
 * reader looks at, with its own source checks. Then every affected
 * integration's mutation lock is held, in a fixed order, from reading the
 * stored definitions through publishing:
 * - a target another owner holds is refused;
 * - plugin-authored binding references are dropped;
 * - the person's untrusted-content settings and receipts come from the stored
 *   copy, never from the plugin's bytes, and a new receipt is added only for
 *   a setting the plugin introduces;
 * - each `validators` rule runs against the result.
 * Each tree then replaces its target by directory rename, so a reader sees
 * the old definition, briefly none, or the sanitized one, never the plugin's
 * raw bytes. A failure restores every replaced tree. Returns the published
 * integration ids.
 */
type PluginPublicationOptions = {
  projectHomeDir: string;
  pluginName: string;
  /** Copies the plugin's integration trees into `stagingDir`; absent retires only. */
  stage?: (stagingDir: string) => string[];
  validators?: readonly PluginIntegrationValidator[];
  now?: () => Date;
  /** Station's recovery backup, refreshed under the lock before retirement. */
  backupRetiredTo?: string;
};

export async function publishPluginIntegrations(
  options: PluginPublicationOptions,
): Promise<string[]> {
  return publishPluginIntegrationsLocked(options, false);
}

/** Restore a Station-owned backup, preserving newer person edits in storage. */
export async function restorePluginIntegrations(options: {
  projectHomeDir: string;
  pluginName: string;
  backupDir: string;
}): Promise<string[]> {
  return publishPluginIntegrationsLocked(
    {
      projectHomeDir: options.projectHomeDir,
      pluginName: options.pluginName,
      stage: (stagingDir) => {
        if (!existsSync(options.backupDir)) return [];
        const ids: string[] = [];
        for (const entry of readdirSync(options.backupDir, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory()) continue;
          assertSafeIntegrationId(entry.name);
          const source = join(options.backupDir, entry.name);
          const def = storedIntegration(join(source, 'integration.json')) as
            | (ToolDef & { plugin?: unknown })
            | undefined;
          if (!def || def.plugin !== options.pluginName)
            throw new Error(`Invalid integration backup '${entry.name}'`);
          cpSync(source, join(stagingDir, entry.name), { recursive: true });
          ids.push(entry.name);
        }
        return ids;
      },
    },
    true,
  );
}

async function publishPluginIntegrationsLocked(
  options: PluginPublicationOptions,
  restoring: boolean,
): Promise<string[]> {
  const { projectHomeDir, pluginName } = options;
  const integrationsDir = join(projectHomeDir, 'integrations');
  // Nothing to publish and nothing stored: create nothing.
  if (!options.stage && !existsSync(integrationsDir)) return [];
  if (options.stage)
    await mkdir(join(projectHomeDir, 'tmp'), { recursive: true });
  // Under the Station home, so the renames below stay on one filesystem.
  const stagingDir = options.stage
    ? await mkdtemp(join(projectHomeDir, 'tmp', 'integration-publish-'))
    : undefined;
  let retainStaging = false;
  try {
    const staged = options.stage && stagingDir ? options.stage(stagingDir) : [];
    for (const id of staged) assertSafeIntegrationId(id);
    if (staged.length === 0 && !existsSync(integrationsDir)) return [];
    await mkdir(integrationsDir, { recursive: true });
    const owned: string[] = [];
    for (const entry of await readdir(integrationsDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !isSafeToolServerId(entry.name)) continue;
      const def = storedIntegration(
        integrationConfigPath(projectHomeDir, entry.name),
      ) as (ToolDef & { plugin?: unknown }) | undefined;
      if (def?.plugin === pluginName) owned.push(entry.name);
    }
    const ids = [...new Set([...staged, ...owned])].sort();
    const releases: (() => Promise<void>)[] = [];
    try {
      for (const id of ids)
        releases.push(
          await acquireFileMutationLockAsync(
            toolServerIntegrationMutationLockPath(projectHomeDir, id),
          ),
        );
      const now = (options.now ?? (() => new Date()))();
      for (const id of ids) {
        const currentRaw = storedIntegration(
          integrationConfigPath(projectHomeDir, id),
        ) as (ToolDef & { plugin?: unknown }) | undefined;
        const overlay = migrateIntegrationTrustOverlay(
          projectHomeDir,
          id,
          currentRaw,
        );
        const current = currentRaw
          ? (applyIntegrationTrustOverlay(currentRaw, overlay) as ToolDef & {
              plugin?: unknown;
            })
          : undefined;
        if (current && current.plugin !== pluginName)
          throw new Error(
            `Integration '${id}' already exists and is not owned by this plugin`,
          );
        if (!staged.includes(id)) {
          if (current && options.backupRetiredTo) {
            const backupDir = options.backupRetiredTo;
            await mkdir(backupDir, { recursive: true });
            const temporary = await mkdtemp(join(backupDir, '.retired-'));
            const destination = join(backupDir, id);
            const previous = join(temporary, 'previous');
            let movedPrevious = false;
            let retainTemporary = false;
            try {
              cpSync(join(integrationsDir, id), join(temporary, 'next'), {
                recursive: true,
              });
              if (existsSync(destination)) {
                await rename(destination, previous);
                movedPrevious = true;
              }
              try {
                await rename(join(temporary, 'next'), destination);
              } catch (error) {
                if (movedPrevious) {
                  try {
                    await rename(previous, destination);
                  } catch (restoreError) {
                    retainTemporary = true;
                    throw new AggregateError(
                      [error, restoreError],
                      `Integration backup recovery retained at ${temporary}`,
                    );
                  }
                }
                throw error;
              }
            } finally {
              if (!retainTemporary)
                await rm(temporary, { recursive: true, force: true });
            }
          }
          continue;
        }
        // Staged ids exist only when a staging directory does.
        const stagedPath = join(stagingDir!, id, 'integration.json');
        const rawIncoming = JSON.parse(
          readFileSync(stagedPath, 'utf8'),
        ) as ToolDef;
        // A plugin cannot author secret bindings.
        const curatedTrust = stationCuratedContentTrust(rawIncoming);
        const incoming = withStationIntegrationTrustDefaults(
          rawIncoming,
          current,
          curatedTrust,
        );
        delete incoming.secretEnvRefs;
        const bindingSource = current ?? (restoring ? rawIncoming : undefined);
        if (restoring && bindingSource?.secretEnvRefs)
          incoming.secretEnvRefs = bindingSource.secretEnvRefs;
        const next = applyIntegrationTrustOverlay(
          withUntrustedContentChange(current, incoming, undefined, now),
          overlay,
        );
        for (const validate of [
          ...pluginIntegrationValidators,
          ...(options.validators ?? []),
        ])
          validate({ id, next, current });
        const published = {
          ...next,
          contentTrust: curatedTrust ?? DEFAULT_EXTERNAL_CONTENT_TRUST,
        };
        delete published.untrustedContentPermissions;
        delete published.trustReadOnlyHints;
        delete published.untrustedContentChanges;
        delete published.untrustedContentPersonOwned;
        await writeFile(stagedPath, JSON.stringify(published, null, 2));
      }
      const replaced: { id: string; backup?: string; published: boolean }[] =
        [];
      try {
        for (const id of ids) {
          const target = join(integrationsDir, id);
          const step: (typeof replaced)[number] = { id, published: false };
          replaced.push(step);
          if (existsSync(target)) {
            if (!stagingDir) {
              // Retiring only: nothing is published, so nothing to restore.
              await rm(target, { recursive: true, force: true });
              continue;
            }
            step.backup = join(stagingDir, `.replaced-${id}`);
            await rename(target, step.backup);
          }
          if (staged.includes(id)) {
            await rename(join(stagingDir!, id), target);
            step.published = true;
          }
        }
      } catch (error) {
        const failures: unknown[] = [];
        for (const step of replaced.reverse()) {
          const target = join(integrationsDir, step.id);
          try {
            if (step.published)
              await rm(target, { recursive: true, force: true });
            if (step.backup && existsSync(step.backup))
              await rename(step.backup, target);
          } catch (failure) {
            failures.push(failure);
          }
        }
        if (failures.length) {
          retainStaging = true;
          throw new AggregateError(
            [error, ...failures],
            `Integration publication recovery required; retained at ${stagingDir}`,
          );
        }
        throw error;
      }
      return staged;
    } finally {
      for (const release of releases.reverse()) await release();
    }
  } finally {
    if (stagingDir && !retainStaging)
      await rm(stagingDir, { recursive: true, force: true });
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

/**
 * The one locked integration write. It owns the untrusted-content receipts
 * (#3483): they come from the stored copy read under this lock, never from
 * `def`, so concurrent writers and whole-definition replacements cannot
 * drop or forge one. Returns the definition it wrote the receipts into.
 */
async function writeIntegrationConfigLocked(
  projectHomeDir: string,
  id: string,
  integrationPath: string,
  incoming: ToolDef,
  current: ToolDef | undefined,
  changedBy: string | undefined,
  personChange?: boolean,
  explicitFields?: readonly (
    | 'contentTrust'
    | 'permissions'
    | 'trustReadOnlyHints'
  )[],
): Promise<ToolDef> {
  rejectRetiredIntegrationCredentialFormat(current, id);
  // The spread inside keeps the enumerable in-memory enabled marker read
  // below.
  const overlay = migrateIntegrationTrustOverlay(projectHomeDir, id, current);
  const effectiveCurrent =
    current || overlay
      ? applyIntegrationTrustOverlay(current ?? incoming, overlay)
      : undefined;
  const def = withUntrustedContentChange(
    effectiveCurrent,
    incoming,
    changedBy,
    new Date(),
    { personChange, explicitFields },
  );
  const persisted = { ...def };
  delete persisted.untrustedContentPermissions;
  delete persisted.trustReadOnlyHints;
  delete persisted.untrustedContentChanges;
  delete persisted.untrustedContentPersonOwned;
  if (changedBy || personChange) {
    if (
      current &&
      !personOwnedUntrustedContentFields(current).has('contentTrust')
    )
      persisted.contentTrust = current.contentTrust;
    else
      persisted.contentTrust =
        stationCuratedContentTrust(incoming) ?? DEFAULT_EXTERNAL_CONTENT_TRUST;
  }
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
  // The overlay is the durable person choice. Publish it only after all
  // preparatory credential writes, and before the replaceable definition.
  writeIntegrationTrustOverlay(projectHomeDir, id, def);
  await publishJsonFileWithOwnedLock(integrationPath, persisted);
  // One credential-store publication retains the referenced set while
  // removing a migrated set. Splitting this into removeMany then reconcile
  // admitted a partial delete if the second write failed after the first.
  if (store) await store.reconcileServer(id, [...refs], [...removals]);
  return def;
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
    deleteIntegrationTrustOverlay(projectHomeDir, id);
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
