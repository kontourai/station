import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type {
  AgentMetadata,
  AgentSpec,
} from '@kontourai/station-contracts/agent';
import {
  agentId,
  isStationAgentIdentity,
} from '@kontourai/station-contracts/agent-identity';
import type { WorkflowMetadata } from '@kontourai/station-contracts/runtime';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { assertSafeContextText } from '../services/orchestration/context-safety.js';
import { createLogger } from '../utils/logger.js';
import {
  acquireAgentIdentityMutationLockAtHome,
  assertCustomAgentIdentity,
  assertRegistryIntegrityAtHomeSync,
  DefaultAgentMutationError,
  registryEngineConnectionForDefaultSync,
  withoutReservedStationBinding,
} from './agent-registry.js';
import { validator } from './validator.js';

const logger = createLogger({ name: 'config-loader' });

const WORKFLOW_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs'];

function agentPersistenceLockPath(
  projectHomeDir: string,
  slug: string,
): string {
  return join(projectHomeDir, 'config', 'agent-persistence', `${slug}.lock`);
}

function renameForDurableDeletion(
  path: string,
  tombstone: string,
  parentDirectory: string,
): void {
  renameSync(path, tombstone);
  try {
    fsyncDirectorySync(parentDirectory);
  } catch (commitError) {
    try {
      renameSync(tombstone, path);
      fsyncDirectorySync(parentDirectory);
    } catch (restoreError) {
      throw new AggregateError(
        [commitError, restoreError],
        `Deletion of ${path} could not be committed or durably restored`,
      );
    }
    throw commitError;
  }
}

async function withAgentPersistenceLock<T>(
  projectHomeDir: string,
  slug: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = agentPersistenceLockPath(projectHomeDir, slug);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const release = await acquireFileMutationLockAsync(lockPath);
  try {
    return await operation();
  } finally {
    await release();
  }
}

/**
 * §3.3 save-time existence check: a synchronous filesystem check against the
 * same `projectHomeDir` root this loader already owns (no listing dep, no
 * async project-service call, so it guards every save path — routes,
 * `updateAgent` materialization, plugin installs — with zero dep
 * threading). Fail-closed by construction: a nonexistent project is the
 * only way this returns false. Exported so `plugin-install-shared.ts`'s
 * plugin-agent sync reuses this exact check (archive#1004 review HIGH-1)
 * instead of duplicating it.
 */
export function owningProjectExists(
  projectHomeDir: string,
  projectSlug: string,
): boolean {
  return existsSync(
    join(projectHomeDir, 'projects', projectSlug, 'project.json'),
  );
}

/**
 * A1 (archive#1004 plan ambiguity resolution): reject only a save that
 * introduces or CHANGES `project` to an unknown value. A save whose
 * `project` is byte-identical to the value already persisted for this slug
 * is allowed — this keeps an already-orphaned record editable (the user can
 * fix unrelated fields, or fix the ownership itself, in the same editor)
 * while no path can ever mint a NEW dangling reference.
 */
async function assertOwningProjectSavable(
  projectHomeDir: string,
  slug: string,
  spec: AgentSpec,
): Promise<void> {
  if (spec.project === undefined) return;
  if (owningProjectExists(projectHomeDir, spec.project)) return;

  let persistedProject: string | undefined;
  try {
    const existing = await loadAgentConfig(projectHomeDir, slug);
    persistedProject = existing.project;
  } catch {
    persistedProject = undefined;
  }
  if (persistedProject === spec.project) return;

  throw new Error(
    `Project '${spec.project}' does not exist; an agent can only be owned by an existing project.`,
  );
}

