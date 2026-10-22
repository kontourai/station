import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  executionBindingAgentId,
  executionProfileAgentId,
} from '@kontourai/station-contracts/execution-target';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { EngineId } from '@kontourai/station-contracts/provider';
import type { ProviderExecutionAuthObservation } from '../../providers/adapter-shape.js';
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
import {
  loadEnsemblePreset,
  type PrepareEnsembleInput,
  prepareEnsemble,
} from './ensemble-presets.js';

/** Non-probing composition: configuration is not evidence of readiness. */
export function createLocalEnsembleInventory(owners: {
  environmentId: () => string;
  captureAgentConfigurationFence: (ids: readonly string[]) => () => void;
  getProjectRevision: (slug: string) => {
    value: unknown;
    assertCurrent?: () => void;
  };
  getProviderRevision: () => number;
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
  getConfiguredAcpConnection?: (
    id: string,
  ) => Promise<{ id: string; name: string; enabled: boolean } | undefined>;
}): ExecutionTargetResolverDependencies {
  return {
    capturePreparationFence: (targets) => {
      const ids = targets.flatMap((target) => [
        executionProfileAgentId(target.agent),
        executionBindingAgentId(target.agent),
      ]);
      const agents = owners.captureAgentConfigurationFence(ids);
      const projects = [
        ...new Set(
          targets
            .map((target) =>
              target.workspace?.kind === 'project'
                ? target.workspace.projectSlug
                : undefined,
            )
            .filter((slug): slug is string => slug !== undefined),
        ),
      ].map((slug) => owners.getProjectRevision(slug));
      for (const project of projects)
        if (!project.assertCurrent)
          throw new Error('Project preparation fence unavailable');
      const providers = owners.getProviderRevision();
      const adapters = ['codex', 'claude'].map((id) => ({
        id,
        adapter: owners.getProviderAdapter(id),
        metadata: JSON.stringify(owners.getProviderAdapter(id)?.metadata),
      }));
      const environment = owners.environmentId();
      // query() stamps this telemetry version after the native login observation.
      const ambient = () =>
        JSON.stringify(
          Object.entries(process.env)
            .filter(([key]) => key !== 'CLAUDE_AGENT_SDK_VERSION')
            .sort(),
        );
      const capturedAmbient = ambient();
      return () => {
        agents();
        for (const project of projects) project.assertCurrent?.();
        if (
          owners.getProviderRevision() !== providers ||
          owners.environmentId() !== environment ||
          ambient() !== capturedAmbient ||
          adapters.some(
            (entry) =>
              owners.getProviderAdapter(entry.id) !== entry.adapter ||
              JSON.stringify(entry.adapter?.metadata) !== entry.metadata,
          )
        )
          throw new Error('Preparation runtime configuration changed');
      };
    },
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
    getAgent: async (_access, id) => ({
      slug: id,
      ...(await owners.getAgent(id)),
    }),
    getConnection: async (_access, id) => {
      const identity = (await owners.listEngineConnectionIdentities()).find(
        (entry) => entry.id === id,
      );
      const adapter = identity && owners.getProviderAdapter(identity.engineId);
      if (identity?.type === 'acp' && adapter) {
        const connection = await owners.getConfiguredAcpConnection?.(id);
        if (!connection || connection.id !== id)
          throw new EnsemblePreparationRefusal(
            'ensemble_auth_unsupported',
            'Configured engine unavailable.',
          );
        return {
          id,
          name: connection.name,
          kind: 'agent',
          type: 'acp',
          enabled: connection.enabled,
          status: 'unknown',
          capabilities: [...adapter.metadata.capabilities],
          config: { provider: 'acp' },
          prerequisites: [],
        };
      }
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
        !isBoundLocalGrantMintedOperator(request) ||
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
    const capture = this.owners.inventory.capturePreparationFence;
    if (!capture)
      throw new EnsemblePreparationRefusal(
        'ensemble_auth_unsupported',
        'Configuration currency cannot be established.',
      );
    const configurationCurrent = capture(Object.values(input.bindings));
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
          const comparable = (
            receipt: typeof resolved.receipt,
            definitions: typeof resolved.preparationDefinitions,
          ) => {
            const { resolvedAt: _at, ...binding } = receipt;
            return JSON.stringify({ binding, definitions });
          };
          if (
            !resolved.preparationDefinitions ||
            comparable(resolved.receipt, resolved.preparationDefinitions) !==
              comparable(selection.resolution, selection.definitions)
          )
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
          const credentialProfileRef =
            resolved.preparationDefinitions.executionAgent.execution
              ?.credentialProfileRef;
          const assertCurrent = async () => {
            assertAuthority();
            const current = await resolveExecutionTarget(
              selection.target,
              this.owners.inventory,
              { purpose: 'preparation' },
            );
            const currentDirectory = await stat(workspace.cwd);
            if (
              directory.dev !== currentDirectory.dev ||
              directory.ino !== currentDirectory.ino ||
              comparable(current.receipt, current.preparationDefinitions) !==
                comparable(resolved.receipt, resolved.preparationDefinitions) ||
              (await realpath(workspace.cwd)) !== workspace.cwd ||
              (await loadEnsemblePreset(source.path)).sha256 !== source.sha256
            )
              throw new EnsemblePreparationRefusal(
                'ensemble_context_changed',
                'Ensemble execution binding changed.',
              );
            return () => {
              try {
                configurationCurrent();
              } catch {
                throw new EnsemblePreparationRefusal(
                  'ensemble_context_changed',
                  'Ensemble configuration changed during preparation.',
                );
              }
              assertAuthority();
            };
          };
          (await assertCurrent())();
          const probeStartedAt = Date.now();
          const observation = await adapter.observeExecutionAuthentication({
            principalId: principal.id,
            bindingHash: createHash('sha256')
              .update(
                comparable(resolved.receipt, resolved.preparationDefinitions),
              )
              .digest('hex'),
            connectionId: resolved.engine.connectionId,
            cwd: workspace.cwd,
            model: selection.member.model,
            modelOptions: selection.target.model?.options ?? {},
            ...(credentialProfileRef !== undefined
              ? { credentialProfileRef }
              : {}),
            assertCurrent,
          });
          (await assertCurrent())();
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
