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
import type { ModelOption } from '@kontourai/station-contracts/tool';
import {
  type ExecutionTargetResolverDependencies,
  type PreparationDefinitions,
  resolveExecutionTarget,
} from '../execution-target/execution-target-resolver.js';

export interface EnsemblePresetFile {
  readonly path: string;
  /** Exact UTF-8 file content, including formatting and final newline. */
  readonly json: string;
  readonly sha256: string;
  readonly preset: EnsemblePreset;
  /** Recheck the loaded file identity after later awaited observations. */
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

/** Explicit canonical paths only; imports neither discover files nor follow symlinks. */
export async function loadEnsemblePreset(
  path: string,
): Promise<EnsemblePresetFile> {
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
    const stat = await lstat(parent, { bigint: true });
    if (!stat.isDirectory())
      throw new Error('Ensemble: preset file identity changed');
    ancestors.push({ path: parent, stat });
    if (dirname(parent) === parent) break;
  }
  const expected = await lstat(path, { bigint: true });
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const assertIdentity = async () => {
      const opened = await file.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (!sameFile(expected, opened) || !sameFile(opened, named))
        throw new Error('Ensemble: preset file identity changed');
      for (const ancestor of ancestors) {
        const current = await lstat(ancestor.path, { bigint: true });
        if (!current.isDirectory() || !sameEntry(ancestor.stat, current))
          throw new Error('Ensemble: preset file identity changed');
      }
    };
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.size > ENSEMBLE_MAX_BYTES)
      throw new Error('Ensemble: invalid preset file');
    await assertIdentity();
    const buffer = Buffer.alloc(ENSEMBLE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > ENSEMBLE_MAX_BYTES)
      throw new Error('Ensemble: preset exceeds byte limit');
    await assertIdentity();
    const bytes = buffer.subarray(0, length);
    const json = bytes.toString('utf8');
    if (!Buffer.from(json, 'utf8').equals(bytes))
      throw new Error('Ensemble: invalid UTF-8');
    return Object.freeze({
      path,
      json,
      sha256: hash(bytes),
      preset: parseEnsemblePreset(json),
      assertCurrent() {
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
      },
    });
  } finally {
    await file.close();
  }
}

export interface EnsembleAuthenticationRequest {
  readonly contextKey: string;
  readonly presetHash: string;
  readonly member: EnsembleMember;
  readonly target: ExecutionTarget;
  readonly resolution: ExecutionResolutionReceipt;
  readonly selectionHash: string;
  readonly definitions?: PreparationDefinitions;
}

/** Host-only observation after checking the actual future child execution context. */
export interface EnsembleAuthenticationReceipt {
  readonly authenticated: boolean;
  readonly contextKey: string;
  readonly presetHash: string;
  readonly memberId: string;
  readonly selectionHash: string;
  readonly checkedAt: number;
}

export interface PreparedEnsembleMember {
  readonly member: EnsembleMember;
  readonly target: ExecutionTarget;
  readonly resolution: ExecutionResolutionReceipt;
  readonly authentication: EnsembleAuthenticationReceipt;
  readonly brief: string;
}

export interface PreparedEnsemble {
  readonly source: EnsemblePresetFile;
  readonly contextKey: string;
  readonly stationmaster: string;
  readonly roster: string;
  readonly members: readonly PreparedEnsembleMember[];
}

export interface PrepareEnsembleInput {
  readonly path: string;
  readonly expectedPresetHash: string;
  /** Host-issued identity for the final workspace, principal and credential context. */
  readonly contextKey: string;
  readonly brief: string;
  /** Receiver-owned targets, keyed by preset member ID. No paths or authority come from JSON. */
  readonly bindings: Readonly<Record<string, Omit<ExecutionTarget, 'model'>>>;
}

