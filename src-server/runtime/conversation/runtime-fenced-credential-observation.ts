import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '@kontourai/relay';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import type { CurrentRuntimeRequestPrincipalSecurity } from '../../security/runtime-request-security.js';
import type { AgentService } from '../../services/agents/agent-service.js';
import {
  readStationControlSourceCredentialAuthority,
  type StationControlSourceCredentialAuthority,
} from '../../services/orchestration/delegation-group-source-admission.js';
import type {
  CanonicalLocalGrantOrigin,
  EnvironmentSecurityService,
} from '../../services/ssh/environment-security-service.js';
import { resolveManagedModelIdentity } from '../plugins/runtime-provider-resolution.js';
import type { RuntimeContext } from '../types.js';
import {
  captureEnvironmentLocalGrantObservationOwner,
  type LocalGrantObservationAdmission,
} from './local-grant-observation-owner.js';
import {
  type ObservedSdkProviderCredential,
  type ProviderCredentialObservation,
  ProviderCredentialObservationStore,
  readObservedSdkProviderCredential,
} from './provider-credential-observation.js';

export interface RuntimeFencedCredentialObservationOwners {
  configLoader: ConfigLoader;
  agentService: AgentService;
  storageAdapter: FileStorageAdapter;
  environmentSecurityService: EnvironmentSecurityService;
  requestSecurity: CurrentRuntimeRequestPrincipalSecurity;
  canonicalLocalGrantOrigin?: CanonicalLocalGrantOrigin;
  runtime: Pick<
    RuntimeContext,
    'getAgentConfigurationRevision' | 'commitAgentConfigurationRead'
  >;
}
export type RuntimeFencedCredentialObservationInput = Readonly<{
  /** Actual server-resolved participating/profile/binding agent IDs. */
  agentIds: readonly string[];
  operation:
    | Readonly<{ kind: 'capture'; connectionId: string; lifetimeMs?: number }>
    | Readonly<{ kind: 'revalidate'; observationId: string }>;
}>;
export class RuntimeCredentialObservationUnavailable extends Error {
  readonly code = 'credential_observation_unavailable';
  constructor() {
    super('Credential source observation is unavailable.');
    this.name = 'RuntimeCredentialObservationUnavailable';
  }
}
function refuse(): never {
  throw new RuntimeCredentialObservationUnavailable();
}
function text(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1024 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Refuse control bytes in private observation identifiers.
    /[\u0000-\u001f]/u.test(value)
  )
    refuse();
  return value;
}
function snapshot(
  input: RuntimeFencedCredentialObservationInput,
): RuntimeFencedCredentialObservationInput {
  const copy = structuredClone(input);
  if (
    Object.keys(copy).sort().join(',') !== 'agentIds,operation' ||
    !Array.isArray(copy.agentIds) ||
    copy.agentIds.length < 1 ||
    copy.agentIds.length > 32
  )
    refuse();
  const ids = [...new Set(copy.agentIds.map(text))].sort();
  const operation = copy.operation;
  if (operation.kind === 'capture') {
    if (
      Object.keys(operation).some(
        (key) => !['kind', 'connectionId', 'lifetimeMs'].includes(key),
      )
    )
      refuse();
    text(operation.connectionId);
    if (
      operation.lifetimeMs !== undefined &&
      (!Number.isSafeInteger(operation.lifetimeMs) ||
        operation.lifetimeMs < 1 ||
        operation.lifetimeMs > 3600000)
    )
      refuse();
  } else if (operation.kind === 'revalidate') {
    if (Object.keys(operation).sort().join(',') !== 'kind,observationId')
      refuse();
    text(operation.observationId);
  } else refuse();
  return Object.freeze({
    agentIds: Object.freeze(ids),
    operation: Object.freeze(operation),
  });
}

/** One server-composed instance per boot/home. Its private store retains original
 * preparation fences across requests. A new boot owner cannot revive historical
 * runtime evidence from a durable source record; a fresh preparation is required.
 * Home identity comes from the actual source owners.
 */
export class RuntimeFencedCredentialObservationOwner {
  readonly #owners: Readonly<RuntimeFencedCredentialObservationOwners>;
  readonly #store: ProviderCredentialObservationStore;
  readonly #authorities = new WeakMap<
    Request,
    Awaited<ReturnType<typeof captureEnvironmentLocalGrantObservationOwner>>
  >();
  readonly #known = new Map<string, string>();
  #captureAttempts = 0;
  #scope: { configuration: () => void; runtime: () => void } | undefined;

