/**
 * Configuration loader for reading and watching .station/ files
 */

import { createHash } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ACPConfig } from '@kontourai/station-contracts/acp';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { PluginOverrides } from '@kontourai/station-contracts/plugin';
import {
  isSafeToolServerId,
  type ToolDef,
  type ToolMetadata,
} from '@kontourai/station-contracts/tool';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { type FSWatcher, watch } from 'chokidar';
import {
  type AppConfigLaunchabilitySnapshot,
  LaunchabilityRevision,
} from '../services/connections/launchability-revision.js';
import {
  configWatcherCloseDuration,
  configWatchRecovered,
} from '../telemetry/metrics.js';
import { createLogger } from '../utils/logger.js';
import { resolveHomeDir } from '../utils/paths.js';
import { nullPrototypeDeep } from '../utils/reserved-object-keys.js';
import {
  agentConfigExists,
  createAgentConfig,
  createAgentWorkflow,
  deleteAgentConfig,
  deleteAgentWorkflow,
  getAgentToolMap,
  listAgentConfigs,
  listAgentWorkflowMetadata,
  loadAgentConfig,
  mutateAgentConfig,
  readAgentWorkflow,
  resolveAgentConfigSlug,
  saveAgentConfig,
  updateAgentConfig,
  updateAgentWorkflow,
} from './config-loader-agents.js';
import {
  APP_CONFIG_MAX_BYTES,
  AppConfigConflictError,
  appConfigFileSignature,
  loadAppConfigFile,
  mergeAppConfigUpdate,
  saveAppConfigFile,
} from './config-loader-app.js';
import {
  deleteIntegrationConfig,
  deleteSkillConfig,
  integrationConfigExists,
  listIntegrationMetadata,
  listSkillConfigs,
  loadACPConfigFile,
  loadIntegrationConfig,
  loadSkillConfig,
  type SkillConfigRecord,
  saveACPConfigFile,
  saveIntegrationConfig,
  saveSkillConfig,
  skillConfigExists,
  updateIntegrationConfig,
} from './config-loader-storage.js';
import { readTextFileBounded } from './file-storage-helpers.js';
import {
  ensureStationHomeSchema,
  readRegularFileNoFollow,
} from './home-schema-gate.js';
import { validator } from './validator.js';

const logger = createLogger({ name: 'config-loader' });
const INTEGRATION_POLICY_MAX_BYTES = 2 * 1024 * 1024;
export type IntegrationPolicySnapshot = Readonly<{
  id: string;
  enabled: boolean;
  disabledTools: readonly string[];
  witness: string;
}>;

/** The directories the watcher covers, relative to the project home. */
const WATCHED_ROOT_NAMES = ['config', 'agents', 'integrations'] as const;

/**
 * Gaps between the bounded reconciliation passes that run after the watcher
 * reports `ready`, in milliseconds. Cumulatively 0.25s, 0.75s, 1.75s, 3.75s,
 * 7.75s, 15.75s.
 *
 * This is a startup-only backoff, not a poller. `ready` means chokidar finished
 * its own directory scan; it does not mean the platform's notification stream
 * is live, and a change made in that gap is lost outright rather than delayed
 * (issue archive#952). Measured on this repo: first-event latency ran to 4.8s even on
 * successful rounds, and archive#952 recorded 11.6s under load — so the last pass sits
 * well past that, and the passes stop entirely once the window has closed.
 * Steady-state correctness is the watcher's job; polling the whole config tree
 * forever would cost far more than the gap it closes.
 */
const WATCHER_RECONCILE_BACKOFF_MS = [
  250, 500, 1000, 2000, 4000, 8000,
] as const;

const INTERNAL_AGENT_WRITE_ECHO_TTL_MS = 30_000;

