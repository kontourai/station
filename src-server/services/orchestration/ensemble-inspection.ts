import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  ENSEMBLE_INSPECTION_LIMITS,
  type EnsembleInspection,
  type EnsembleInspectionFact,
  type EnsembleInspectionInput,
} from '@kontourai/station-contracts/ensemble';
import type { ExecutionResolutionReceipt } from '@kontourai/station-contracts/execution-target';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  isBoundLocalGrantMintedOperator,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import {
  type ExecutionTargetResolverDependencies,
  resolveExecutionTarget,
} from '../execution-target/execution-target-resolver.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';
import { loadEnsemblePreset } from './ensemble-presets.js';

export class EnsembleInspectionRefusal extends Error {
  constructor(
    readonly code:
      | 'ensemble_inspection_authority_required'
      | 'ensemble_inspection_stale'
      | 'ensemble_inspection_invalid'
      | 'ensemble_inspection_unavailable',
  ) {
    super(code);
  }
}

const safeId = (value: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
const label = (value: string) =>
  Array.from(value.slice(0, 256), (character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ? ' '
      : character,
  ).join('');

function publicReceipt(
  receipt: ExecutionResolutionReceipt,
): ExecutionResolutionReceipt {
  const plan = receipt.modelLaunchPlan;
  const workspace = receipt.workspace;
  return {
    schemaVersion: receipt.schemaVersion,
    resolvedAt: receipt.resolvedAt,
    environmentId: receipt.environmentId,
    agentId: receipt.agentId,
    ...(receipt.executionAgentId
      ? { executionAgentId: receipt.executionAgentId }
      : {}),
    ...(receipt.definitionFingerprint
      ? { definitionFingerprint: receipt.definitionFingerprint }
      : {}),
    engine:
      receipt.engine.kind === 'station'
        ? { kind: 'station' }
        : { kind: 'connection', connectionId: receipt.engine.connectionId },
    provider: receipt.provider,
    modelLaunchPlan:
      plan.kind === 'station-resolved'
        ? {
            kind: plan.kind,
            modelConnectionId: plan.modelConnectionId,
            modelId: plan.modelId,
            evidence: plan.evidence,
          }
        : plan.kind === 'engine-selected'
          ? { kind: plan.kind, evidence: plan.evidence }
          : { kind: plan.kind, reason: plan.reason },
    ...(workspace
      ? {
          workspace:
            workspace.kind === 'project'
              ? {
                  kind: 'project' as const,
                  projectSlug: workspace.projectSlug,
                  cwd: workspace.cwd,
                  workspaceIsolation: {
                    mode: workspace.workspaceIsolation.mode,
                  },
                }
              : { kind: 'directory' as const, cwd: workspace.cwd },
        }
      : {}),
  };
}

export class EnsembleInspectionService {
  private readonly personalRequest = createPersonalRuntimeRequestGuard();

  constructor(
    private readonly owners: {
      security: CurrentRuntimeRequestPrincipalSecurity;
      inventory: ExecutionTargetResolverDependencies;
      readIntegration: (id: string) => ToolDef | undefined;
    },
  ) {}

  assertAuthority(request: Request, principal: PrincipalRef): void {
    if (
      !this.personalRequest(request) ||
      !isOperatorInPersonNotAgent(request) ||
      !isBoundLocalGrantMintedOperator(request) ||
      principal.id !== LOCAL_OPERATOR_PRINCIPAL_ID ||
      !isRuntimeRequestPrincipalCurrent(request, this.owners.security)
    )
      throw new EnsembleInspectionRefusal(
        'ensemble_inspection_authority_required',
      );
  }

  async inspect(
    input: EnsembleInspectionInput,
    request: Request,
    principal: PrincipalRef,
  ): Promise<EnsembleInspection> {
    this.assertAuthority(request, principal);
    input = structuredClone(input);
    const bindings = new Map(Object.entries(input.bindings));
    const source = await loadEnsemblePreset(input.path);
    if (input.expectedPresetHash && input.expectedPresetHash !== source.sha256)
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
    if (
      Object.keys(input.bindings).some(
        (id) => !source.preset.members.some((member) => member.id === id),
      )
    )
      throw new EnsembleInspectionRefusal('ensemble_inspection_invalid');

    const targets = source.preset.members.flatMap((member) => {
      const binding = bindings.get(member.id);
      return binding
        ? [
            {
              environment: { kind: 'current' as const },
              agent: agentId(binding.agent),
              workspace: {
                kind: 'project' as const,
                projectSlug: binding.projectSlug,
              },
              model: {
                override: member.model,
                options: {
                  ...member.options,
                  ...(member.reasoning
                    ? { [member.reasoning.option]: member.reasoning.value }
                    : {}),
                },
              },
            },
          ]
        : [];
    });
    const access = await this.owners.inventory.resolveEnvironmentAccess({
      environment: { kind: 'current' },
      agent: agentId('station'),
    });
    const fence = this.owners.inventory.capturePreparationFence?.(targets);
    if (!fence)
      throw new EnsembleInspectionRefusal('ensemble_inspection_unavailable');
    const facts: EnsembleInspectionFact[] = [];
    const resolutions: EnsembleInspection['resolutions'][number][] = [];
    const presetOwner = { label: 'Preset source', receipt: source.sha256 };
    const add = (fact: EnsembleInspectionFact) => {
      if (facts.length >= ENSEMBLE_INSPECTION_LIMITS.facts)
        throw new EnsembleInspectionRefusal('ensemble_inspection_unavailable');
      facts.push(fact);
    };
    for (const member of source.preset.members) {
      const memberOwner = {
        ...presetOwner,
        label: `Preset member ${member.id}`,
      };
      add({
        id: `member:${member.id}`,
        memberId: member.id,
        category: 'members/models',
        label: label(member.codename),
        value: `${member.engine} / ${label(member.model)}${source.preset.stationmaster === member.id ? ' · Stationmaster' : ''}`,
        origin: 'authored',
        state: 'configured',
        owner: memberOwner,
      });
      add({
        id: `options:${member.id}`,
        memberId: member.id,
        category: 'members/models',
        label: 'Model options',
        value: label(
          JSON.stringify({
            ...member.options,
            ...(member.reasoning
              ? { [member.reasoning.option]: member.reasoning.value }
              : {}),
          }),
        ),
        origin: 'authored',
        state: 'configured',
        owner: memberOwner,
      });
      const binding = bindings.get(member.id);
      const owner = binding
        ? {
            label: 'Agent settings',
            href: `/agents/${encodeURIComponent(binding.agent)}`,
          }
        : memberOwner;
      let workspace: EnsembleInspectionFact = {
        id: `workspace:${member.id}`,
        memberId: member.id,
        category: 'workspace',
        label: 'Workspace',
        value:
          'Select the receiver Agent and Project IDs to resolve this member.',
        origin: 'unknown',
        state: 'missing',
        owner,
      };
      if (binding) {
        try {
          const resolved = await resolveExecutionTarget(
            {
              environment: { kind: 'current' },
              agent: agentId(binding.agent),
              workspace: { kind: 'project', projectSlug: binding.projectSlug },
              model: {
                override: member.model,
                options: {
                  ...member.options,
                  ...(member.reasoning
                    ? { [member.reasoning.option]: member.reasoning.value }
                    : {}),
                },
              },
            },
            this.owners.inventory,
            { purpose: 'preparation' },
          );
          if (
            resolved.provider !== member.engine ||
            resolved.modelId !== member.model
          )
            throw new Error('Binding differs');
          resolutions.push({
            memberId: member.id,
            receipt: publicReceipt(resolved.receipt),
          });
          add({
            id: `engine:${member.id}`,
            memberId: member.id,
            category: 'members/models',
            label: 'Resolved engine',
            value: `${resolved.provider} / ${resolved.engine.kind === 'connection' ? resolved.engine.connectionId : 'Station engine'}`,
            origin: 'runtime-derived',
            state: 'configured',
            owner: { ...owner, receipt: `resolution:${member.id}` },
          });
          workspace = {
            ...workspace,
            value: `${resolved.workspace?.cwd ?? 'Unknown directory'}; expanded Project path configuration, filesystem availability unverified`,
            origin: 'authored',
            state: 'configured',
            owner: {
              label: 'Project settings',
              href: `/projects/${encodeURIComponent(binding.projectSlug)}/settings`,
              receipt: `resolution:${member.id}`,
            },
          };
          add({
            id: `isolation:${member.id}`,
            memberId: member.id,
            category: 'workspace',
            label: 'Workspace isolation',
            value: `${resolved.workspace?.kind === 'project' ? resolved.workspace.workspaceIsolation.mode : 'unknown'}; Project > Station > shared default precedence. Origin is not separately witnessed.`,
            origin: 'unknown',
            state: 'unknown',
            owner: workspace.owner,
          });
          const spec = resolved.preparationDefinitions?.agent;
          const ids = spec?.tools?.mcpServers ?? [];
          for (const id of [...new Set(ids)].slice(
            0,
            ENSEMBLE_INSPECTION_LIMITS.toolsPerMember,
          )) {
            if (!safeId(id)) continue;
            let definition: ToolDef | undefined;
            try {
              definition = this.owners.readIntegration(id);
            } catch {
              /* An unreadable definition is not an empty capability inventory. */
            }
            add({
              id: `tool:${member.id}:${id}`,
              memberId: member.id,
              category: 'tools/services',
              label: id,
              value: definition
                ? `${definition.kind} · ${definition.transport ?? 'built-in'} · ${definition.enabled === false ? 'disabled' : 'configured'}; definition currency, delivery and authorization unknown`
                : 'Configured reference; definition unavailable.',
              origin: 'authored',
              state: 'unknown',
              owner: {
                label: 'Tool connection settings',
                href: `/connections/tools/${encodeURIComponent(id)}`,
              },
            });
          }
          add({
            id: `tools:${member.id}`,
            memberId: member.id,
            category: 'tools/services',
            label: 'Tool policy',
            value: `Configured MCP references: ${ids.length}. Showing at most ${ENSEMBLE_INSPECTION_LIMITS.toolsPerMember}. Harness tools, effective grants and external service access are unknown.`,
            origin: 'authored',
            state: 'unknown',
            owner,
          });
        } catch {
          add({
            id: `binding:${member.id}`,
            memberId: member.id,
            category: 'members/models',
            label: 'Receiver binding',
            value:
              'The exact Agent, engine, model or Project binding is unavailable. No substitute was selected.',
            origin: 'unknown',
            state: 'unavailable',
            owner,
          });
          add({
            id: `tools:${member.id}`,
            memberId: member.id,
            category: 'tools/services',
            label: 'Tools and external services',
            value:
              'Exact receiver configuration unavailable; effective capabilities are unknown.',
            origin: 'unknown',
            state: 'unavailable',
            owner,
          });
        }
      } else {
        add({
          id: `tools:${member.id}`,
          memberId: member.id,
          category: 'tools/services',
          label: 'Tools and external services',
          value: 'Receiver binding missing; capabilities unavailable.',
          origin: 'unknown',
          state: 'unavailable',
          owner,
        });
      }
      add(workspace);
      add({
        id: `api:${member.id}`,
        memberId: member.id,
        category: 'members/models',
        label: 'API model connection',
        value:
          'Separate from the engine connection. Backing API selection, authentication and model entitlement were not inspected.',
        origin: 'unknown',
        state: 'unknown',
        owner: {
          label: 'Model connection settings',
          href: '/connections/models',
        },
      });
      add({
        id: `memory:${member.id}`,
        memberId: member.id,
        category: 'memory',
        label: 'Memory',
        value:
          'No bound Session or authorized continuity receipt; shared memory is unverified.',
        origin: 'unknown',
        state: 'unavailable',
        owner,
      });
    }
    for (const [id, category, value] of [
      [
        'routing',
        'routing/triggers',
        'Preset v1 declares no routing or trigger edges. Stationmaster grants no routing authority.',
      ],
      [
        'schedules',
        'schedules/webhooks',
        'No durable Ensemble binding or metadata-only schedule/webhook projection is available.',
      ],
      [
        'outputs',
        'output destinations',
        'No authored destination or bound Session/group output receipt is available.',
      ],
    ] as const)
      add({
        id,
        category,
        label: category,
        value,
        origin: 'unknown',
        state: 'unavailable',
        owner: presetOwner,
      });
    this.assertAuthority(request, principal);
    const finalAccess = await this.owners.inventory.resolveEnvironmentAccess({
      environment: { kind: 'current' },
      agent: agentId('station'),
    });
    if (
      access.environmentId !== finalAccess.environmentId ||
      (await loadEnsemblePreset(source.path)).sha256 !== source.sha256
    )
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
    try {
      fence();
    } catch {
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
    }
    this.assertAuthority(request, principal);
    return {
      version: 'station.ensemble.inspection/v1',
      source: {
        sha256: source.sha256,
        presetId: source.preset.id,
        name: label(source.preset.name),
        stationmaster: source.preset.stationmaster,
      },
      environmentId: access.environmentId,
      observedAt: new Date().toISOString(),
      facts,
      resolutions,
      limits:
        'Authentication, entitlement, execution limits and live group bindings are unverified.',
    };
  }
}