  constructor(owners: RuntimeFencedCredentialObservationOwners) {
    this.#owners = Object.freeze({ ...owners });
    try {
      this.#requireSameHome();
    } catch {
      refuse();
    }
    this.#store = new ProviderCredentialObservationStore(
      owners.configLoader.getProjectHomeDir(),
      {
        adapter: owners.storageAdapter,
        authority: {
          withObservationScope: <T>(request: Request, check: () => T): T => {
            const authority = this.#authorities.get(request);
            if (!authority) refuse();
            return authority.withObservationScope(request, check);
          },
          requireCurrentLocalGrant: (request) => {
            const authority = this.#authorities.get(request);
            if (!authority) refuse();
            return authority.requireCurrentLocalGrant(request);
          },
        },
        captureConfigurationFence: () => {
          if (!this.#scope) refuse();
          return this.#scope.configuration;
        },
        captureRuntimeFence: () => {
          if (!this.#scope) refuse();
          return this.#scope.runtime;
        },
      },
    );
  }

  #requireSameHome(): void {
    const owners = this.#owners;
    const home = realpathSync(resolve(owners.configLoader.getProjectHomeDir()));
    if (
      realpathSync(resolve(owners.storageAdapter.getProjectHomeDir())) !==
        home ||
      realpathSync(
        resolve(owners.environmentSecurityService.getProjectHomeDir()),
      ) !== home ||
      realpathSync(resolve(owners.agentService.getProjectHomeDir())) !== home
    )
      refuse();
  }

  /** Select the participating Station Agent's actual managed binding. No caller
   * model/connection/key or implicit engine conversion is accepted here. */
  async captureAgentSdkCredential(
    request: Request,
    agentId: string,
    sessionCapability?: StationControlSourceCredentialAuthority,
    admit?: LocalGrantObservationAdmission,
  ): Promise<
    Readonly<{
      agentId: string;
      provider: 'anthropic' | 'google';
      modelId: string;
      instructions: string;
      credential: ObservedSdkProviderCredential;
    }>
  > {
    const owners = this.#owners;
    const id = text(agentId);
    const revision = owners.runtime.getAgentConfigurationRevision();
    const configuration =
      owners.configLoader.capturePreparationConfigurationFence([id]);
    const runtime = owners.agentService.capturePreparationConfigurationFence(
      [id],
      () => owners.runtime.getAgentConfigurationRevision(),
    );
    const session = sessionCapability
      ? readStationControlSourceCredentialAuthority(sessionCapability, request)
      : undefined;
    session?.assertMayCapture();
    if (session && session.agentId !== id) refuse();
    const authority = session
      ? undefined
      : await captureEnvironmentLocalGrantObservationOwner(
          request,
          owners.environmentSecurityService,
          owners.requestSecurity,
          admit,
          owners.canonicalLocalGrantOrigin,
        );
    const assertCurrent = () => {
      if (
        revision === null ||
        request.signal.aborted ||
        owners.runtime.getAgentConfigurationRevision() !== revision
      )
        refuse();
      this.#requireSameHome();
      configuration();
      runtime();
      if (session) session.assertCurrent();
      else authority!.requireCurrentLocalGrant(request).assertCurrent();
    };
    if (admit) await admit(assertCurrent);
    else assertCurrent();
    const spec = await owners.agentService.getAgent(id);
    if (admit) await admit(assertCurrent);
    else assertCurrent();
    if (session && spec.project !== session.projectSlug) refuse();
    if (spec.execution?.agentConnectionId) refuse();
    const appConfig = await owners.configLoader.loadAppConfig();
    if (admit) await admit(assertCurrent);
    else assertCurrent();
    const connections = owners.storageAdapter.listProviderConnections();
    const inventory = canonicalJson(connections);
    const binding = resolveManagedModelIdentity(spec, {
      appConfig,
      listProviderConnections: () => connections,
    });
    const provider = binding.providerType;
    if (provider !== 'anthropic' && provider !== 'google') refuse();
    const credential = await this.captureSdkCredential(
      request,
      {
        agentIds: [id],
        connectionId: binding.providerConnection.id,
        provider,
      },
      sessionCapability,
      admit,
    );
    if (admit) await admit(assertCurrent);
    else assertCurrent();
    if (
      canonicalJson(owners.storageAdapter.listProviderConnections()) !==
      inventory
    )
      refuse();
    if (admit)
      await admit(() =>
        readObservedSdkProviderCredential(credential, provider, request),
      );
    else readObservedSdkProviderCredential(credential, provider, request);
    return Object.freeze({
      agentId: id,
      provider,
      modelId: binding.modelId,
      instructions: spec.prompt,
      credential,
    });
  }