/**
 * archive#3549 review round 3 (independent, Codex): "this agent has no
 * on-disk spec" and "this agent's spec could not be read" were both a bare
 * `Error`, so no caller could tell them apart.
 *
 * That matters because they demand OPPOSITE handling. Absence is ordinary —
 * every registry-default agent (`station`, `claude`, `codex`, …) is
 * deliberately never written to `agents/`, so absence is the common case, not
 * a fault. Unreadability is a fault, and a caller deciding which credentials a
 * session runs on must fail closed on it rather than proceed as though the
 * agent expressed nothing.
 *
 * Conflating them cost a real regression in both directions: first a pinned
 * agent silently running on the wrong account, then a fix for that which broke
 * session starts for every default agent.
 */
export class AgentConfigNotFoundError extends Error {
  readonly code = 'AGENT_CONFIG_NOT_FOUND';

  constructor(slug: string, path: string) {
    super(`Agent '${slug}' not found at ${path}`);
    this.name = 'AgentConfigNotFoundError';
  }
}

export function isAgentConfigNotFound(error: unknown): boolean {
  return (
    error instanceof AgentConfigNotFoundError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'AGENT_CONFIG_NOT_FOUND')
  );
}

export async function loadAgentConfig(
  projectHomeDir: string,
  slug: string,
): Promise<AgentSpec> {
  const path = join(projectHomeDir, 'agents', slug, 'agent.json');

  // Review round 4 (independent, Codex), HIGH: this used to be
  // `if (!existsSync(path)) throw new AgentConfigNotFoundError(...)`.
  //
  // `existsSync` returns false for EACCES as well as ENOENT, so a spec that
  // EXISTS but sits under an unreadable directory was manufactured as
  // "absent" — and absence is the branch that means "no credential pin is
  // possible, proceed". A pinned agent therefore ran on the connection's
  // account, which is the third time this arc has produced that exact defect.
  //
  // Asking the filesystem for the file and classifying its REAL error code is
  // the only way to tell the two apart. It also removes the TOCTOU window the
  // check-then-read pair opened: a file deleted between the two used to throw
  // a raw ENOENT that read as unreadable rather than as the absence it
  // actually was.
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new AgentConfigNotFoundError(slug, path);
    }
    throw error;
  }
  const data = JSON.parse(content);
  dropRetiredToolAliases(slug, data);
  validator.validateAgentSpec(data, slug);
  assertSafeAgentSpec(slug, data);
  return data;
}

/**
 * Drop `tools.aliases` from a spec read off disk (archive#2832).
 *
 * The field was write-only for its whole life: a validated, scoped route and a
 * service setter persisted it, and nothing ever read it to rename or resolve a
 * tool. Removing it from the schema without this would be a hard break — the
 * `tools` object is `additionalProperties: false`, so any agent whose config
 * carries the key would fail validation on load and the agent would disappear.
 *
 * Stripping before validation means such a config still loads and simply loses
 * a value that never did anything; the key is gone from disk on the next save.
 * The values cannot be worth preserving, because no code path has ever applied
 * them.
 */
function dropRetiredToolAliases(slug: string, data: unknown): void {
  if (data === null || typeof data !== 'object') return;
  const tools = (data as { tools?: unknown }).tools;
  // `undefined` (no tools block — the common case) and `null` (schema-valid:
  // `tools` is typed ["object","null"]) both throw when used as an object
  // receiver, so this guard is load-bearing for ordinary agents, not just for
  // hostile input. Without it `Object.hasOwn` below throws and every
  // tools-less agent becomes unloadable.
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
    return;
  }
  if (!Object.hasOwn(tools, 'aliases')) return;
  delete (tools as Record<string, unknown>).aliases;
  // The value is dropped silently from the caller's perspective; log it so the
  // migration is observable in the field rather than being invisible erasure.
  logger.debug('Dropped retired tools.aliases from agent config', {
    agent: slug,
  });
}

export async function saveAgentConfig(
  projectHomeDir: string,
  slug: string,
  spec: AgentSpec,
): Promise<void> {
  await withAgentPersistenceLock(projectHomeDir, slug, () =>
    saveAgentConfigWithOwnedLock(projectHomeDir, slug, spec),
  );
}

