import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { EngineId } from '@kontourai/station-contracts/provider';
import type { ProviderExecutionAuthObservation } from '../../providers/adapter-shape.js';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import {
  type ExecutionTargetResolverDependencies,
  resolveExecutionTarget,
} from '../execution-target/execution-target-resolver.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';
import {
  loadEnsemblePreset,
  type PrepareEnsembleInput,
  prepareEnsemble,
} from './ensemble-presets.js';

/** Non-probing composition: configuration is not evidence of readiness. */
export function createLocalEnsembleInventory(owners: {
  environmentId: () => string;
  getAgent: (
    id: string,
  ) => ReturnType<ExecutionTargetResolverDependencies['getAgent']>;
  listEngineConnectionIdentities: () => Promise<
    Array<{ id: EngineConnectionId; engineId: EngineId; type: string }>
  >;
  loadAppConfig: () => Promise<AppConfig>;
  getProject: (
    slug: string,
  ) => Awaited<ReturnType<ExecutionTargetResolverDependencies['getProject']>>;
  getProviderAdapter: ExecutionTargetResolverDependencies['getProviderAdapter'];
}): ExecutionTargetResolverDependencies {
  return {
    resolveEnvironmentAccess: async (target) => {
      if (target.environment.kind !== 'current')
        throw new EnsemblePreparationRefusal(
          'ensemble_environment_unsupported',
          'Preparation is local only.',
        );
      return {
        kind: 'current',
        environmentId: owners.environmentId(),
        environmentName: 'This Station',
        apiBase: '',
      };
    },
    getAgent: (_access, id) => owners.getAgent(id),
    getConnection: async (_access, id) => {
      const identity = (await owners.listEngineConnectionIdentities()).find(
        (entry) => entry.id === id,
      );
      const adapter = identity && owners.getProviderAdapter(identity.engineId);
      if (!identity || !adapter || adapter.metadata.connectionId !== id)
        throw new EnsemblePreparationRefusal(
          'ensemble_auth_unsupported',
          'The configured engine has no supported authentication probe.',
        );
      const settings = (await owners.loadAppConfig()).agentConnections?.[
        identity.engineId
      ];
      return {
        id,
        name: adapter.metadata.displayName,
        kind: 'agent',
        type: identity.type,
        enabled: settings?.enabled ?? true,
        status: 'unknown',
        capabilities: [...adapter.metadata.capabilities],
        config: { provider: identity.engineId },
        prerequisites: [],
      };
    },
    getProject: async (_access, slug) => owners.getProject(slug),
    getStationDefaultWorkspaceIsolation: async () =>
      (await owners.loadAppConfig()).defaultWorkspaceIsolation,
    getProviderAdapter: owners.getProviderAdapter,
  };
}

export class EnsemblePreparationRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly observation?: ProviderExecutionAuthObservation,
  ) {
    super(message);
    this.name = 'EnsemblePreparationRefusal';
  }
}

export type LocalEnsemblePreparationInput = Omit<
  PrepareEnsembleInput,
  'contextKey'
>;

/** Preparation is deliberately unable to create a session or invoke a provider turn. */
export class EnsembleExecutionContext {
  private readonly personalRequest = createPersonalRuntimeRequestGuard();

  constructor(
    private readonly owners: {
      inventory: ExecutionTargetResolverDependencies;
      security: CurrentRuntimeRequestPrincipalSecurity;
    },
  ) {}