  /** Private SDK handoff under the actual boot/configuration read lease. The
   * returned capability retains these fences; it never exposes a wire DTO/key. */
  async captureSdkCredential(
    request: Request,
    input: Readonly<{
      agentIds: readonly string[];
      connectionId: string;
      provider: 'anthropic' | 'google';
      lifetimeMs?: number;
    }>,
    sessionCapability?: StationControlSourceCredentialAuthority,
    admit?: LocalGrantObservationAdmission,
  ): Promise<ObservedSdkProviderCredential> {
    const owners = this.#owners;
    const provider = input.provider;
    const selected = snapshot({
      agentIds: input.agentIds,
      operation: {
        kind: 'capture',
        connectionId: input.connectionId,
        ...(input.lifetimeMs === undefined
          ? {}
          : { lifetimeMs: input.lifetimeMs }),
      },
    });
    if (selected.operation.kind !== 'capture') refuse();
    const operation = selected.operation;
    let active = true;
    let entered = false;
    try {
      const revision = owners.runtime.getAgentConfigurationRevision();
      if (revision === null || !Number.isSafeInteger(revision) || revision < 0)
        refuse();
      const configuration =
        owners.configLoader.capturePreparationConfigurationFence(
          selected.agentIds,
        );
      const runtime = owners.agentService.capturePreparationConfigurationFence(
        selected.agentIds,
        () => owners.runtime.getAgentConfigurationRevision(),
      );
      const assertScopeCurrent = () => {
        if (
          request.signal.aborted ||
          owners.runtime.getAgentConfigurationRevision() !== revision
        )
          refuse();
        this.#requireSameHome();
      };
      const configurationCurrent = () => {
        assertScopeCurrent();
        configuration();
      };
      const runtimeCurrent = () => {
        assertScopeCurrent();
        runtime();
      };
      const assertCurrent = () => {
        configurationCurrent();
        runtimeCurrent();
      };
      if (admit) await admit(assertCurrent);
      else assertCurrent();
      const session = sessionCapability
        ? readStationControlSourceCredentialAuthority(
            sessionCapability,
            request,
          )
        : undefined;
      session?.assertMayCapture();
      const local = session
        ? undefined
        : await captureEnvironmentLocalGrantObservationOwner(
            request,
            owners.environmentSecurityService,
            owners.requestSecurity,
            admit,
            owners.canonicalLocalGrantOrigin,
          );
      const authority = sessionCapability
        ? {
            kind: 'station-control-session' as const,
            capability: sessionCapability,
          }
        : local!;
      if (admit) await admit(assertCurrent);
      else assertCurrent();
      if (session) {
        if (
          selected.agentIds.length !== 1 ||
          selected.agentIds[0] !== session.agentId
        )
          refuse();
        const agent = await owners.agentService.getAgent(selected.agentIds[0]!);
        if (admit) await admit(assertCurrent);
        else assertCurrent();
        session.assertCurrent();
        if (
          agent.project !== session.projectSlug ||
          agent.execution?.agentConnectionId
        )
          refuse();
        const appConfig = await owners.configLoader.loadAppConfig();
        if (admit) await admit(assertCurrent);
        else assertCurrent();
        session.assertCurrent();
        const binding = resolveManagedModelIdentity(agent, {
          appConfig,
          listProviderConnections: () =>
            owners.storageAdapter.listProviderConnections(),
        });
        if (
          binding.providerConnection.id !== operation.connectionId ||
          binding.providerType !== provider
        )
          refuse();
      }
      const store = new ProviderCredentialObservationStore(
        owners.configLoader.getProjectHomeDir(),
        {
          adapter: owners.storageAdapter,
          authority,
          captureConfigurationFence: () => configurationCurrent,
          captureRuntimeFence: () => runtimeCurrent,
        },
      );
      let credential: ObservedSdkProviderCredential | undefined;
      const receipt = await owners.runtime.commitAgentConfigurationRead(
        revision,
        async () => {
          const select = () => {
            if (!active || entered || this.#captureAttempts >= 4096) refuse();
            assertCurrent();
            if (session) session.assertMayCapture();
            else local!.requireCurrentLocalGrant(request).assertCurrent();
            entered = true;
            this.#captureAttempts++;
            credential = store.captureSdkCredential(
              request,
              operation.connectionId,
              operation.lifetimeMs,
            );
            readObservedSdkProviderCredential(credential, provider, request);
            assertCurrent();
            return credential;
          };
          return admit ? admit(select) : select();
        },
      );
      if (admit) await admit(assertCurrent);
      else assertCurrent();
      if (!entered || credential === undefined || receipt !== credential)
        refuse();
      const captured = credential;
      if (admit)
        await admit(() =>
          readObservedSdkProviderCredential(captured, provider, request),
        );
      else readObservedSdkProviderCredential(captured, provider, request);
      return captured;
    } catch {
      return refuse();
    } finally {
      // A rejected/timed-out outer lease must fence a still-queued callback.
      active = false;
    }
  }

  async observe(
    request: Request,
    input: RuntimeFencedCredentialObservationInput,
  ): Promise<ProviderCredentialObservation> {
    const owners = this.#owners;
    let active = true;
    let entered = false;
    let registered:
      | Awaited<ReturnType<typeof captureEnvironmentLocalGrantObservationOwner>>
      | undefined;
    const deactivate = () => {
      active = false;
    };
    request.signal.addEventListener('abort', deactivate, { once: true });
    try {
      const selected = snapshot(input);
      const ids = JSON.stringify(selected.agentIds);
      if (selected.operation.kind === 'revalidate') {
        if (this.#known.get(selected.operation.observationId) !== ids) refuse();
      }
      const revision = owners.runtime.getAgentConfigurationRevision();
      if (revision === null || !Number.isSafeInteger(revision) || revision < 0)
        refuse();
      const configuration =
        owners.configLoader.capturePreparationConfigurationFence(
          selected.agentIds,
        );
      const runtime = owners.agentService.capturePreparationConfigurationFence(
        selected.agentIds,
        () => owners.runtime.getAgentConfigurationRevision(),
      );
      const requireCurrent = () => {
        if (
          !active ||
          request.signal.aborted ||
          owners.runtime.getAgentConfigurationRevision() !== revision
        )
          refuse();
        this.#requireSameHome();
        configuration();
        runtime();
      };
      requireCurrent();
      const authority = await captureEnvironmentLocalGrantObservationOwner(
        request,
        owners.environmentSecurityService,
        owners.requestSecurity,
        undefined,
        owners.canonicalLocalGrantOrigin,
      );
      requireCurrent();
      authority.requireCurrentLocalGrant(request).assertCurrent();
      if (this.#authorities.has(request)) refuse();
      this.#authorities.set(request, authority);
      registered = authority;
      let observed: ProviderCredentialObservation | undefined;
      const receipt = await owners.runtime.commitAgentConfigurationRead(
        revision,
        () => {
          // A timed-out Promise.race leaves queued callbacks live. No effect may
          // precede this private request gate; this synchronous scope never awaits.
          requireCurrent();
          authority.requireCurrentLocalGrant(request).assertCurrent();
          if (
            entered ||
            this.#scope ||
            (selected.operation.kind === 'capture' &&
              this.#captureAttempts >= 4096)
          )
            refuse();
          entered = true;
          // Bound retained fence closures, including captures whose outer lease fails.
          if (selected.operation.kind === 'capture') this.#captureAttempts++;
          this.#scope = { configuration, runtime };
          try {
            observed =
              selected.operation.kind === 'capture'
                ? this.#store.capture(
                    request,
                    selected.operation.connectionId,
                    selected.operation.lifetimeMs,
                  )
                : this.#store.revalidate(
                    request,
                    selected.operation.observationId,
                  );
            requireCurrent();
            authority.requireCurrentLocalGrant(request).assertCurrent();
            return Promise.resolve(observed);
          } finally {
            this.#scope = undefined;
          }
        },
      );
      requireCurrent();
      authority.requireCurrentLocalGrant(request).assertCurrent();
      if (!entered || observed === undefined || receipt !== observed) refuse();
      // The outer lease may outlive the callback's observation window.
      // Preserve its original timestamps; final disclosure cannot renew it.
      const disclosedAtMs = Date.now();
      if (
        !Number.isSafeInteger(disclosedAtMs) ||
        disclosedAtMs < observed.observedAtMs ||
        disclosedAtMs >= observed.expiresAtMs
      )
        refuse();
      // Publish boot-local continuity only after the lease and final checks.
      this.#known.set(observed.observationId, ids);
      return Object.freeze({
        observationId: observed.observationId,
        observedAtMs: observed.observedAtMs,
        expiresAtMs: observed.expiresAtMs,
        kind: 'credential-source-observation',
      });
    } catch {
      return refuse();
    } finally {
      active = false;
      if (registered && this.#authorities.get(request) === registered)
        this.#authorities.delete(request);
      request.signal.removeEventListener('abort', deactivate);
    }
  }
}