interface InternalAgentWrite {
  expectedContentSignature?: string | null;
  pendingEvents: Array<'change' | 'add' | 'remove'>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export { DEFAULT_SYSTEM_PROMPT } from './config-loader-app.js';

/**
 * Does `path` match one of the config files the loader watches?
 *
 * This is the explicit form of the three glob patterns the watcher used before
 * chokidar removed glob support in v4:
 *
 *   config/*.json
 *   agents/&#42;/agent.json
 *   integrations/&#42;/integration.json
 *
 * Exported so the pattern set is testable on its own — a watcher that silently
 * matches nothing looks identical to a quiet system.
 */
export function isWatchedConfigPath(
  projectHomeDir: string,
  path: string,
): boolean {
  const relative = relativePath(resolve(projectHomeDir), resolve(path));
  if (!relative) return false;

  const segments = relative.split(sep);
  if (segments.length === 2 && segments[0] === 'config') {
    return segments[1].endsWith('.json');
  }
  if (segments.length === 3 && segments[0] === 'agents') {
    return segments[2] === 'agent.json';
  }
  if (segments.length === 3 && segments[0] === 'integrations') {
    return segments[2] === 'integration.json';
  }
  return false;
}

/**
 * The subset of `isWatchedConfigPath` that names an `agent.json` or
 * `integration.json` file specifically — never `config/*.json` (that
 * includes `app.json`, whose own external-edit path already runs through
 * `onLaunchabilityChange`/`observeExternalAppMutation`, and other
 * unrelated files like `hosts.json`/`host-credentials.json`).
 *
 * archive#983 (scoped advance, station#settings-revamp slice 6, docs/design/
 * settings-architecture.md §6): the watcher already filters/dedupes/
 * reconciles these events into `notifyListeners()`, but nothing in
 * production ever subscribed — see `observeRuntimeConfigurationSources` in
 * `src-server/runtime/bootstrap/station-runtime.ts`, the first production
 * subscriber. Exported so that wiring's path filter is provably the exact
 * same predicate the watcher itself uses to decide these events exist,
 * rather than a second, driftable copy.
 */
export function isAgentOrIntegrationConfigPath(
  projectHomeDir: string,
  path: string,
): boolean {
  if (!isWatchedConfigPath(projectHomeDir, path)) return false;
  const relative = relativePath(resolve(projectHomeDir), resolve(path));
  if (!relative) return false;
  const [root] = relative.split(sep);
  return root === 'agents' || root === 'integrations';
}

/** `null` when `child` is not inside `parent`. */
function relativePath(parent: string, child: string): string | null {
  const value = relative(parent, child);
  return !value || value.startsWith('..') || isAbsolute(value) ? null : value;
}

export interface ConfigLoaderOptions {
  projectHomeDir?: string;
  watchFiles?: boolean;
  /**
   * Runtime-only boundary: no application data may be observed until the
   * Station-home schema marker has been verified or safely bootstrapped.
   * Direct domain callers keep the historic opt-in behaviour for now.
   */
  enforceHomeSchema?: boolean;
}

export interface SkillConfig extends SkillConfigRecord {}

export class ConfigLoader {
  private projectHomeDir: string;
  private watcher?: FSWatcher;
  private launchabilityPoller?: ReturnType<typeof setInterval>;
  private watcherReconcileTimer?: ReturnType<typeof setTimeout>;
  /** Set the moment `dispose()` starts, so nothing new is scheduled or emitted. */
  private disposed = false;
  /** Memoised so a second `dispose()` is a no-op that resolves the same way. */
  private disposal?: Promise<void>;
  /** The residual watcher close `dispose()` starts but does not await. */
  private watcherClose: Promise<void> = Promise.resolve();
  /**
   * Every watched config file this loader has already reported, so a
   * reconciliation pass can tell "the watcher missed this" from "the watcher
   * already told me". Seeded with the tree as it stood when watching started,
   * because `ignoreInitial: true` means pre-existing files are deliberately
   * never announced.
   */
  private readonly knownConfigPaths = new Set<string>();
  private listeners: Map<string, Set<(data: unknown) => void>>;
  private readonly launchabilityRevision = new LaunchabilityRevision();
  private readonly launchabilityFingerprints = new Map<string, string | null>();
  private readonly launchabilityFileSignatures = new Map<
    string,
    string | null
  >();
  /**
   * Agent route writes synchronously reload the runtime before responding.
   * Their matching filesystem notifications are echoes, not external edits.
   */
  private readonly internalAgentWrites = new Map<string, InternalAgentWrite>();
  private internalAppMutationDepth = 0;
  private internalAppMutationBarrier: Promise<void> | null = null;
  private releaseInternalAppMutation: (() => void) | null = null;
  private launchabilityObservationQueue = Promise.resolve();
  private appMutationQueue = Promise.resolve();
  private readonly enforceHomeSchema: boolean;
  private readonly homeSchemaReady: Promise<void>;
  /**
   * archive#3063: per-integration-id resolvers for the RUNNING instance's
   * spawn identity (`command`/`args`/`env`) of the built-in tool servers.
   * Registered by `StationRuntime`'s constructor for `station-control` and
   * `station-docs`. For a registered id, `loadIntegration` overlays these
   * fields fresh on every read and `saveIntegration`/`updateIntegration`
   * strip them from every write — the persisted file carries only
   * instance-INDEPENDENT bytes, so two servers sharing one home (desktop
   * app + launchd service) agree on the file's content and the archive#1588
   * byte-identical save skip converges instead of ping-ponging each
   * other's config watchers forever.
   */
  private readonly builtinIntegrationRuntimeIdentities = new Map<
    string,
    () => Pick<ToolDef, 'command' | 'args' | 'env'>
  >();

  constructor(options: ConfigLoaderOptions = {}) {
    this.projectHomeDir = resolve(options.projectHomeDir || resolveHomeDir());
    this.listeners = new Map();
    this.enforceHomeSchema = options.enforceHomeSchema === true;
    this.homeSchemaReady = this.enforceHomeSchema
      ? ensureStationHomeSchema(this.projectHomeDir)
      : Promise.resolve();

    if (options.watchFiles) {
      if (options.enforceHomeSchema) {
        void this.homeSchemaReady.then(() => this.setupFileWatcher());
      } else {
        this.setupFileWatcher();
      }
    }
  }

  /**
   * Get the project home directory path
   */
  getProjectHomeDir(): string {
    return this.projectHomeDir;
  }

  async ensureHomeSchema(): Promise<void> {
    await this.homeSchemaReady;
  }

  /**
   * Load application configuration
   */
  async loadAppConfig(): Promise<AppConfig> {
    await this.ensureHomeSchema();
    return loadAppConfigFile(this.projectHomeDir);
  }

  /**
   * Save application configuration
   */
  async saveAppConfig(config: AppConfig): Promise<void> {
    if (this.enforceHomeSchema) await this.ensureHomeSchema();
    const path = join(this.projectHomeDir, 'config', 'app.json');
    const expectedSourceSignature = this.appConfigFileSignature(path);
    await this.serializeAppMutation(() =>
      this.commitInternalAppConfig(config, expectedSourceSignature),
    );
  }

  /**
   * Load plugin provider overrides.
   *
   * The returned object is NULL-PROTOTYPE, top level and all the way down
   * (archive#4307). Its top-level keys are plugin names and its `settings`
   * keys are manifest-declared field names — both external identifiers, so
   * the plain-prototype form gave `overrides['__proto__']` an
   * `Object.prototype` answer that is truthy (skipping a caller's
   * `if (!overrides[name])` initializer) and made the subsequent write hit the
   * prototype setter: the pollution persisted process-wide while
   * `JSON.stringify` emitted an object with no such own key, so the write was
   * silently lost. `manifest.name` is now validated as a canonical plugin id
   * at load (`plugin-manifest-loader.ts`), which is the real fix; this is the
   * class fix, so it cannot recur through a key nobody thought about. The
   * policy and its helpers are the ones the grants store established —
   * `utils/reserved-object-keys.ts`, lifted from
   * `services/plugins/grants-file-store.ts` decision 5.
   *
   * `JSON.parse` creates a literal `"__proto__"` member as an own data
   * property rather than invoking the setter, and `JSON.stringify` serializes
   * a null-prototype object identically, so the on-disk format is unchanged.
   */
  async loadPluginOverrides(): Promise<PluginOverrides> {
    await this.ensureHomeSchema();
    const path = join(this.projectHomeDir, 'config', 'plugin-overrides.json');
    if (!existsSync(path)) return nullPrototypeDeep({}) as PluginOverrides;
    const content = await readFile(path, 'utf-8');
    return nullPrototypeDeep(JSON.parse(content)) as PluginOverrides;
  }

  /**
   * Save plugin provider overrides
   */
  async savePluginOverrides(overrides: PluginOverrides): Promise<void> {
    const configDir = join(this.projectHomeDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'plugin-overrides.json'),
      JSON.stringify(overrides, null, 2),
      'utf-8',
    );
  }

