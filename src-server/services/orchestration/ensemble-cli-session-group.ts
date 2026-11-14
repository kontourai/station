import { createHash } from 'node:crypto';
import type {
  CliSessionGroupCreateInput,
  CliSessionGroupPresetIdentity,
} from '@kontourai/station-contracts/delegation-group';
import {
  composeEnsembleBrief,
  type EnsembleCliSessionGroupInput,
  parseEnsemblePreset,
} from '@kontourai/station-contracts/ensemble';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import {
  type ExecutionTargetResolverDependencies,
  resolveExecutionTarget,
} from '../execution-target/execution-target-resolver.js';
import { CliSessionGroupUnavailable } from './cli-session-group.js';
import type { EnsembleInspectionService } from './ensemble-inspection.js';
import { loadEnsemblePreset } from './ensemble-presets.js';

export type PreparedEnsembleCliSessionGroup = CliSessionGroupCreateInput & {
  preset: CliSessionGroupPresetIdentity;
};

/** Resolves configuration only. Actual startup authentication belongs to the member runtime. */
export class EnsembleCliSessionGroupPreparation {
  constructor(
    private readonly authority: Pick<
      EnsembleInspectionService,
      'assertAuthority'
    >,
    private readonly inventory: ExecutionTargetResolverDependencies,
  ) {}

  async compose(
    input: EnsembleCliSessionGroupInput,
    request: Request,
    principal: PrincipalRef,
    assertCurrent: () => void,
  ): Promise<PreparedEnsembleCliSessionGroup> {
    input = structuredClone(input);
    if ((input.path === undefined) === (input.presetJson === undefined))
      throw new CliSessionGroupUnavailable('group_invalid');
    const current = () => {
      request.signal.throwIfAborted();
      assertCurrent();
      if (input.path !== undefined)
        try {
          this.authority.assertAuthority(request, principal);
        } catch {
          throw new CliSessionGroupUnavailable('group_authority_required');
        }
    };
    current();
    const source =
      input.path !== undefined
        ? await loadEnsemblePreset(input.path)
        : {
            sha256: `sha256:${createHash('sha256')
              .update(input.presetJson ?? '')
              .digest('hex')}`,
            preset: parseEnsemblePreset(input.presetJson ?? ''),
          };
    current();
    if (source.sha256 !== input.expectedPresetHash)
      throw new CliSessionGroupUnavailable('ensemble_preset_stale');
    if (
      Object.keys(input.bindings).length !== source.preset.members.length ||
      source.preset.members.some(
        (member) => !Object.hasOwn(input.bindings, member.id),
      )
    )
      throw new CliSessionGroupUnavailable('group_invalid');
    const targets = source.preset.members.map((member) => ({
      ...input.bindings[member.id].target,
      environment: { kind: 'current' as const },
      model: {
        override: member.model,
        options: {
          ...member.options,
          ...(member.reasoning
            ? { [member.reasoning.option]: member.reasoning.value }
            : {}),
        },
      },
    }));
    const fence = this.inventory.capturePreparationFence?.(targets);
    if (!fence) throw new CliSessionGroupUnavailable('group_unavailable');
    const members: CliSessionGroupCreateInput['members'] = [];
    for (const [index, member] of source.preset.members.entries()) {
      const target = targets[index];
      const resolved = await resolveExecutionTarget(target, this.inventory, {
        purpose: 'preparation',
      });
      current();
      fence();
      if (
        resolved.access.kind !== 'current' ||
        resolved.engine.kind !== 'connection' ||
        (resolved.provider === 'acp' && resolved.engine.kind === 'connection'
          ? resolved.engine.connectionId
          : resolved.provider) !== member.engine ||
        resolved.modelId !== member.model
      )
        throw new CliSessionGroupUnavailable('ensemble_binding_changed');
      members.push({
        seatId: member.id,
        needs: input.bindings[member.id].needs,
        prompt: composeEnsembleBrief(source.preset, member.id, input.brief),
        target,
      });
    }
    if (
      input.path !== undefined &&
      (await loadEnsemblePreset(input.path)).sha256 !== source.sha256
    )
      throw new CliSessionGroupUnavailable('ensemble_preset_stale');
    fence();
    current();
    return {
      operationId: input.operationId,
      maxConcurrent: input.maxConcurrent,
      ...(input.maxDispatches === undefined
        ? {}
        : { maxDispatches: input.maxDispatches }),
      deadlineAt: input.deadlineAt,
      members,
      preset: {
        presetId: source.preset.id,
        name: source.preset.name,
        sha256: source.sha256,
        stationmaster: source.preset.stationmaster,
        members: source.preset.members.map(({ id, codename, color, role }) => ({
          seatId: id,
          codename,
          color,
          role,
        })),
      },
    };
  }
}
