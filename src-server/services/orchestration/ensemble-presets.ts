// UNWIRED(#91): actual-context authentication and final admission own the mount.
import { createHash } from 'node:crypto';
import { type BigIntStats, constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  composeEnsembleBrief,
  ENSEMBLE_MAX_BYTES,
  type EnsembleMember,
  type EnsemblePreset,
  parseEnsemblePreset,
  renderEnsembleRoster,
} from '@kontourai/station-contracts/ensemble';
import type {
  ExecutionResolutionReceipt,
  ExecutionTarget,
} from '@kontourai/station-contracts/execution-target';
import {
  type ExecutionTargetResolverDependencies,
  resolveExecutionTarget,
} from '../execution-target/execution-target-resolver.js';

export interface EnsemblePresetFile {
  readonly path: string;
  /** Exact UTF-8 file content, including formatting and final newline. */
  readonly json: string;
  readonly sha256: string;
  readonly preset: EnsemblePreset;
  assertCurrent(): void;
}

function hash(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameEntry(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function requireCurrent(isCurrent: () => boolean): void {
  if (isCurrent?.() !== true)
    throw new Error('Ensemble: current caller binding required');
}

export async function loadEnsemblePreset(
  path: string,
  isCurrent: () => boolean,
): Promise<EnsemblePresetFile> {
  requireCurrent(isCurrent);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !path.endsWith('.json') ||
    (await realpath(path)) !== path
  ) {
    throw new Error('Ensemble: expected an explicit canonical .json path');
  }
  const ancestors: Array<{ path: string; stat: BigIntStats }> = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    requireCurrent(isCurrent);
    const stat = await lstat(parent, { bigint: true });
    if (!stat.isDirectory())
      throw new Error('Ensemble: preset file identity changed');
    ancestors.push({ path: parent, stat });
    if (dirname(parent) === parent) break;
  }
  requireCurrent(isCurrent);
  const expected = await lstat(path, { bigint: true });
  if (!expected.isFile() || expected.size > ENSEMBLE_MAX_BYTES)
    throw new Error('Ensemble: invalid preset file');

  const assertCurrent = () => {
    requireCurrent(isCurrent);
    if (
      realpathSync(path) !== path ||
      !sameFile(expected, lstatSync(path, { bigint: true }))
    )
      throw new Error('Ensemble: preset file identity changed');
    for (const ancestor of ancestors) {
      const current = lstatSync(ancestor.path, { bigint: true });
      if (!current.isDirectory() || !sameEntry(ancestor.stat, current))
        throw new Error('Ensemble: preset file identity changed');
    }
  };

  requireCurrent(isCurrent);
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let json: string;
  let sha256: string;
  try {
    const assertOpenedIdentity = async () => {
      requireCurrent(isCurrent);
      const opened = await file.stat({ bigint: true });
      if (!sameFile(expected, opened))
        throw new Error('Ensemble: preset file identity changed');
      assertCurrent();
    };
    await assertOpenedIdentity();
    const buffer = Buffer.alloc(ENSEMBLE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      requireCurrent(isCurrent);
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > ENSEMBLE_MAX_BYTES)
      throw new Error('Ensemble: preset exceeds byte limit');
    await assertOpenedIdentity();
    const bytes = buffer.subarray(0, length);
    json = bytes.toString('utf8');
    if (!Buffer.from(json, 'utf8').equals(bytes))
      throw new Error('Ensemble: invalid UTF-8');
    sha256 = hash(bytes);
  } finally {
    await file.close();
  }
  assertCurrent();
  return Object.freeze({
    path,
    json,
    sha256,
    preset: parseEnsemblePreset(json),
    assertCurrent,
  });
}

export interface PrepareEnsembleInput {
  readonly path: string;
  readonly expectedPresetHash: string;
  readonly contextKey: string;
  readonly brief: string;
  readonly bindings: Readonly<Record<string, Omit<ExecutionTarget, 'model'>>>;
}

export interface EnsemblePreparationHost {
  readonly inventory: ExecutionTargetResolverDependencies;
  readonly isCurrent: (binding: Omit<PrepareEnsembleInput, 'brief'>) => boolean;
}

interface PreparedEnsembleMember {
  readonly member: EnsembleMember;
  readonly target: ExecutionTarget;
  readonly resolution: ExecutionResolutionReceipt;
  readonly brief: string;
}