/**
 * A registry engine identity may be MATERIALIZED — that is the whole point of
 * this branch — but only by its own definition. An Agent that merely shares
 * the id while binding somewhere else (or nowhere) would silently take over
 * the engine's row, which is the collision the registry has always refused;
 * the previous guard refused every write to an owned id, materialization
 * included, so this narrows the rule rather than removing it.
 */
function assertEngineIdentityWritable(
  projectHomeDir: string,
  slug: string,
  spec: AgentSpec,
): void {
  const connectionId = registryEngineConnectionForDefaultSync(
    projectHomeDir,
    slug,
  );
  if (!connectionId) return;
  if (spec.execution?.agentConnectionId !== connectionId) {
    throw new DefaultAgentMutationError(slug);
  }
}

/**
 * Returns the spec that was actually written, which is not always the spec
 * handed in: for the reserved Station identity the engine binding is stripped
 * here (archive#3662 delta H3).
 *
 * This is the one seam every Agent write shares — create, update and
 * `mutateAgentConfig` all land here under the per-Agent persistence lock — so
 * it is where "the Station record never carries a binding" stops being a rule
 * readers have to remember and becomes a property of the file. The read
 * projection (`AgentService`) puts the per-boot resolved binding back on the
 * way out; without this strip that projected value round-trips through the
 * editor form and gets persisted by any unrelated save, which is a copy of
 * `builtinAgentEngineConnectionId` that no longer tracks it.
 *
 * Stripping rather than rejecting: the value the editor sends back is one
 * this server just handed it, for a field the user did not touch. Failing
 * that save would refuse an edit nobody made.
 */
async function saveAgentConfigWithOwnedLock(
  projectHomeDir: string,
  slug: string,
  spec: AgentSpec,
): Promise<AgentSpec> {
  assertCustomAgentIdentity(slug);
  assertRegistryIntegrityAtHomeSync(projectHomeDir);
  const persisted = isStationAgentIdentity(slug)
    ? withoutReservedStationBinding(spec)
    : spec;
  if (persisted !== spec) {
    logger.debug(
      'Dropped the engine binding from the Station Agent record; the app-level selection owns it',
      { agent: slug },
    );
  }
  validator.validateAgentSpec(persisted, slug);
  assertSafeAgentSpec(slug, persisted);
  await assertOwningProjectSavable(projectHomeDir, slug, persisted);
  const agentDir = join(projectHomeDir, 'agents', slug);
  await mkdir(join(agentDir, 'memory', 'sessions'), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(agentDir, 'workflows'), { recursive: true, mode: 0o700 });
  await publishAgentTextWithIdentityFence(
    projectHomeDir,
    slug,
    join(agentDir, 'agent.json'),
    JSON.stringify(persisted, null, 2),
    () => assertEngineIdentityWritable(projectHomeDir, slug, persisted),
  );
  return persisted;
}

export function resolveAgentConfigSlug(spec: AgentSpec): string {
  const slug =
    (spec as { slug?: string }).slug?.trim() ||
    spec.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  if (!slug) {
    throw new Error(
      'Agent name must contain at least one alphanumeric character',
    );
  }
  return slug;
}

export async function createAgentConfig(
  projectHomeDir: string,
  spec: AgentSpec,
): Promise<{ slug: string; spec: AgentSpec }> {
  const slug = resolveAgentConfigSlug(spec);
  const { slug: _ignored, ...cleanSpec } = spec as AgentSpec & {
    slug?: string;
  };
  const persisted = await withAgentPersistenceLock(
    projectHomeDir,
    slug,
    async () => {
      assertCustomAgentIdentity(slug);
      // Registry identities describe engine connections, not locked phantom
      // agents, so ownership is no longer a veto — but the registry file itself
      // must still be intact before any Agent write (a symlinked or hand-edited
      // registry fails the home closed).
      assertRegistryIntegrityAtHomeSync(projectHomeDir);
      if (await agentConfigExists(projectHomeDir, slug)) {
        throw new Error(`Agent with slug '${slug}' already exists`);
      }
      return saveAgentConfigWithOwnedLock(projectHomeDir, slug, cleanSpec);
    },
  );
  return { slug, spec: persisted };
}

