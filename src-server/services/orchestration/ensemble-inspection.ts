import { createHash } from 'node:crypto';
import { BUILTIN_STATION_AGENT_MCP_SERVER_IDS } from '@kontourai/station-contracts/agent';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import {
  ENSEMBLE_INSPECTION_LIMITS,
  type EnsembleInspection,
  type EnsembleInspectionFact,
  type EnsembleInspectionInput,
  parseEnsemblePreset,
} from '@kontourai/station-contracts/ensemble';
import type {
  ExecutionResolutionReceipt,
  ExecutionTarget,
} from '@kontourai/station-contracts/execution-target';
import {
  BUILTIN_KNOWLEDGE_NAMESPACES,
  resolveKnowledgeNamespaceConfiguration,
} from '@kontourai/station-contracts/knowledge';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { surfaceDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import type { KnowledgeRootObservation } from '../../knowledge-store/knowledge-record-observation.js';
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
import { projectMcpServers } from '../projects/project-tools.js';
import { CliSessionGroupUnavailable } from './cli-session-group.js';
import { loadEnsemblePreset } from './ensemble-presets.js';
import type {
  EnsembleSessionAuthenticationObservation,
  EnsembleSessionAuthenticationObserver,
  EnsembleSessionGroupAuthenticationInput,
} from './ensemble-session-group-authentication.js';

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
      readProject?: (slug: string) => ProjectConfig;
      verifyAuthentication?: (
        input: EnsembleSessionGroupAuthenticationInput,
        principal: PrincipalRef,
        assertCurrent: () => void,
        onObservation: EnsembleSessionAuthenticationObserver,
      ) => Promise<void>;
      observeKnowledgeRoots?: () => KnowledgeRootObservation;
    },
  ) {}

  assertConfigurationAuthority(
    request: Request,
    principal: PrincipalRef,
  ): void {
    if (
      !this.personalRequest(request) ||
      !isOperatorInPersonNotAgent(request) ||
      principal.id !== LOCAL_OPERATOR_PRINCIPAL_ID ||
      !isRuntimeRequestPrincipalCurrent(request, this.owners.security)
    )
      throw new EnsembleInspectionRefusal(
        'ensemble_inspection_authority_required',
      );
  }

  assertAuthority(request: Request, principal: PrincipalRef): void {
    this.assertConfigurationAuthority(request, principal);
    if (!isBoundLocalGrantMintedOperator(request))
      throw new EnsembleInspectionRefusal(
        'ensemble_inspection_authority_required',
      );
  }

  async inspect(
    input: EnsembleInspectionInput,
    request: Request,
    principal: PrincipalRef,
    readGroup?: (groupId: string) => Promise<CliSessionGroupView>,
  ): Promise<EnsembleInspection> {
    input = structuredClone(input);
    if ((input.path === undefined) === (input.presetJson === undefined))
      throw new EnsembleInspectionRefusal('ensemble_inspection_invalid');
    const current = () => {
      request.signal.throwIfAborted();
      if (input.path !== undefined || input.verifyAuthentication)
        this.assertAuthority(request, principal);
      else this.assertConfigurationAuthority(request, principal);
    };
    current();
    if (
      input.groupId &&
      (!readGroup ||
        !input.expectedPresetHash ||
        Object.keys(input.bindings).length ||
        input.groupBindings ||
        input.verifyAuthentication)
    )
      throw new EnsembleInspectionRefusal('ensemble_inspection_invalid');
    const readRecordedGroup = async (groupId: string) => {
      try {
        return await readGroup!(groupId);
      } catch (error) {
        if (
          error instanceof CliSessionGroupUnavailable &&
          error.code === 'group_snapshot_changed'
        )
          throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
        throw error;
      }
    };
    const group = input.groupId
      ? structuredClone(await readRecordedGroup(input.groupId))
      : undefined;
    if (group && (!Number.isSafeInteger(group.revision) || group.revision < 0))
      throw new EnsembleInspectionRefusal('ensemble_inspection_unavailable');
    const groupSnapshot = JSON.stringify(group);
    current();
    const bindings = new Map(Object.entries(input.bindings));
    const source =
      input.path !== undefined
        ? await loadEnsemblePreset(input.path)
        : {
            preset: parseEnsemblePreset(input.presetJson ?? ''),
            sha256: `sha256:${createHash('sha256')
              .update(input.presetJson ?? '')
              .digest('hex')}`,
          };
    current();
    if (input.expectedPresetHash && input.expectedPresetHash !== source.sha256)
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
    if (
      [
        ...Object.keys(input.bindings),
        ...Object.keys(input.groupBindings ?? {}),
      ].some((id) => !source.preset.members.some((member) => member.id === id))
    )
      throw new EnsembleInspectionRefusal('ensemble_inspection_invalid');

    const recordedMembers = group?.preset?.members;
    if (group && !recordedMembers)
      throw new EnsembleInspectionRefusal('ensemble_inspection_unavailable');
    if (
      group &&
      (group.groupId !== input.groupId ||
        group.preset?.sha256 !== source.sha256 ||
        group.preset.presetId !== source.preset.id ||
        group.preset.stationmaster !== source.preset.stationmaster ||
        group.members.length !== source.preset.members.length ||
        recordedMembers?.length !== source.preset.members.length ||
        source.preset.members.some(
          (member) =>
            group.members.filter((seat) => seat.seatId === member.id).length !==
              1 ||
            recordedMembers?.filter(
              (seat) =>
                seat.seatId === member.id &&
                seat.codename === member.codename &&
                seat.color === member.color &&
                seat.role === member.role,
            ).length !== 1,
        ))
    )
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');

    const targets = new Map<string, ExecutionTarget>();
    for (const member of source.preset.members) {
      const binding = bindings.get(member.id);
      const selected =
        input.groupBindings?.[member.id]?.target ??
        (binding
          ? {
              agent: agentId(binding.agent),
              workspace: {
                kind: 'project' as const,
                projectSlug: binding.projectSlug,
              },
            }
          : undefined);
      if (!selected) continue;
      targets.set(member.id, {
        ...selected,
        environment: { kind: 'current' },
        model: {
          override: member.model,
          options: {
            ...member.options,
            ...(member.reasoning
              ? { [member.reasoning.option]: member.reasoning.value }
              : {}),
          },
        },
      });
      if (
        input.groupBindings?.[member.id]?.needs.some(
          (id) => !source.preset.members.some((member) => member.id === id),
        )
      )
        throw new EnsembleInspectionRefusal('ensemble_inspection_invalid');
    }
    const access = await this.owners.inventory.resolveEnvironmentAccess({
      environment: { kind: 'current' },
      agent: agentId('station'),
    });
    current();
    const fence = this.owners.inventory.capturePreparationFence?.([
      ...targets.values(),
    ]);
    if (!fence)
      throw new EnsembleInspectionRefusal('ensemble_inspection_unavailable');
    let knowledgeRoots: KnowledgeRootObservation | undefined;
    try {
      knowledgeRoots = this.owners.observeKnowledgeRoots?.();
    } catch {
      // An unavailable registry cannot establish an empty store inventory.
    }
    const projects = new Map<string, ProjectConfig>();
    const facts: EnsembleInspectionFact[] = [];
    const resolutions: EnsembleInspection['resolutions'][number][] = [];
    const draftReceipt = `draft:sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
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
      const target = targets.get(member.id);
      const owner = target
        ? {
            label: 'Agent settings',
            href: `/agents/${encodeURIComponent(typeof target.agent === 'string' ? target.agent : target.agent.agent)}`,
          }
        : memberOwner;
      let workspace: EnsembleInspectionFact = {
        id: `workspace:${member.id}`,
        memberId: member.id,
        category: 'workspace',
        label: 'Workspace',
        value: group
          ? 'Current receiver settings are not projected by recorded-group inspection; inspect a separate receiver draft.'
          : 'Select the receiver Agent and Project IDs to resolve this member.',
        origin: 'unknown',
        state: group ? 'unavailable' : 'missing',
        owner,
      };
      if (target) {
        try {
          const resolved = await resolveExecutionTarget(
            target,
            this.owners.inventory,
            { purpose: 'preparation' },
          );
          current();
          if (
            (resolved.provider === 'acp' &&
            resolved.engine.kind === 'connection'
              ? resolved.engine.connectionId
              : resolved.provider) !== member.engine ||
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
            value: `${resolved.workspace?.cwd ?? 'Unknown directory'}; ${binding ? 'expanded Project path configuration' : 'receiver workspace configuration'}, execution access unverified`,
            origin: 'authored',
            state: 'configured',
            owner: {
              ...(binding
                ? {
                    label: 'Project settings',
                    href: `/projects/${encodeURIComponent(binding.projectSlug)}/edit`,
                  }
                : { label: 'Group workspace draft' }),
              receipt: `resolution:${member.id}`,
            },
          };
          const spec = resolved.preparationDefinitions?.agent;
          const projectSlug =
            resolved.workspace?.kind === 'project'
              ? resolved.workspace.projectSlug
              : undefined;
          let project: ProjectConfig | undefined;
          if (projectSlug && this.owners.readProject) {
            project = projects.get(projectSlug);
            if (!project) {
              project = structuredClone(this.owners.readProject(projectSlug));
              projects.set(projectSlug, project);
            }
          }
          const directory = resolved.workspace?.kind === 'directory';
          const projectMode = project?.defaultWorkspaceIsolation;
          const knownIsolationOrigin = directory || project !== undefined;
          add({
            id: `isolation:${member.id}`,
            memberId: member.id,
            category: 'workspace',
            label: 'Workspace isolation',
            value: directory
              ? 'shared; explicit directory configuration. Runtime provisioning and filesystem isolation unverified.'
              : `${resolved.workspace?.kind === 'project' ? resolved.workspace.workspaceIsolation.mode : 'unknown'}; ${projectMode ? 'authored Project configuration' : project ? 'resolved Station/shared default configuration' : 'configuration origin unavailable'}. Runtime provisioning and filesystem isolation unverified.`,
            origin:
              directory || projectMode
                ? 'authored'
                : project
                  ? 'default'
                  : 'unknown',
            state: knownIsolationOrigin ? 'configured' : 'unknown',
            owner: {
              ...(directory
                ? { label: 'Group workspace draft' }
                : projectMode
                  ? {
                      label: 'Project settings',
                      href: `/projects/${encodeURIComponent(projectSlug ?? '')}/edit`,
                    }
                  : project
                    ? {
                        label: 'Station workspace settings',
                        href: '/settings?view=agent-runs&highlight=default-workspace-isolation',
                      }
                    : workspace.owner),
              receipt: `resolution:${member.id}`,
            },
          });
          const roots =
            knowledgeRoots?.roots.filter(
              (root) =>
                root.scope.kind === 'project' &&
                root.scope.projectSlug === projectSlug,
            ) ?? [];
          const declared = spec?.tools?.mcpServers ?? [];
          const projectServers = project
            ? projectMcpServers(project, roots.length > 0)
            : [];
          const ids = [...new Set([...declared, ...projectServers])];
          if (projectSlug) {
            const projectOwner = {
              label: 'Project knowledge and tool settings',
              href: `/projects/${encodeURIComponent(projectSlug)}/edit`,
              receipt: `resolution:${member.id}`,
            };
            add({
              id: `knowledge-policy:${member.id}`,
              memberId: member.id,
              category: 'tools/services',
              label: 'Project Knowledge tool default',
              value: project
                ? project.toolDefaults?.knowledge === false
                  ? 'Project-added Knowledge tools disabled; explicit Agent references retain their own policy.'
                  : 'Knowledge tools are added when a Project store is registered. Effective engine delivery and grants remain unverified.'
                : 'Project configuration observation unavailable.',
              origin: !project
                ? 'unknown'
                : project.toolDefaults?.knowledge === undefined
                  ? 'default'
                  : 'authored',
              state: project ? 'configured' : 'unavailable',
              owner: projectOwner,
            });
            const namespaces = project
              ? resolveKnowledgeNamespaceConfiguration(
                  project.knowledgeNamespaces,
                )
              : [];
            add({
              id: `knowledge-namespaces:${member.id}`,
              memberId: member.id,
              category: 'memory',
              label: 'Project knowledge namespaces',
              value: project
                ? `${namespaces.length} configured; showing at most ${ENSEMBLE_INSPECTION_LIMITS.knowledgeDetailsPerMember}. Configuration only; retrieval, injection and content availability are unverified.`
                : 'Project namespace configuration unavailable.',
              origin: 'unknown',
              state: project ? 'configured' : 'unavailable',
              owner: projectOwner,
            });
            for (const [index, namespace] of namespaces
              .slice(0, ENSEMBLE_INSPECTION_LIMITS.knowledgeDetailsPerMember)
              .entries())
              add({
                id: `namespace:${member.id}:${index}`,
                memberId: member.id,
                category: 'memory',
                label: label(namespace.label),
                value: `${label(namespace.id)} · ${namespace.behavior}; content and storage paths are not inspected.`,
                origin: BUILTIN_KNOWLEDGE_NAMESPACES.some(
                  (entry) => entry.id === namespace.id,
                )
                  ? 'default'
                  : 'authored',
                state: 'configured',
                owner: projectOwner,
              });
            add({
              id: `knowledge-roots:${member.id}`,
              memberId: member.id,
              category: 'memory',
              label: 'Registered Project knowledge stores',
              value: knowledgeRoots
                ? `${roots.length} registered; showing at most ${ENSEMBLE_INSPECTION_LIMITS.knowledgeDetailsPerMember}. Adapter availability, content and write authority are unverified.`
                : 'Registry observation unavailable; this is not an empty store inventory.',
              origin: 'runtime-derived',
              state: !knowledgeRoots
                ? 'unavailable'
                : roots.length
                  ? 'configured'
                  : 'missing',
              owner: projectOwner,
            });
            for (const [index, root] of roots
              .slice(0, ENSEMBLE_INSPECTION_LIMITS.knowledgeDetailsPerMember)
              .entries())
              add({
                id: `knowledge-root:${member.id}:${index}`,
                memberId: member.id,
                category: 'memory',
                label: label(root.displayName),
                value: `${label(root.id)} · ${label(root.adapterId)}; registered metadata only.`,
                origin: 'authored',
                state: 'configured',
                owner: projectOwner,
              });
          }
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
            const builtin = BUILTIN_STATION_AGENT_MCP_SERVER_IDS.some(
              (builtinId) => builtinId === id,
            );
            add({
              id: `tool:${member.id}:${id}`,
              memberId: member.id,
              category: 'tools/services',
              label: id,
              value: definition
                ? `${definition.kind} · ${definition.transport ?? 'built-in'} · ${definition.enabled === false ? 'disabled' : 'configured'}; definition currency, delivery and authorization unknown`
                : builtin
                  ? 'Built-in reference; runtime availability, delivery and authorization unknown.'
                  : 'Configured reference; definition unavailable.',
              origin:
                declared.includes(id) ||
                project?.toolDefaults?.mcpServers?.includes(id)
                  ? 'authored'
                  : 'default',
              state: !definition
                ? builtin
                  ? 'unknown'
                  : 'missing'
                : definition.enabled === false
                  ? 'unavailable'
                  : 'unknown',
              owner: {
                label: declared.includes(id)
                  ? 'Agent tool connection settings'
                  : 'Project tool connection settings',
                href: declared.includes(id)
                  ? `/connections/tools/${encodeURIComponent(id)}`
                  : `/projects/${encodeURIComponent(projectSlug ?? '')}/edit`,
              },
            });
          }
          add({
            id: `tools:${member.id}`,
            memberId: member.id,
            category: 'tools/services',
            label: 'Tool policy',
            value: `Observed Agent and Project MCP references: ${ids.length}. Showing at most ${ENSEMBLE_INSPECTION_LIMITS.toolsPerMember}. Harness tools, effective grants and external service access are unknown; unavailable Project/store observations may hide additional defaults.`,
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
          value: group
            ? 'Current receiver tool settings are not projected by recorded-group inspection; inspect a separate receiver draft. Effective capabilities remain unverified.'
            : 'Receiver binding missing; capabilities unavailable.',
          origin: 'unknown',
          state: 'unavailable',
          owner,
        });
      }
      const groupBinding = input.groupBindings?.[member.id];
      if (groupBinding)
        add({
          id: `needs:${member.id}`,
          memberId: member.id,
          needs: groupBinding.needs,
          category: 'routing/triggers',
          label: 'Declared prerequisites',
          value: groupBinding.needs.length
            ? `${groupBinding.needs.join(', ')} → ${member.id}`
            : 'No prerequisites; eligible at group start subject to admission.',
          origin: 'authored',
          state: 'configured',
          owner: { label: 'Group dependency draft', receipt: draftReceipt },
        });
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
      if (!group)
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
    if (group) {
      const owner = {
        label: 'Recorded Session group snapshot',
        receipt: `group:${group.groupId}:${group.revision}`,
      };
      for (const seat of group.members) {
        const memberOwner = seat.handle
          ? {
              ...owner,
              href: surfaceDeepLink({
                surfaceId: 'activity',
                sessionId: seat.handle.sessionId,
              }),
            }
          : owner;
        add({
          id: `needs:${seat.seatId}`,
          memberId: seat.seatId,
          needs: seat.needs,
          category: 'routing/triggers',
          label: 'Recorded prerequisites',
          value: JSON.stringify(seat.needs),
          origin: 'authored',
          state: 'configured',
          owner,
        });
        add({
          id: `outputs:${seat.seatId}`,
          memberId: seat.seatId,
          category: 'output destinations',
          label: 'Recorded Session and output references',
          value: JSON.stringify({
            state: seat.state,
            ...(seat.handle ? { handle: seat.handle } : {}),
            ...(seat.reservedSessionId
              ? { reservedSessionId: seat.reservedSessionId }
              : {}),
            ...(seat.initialClientTurnId
              ? { initialClientTurnId: seat.initialClientTurnId }
              : {}),
            ...(seat.terminalEvent
              ? { terminalEvent: seat.terminalEvent }
              : {}),
            observation: seat.handle
              ? 'Recorded references; availability and acceptance unverified.'
              : seat.state === 'launch-intent' || seat.reservedSessionId
                ? 'Launch outcome indeterminate; reservation is not a confirmed Session.'
                : 'No confirmed Session reference recorded.',
          }),
          origin: 'runtime-derived',
          state: seat.handle ? 'configured' : 'unknown',
          owner: memberOwner,
        });
        const sync = group.contextSync;
        const receipt = sync?.members.find(
          (entry) => entry.seatId === seat.seatId,
        );
        add({
          id: `memory:${seat.seatId}`,
          memberId: seat.seatId,
          category: 'memory',
          label: 'Recorded context-sync attempt/status',
          value:
            receipt && sync
              ? JSON.stringify({
                  operationId: sync.operationId,
                  runId: sync.runId,
                  contentHash: sync.contentHash,
                  timestamp: sync.timestamp,
                  status: sync.status,
                  member: receipt,
                  limits:
                    'Recorded context-sync metadata only; native/shared memory, acceptance and grants unverified.',
                })
              : 'No recorded context receipt; native/shared memory unverified.',
          origin: receipt ? 'runtime-derived' : 'unknown',
          state:
            !receipt || receipt.status === 'failed'
              ? 'unavailable'
              : receipt.status === 'acknowledged' &&
                  receipt.turnId &&
                  receipt.terminalEventId &&
                  receipt.nativeIdentityHash &&
                  receipt.toolCalls === 0
                ? 'configured'
                : 'unknown',
          owner: memberOwner,
        });
      }
      add({
        id: 'group-flow',
        category: 'routing/triggers',
        label: 'Recorded Flow reference',
        value: group.flow
          ? JSON.stringify(group.flow)
          : 'No Flow reference recorded; portable lineage remains unbound.',
        origin: 'runtime-derived',
        state: group.flow ? 'configured' : 'unavailable',
        owner,
      });
    }
    let localOperator = true;
    try {
      this.assertAuthority(request, principal);
    } catch {
      localOperator = false;
    }
    const supported = source.preset.members.every((member) => {
      const resolution = resolutions.find(
        (item) => item.memberId === member.id,
      )?.receipt;
      const workspace = resolution?.workspace;
      return (
        targets.has(member.id) &&
        resolution?.engine.kind === 'connection' &&
        Boolean(
          this.owners.inventory.getProviderAdapter(resolution.provider)
            ?.observeExecutionAuthentication,
        ) &&
        workspace !== undefined &&
        (workspace.kind === 'directory' ||
          workspace.workspaceIsolation.mode === 'shared') &&
        !facts.some((fact) => fact.id === `binding:${member.id}`)
      );
    });
    const canCheckAuthentication =
      Boolean(this.owners.verifyAuthentication) && localOperator && supported;
    const authenticationCheck: NonNullable<
      EnsembleInspection['authenticationCheck']
    > = canCheckAuthentication
      ? { state: 'available' }
      : {
          state: 'unavailable',
          detail: !localOperator
            ? 'Engine sign-in checks require current local operator access.'
            : 'Choose every receiver with a supported native engine and shared workspace before checking sign-in.',
        };
    const observations = new Map<
      string,
      EnsembleSessionAuthenticationObservation
    >();
    const authenticationCurrency: Array<() => void> = [];
    let authenticationSucceeded = false;
    if (input.verifyAuthentication && canCheckAuthentication) {
      try {
        await this.owners.verifyAuthentication?.(
          {
            groupId: `inspection:${source.preset.id}`,
            intentDigest: createHash('sha256')
              .update(JSON.stringify([source.sha256, [...targets]]))
              .digest('hex'),
            members: [...targets].map(([seatId, target]) => ({
              seatId,
              target,
            })),
            signal: request.signal,
          },
          principal,
          current,
          (observation, assertObservedCurrent) => {
            observations.set(observation.seatId, observation);
            authenticationCurrency.push(assertObservedCurrent);
          },
        );
        authenticationSucceeded = true;
      } catch (error) {
        current();
        fence();
        if (
          error instanceof CliSessionGroupUnavailable &&
          error.code === 'ensemble_auth_stale'
        )
          throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
      }
      current();
      fence();
    }
    for (const member of source.preset.members) {
      const observation = observations.get(member.id);
      const checkedAt = observation?.checkedAt;
      const signedIn =
        authenticationSucceeded &&
        observation?.state === 'authenticated' &&
        checkedAt !== undefined &&
        checkedAt <= Date.now() &&
        Date.now() - checkedAt < 30_000;
      const signedOut = observation?.state === 'unauthenticated';
      add({
        id: `authentication:${member.id}`,
        memberId: member.id,
        category: 'members/models',
        label: 'Engine sign-in',
        value: signedIn
          ? `Signed in when checked at ${new Date(checkedAt).toISOString()}. Sign-in is checked again before launch.`
          : signedOut
            ? 'Not signed in to the selected engine context.'
            : input.verifyAuthentication
              ? 'Sign-in could not be verified in the selected execution context.'
              : 'Not checked.',
        origin: observation ? 'runtime-derived' : 'unknown',
        state: signedIn ? 'configured' : signedOut ? 'unavailable' : 'unknown',
        owner: {
          label: 'Engine connection settings',
          href: '/connections/engines',
        },
      });
    }
    for (const [id, category, value] of [
      [
        'routing',
        'routing/triggers',
        input.groupBindings
          ? 'Member prerequisites are declared in this group draft. Stationmaster grants no routing authority; additional triggers and routes are not declared.'
          : 'Preset v1 declares no routing or trigger edges. Stationmaster grants no routing authority.',
      ],
      [
        'schedules',
        'schedules/webhooks',
        group
          ? 'Schedule/webhook projection unavailable; recorded group references grant no automation authority.'
          : 'No durable Ensemble binding or metadata-only schedule/webhook projection is available.',
      ],
      [
        'outputs',
        'output destinations',
        'No authored destination or bound Session/group output receipt is available.',
      ],
    ] as const)
      if (!(group && (id === 'routing' || id === 'outputs')))
        add({
          id,
          category,
          label: category,
          value,
          origin: 'unknown',
          state: 'unavailable',
          owner: presetOwner,
        });
    current();
    const finalAccess = await this.owners.inventory.resolveEnvironmentAccess({
      environment: { kind: 'current' },
      agent: agentId('station'),
    });
    if (
      access.environmentId !== finalAccess.environmentId ||
      (input.path !== undefined &&
        (await loadEnsemblePreset(input.path)).sha256 !== source.sha256)
    )
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
    try {
      fence();
    } catch {
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
    }
    current();
    for (const assertObservedCurrent of authenticationCurrency) {
      try {
        assertObservedCurrent();
      } catch {
        current();
        throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
      }
    }
    if (
      group &&
      JSON.stringify(await readRecordedGroup(group.groupId)) !== groupSnapshot
    )
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
    current();
    try {
      if ('assertCurrent' in source) source.assertCurrent();
      if (
        knowledgeRoots &&
        this.owners.observeKnowledgeRoots?.().digest !== knowledgeRoots.digest
      )
        throw new Error('Knowledge registry changed');
      fence();
    } catch {
      throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
    }
    return {
      groupInspection: group
        ? { state: 'bound', groupId: group.groupId, revision: group.revision }
        : readGroup
          ? { state: 'available' }
          : {
              state: 'unavailable',
              detail: 'Recorded group inspection is unavailable on this host.',
            },
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
      authenticationCheck,
      limits: group
        ? 'Recorded group references only; output availability, acceptance, native/shared memory, authentication, entitlement and execution limits are unverified.'
        : input.verifyAuthentication
          ? 'Engine sign-in checks grant no execution authority; model entitlement, execution limits and live group bindings are unverified.'
          : 'Authentication, entitlement, execution limits and live group bindings are unverified.',
    };
  }
}