  /**
   * Update application configuration (alias for saveAppConfig)
   */
  async updateAppConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
    if (this.enforceHomeSchema) await this.ensureHomeSchema();
    return this.mutateAppConfig(() => updates);
  }

  async mutateAppConfig(
    mutate: (current: Readonly<AppConfig>) => Partial<AppConfig>,
  ): Promise<AppConfig> {
    if (this.enforceHomeSchema) await this.ensureHomeSchema();
    return this.serializeAppMutation(async () => {
      const path = join(this.projectHomeDir, 'config', 'app.json');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const release = await acquireFileMutationLockAsync(`${path}.mutation`);
      this.beginInternalAppMutation();
      try {
        // Every cooperating Station writer owns this exact file authority
        // before it reads. A peer therefore waits and derives from the latest
        // bytes; an uncoordinated edit detected inside this window is a real
        // conflict, not a retryable stale read that may overwrite that edit.
        await loadAppConfigFile(this.projectHomeDir, {
          mutationLockHeld: true,
        });
        const sourceSnapshot = this.stableAppConfigFileSnapshot(path);
        const existing = await loadAppConfigFile(this.projectHomeDir, {
          mutationLockHeld: true,
        });
        if (
          sourceSnapshot.signature !==
            (await appConfigFileSignature(this.projectHomeDir)) ||
          sourceSnapshot.fingerprint !== this.appConfigFingerprint(existing)
        ) {
          throw new AppConfigConflictError();
        }
        const updates = mutate(structuredClone(existing));
        // An explicit null/undefined in `updates` clears non-nullable
        // fields instead of assigning a value AJV would reject.
        const updated = mergeAppConfigUpdate(existing, updates);
        if (this.appConfigFingerprint(updated) === sourceSnapshot.fingerprint) {
          return existing;
        }
        await saveAppConfigFile(this.projectHomeDir, updated, {
          expectedSourceSignature: sourceSnapshot.signature,
          mutationLockHeld: true,
        });
        this.recordInternalAppCommit(updated);
        return updated;
      } finally {
        this.endInternalAppMutation();
        await release();
      }
    });
  }

  getLaunchabilityRevision(): number {
    this.synchronizeAppConfigFingerprint();
    return this.launchabilityRevision.getLaunchabilityRevision();
  }

  captureAppConfigLaunchabilitySnapshot(): Promise<AppConfigLaunchabilitySnapshot> {
    return this.ensureHomeSchema().then(() =>
      this.serializeAppMutation(async () => {
        const path = join(this.projectHomeDir, 'config', 'app.json');
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const config = await loadAppConfigFile(this.projectHomeDir);
          const snapshotFingerprint = this.appConfigFingerprint(config);
          const currentSnapshot = this.stableAppConfigFileSnapshot(path);
          if (currentSnapshot.fingerprint !== snapshotFingerprint) continue;
          this.synchronizeAppConfigFingerprintValue(path, snapshotFingerprint);
          this.launchabilityFileSignatures.set(path, currentSnapshot.signature);
          return {
            revision: this.launchabilityRevision.getLaunchabilityRevision(),
            config: structuredClone(config),
          };
        }
        throw new Error(
          'App configuration changed while capturing a snapshot.',
        );
      }),
    );
  }

  onLaunchabilityChange(listener: (revision: number) => void): () => void {
    return this.launchabilityRevision.onLaunchabilityChange(listener);
  }

  /**
   * Load agent specification
   */
  async loadAgent(slug: string) {
    await this.ensureHomeSchema();
    return loadAgentConfig(this.projectHomeDir, slug);
  }

  /**
   * Create a new agent (generates slug from name)
   */
  async createAgent(spec: Parameters<typeof createAgentConfig>[1]) {
    await this.ensureHomeSchema();
    const slug = resolveAgentConfigSlug(spec);
    return this.withInternalAgentWrite(
      join(this.projectHomeDir, 'agents', slug, 'agent.json'),
      async () => {
        const created = await createAgentConfig(this.projectHomeDir, spec);
        return {
          result: created,
          expectedContentSignature: this.agentConfigContentSignature(
            created.spec,
          ),
        };
      },
    );
  }

  /**
   * Update an existing agent
   */
  async updateAgent(
    slug: string,
    updates: Parameters<typeof updateAgentConfig>[2],
  ) {
    await this.ensureHomeSchema();
    return this.withInternalAgentWrite(
      join(this.projectHomeDir, 'agents', slug, 'agent.json'),
      async () => {
        const updated = await updateAgentConfig(
          this.projectHomeDir,
          slug,
          updates,
        );
        return {
          result: updated,
          expectedContentSignature: this.agentConfigContentSignature(updated),
        };
      },
    );
  }

  /**
   * Read → derive → write one agent record inside its persistence lock.
   *
   * THE binding-write seam: every path that changes `agent.skills` (the
   * skills routes, a plugin skill's `agent:` binding, `station doctor
   * --migrate-playbooks`) goes through here rather than `saveAgent`, so none
   * of them can republish a snapshot taken before a concurrent editor save.
   * Bracketed by
   * `withInternalAgentWrite` exactly as the other agent writers are, so the
   * watcher does not re-read our own write as an external change.
   */
  async mutateAgent(
    slug: string,
    updater: Parameters<typeof mutateAgentConfig>[2],
  ) {
    await this.ensureHomeSchema();
    return this.withInternalAgentWrite(
      join(this.projectHomeDir, 'agents', slug, 'agent.json'),
      async () => {
        const updated = await mutateAgentConfig(
          this.projectHomeDir,
          slug,
          updater,
        );
        return {
          result: updated,
          // A no-op updater wrote nothing, so there is no signature to expect
          // and no echo to suppress.
          expectedContentSignature:
            updated === null ? null : this.agentConfigContentSignature(updated),
        };
      },
    );
  }

  /**
   * Delete an agent and all its data
   */
  async deleteAgent(slug: string): Promise<void> {
    await this.ensureHomeSchema();
    await this.withInternalAgentWrite(
      join(this.projectHomeDir, 'agents', slug, 'agent.json'),
      async () => {
        await deleteAgentConfig(this.projectHomeDir, slug);
        return { result: undefined, expectedContentSignature: null };
      },
    );
  }

  /**
   * Save agent specification
   */
  async saveAgent(
    slug: string,
    spec: Parameters<typeof saveAgentConfig>[2],
  ): Promise<void> {
    await this.ensureHomeSchema();
    await this.withInternalAgentWrite(
      join(this.projectHomeDir, 'agents', slug, 'agent.json'),
      async () => {
        await saveAgentConfig(this.projectHomeDir, slug, spec);
        return {
          result: undefined,
          expectedContentSignature: this.agentConfigContentSignature(spec),
        };
      },
    );
  }

  /**
   * List all agents
   */
  async listAgents() {
    await this.ensureHomeSchema();
    return listAgentConfigs(this.projectHomeDir);
  }

  async listAgentWorkflows(slug: string) {
    return listAgentWorkflowMetadata(this.projectHomeDir, slug);
  }

  /**
   * Create a new workflow file
   */
  async createWorkflow(
    slug: string,
    filename: string,
    content: string,
  ): Promise<void> {
    await createAgentWorkflow(this.projectHomeDir, slug, filename, content);
  }

  /**
   * Read workflow file content
   */
  async readWorkflow(slug: string, workflowId: string): Promise<string> {
    return readAgentWorkflow(this.projectHomeDir, slug, workflowId);
  }

  /**
   * Update an existing workflow file
   */
  async updateWorkflow(
    slug: string,
    workflowId: string,
    content: string,
  ): Promise<void> {
    await updateAgentWorkflow(this.projectHomeDir, slug, workflowId, content);
  }

  /**
   * Delete a workflow file
   */
  async deleteWorkflow(slug: string, workflowId: string): Promise<void> {
    await deleteAgentWorkflow(this.projectHomeDir, slug, workflowId);
  }

  /**
   * archive#3063: declare that integration `id` is a built-in whose spawn
   * identity (`command`/`args`/`env`) belongs to the running instance, not
   * to the persisted file. `resolveIdentity` is called lazily on every
   * `loadIntegration` so the values always reflect THIS process's actually
   * bound port and dist path.
   */
  registerBuiltinIntegrationRuntimeIdentity(
    id: string,
    resolveIdentity: () => Pick<ToolDef, 'command' | 'args' | 'env'>,
  ): void {
    this.builtinIntegrationRuntimeIdentities.set(id, resolveIdentity);
  }

  /**
   * The instance-independent projection persisted for a registered built-in:
   * everything EXCEPT the running instance's spawn identity. Applied to every
   * write path (`saveIntegration`, `updateIntegration`) so no
   * load-modify-save round trip — e.g. `MCPService.setEnabled` — can leak
   * the overlay's identity back into the shared file.
   *
   * `storedEnvNames` is stripped for the same reason (review fix, LOW-1):
   * the load overlay replaces `env` wholesale, so a credential-store
   * reference on a built-in id could never be read back — persisting the
   * marker would both dangle (a silently dead credential) and defeat the
   * byte-identical save skip every boot (materialized def lacks the marker,
   * file has it → one real rewrite + sibling watcher echo per boot). The
   * write-time credential fields (`secretEnv`/`removeSecretEnvKeys`) are
   * rejected outright by `assertBuiltinIntegrationCredentialFree` before
   * this projection runs; the deletes here only clear empty remnants.
   */
  private builtinIntegrationPersistedProjection(
    id: string,
    def: ToolDef,
  ): ToolDef {
    if (!this.builtinIntegrationRuntimeIdentities.has(id)) return def;
    const persisted = { ...def };
    delete persisted.command;
    delete persisted.args;
    delete persisted.env;
    delete persisted.storedEnvNames;
    delete persisted.secretEnvRefs;
    delete persisted.secretEnv;
    delete persisted.removeSecretEnvKeys;
    return persisted;
  }

  /**
   * Review fix (archive#3063 LOW-1): a credential written to a built-in
   * integration id would be silently DEAD — the runtime-identity overlay
   * replaces the loaded `env` wholesale, so a stored value is never read at
   * spawn. Fail the write with a clear reason instead of accepting material
   * into the credential store that nothing will ever use.
   */
  private assertBuiltinIntegrationCredentialFree(
    id: string,
    def: ToolDef,
  ): void {
    if (!this.builtinIntegrationRuntimeIdentities.has(id)) return;
    if (
      Object.keys(def.secretEnv ?? {}).length > 0 ||
      (def.removeSecretEnvKeys ?? []).length > 0 ||
      Object.keys(def.secretEnvRefs ?? {}).length > 0
    ) {
      throw new Error(
        `Built-in integration '${id}' cannot store credentials or secret bindings: its environment is resolved at spawn time from the running Station instance, so a stored value would never be used (station#3063).`,
      );
    }
  }

  /**
   * Overlay the running instance's spawn identity on a registered built-in's
   * loaded definition. Wholesale replacement of `command`/`args`/`env` (a
   * field the identity omits is deleted, not inherited from disk): the file
   * is user-visible and hand-editable, and a stale or tampered identity
   * there must never decide what this instance spawns — that is the same
   * posture as `isBuiltinStationControl`'s exact-path match, which this
   * overlay is what keeps satisfied for BOTH servers sharing a home.
   */
  private withBuiltinIntegrationRuntimeIdentity(
    id: string,
    def: ToolDef,
  ): ToolDef {
    const resolveIdentity = this.builtinIntegrationRuntimeIdentities.get(id);
    if (!resolveIdentity) return def;
    const identity = resolveIdentity();
    const projected = { ...def };
    delete projected.command;
    delete projected.args;
    delete projected.env;
    if (identity.command !== undefined) projected.command = identity.command;
    if (identity.args !== undefined) projected.args = identity.args;
    if (identity.env !== undefined) projected.env = identity.env;
    return projected;
  }

  /**
   * Whether an integration definition exists on disk. Used by the built-in
   * materializer's reload-path self-heal (`materializeBuiltinIntegrations`
   * with `onlyIfMissing`), which must be existence-gated — never
   * content-gated — so a reload can only ever write a file that is ABSENT,
   * making a reload-driven write loop structurally impossible.
   */
  async hasIntegration(id: string): Promise<boolean> {
    await this.ensureHomeSchema();
    return integrationConfigExists(this.projectHomeDir, id);
  }

  /** Runtime-owned built-ins cannot persist credential or binding references. */
  isBuiltinIntegration(id: string): boolean {
    return this.builtinIntegrationRuntimeIdentities.has(id);
  }

  /**
   * Load tool definition
   */
  async loadIntegration(id: string): Promise<ToolDef> {
    await this.ensureHomeSchema();
    const def = await loadIntegrationConfig(this.projectHomeDir, id);
    return this.withBuiltinIntegrationRuntimeIdentity(id, def);
  }

  async captureIntegrationPolicySnapshot(
    id: string,
  ): Promise<IntegrationPolicySnapshot | null> {
    try {
      return this.readIntegrationPolicySnapshot(id);
    } catch {
      return null;
    }
  }

  isIntegrationPolicySnapshotCurrent(
    snapshot: IntegrationPolicySnapshot,
  ): boolean {
    if (!snapshot) return false;
    try {
      return (
        this.readIntegrationPolicySnapshot(snapshot.id)?.witness ===
        snapshot.witness
      );
    } catch {
      return false;
    }
  }

  /**
   * Derive policy and its witness from one verified, bounded file generation.
   * The policy fence must never combine a parsed earlier definition with a
   * hash of later bytes: either both came from this source or neither exists.
   */
  private readIntegrationPolicySnapshot(
    id: string,
  ): IntegrationPolicySnapshot | null {
    if (!isSafeToolServerId(id)) return null;
    const file = join(
      this.projectHomeDir,
      'integrations',
      id,
      'integration.json',
    );
    const source = readRegularFileNoFollow(this.projectHomeDir, file, {
      maxBytes: INTEGRATION_POLICY_MAX_BYTES,
    });
    const value = JSON.parse(source) as unknown;
    validator.validateToolDef(value);
    const def = value as ToolDef;
    return Object.freeze({
      id,
      enabled: def.enabled !== false,
      disabledTools: Object.freeze([...(def.disabledTools ?? [])].sort()),
      witness: createHash('sha256').update(source, 'utf8').digest('base64url'),
    });
  }

  /**
   * Save tool definition. Deliberately NOT bracketed as an internal write:
   * route-driven integration saves rely on the watcher event for activation.
   * Instead, a byte-identical save is skipped entirely — the runtime re-saves
   * the station-control integration on every agents reload, and re-writing
   * identical content fed the watcher an "external edit" that scheduled the
   * next reload, forever (archive#1588, the reload loop behind archive#1574's catalog
   * churn). A genuine content change still writes and still activates.
   */
  async saveIntegration(id: string, def: ToolDef): Promise<void> {
    // archive#3063: a registered built-in's spawn identity never reaches
    // disk — projected out BEFORE the byte comparison so the compare runs
    // against the bytes that would actually be written. Credential writes
    // to a built-in id fail closed first (they would be silently dead).
    this.assertBuiltinIntegrationCredentialFree(id, def);
    const persisted = this.builtinIntegrationPersistedProjection(id, def);
    validator.validateToolDef(persisted);
    const path = join(
      this.projectHomeDir,
      'integrations',
      id,
      'integration.json',
    );
    // Raw-byte comparison on purpose: the writer and this comparator must
    // stay byte-lockstep. Parsing-and-comparing would re-admit rewrites of
    // semantically-equal-but-differently-formatted files on every reload —
    // the exact fragility this skip removes. An externally reformatted file
    // costs one canonicalizing write, then stays byte-stable.
    if (
      this.watchedConfigFileContentSignature(path) ===
      this.agentConfigContentSignature(persisted)
    ) {
      return;
    }
    await saveIntegrationConfig(this.projectHomeDir, id, persisted);
  }

  /**
   * Verify and replace one integration under its cross-runtime mutation lock.
   * The callback is synchronous so its read-derived write is indivisible.
   */
  async updateIntegration(
    id: string,
    update: (current: ToolDef) => ToolDef,
  ): Promise<ToolDef> {
    await this.ensureHomeSchema();
    return updateIntegrationConfig(this.projectHomeDir, id, (current) => {
      const updated = update(current);
      this.assertBuiltinIntegrationCredentialFree(id, updated);
      const next = this.builtinIntegrationPersistedProjection(id, updated);
      validator.validateToolDef(next);
      return next;
    });
  }

  async deleteIntegration(id: string): Promise<void> {
    await deleteIntegrationConfig(this.projectHomeDir, id);
  }

  /**
   * List all tools in catalog
   */
  async listIntegrations(): Promise<ToolMetadata[]> {
    await this.ensureHomeSchema();
    const metadata = await listIntegrationMetadata(this.projectHomeDir, logger);
    // archive#3063: the persisted built-in files no longer carry
    // command/env, so derive the listing's identity-dependent projections
    // (`source`, `requiresEnvSecrets`) from the runtime overlay — the same
    // truth `loadIntegration` serves. Without this, station-control would
    // list as secret-free and the ACP tool-server picker would stop flagging
    // it, even though its loaded shape still declares env.
    return metadata.map((entry) => {
      const resolveIdentity = this.builtinIntegrationRuntimeIdentities.get(
        entry.id,
      );
      if (!resolveIdentity) return entry;
      const identity = resolveIdentity();
      return {
        ...entry,
        source: identity.command ?? entry.source,
        requiresEnvSecrets: Boolean(
          identity.env && Object.keys(identity.env).length > 0,
        ),
      };
    });
  }

  /**
   * Build a map of tool ID → agent slugs that use it
   */
  async getToolAgentMap(): Promise<Record<string, string[]>> {
    return getAgentToolMap(this.projectHomeDir);
  }

  /**
   * Check if agent exists
   */
  async agentExists(slug: string): Promise<boolean> {
    return agentConfigExists(this.projectHomeDir, slug);
  }

  /**
   * Check if tool exists
   */
  async toolExists(id: string): Promise<boolean> {
    const path = join(
      this.projectHomeDir,
      'integrations',
      id,
      'integration.json',
    );
    return existsSync(path);
  }

  /**
   * Set up file watcher for configuration changes
   */
  private setupFileWatcher(): void {
    // Watch the containing directories, not glob patterns: chokidar dropped
    // glob support in v4, and a glob silently resolves to watching nothing at
    // all (`getWatched()` returns `{}`) rather than erroring — config
    // hot-reload would just stop firing. `isWatchedConfigPath` reproduces the
    // pattern set as an explicit predicate instead.
    const roots = WATCHED_ROOT_NAMES.map((name) =>
      join(this.projectHomeDir, name),
    );

    const appConfigPath = join(this.projectHomeDir, 'config', 'app.json');
    try {
      this.launchabilityFingerprints.set(
        appConfigPath,
        this.appConfigFileFingerprint(appConfigPath),
      );
      this.launchabilityFileSignatures.set(
        appConfigPath,
        this.appConfigFileSignature(appConfigPath),
      );
    } catch {
      this.launchabilityFingerprints.set(appConfigPath, 'invalid');
      this.launchabilityFileSignatures.set(
        appConfigPath,
        this.appConfigFileSignature(appConfigPath),
      );
    }

    // Baseline for reconciliation, taken as close to the watcher's own scan as
    // possible: anything on disk now is already "known" and must not be
    // re-announced, since `ignoreInitial: true` suppresses it.
    for (const path of this.scanWatchedConfigPaths()) {
      this.knownConfigPaths.add(path);
    }

    this.watcher = watch(roots, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
    });

    const forward =
      (event: 'change' | 'add' | 'remove') =>
      (path: string): void => {
        // `dispose()` defers the close by a turn, so the watcher is briefly
        // still live and subscribed afterwards. A disposed loader is silent.
        if (this.disposed) return;
        if (!isWatchedConfigPath(this.projectHomeDir, path)) return;
        if (event === 'add') {
          // A reconciliation pass may have reported this file already, and
          // re-arming a recovered directory makes chokidar replay `add` for
          // everything inside it. Report a file appearing exactly once.
          if (this.knownConfigPaths.has(path)) return;
          this.knownConfigPaths.add(path);
        } else if (event === 'remove') {
          if (!this.knownConfigPaths.has(path)) return;
          this.knownConfigPaths.delete(path);
        } else {
          this.knownConfigPaths.add(path);
        }
        this.notifyConfigFileEvent(event, path);
      };

    this.watcher.on('change', forward('change'));
    this.watcher.on('add', forward('add'));
    this.watcher.on('unlink', forward('remove'));
    this.watcher.on('ready', () => this.scheduleWatcherReconciliation(0));
    this.launchabilityPoller = setInterval(() => {
      try {
        this.synchronizeAppConfigFingerprintAfterMetadataChange(appConfigPath);
      } catch {
        logger.error('Failed to poll application configuration fingerprint.');
      }
    }, 250);
    this.launchabilityPoller.unref();
  }

  /**
   * Every watched config file that exists on disk right now.
   *
   * Mirrors the watcher's own reach exactly — the three roots at `depth: 1`,
   * filtered through `isWatchedConfigPath` — so a difference against
   * `knownConfigPaths` means a notification was missed, not that the two are
   * measuring different things.
   */
  private scanWatchedConfigPaths(): Set<string> {
    const found = new Set<string>();
    for (const name of WATCHED_ROOT_NAMES) {
      const root = join(this.projectHomeDir, name);
      for (const entry of this.readDirEntries(root)) {
        const path = join(root, entry.name);
        if (entry.isFile()) {
          if (isWatchedConfigPath(this.projectHomeDir, path)) found.add(path);
          continue;
        }
        if (!entry.isDirectory()) continue;
        for (const child of this.readDirEntries(path)) {
          if (!child.isFile()) continue;
          const childPath = join(path, child.name);
          if (isWatchedConfigPath(this.projectHomeDir, childPath)) {
            found.add(childPath);
          }
        }
      }
    }
    return found;
  }

  /** `[]` when the directory is absent or unreadable — both are normal here. */
  private readDirEntries(path: string): Dirent[] {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /**
   * One reconciliation pass: diff the disk against what has been reported and
   * announce the difference through the ordinary event path, so a recovered
   * file is indistinguishable from one the watcher delivered live.
   */
  private reconcileWatchedConfigPaths(): void {
    const onDisk = this.scanWatchedConfigPaths();
    const recoveredDirs = new Set<string>();

    for (const path of onDisk) {
      if (this.knownConfigPaths.has(path)) continue;
      this.knownConfigPaths.add(path);
      recoveredDirs.add(dirname(path));
      configWatchRecovered.add(1, { event: 'add' });
      this.notifyConfigFileEvent('add', path);
    }

    for (const path of Array.from(this.knownConfigPaths)) {
      if (onDisk.has(path)) continue;
      this.knownConfigPaths.delete(path);
      configWatchRecovered.add(1, { event: 'remove' });
      this.notifyConfigFileEvent('remove', path);
    }

    // Discovery above is complete on its own, but chokidar still does not know
    // the directory exists, so later edits inside it would go unreported for
    // the life of the process. `add()` repairs that listing cache directly:
    // measured against a stalled watcher, the recovered directory entered
    // `getWatched()` 21/21 times after `add()` and 0/21 without it.
    for (const dir of recoveredDirs) {
      try {
        this.watcher?.add(dir);
      } catch {
        logger.error('Failed to re-arm the config watcher on a directory.');
      }
    }
  }

  /** Chains the bounded post-`ready` passes; stops when the backoff runs out. */
  private scheduleWatcherReconciliation(index: number): void {
    if (this.disposed) return;
    if (index >= WATCHER_RECONCILE_BACKOFF_MS.length) return;
    this.watcherReconcileTimer = setTimeout(() => {
      this.watcherReconcileTimer = undefined;
      if (this.disposed || !this.watcher) return;
      try {
        this.reconcileWatchedConfigPaths();
      } catch {
        logger.error('Failed to reconcile watched configuration directories.');
      }
      this.scheduleWatcherReconciliation(index + 1);
    }, WATCHER_RECONCILE_BACKOFF_MS[index]);
    this.watcherReconcileTimer.unref();
  }

  private notifyConfigFileEvent(
    event: 'change' | 'add' | 'remove',
    path: string,
  ): void {
    const internalWrite = this.internalAgentWrites.get(path);
    if (internalWrite) {
      internalWrite.pendingEvents.push(event);
      this.flushInternalAgentWrite(path, internalWrite);
      return;
    }
    this.forwardConfigFileEvent(event, path);
  }

  private forwardConfigFileEvent(
    event: 'change' | 'add' | 'remove',
    path: string,
  ): void {
    this.notifyListeners(event, path);
    if (path === join(this.projectHomeDir, 'config', 'app.json')) {
      this.launchabilityObservationQueue = this.launchabilityObservationQueue
        .then(() => this.observeExternalAppMutation(event, path))
        .catch(() => {
          this.launchabilityFingerprints.delete(path);
          this.launchabilityFileSignatures.delete(path);
          this.launchabilityRevision.commit();
          logger.error('Failed to fingerprint changed app configuration.');
        });
    }
  }

  /**
   * Bracket agent persistence before it starts, so a fast filesystem event
   * cannot arrive before the write is marked internal. Any event received
   * during the write is held until the final on-disk signature is known.
   */
  private async withInternalAgentWrite<T>(
    path: string,
    operation: () => Promise<{
      result: T;
      expectedContentSignature: string | null;
    }>,
  ): Promise<T> {
    if (!this.watcher) return (await operation()).result;
    const record: InternalAgentWrite = { pendingEvents: [] };
    this.internalAgentWrites.set(path, record);
    try {
      const { result, expectedContentSignature } = await operation();
      record.expectedContentSignature = expectedContentSignature;
      this.flushInternalAgentWrite(path, record);
      if (this.internalAgentWrites.get(path) === record) {
        record.cleanupTimer = setTimeout(() => {
          if (this.internalAgentWrites.get(path) === record) {
            this.internalAgentWrites.delete(path);
          }
        }, INTERNAL_AGENT_WRITE_ECHO_TTL_MS);
        record.cleanupTimer.unref();
      }
      return result;
    } catch (error) {
      this.internalAgentWrites.delete(path);
      this.forwardLatestInternalAgentWriteEvent(path, record);
      throw error;
    }
  }

  /**
   * A matching content signature is the write the live route already
   * activated. A different value means a concurrent external edit won the
   * race, so replay the queued event instead of hiding that external change.
   */
  private flushInternalAgentWrite(
    path: string,
    record: InternalAgentWrite,
  ): void {
    if (record.expectedContentSignature === undefined) return;
    try {
      if (
        this.watchedConfigFileContentSignature(path) ===
        record.expectedContentSignature
      ) {
        record.pendingEvents.length = 0;
        return;
      }
    } catch {
      // Fall through: an unreadable path is not safe to classify as our echo.
    }
    this.clearInternalAgentWrite(path, record);
    this.forwardLatestInternalAgentWriteEvent(path, record);
  }

  private forwardLatestInternalAgentWriteEvent(
    path: string,
    record: InternalAgentWrite,
  ): void {
    const event = record.pendingEvents.at(-1);
    record.pendingEvents.length = 0;
    if (event) this.forwardConfigFileEvent(event, path);
  }

  private clearInternalAgentWrite(
    path: string,
    record: InternalAgentWrite,
  ): void {
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    if (this.internalAgentWrites.get(path) === record) {
      this.internalAgentWrites.delete(path);
    }
  }

  private watchedConfigFileContentSignature(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      return createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private agentConfigContentSignature(spec: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(spec, null, 2), 'utf8')
      .digest('hex');
  }

  private appConfigFingerprint(config: AppConfig): string {
    return createHash('sha256')
      .update(JSON.stringify(config, null, 2))
      .digest('hex');
  }

  private appConfigFileFingerprint(path: string): string | null {
    if (!existsSync(path)) return null;
    const config = JSON.parse(
      readTextFileBounded(path, APP_CONFIG_MAX_BYTES, 'app config'),
    ) as AppConfig;
    return this.appConfigFingerprint(config);
  }

  private appConfigFileSignature(path: string): string | null {
    try {
      const stats = statSync(path, { bigint: true });
      return [
        stats.dev,
        stats.ino,
        stats.size,
        stats.mtimeNs,
        stats.ctimeNs,
      ].join(':');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private stableAppConfigFileSnapshot(path: string): {
    fingerprint: string | null;
    signature: string | null;
  } {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const signatureBefore = this.appConfigFileSignature(path);
      try {
        const fingerprint = this.appConfigFileFingerprint(path);
        const signatureAfter = this.appConfigFileSignature(path);
        if (signatureBefore === signatureAfter) {
          return { fingerprint, signature: signatureAfter };
        }
      } catch (error) {
        if (signatureBefore === this.appConfigFileSignature(path)) throw error;
      }
    }
    throw new Error('App configuration changed repeatedly while being read.');
  }

  private synchronizeAppConfigFingerprintAfterMetadataChange(
    path: string,
  ): void {
    if (this.internalAppMutationDepth > 0) return;
    const signature = this.appConfigFileSignature(path);
    if (this.launchabilityFileSignatures.get(path) === signature) return;
    const revisionBefore =
      this.launchabilityRevision.getLaunchabilityRevision();
    this.synchronizeAppConfigFingerprint();
    if (
      this.launchabilityRevision.getLaunchabilityRevision() === revisionBefore
    )
      this.launchabilityRevision.commit();
  }

  private synchronizeAppConfigFingerprint(): void {
    if (this.internalAppMutationDepth > 0) return;
    const path = join(this.projectHomeDir, 'config', 'app.json');
    try {
      const hadSignature = this.launchabilityFileSignatures.has(path);
      const previousSignature = this.launchabilityFileSignatures.get(path);
      const revisionBefore =
        this.launchabilityRevision.getLaunchabilityRevision();
      const snapshot = this.stableAppConfigFileSnapshot(path);
      this.synchronizeAppConfigFingerprintValue(path, snapshot.fingerprint);
      this.launchabilityFileSignatures.set(path, snapshot.signature);
      if (
        hadSignature &&
        previousSignature !== snapshot.signature &&
        this.launchabilityRevision.getLaunchabilityRevision() === revisionBefore
      ) {
        this.launchabilityRevision.commit();
      }
    } catch (error) {
      this.launchabilityFileSignatures.set(
        path,
        this.appConfigFileSignature(path),
      );
      if (this.launchabilityFingerprints.get(path) !== 'invalid') {
        this.launchabilityFingerprints.set(path, 'invalid');
        this.launchabilityRevision.commit();
      }
      throw error;
    }
  }

  private synchronizeAppConfigFingerprintValue(
    path: string,
    fingerprint: string | null,
  ): void {
    if (!this.launchabilityFingerprints.has(path)) {
      this.launchabilityFingerprints.set(path, fingerprint);
      return;
    }
    if (this.launchabilityFingerprints.get(path) === fingerprint) return;
    this.launchabilityFingerprints.set(path, fingerprint);
    this.launchabilityRevision.commit();
  }

  private beginInternalAppMutation(): void {
    if (this.internalAppMutationDepth === 0) {
      this.internalAppMutationBarrier = new Promise((resolve) => {
        this.releaseInternalAppMutation = resolve;
      });
    }
    this.internalAppMutationDepth += 1;
  }

  private endInternalAppMutation(): void {
    this.internalAppMutationDepth -= 1;
    if (this.internalAppMutationDepth === 0) {
      this.releaseInternalAppMutation?.();
      this.releaseInternalAppMutation = null;
      this.internalAppMutationBarrier = null;
    }
  }

  private recordInternalAppCommit(config: AppConfig): void {
    const path = join(this.projectHomeDir, 'config', 'app.json');
    this.launchabilityFingerprints.set(path, this.appConfigFingerprint(config));
    this.launchabilityFileSignatures.set(
      path,
      this.appConfigFileSignature(path),
    );
    this.launchabilityRevision.commit();
  }

  private async commitInternalAppConfig(
    config: AppConfig,
    expectedSourceSignature: string | null,
  ): Promise<void> {
    this.beginInternalAppMutation();
    try {
      await saveAppConfigFile(this.projectHomeDir, config, {
        expectedSourceSignature,
      });
      this.recordInternalAppCommit(config);
    } finally {
      this.endInternalAppMutation();
    }
  }

  private serializeAppMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.appMutationQueue.then(operation, operation);
    this.appMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async observeExternalAppMutation(
    _event: 'change' | 'add' | 'remove',
    path: string,
  ): Promise<void> {
    await this.internalAppMutationBarrier;
    this.synchronizeAppConfigFingerprintAfterMetadataChange(path);
  }

  /**
   * Register a listener for config changes
   */
  on(event: string, listener: (data: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  /**
   * Unregister a listener
   */
  off(event: string, listener: (data: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  /**
   * Notify all listeners for an event
   */
  private notifyListeners(event: string, data: unknown): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          logger.error('Error in config listener', { error });
        }
      }
    }
  }

  // ── Skills ──────────────────────────────────────────────

  /**
   * List installed skills by scanning skill.json files
   */
  async listSkills(): Promise<SkillConfig[]> {
    return listSkillConfigs(this.projectHomeDir, logger);
  }

  /**
   * Load a single skill config
   */
  async loadSkill(name: string): Promise<SkillConfig> {
    return loadSkillConfig(this.projectHomeDir, name);
  }

  /**
   * Save a skill config
   */
  async saveSkill(name: string, config: SkillConfig): Promise<void> {
    await saveSkillConfig(this.projectHomeDir, name, config);
  }

  /**
   * Delete a skill directory
   */
  async deleteSkill(name: string): Promise<void> {
    await deleteSkillConfig(this.projectHomeDir, name);
  }

  /**
   * Check if a skill exists
   */
  async skillExists(name: string): Promise<boolean> {
    return skillConfigExists(this.projectHomeDir, name);
  }

  /**
   * Load ACP configuration (connections to external agents)
   */
  async loadACPConfig(): Promise<ACPConfig> {
    await this.ensureHomeSchema();
    return loadACPConfigFile(this.projectHomeDir);
  }

  /**
   * Save ACP configuration
   */
  async saveACPConfig(config: ACPConfig): Promise<void> {
    await saveACPConfigFile(this.projectHomeDir, config);
  }

  /**
   * Stop file watching and clean up.
   *
   * Everything that can still affect correctness settles before this resolves:
   * the reconciliation backoff and the launchability poller are cancelled, the
   * loader goes permanently silent, and the two in-flight work queues drain.
   * The one thing deliberately left for a later turn of the event loop is
   * `watcher.close()`.
   *
   * `FSWatcher.close()` reads like an async call, but chokidar runs every
   * closer inline and returns an already-settled promise: the whole cost is a
   * *synchronous* block of the JS thread, in `uv_fs_event_stop` tearing the
   * process-wide macOS FSEvents stream down on a CFRunLoop thread. Measured
   * here (archive#956), splitting the synchronous call from the promise it returns:
   *
   *   sync=1045.0ms async=0.0ms      sync=5931.7ms async=0.0ms
   *   sync= 958.3ms async=0.0ms      sync=2592.4ms async=0.0ms   (8 rounds)
   *
   * That is why this defers rather than races. `Promise.race([close, timeout])`
   * and "close concurrently with the rest of teardown" both assume the cost is
   * awaited time that something else can overlap; against a synchronous block
   * neither can win a millisecond — the thread is already gone by the time the
   * race is set up. And a fixed budget was unaffordable anyway: the fastest
   * close in 50 measured rounds was 527ms, so a 250ms bound would have expired
   * every time.
   *
   * Deferring works because `StationRuntime.shutdown()`'s only caller exits
   * immediately afterwards (`src-server/index.ts` → `process.exit()`), which
   * runs before any `setImmediate` callback — so on the quit path the block is
   * never paid at all and the kernel reclaims the handle with the process. A
   * process that keeps running instead pays it one turn later, off the path
   * that was waiting. Nothing observable survives either way: the loader is
   * already silent, so a late event cannot reach a listener.
   *
   * Callers that need a genuinely settled teardown — tests, mainly — await
   * {@link whenWatcherClosed}.
   *
   * Idempotent: repeat calls return the first call's promise.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.runDispose();
    return this.disposal;
  }

  /**
   * Resolves once the deferred watcher close that {@link dispose} scheduled has
   * run to completion.
   *
   * Never rejects — a failed close is logged, not propagated, because by then
   * there is nothing left to fall back to. Resolves immediately when there was
   * no watcher, or when `dispose()` has not been called. Stays pending forever
   * if the process exits first, which is the intended production outcome.
   *
   * A caller that deletes the watched tree must await this first. Deleting a
   * watched directory, letting a turn pass, and only then closing leaves
   * chokidar with work that never settles and a process that never exits —
   * reproducible against chokidar alone, with no Station code involved, so this
   * is an ordering rule rather than something the loader can paper over.
   */
  whenWatcherClosed(): Promise<void> {
    return this.watcherClose;
  }

  private async runDispose(): Promise<void> {
    this.disposed = true;
    for (const record of this.internalAgentWrites.values()) {
      if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    }
    this.internalAgentWrites.clear();
    if (this.launchabilityPoller) {
      clearInterval(this.launchabilityPoller);
      this.launchabilityPoller = undefined;
    }
    if (this.watcherReconcileTimer) {
      clearTimeout(this.watcherReconcileTimer);
      this.watcherReconcileTimer = undefined;
    }
    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher) this.watcherClose = closeWatcherAfterThisTurn(watcher);
    await this.appMutationQueue;
    await this.launchabilityObservationQueue;
    this.listeners.clear();
  }
}

/**
 * Run `watcher.close()` on a later turn of the event loop.
 *
 * `setImmediate` rather than a microtask on purpose: microtasks drain before
 * the caller's own `await` chain finishes unwinding, so a microtask would still
 * charge the synchronous close to whoever awaited `dispose()`.
 *
 * The deferral is unref'd so it can never be the reason a process stays alive;
 * the watcher's own handle is what keeps the loop running until this fires.
 */
function closeWatcherAfterThisTurn(watcher: FSWatcher): Promise<void> {
  return new Promise<void>((resolve) => {
    const deferred = setImmediate(() => {
      const startedAt = performance.now();
      const finish = (error?: unknown): void => {
        if (error) {
          logger.error('Failed to close the configuration watcher.', { error });
        }
        configWatcherCloseDuration.record(performance.now() - startedAt);
        resolve();
      };
      try {
        Promise.resolve(watcher.close()).then(() => finish(), finish);
      } catch (error) {
        finish(error);
      }
    });
    deferred.unref();
  });
}