/**
 * Merge a partial agent update onto a stored record, the ONE way it is done.
 *
 * Exported because two paths now merge an update: `updateAgentConfig` below,
 * and `station doctor --migrate-playbooks`, which has to write the record
 * WHOLE in order to drop the legacy binding field and so cannot go through the
 * merge itself. Copying
 * these rules into the second path let response-only fields through — a client
 * that round-trips a `GET /agents/:slug` response back into `PUT` carries
 * `slug`, `updatedAt` and `workflowWarnings`, which the schema then rejects
 * (`additionalProperties: false`), while the ordinary path had always dropped
 * them (review delta-2 MEDIUM).
 *
 * Four rules, all load-bearing:
 * - `slug`/`updatedAt`/`workflowWarnings` are RESPONSE shape, never input.
 * - `undefined` means "no change", so it must not overwrite a stored value.
 * - `project: null` is the ownership-clearing signal (archive#1004 §4). The
 *   schema types `project` as a bare string, so `null` is never persisted; it
 *   deletes the key from the merged record instead.
 * - `execution: null` is the same shape for the engine binding (archive#3662).
 *   An Agent moved to Station's own engine must LOSE `execution`, and an
 *   omitted block cannot say that — `undefined` is "leave it alone", which
 *   kept the old binding across a save that visibly changed the engine. The
 *   schema does accept `execution: null`, but a persisted `null` would be a
 *   second spelling of "unbound", so the key is deleted just as `project`'s is.
 */
export function mergeAgentConfigUpdate(
  existing: AgentSpec,
  updates: Partial<AgentSpec>,
): AgentSpec {
  const {
    slug: _ignoredSlug,
    updatedAt: _ignoredUpdatedAt,
    workflowWarnings: _ignoredWarnings,
    ...cleanUpdates
  } = updates as Partial<AgentSpec> & {
    slug?: string;
    updatedAt?: string;
    workflowWarnings?: string[];
  };

  const filteredUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cleanUpdates)) {
    if (value !== undefined) {
      filteredUpdates[key] = value;
    }
  }

  const clearsProject = cleanUpdates.project === null;
  if (clearsProject) {
    delete filteredUpdates.project;
  }

  const clearsExecution = cleanUpdates.execution === null;
  if (clearsExecution) {
    delete filteredUpdates.execution;
  }

  const updated: AgentSpec = { ...existing, ...filteredUpdates };
  if (clearsProject) {
    delete updated.project;
  }
  if (clearsExecution) {
    delete updated.execution;
  }
  return updated;
}

export async function updateAgentConfig(
  projectHomeDir: string,
  slug: string,
  updates: Partial<AgentSpec>,
): Promise<AgentSpec> {
  return withAgentPersistenceLock(projectHomeDir, slug, async () => {
    assertCustomAgentIdentity(slug);
    assertRegistryIntegrityAtHomeSync(projectHomeDir);
    const existing = await loadAgentConfig(projectHomeDir, slug);
    const updated = mergeAgentConfigUpdate(existing, updates);
    // The WRITE is what decides the record, not the merge: the reserved
    // Station identity's binding is stripped there (archive#3662 delta H3),
    // so returning the merge result would report a field that is not on disk.
    return saveAgentConfigWithOwnedLock(projectHomeDir, slug, updated);
  });
}