export interface EnsemblePreparationHost {
  readonly inventory: ExecutionTargetResolverDependencies;
  readonly resolutionPurpose?: 'preparation';
  /** Must probe in the final context, not infer authentication from inventory readiness. */
  readonly authenticateMember: (
    request: EnsembleAuthenticationRequest,
  ) => Promise<EnsembleAuthenticationReceipt>;
  readonly now: () => number;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

/**
 * Preparation only: existing inventory resolution plus mandatory host authentication.
 * A prepared snapshot grants no launch authority; adoption must revalidate the
 * final context and consume the published execution contract.
 */
export async function prepareEnsemble(
  input: PrepareEnsembleInput,
  host: EnsemblePreparationHost,
): Promise<PreparedEnsemble> {
  input = freeze(structuredClone(input));
  if (
    !input.contextKey.trim() ||
    typeof host.authenticateMember !== 'function'
  ) {
    throw new Error('Ensemble: actual-context authentication is required');
  }
  const source = await loadEnsemblePreset(input.path);
  if (source.sha256 !== input.expectedPresetHash)
    throw new Error('Ensemble: stale preset bytes');
  const bindings = input.bindings;
  if (
    Object.keys(bindings).length !== source.preset.members.length ||
    source.preset.members.some((member) => !Object.hasOwn(bindings, member.id))
  ) {
    throw new Error('Ensemble: every member requires an exact host binding');
  }
  const startedAt = host.now();
  const members: PreparedEnsembleMember[] = [];
  for (const member of source.preset.members) {
    const binding = bindings[member.id];
    if ('model' in binding)
      throw new Error('Ensemble: model selection belongs to the preset');
    const options = {
      ...member.options,
      ...(member.reasoning
        ? { [member.reasoning.option]: member.reasoning.value }
        : {}),
    };
    const target = freeze({
      ...binding,
      model: { override: member.model, options },
    });
    const resolved = await resolveExecutionTarget(target, host.inventory, {
      purpose: host.resolutionPurpose,
    });
    if (
      resolved.provider !== member.engine ||
      resolved.modelId !== member.model
    ) {
      throw new Error(`Ensemble: member ${member.id} engine/model changed`);
    }
    if (Object.keys(options).length) {
      const adapter = host.inventory.getProviderAdapter(resolved.provider);
      const catalog = await adapter?.listModelCatalog?.();
      const model: ModelOption | undefined = catalog?.models.find(
        (entry) =>
          entry.id === member.model || entry.originalId === member.model,
      );
      const capabilities = model?.capabilities;
      for (const [key, value] of Object.entries(options)) {
        const supported =
          ((key === 'effort' || key === 'reasoningEffort') &&
            typeof value === 'string' &&
            capabilities?.supportsEffort === true &&
            capabilities.supportedEffortLevels?.includes(value) === true) ||
          (key === 'fastMode' &&
            typeof value === 'boolean' &&
            capabilities?.supportsFastMode === true) ||
          (key === 'thinking' &&
            typeof value === 'boolean' &&
            capabilities?.supportsAdaptiveThinking === true);
        if (!supported)
          throw new Error(
            `Ensemble: member ${member.id} unsupported model option value '${key}'`,
          );
      }
    }
    const resolution = freeze(structuredClone(resolved.receipt));
    const selectionHash = hash(
      JSON.stringify({
        contextKey: input.contextKey,
        presetHash: source.sha256,
        member,
        target,
        resolution,
      }),
    );
    const authentication = freeze(
      structuredClone(
        await host.authenticateMember(
          freeze({
            contextKey: input.contextKey,
            presetHash: source.sha256,
            member,
            target,
            resolution,
            selectionHash,
            ...(resolved.preparationDefinitions
              ? { definitions: resolved.preparationDefinitions }
              : {}),
          }),
        ),
      ),
    );
    if (
      authentication.authenticated !== true ||
      authentication.contextKey !== input.contextKey ||
      authentication.presetHash !== source.sha256 ||
      authentication.memberId !== member.id ||
      authentication.selectionHash !== selectionHash ||
      !Number.isFinite(authentication.checkedAt) ||
      authentication.checkedAt < startedAt ||
      authentication.checkedAt > host.now()
    ) {
      throw new Error(
        `Ensemble: member ${member.id} lacks fresh actual-context authentication`,
      );
    }
    members.push({
      member,
      target,
      resolution,
      authentication,
      brief: composeEnsembleBrief(source.preset, member.id, input.brief),
    });
  }
  if ((await loadEnsemblePreset(source.path)).sha256 !== source.sha256) {
    throw new Error('Ensemble: preset changed during preparation');
  }
  const finishedAt = host.now();
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt ||
    members.some(
      (entry) => finishedAt - entry.authentication.checkedAt > 30_000,
    )
  ) {
    throw new Error('Ensemble: authentication expired during preparation');
  }
  return freeze({
    source,
    contextKey: input.contextKey,
    stationmaster: source.preset.stationmaster,
    roster: renderEnsembleRoster(source.preset),
    members,
  });
}