  async prepare(
    input: LocalEnsemblePreparationInput,
    request: Request,
    principal: PrincipalRef,
  ) {
    input = structuredClone(input);
    const assertAuthority = () => {
      if (
        !this.personalRequest(request) ||
        !isOperatorInPersonNotAgent(request) ||
        principal.id !== LOCAL_OPERATOR_PRINCIPAL_ID ||
        !isRuntimeRequestPrincipalCurrent(request, this.owners.security)
      ) {
        throw new EnsemblePreparationRefusal(
          'ensemble_preparation_authority_required',
          'Ensemble preparation requires the current local operator on a personal Station.',
        );
      }
    };
    assertAuthority();
    const source = await loadEnsemblePreset(input.path);
    if (source.sha256 !== input.expectedPresetHash)
      throw new EnsemblePreparationRefusal(
        'ensemble_preset_stale',
        'Ensemble preset bytes changed.',
      );
    if (
      source.preset.members.some(
        (member) => member.reasoning || Object.keys(member.options).length,
      )
    )
      throw new EnsemblePreparationRefusal(
        'ensemble_model_options_unverified',
        'Model options require catalog validation; preparation cannot start a discovery process.',
      );
    if (
      source.preset.members.some(
        (member) => member.engine !== 'codex' && member.engine !== 'claude',
      )
    )
      throw new EnsemblePreparationRefusal(
        'ensemble_auth_unsupported',
        'This engine has no supported actual-context authentication probe.',
      );
    const contextKey = `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          principal: principal.id,
          preset: input.expectedPresetHash,
          bindings: input.bindings,
        }),
      )
      .digest('hex')}`;
    return prepareEnsemble(
      { ...input, contextKey },
      {
        inventory: this.owners.inventory,
        resolutionPurpose: 'preparation',
        now: Date.now,
        authenticateMember: async (selection) => {
          assertAuthority();
          const resolved = await resolveExecutionTarget(
            selection.target,
            this.owners.inventory,
            { purpose: 'preparation' },
          );
          const comparable = ({
            resolvedAt: _at,
            ...receipt
          }: typeof resolved.receipt) => JSON.stringify(receipt);
          if (comparable(resolved.receipt) !== comparable(selection.resolution))
            throw new EnsemblePreparationRefusal(
              'ensemble_context_changed',
              'Ensemble execution binding changed.',
            );
          const workspace = resolved.workspace;
          if (
            resolved.access.kind !== 'current' ||
            selection.target.environment.kind !== 'current' ||
            workspace?.kind !== 'project' ||
            workspace.workspaceIsolation?.mode !== 'shared' ||
            (await realpath(workspace.cwd)) !== workspace.cwd
          )
            throw new EnsemblePreparationRefusal(
              'ensemble_workspace_unsupported',
              'Ensemble preparation requires a shared canonical Project folder on this Station.',
            );
          if (resolved.engine.kind !== 'connection')
            throw new EnsemblePreparationRefusal(
              'ensemble_auth_unsupported',
              'This engine has no supported actual-context authentication probe.',
            );
          const directory = await stat(workspace.cwd);
          if (!directory.isDirectory())
            throw new EnsemblePreparationRefusal(
              'ensemble_workspace_unsupported',
              'Preparation requires a Project folder.',
            );
          const adapter = this.owners.inventory.getProviderAdapter(
            resolved.provider,
          );
          if (
            !adapter?.observeExecutionAuthentication ||
            adapter.metadata.connectionId !== resolved.engine.connectionId
          )
            throw new EnsemblePreparationRefusal(
              'ensemble_auth_unsupported',
              'This engine has no supported actual-context authentication probe.',
            );
          const executionAgent = await this.owners.inventory.getAgent(
            resolved.access,
            resolved.executionAgentId ?? resolved.agentId,
          );
          const credentialProfileRef =
            executionAgent.execution?.credentialProfileRef;
          assertAuthority();
          const probeStartedAt = Date.now();
          const observation = await adapter.observeExecutionAuthentication({
            principalId: principal.id,
            connectionId: resolved.engine.connectionId,
            cwd: workspace.cwd,
            model: selection.member.model,
            modelOptions: selection.target.model?.options ?? {},
            ...(credentialProfileRef !== undefined
              ? { credentialProfileRef }
              : {}),
          });
          assertAuthority();
          const current = await resolveExecutionTarget(
            selection.target,
            this.owners.inventory,
            { purpose: 'preparation' },
          );
          const currentAgent = await this.owners.inventory.getAgent(
            current.access,
            current.executionAgentId ?? current.agentId,
          );
          const currentDirectory = await stat(workspace.cwd);
          assertAuthority();
          if (
            directory.dev !== currentDirectory.dev ||
            directory.ino !== currentDirectory.ino ||
            currentAgent.execution?.credentialProfileRef !==
              credentialProfileRef ||
            comparable(current.receipt) !== comparable(resolved.receipt) ||
            (await realpath(workspace.cwd)) !== workspace.cwd ||
            (await loadEnsemblePreset(source.path)).sha256 !== source.sha256
          )
            throw new EnsemblePreparationRefusal(
              'ensemble_context_changed',
              'Ensemble execution binding changed.',
            );
          if (
            observation.state !== 'authenticated' ||
            !Number.isFinite(observation.checkedAt) ||
            observation.checkedAt < probeStartedAt ||
            observation.checkedAt > Date.now() ||
            Date.now() - observation.checkedAt > 30_000
          )
            throw new EnsemblePreparationRefusal(
              'ensemble_auth_unverified',
              'The selected execution context did not establish a current login.',
              observation,
            );
          // Login status proves neither access to this model nor a native output bound.
          throw new EnsemblePreparationRefusal(
            'ensemble_execution_guarantees_unavailable',
            'Login was observed. Selected-model entitlement is not checked and native output-token bounding is unavailable; bounded-group preparation is refused.',
            observation,
          );
        },
      },
    );
  }
}