/**
 * Read → derive → write, all INSIDE the per-agent lock (archive#1606's
 * serialized-updater pattern).
 *
 * `updateAgentConfig` merges a partial and therefore cannot DELETE a field —
 * `prompts` survived every update. `saveAgentConfig` can replace the record but
 * takes the lock only around the write, so a caller that loaded, derived and
 * then saved republished a stale snapshot over whatever landed in between: the
 * alias attaching a skill silently erased an editor's concurrent prompt/model
 * change (review delta HIGH). This does both correctly: the read happens under
 * the same lock as the write, and the updater returns the WHOLE next record.
 *
 * The updater gets a DEFENSIVE COPY. Handing it the live object let a mutating
 * updater diverge an in-memory cache from disk in the sibling store this
 * pattern comes from; here it also means an updater that throws half-way
 * cannot have already scribbled on the record we would otherwise persist.
 *
 * Returning `null` means "nothing to change": no write happens at all, so a
 * retry over an already-correct record is not a write that can fail for a new
 * reason.
 */
export async function mutateAgentConfig(
  projectHomeDir: string,
  slug: string,
  updater: (current: AgentSpec) => AgentSpec | null,
): Promise<AgentSpec | null> {
  return withAgentPersistenceLock(projectHomeDir, slug, async () => {
    assertCustomAgentIdentity(slug);
    assertRegistryIntegrityAtHomeSync(projectHomeDir);
    const existing = await loadAgentConfig(projectHomeDir, slug);
    const next = updater(structuredClone(existing));
    if (next === null) return null;
    return saveAgentConfigWithOwnedLock(projectHomeDir, slug, next);
  });
}

export async function deleteAgentConfig(
  projectHomeDir: string,
  slug: string,
): Promise<void> {
  await withAgentPersistenceLock(projectHomeDir, slug, async () => {
    assertCustomAgentIdentity(slug);
    assertRegistryIntegrityAtHomeSync(projectHomeDir);
    const agentDir = join(projectHomeDir, 'agents', slug);
    if (!existsSync(agentDir)) throw new Error(`Agent '${slug}' not found`);
    const tombstone = `${agentDir}.deleting.${process.pid}.${randomUUID()}`;
    const releaseIdentity =
      await acquireAgentIdentityMutationLockAtHome(projectHomeDir);
    try {
      renameForDurableDeletion(
        agentDir,
        tombstone,
        join(projectHomeDir, 'agents'),
      );
    } finally {
      await releaseIdentity();
    }
    await rm(tombstone, { recursive: true, force: true });
  });
}

export async function listAgentConfigs(
  projectHomeDir: string,
): Promise<AgentMetadata[]> {
  const agentsDir = join(projectHomeDir, 'agents');

  if (!existsSync(agentsDir)) {
    return [];
  }

  const entries = await readdir(agentsDir, { withFileTypes: true });
  const agents: AgentMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const agentPath = join(agentsDir, entry.name, 'agent.json');
    if (!existsSync(agentPath)) continue;

    try {
      const spec = await loadAgentConfig(projectHomeDir, entry.name);
      const stats = await stat(agentPath);
      const workflowWarnings = await validateWorkflowShortcuts(
        projectHomeDir,
        entry.name,
        spec.ui?.workflowShortcuts,
      );
      const pluginOwnerPath = join(
        agentsDir,
        entry.name,
        '.station-plugin-owner.json',
      );
      let pluginName: string | undefined;
      if (existsSync(pluginOwnerPath)) {
        const owner = JSON.parse(await readFile(pluginOwnerPath, 'utf-8')) as {
          plugin?: unknown;
        };
        if (typeof owner.plugin === 'string') pluginName = owner.plugin;
      }

      agents.push({
        slug: agentId(entry.name),
        name: spec.name,
        model: spec.model,
        updatedAt: stats.mtime.toISOString(),
        description: spec.prompt,
        plugin: pluginName,
        ui: spec.ui,
        workflowWarnings:
          workflowWarnings.length > 0 ? workflowWarnings : undefined,
        execution: spec.execution,
        project: spec.project,
      });
    } catch (error: any) {
      logger.error('Failed to load agent', {
        agent: entry.name,
        error: error.message || error,
      });
      if (error.name === 'ValidationError') {
        logger.error('Validation errors', { errors: error.errors });
      }
    }
  }

  return agents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listAgentWorkflowMetadata(
  projectHomeDir: string,
  slug: string,
): Promise<WorkflowMetadata[]> {
  const workflowsDir = join(projectHomeDir, 'agents', slug, 'workflows');

  if (!existsSync(workflowsDir)) {
    return [];
  }

  const entries = await readdir(workflowsDir, { withFileTypes: true });
  const workflows: WorkflowMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const ext = extname(entry.name).toLowerCase();
    if (!WORKFLOW_EXTENSIONS.includes(ext)) continue;

    const id = entry.name;
    const filePath = join(workflowsDir, entry.name);
    const stats = await stat(filePath);

    workflows.push({
      id,
      label: deriveWorkflowLabel(id),
      filename: entry.name,
      lastModified: stats.mtime.toISOString(),
    });
  }

  return workflows.sort((a, b) => a.label.localeCompare(b.label));
}