export interface PreparedEnsemble {
  readonly source: EnsemblePresetFile;
  readonly contextKey: string;
  readonly stationmaster: string;
  readonly roster: string;
  readonly members: readonly PreparedEnsembleMember[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Prepare a snapshot of configured local inventory for the retained preset. */
export async function prepareEnsemble(
  input: PrepareEnsembleInput,
  host: EnsemblePreparationHost,
): Promise<PreparedEnsemble> {
  const { brief, ...request } = freeze(structuredClone(input));
  Object.freeze(request);
  if (typeof request.contextKey !== 'string' || !request.contextKey.trim())
    throw new Error('Ensemble: current caller binding required');
  const current = host.isCurrent?.bind(host);
  const isCurrent = () => current?.(request) === true;
  const owner = host.inventory;
  const inventory = {
    resolveEnvironmentAccess: owner.resolveEnvironmentAccess,
    getAgent: owner.getAgent,
    getConnection: owner.getConnection,
    getProject: owner.getProject,
    getProviderAdapter: owner.getProviderAdapter,
    getStationDefaultWorkspaceIsolation:
      owner.getStationDefaultWorkspaceIsolation,
    acpApprovalControl: owner.acpApprovalControl,
    now: owner.now,
  };
  const source = await loadEnsemblePreset(request.path, isCurrent);
  if (source.sha256 !== request.expectedPresetHash)
    throw new Error('Ensemble: stale preset bytes');

  const { bindings } = request;
  const { preset } = source;
  if (
    Object.keys(bindings).length !== preset.members.length ||
    preset.members.some((member) => !Object.hasOwn(bindings, member.id))
  )
    throw new Error('Ensemble: every member requires an exact host binding');
  if (
    preset.members.some(
      (member) => member.reasoning || Object.keys(member.options).length,
    )
  )
    throw new Error('Ensemble: model option values require catalog validation');

  const selections = preset.members.map((member) => {
    const binding = bindings[member.id];
    if (
      binding?.environment?.kind !== 'current' ||
      Object.keys(binding).some(
        (key) =>
          !['environment', 'agent', 'workspace', 'expectedEngine'].includes(
            key,
          ),
      ) ||
      binding.workspace?.kind === 'project-portable' ||
      binding.workspace?.kind === 'project-portable-prepared'
    )
      throw new Error(
        'Ensemble: every member requires an exact local host binding',
      );
    const target: ExecutionTarget = freeze({
      ...binding,
      model: { override: member.model },
    });
    return { member, target };
  });

  const guard =
    <Args extends unknown[], Result>(operation: (...args: Args) => Result) =>
    (...args: Args): Result => {
      source.assertCurrent();
      return operation.apply(owner, args);
    };
  const resolveEnvironmentAccess = guard(inventory.resolveEnvironmentAccess);
  const observations: ExecutionTargetResolverDependencies = {
    async resolveEnvironmentAccess(target) {
      const access = await resolveEnvironmentAccess(target);
      source.assertCurrent();
      if (access.kind !== 'current')
        throw new Error('Ensemble: the selected inventory must be local');
      return access;
    },
    getAgent: guard(inventory.getAgent),
    getConnection: guard(inventory.getConnection),
    getProject: guard(inventory.getProject),
    getProviderAdapter: guard(inventory.getProviderAdapter),
    ...(inventory.getStationDefaultWorkspaceIsolation
      ? {
          getStationDefaultWorkspaceIsolation: guard(
            inventory.getStationDefaultWorkspaceIsolation,
          ),
        }
      : {}),
    ...(inventory.acpApprovalControl
      ? { acpApprovalControl: guard(inventory.acpApprovalControl) }
      : {}),
    ...(inventory.now ? { now: guard(inventory.now) } : {}),
  };

  const members: PreparedEnsembleMember[] = [];
  for (const { member, target } of selections) {
    const resolved = await resolveExecutionTarget(target, observations);
    source.assertCurrent();
    if (
      resolved.provider !== member.engine ||
      resolved.modelId !== member.model
    )
      throw new Error(`Ensemble: member ${member.id} engine/model changed`);
    members.push({
      member,
      target,
      resolution: structuredClone(resolved.receipt),
      brief: composeEnsembleBrief(preset, member.id, brief),
    });
  }

  return freeze({
    source,
    contextKey: request.contextKey,
    stationmaster: preset.stationmaster,
    roster: renderEnsembleRoster(preset),
    members,
  });
}