export async function createAgentWorkflow(
  projectHomeDir: string,
  slug: string,
  filename: string,
  content: string,
): Promise<void> {
  const ext = extname(filename).toLowerCase();
  if (!WORKFLOW_EXTENSIONS.includes(ext)) {
    throw new Error('Workflow filename must end with .ts, .js, .mjs, or .cjs');
  }

  assertSafeContextText(content, {
    source: `workflow '${filename}' for agent '${slug}'`,
  });
  await mutateWorkflow(projectHomeDir, slug, filename, 'create', content);
}

export async function readAgentWorkflow(
  projectHomeDir: string,
  slug: string,
  workflowId: string,
): Promise<string> {
  const path = join(projectHomeDir, 'agents', slug, 'workflows', workflowId);

  if (!existsSync(path)) {
    throw new Error(`Workflow '${workflowId}' not found`);
  }

  const content = await readFile(path, 'utf-8');
  assertSafeContextText(content, {
    source: `workflow '${workflowId}' for agent '${slug}'`,
  });
  return content;
}

export async function updateAgentWorkflow(
  projectHomeDir: string,
  slug: string,
  workflowId: string,
  content: string,
): Promise<void> {
  assertSafeContextText(content, {
    source: `workflow '${workflowId}' for agent '${slug}'`,
  });
  await mutateWorkflow(projectHomeDir, slug, workflowId, 'update', content);
}

export async function deleteAgentWorkflow(
  projectHomeDir: string,
  slug: string,
  workflowId: string,
): Promise<void> {
  await mutateWorkflow(projectHomeDir, slug, workflowId, 'delete');
}

async function publishAgentTextWithIdentityFence(
  projectHomeDir: string,
  _slug: string,
  path: string,
  content: string,
  /**
   * Re-asserted UNDER the identity lock, immediately before the rename. The
   * caller's own pre-flight check is not enough on its own: a concurrent
   * registry commit can land between it and this publish, and then both
   * writers "win" the same id. `saveRegistry`'s fence is the mirror of this
   * one, so whichever commits first is the one the other observes.
   */
  assertUnderIdentityLock?: () => void,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = await open(temporaryPath, 'wx', 0o600);
    try {
      await descriptor.writeFile(content, 'utf-8');
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    const releaseIdentity =
      await acquireAgentIdentityMutationLockAtHome(projectHomeDir);
    try {
      assertUnderIdentityLock?.();
      renameSync(temporaryPath, path);
      // The file fsync makes its bytes durable; the parent-directory fsync
      // makes the rename itself durable across power loss.
      fsyncDirectorySync(dirname(path));
    } finally {
      await releaseIdentity();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function deleteAgentFileWithIdentityFence(
  projectHomeDir: string,
  _slug: string,
  path: string,
): Promise<void> {
  const tombstone = `${path}.deleting.${process.pid}.${randomUUID()}`;
  const releaseIdentity =
    await acquireAgentIdentityMutationLockAtHome(projectHomeDir);
  try {
    renameForDurableDeletion(path, tombstone, dirname(path));
  } finally {
    await releaseIdentity();
  }
  await rm(tombstone, { force: true });
}

async function mutateWorkflow(
  projectHomeDir: string,
  slug: string,
  workflowId: string,
  operation: 'create' | 'update' | 'delete',
  content?: string,
): Promise<void> {
  assertCustomAgentIdentity(slug);
  if (basename(workflowId) !== workflowId)
    throw new Error('Invalid workflow id');
  const ext = extname(workflowId).toLowerCase();
  if (!WORKFLOW_EXTENSIONS.includes(ext)) {
    throw new Error('Workflow filename must end with .ts, .js, .mjs, or .cjs');
  }
  await withAgentPersistenceLock(projectHomeDir, slug, async () => {
    assertRegistryIntegrityAtHomeSync(projectHomeDir);
    const workflowsDir = join(projectHomeDir, 'agents', slug, 'workflows');
    await mkdir(workflowsDir, { recursive: true, mode: 0o700 });
    const path = join(workflowsDir, workflowId);
    const exists = existsSync(path);
    if (operation === 'create' && exists) {
      throw new Error(`Workflow '${workflowId}' already exists`);
    }
    if (operation !== 'create' && !exists) {
      throw new Error(`Workflow '${workflowId}' not found`);
    }
    if (operation === 'delete')
      await deleteAgentFileWithIdentityFence(projectHomeDir, slug, path);
    else
      await publishAgentTextWithIdentityFence(
        projectHomeDir,
        slug,
        path,
        content ?? '',
      );
  });
}

export async function getAgentToolMap(projectHomeDir: string) {
  const agentsDir = join(projectHomeDir, 'agents');
  const map: Record<string, string[]> = {};

  if (!existsSync(agentsDir)) return map;

  const entries = await readdir(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const spec = await loadAgentConfig(projectHomeDir, entry.name);
      for (const toolId of spec.tools?.mcpServers || []) {
        if (!map[toolId]) map[toolId] = [];
        map[toolId].push(spec.name || entry.name);
      }
    } catch (error) {
      logger.debug('Failed to load agent for tool map', {
        agent: entry.name,
        error,
      });
    }
  }

  return map;
}

export async function agentConfigExists(
  projectHomeDir: string,
  slug: string,
): Promise<boolean> {
  return existsSync(join(projectHomeDir, 'agents', slug, 'agent.json'));
}

function deriveWorkflowLabel(filename: string): string {
  const name = basename(filename, extname(filename));
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function assertSafeAgentSpec(slug: string, spec: AgentSpec): void {
  if (typeof spec.prompt === 'string' && spec.prompt.length > 0) {
    assertSafeContextText(spec.prompt, {
      source: `agent '${slug}' prompt`,
    });
  }

  for (const quickPrompt of spec.ui?.quickPrompts || []) {
    if (
      typeof quickPrompt.prompt !== 'string' ||
      quickPrompt.prompt.length === 0
    ) {
      continue;
    }

    assertSafeContextText(quickPrompt.prompt, {
      source: `agent '${slug}' quick prompt '${quickPrompt.id}'`,
    });
  }
}

async function validateWorkflowShortcuts(
  projectHomeDir: string,
  slug: string,
  shortcuts?: string[],
): Promise<string[]> {
  if (!shortcuts || shortcuts.length === 0) {
    return [];
  }

  try {
    const workflows = await listAgentWorkflowMetadata(projectHomeDir, slug);
    const knownIds = new Set(workflows.map((workflow) => workflow.id));
    const missing = shortcuts.filter((id) => !knownIds.has(id));

    if (missing.length > 0) {
      logger.warn(
        'Agent references missing workflows in ui.workflowShortcuts',
        {
          agent: slug,
          missing: missing.join(', '),
        },
      );
    }

    return missing;
  } catch (error) {
    logger.error('Failed to validate workflow shortcuts', {
      agent: slug,
      error,
    });
    return shortcuts;
  }
}
