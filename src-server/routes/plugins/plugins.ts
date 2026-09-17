import type { PluginProviderReadView } from '../../providers/registries/registry.js';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import type { PluginInstallationHost } from '../../services/plugins/plugin-installation-service.js';
import type { RegistryTrustPolicyAuthority } from '../../services/plugins/registry-trust-policy.js';
/**
 * Plugin Routes — top-level composer for plugin discovery, install, and public bridge routes.
 */

import { join } from 'node:path';
import type { OperationalEventEnvelope } from '@kontourai/station-contracts/operational-event';
import { Hono } from 'hono';
import {
  disposeRetainedPreparedPluginProviders,
  pluginProviderSourceGeneration,
  retirePluginProvidersForSourceGeneration,
  withPluginProviderSourceGeneration,
} from '../../providers/registries/registry.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import { PrincipalUnresolvedError } from '../../services/identity/principal-resolver.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import {
  createPluginCommandEffectAdmission,
  type PluginCommandEffectAdmissionDeps,
} from '../../services/plugins/plugin-command-effect-admission.js';
import {
  createPluginCommandEffectService,
  FilePluginCommandEffectStore,
} from '../../services/plugins/plugin-command-effects.js';
import { createPluginGrantReconciliationService } from '../../services/plugins/plugin-grant-reconciliation.js';
import {
  publishGrantedPluginProviderGeneration,
  withPluginInstallationGeneration,
} from '../../services/plugins/plugin-installation-generation-fence.js';
import {
  hasGrant,
  readPluginGrantStateAsync,
} from '../../services/plugins/plugin-permissions.js';
import { quiescePluginPublicServerModule } from '../../services/plugins/plugin-public-server.js';
import {
  capturePluginRuntimeArtifact,
  capturePluginRuntimeArtifactAsync,
  pluginInstallationGeneration,
} from '../../services/plugins/plugin-runtime-artifact.js';
import type { Logger } from '../../utils/logger.js';
import { buildPlugin } from './plugin-bundles.js';
import { registerPluginCommandEffectRoutes } from './plugin-command-effect-routes.js';
import { registerPluginConfigRoutes } from './plugin-config-routes.js';
import { registerPluginHomeRoleRoutes } from './plugin-home-role-routes.js';
import { registerPluginHostApprovalRoutes } from './plugin-host-approval-routes.js';
import { registerPluginInstallRoutes } from './plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from './plugin-lifecycle-routes.js';
import { preparePluginProviders } from './plugin-loader.js';
import { registerPluginPublicRoutes } from './plugin-public-routes.js';
import {
  type PluginVisibilityRouteDeps,
  registerPluginVisibilityRoutes,
} from './plugin-visibility-routes.js';

export function createPluginRoutes(
  projectHomeDir: string,
  logger: Logger,
  eventBus?: EventBus,
  runtime?: {
    installationHost?: PluginInstallationHost;
    registryTrustPolicyAuthority?: RegistryTrustPolicyAuthority;
    packageMcpJournal?: PackageMcpAdmissionJournal;
    /** archive#3677: the distinct-origin consent surface (host approvals). */
    consentChannel?: ConsentChannelService;
    /**
     * Per-principal plugin visibility (#2067). REQUIRED in production and
     * REQUIRED here whenever `runtime` is supplied at all: `visibility` is the
     * pair that decides whether `GET /api/plugins` enumerates this instance's
     * inventory for the caller, so a composition may not half-supply it.
     *
     * `resolvePrincipal` reads the request's own authentication and never a
     * body or header the caller wrote; `listKnownPrincipals` is the trusted
     * device registry's own list, injected rather than re-derived.
     */
    visibility: Pick<
      PluginVisibilityRouteDeps,
      'service' | 'resolvePrincipal' | 'listKnownPrincipals'
    >;
    applyConfigurationMutation: AgentConfigurationMutationRunner;
    refreshKitObservability?: () => void;
    settleProviderAdapterRetirements: () => Promise<void>;
    reconcileEngineConnections?: (
      plugin: string,
      view?: PluginProviderReadView,
    ) => Promise<void>;
    removeEngineConnections?: (plugin: string) => Promise<void>;
    quiesceEventSubscriptions?: (
      pluginName?: string,
    ) => Promise<{ release(): void }>;
    reconcileEventSubscriptions?: () => Promise<{
      kind: 'applied' | 'unavailable';
    }>;
    /**
     * kontourai/station#1418: plugin command effect admission. Absent, the
     * routes still refuse unattributed callers and record nothing.
     */
    commandEffects?: {
      isHostedDeployment(): boolean;
      publishAudit?(event: OperationalEventEnvelope): boolean;
      producerVersion?: string;
      onSettlementConflict?(): void;
      resolveRequirement: PluginCommandEffectAdmissionDeps['resolveRequirement'];
      /** Test seam: runs inside every lock and lease just before the append. */
      beforeRecord?: PluginCommandEffectAdmissionDeps['beforeRecord'];
      /** Test seams for withdrawal age; production uses the wall clock. */
      now?(): Date;
      indeterminateAfterMs?: number;
    };
  },
) {
  const app = new Hono();
  const pluginsDir = join(projectHomeDir, 'plugins');
  /**
   * The projection `GET /` applies, and the ONE resolution path to it.
   *
   * When no `runtime` is supplied this composition is not serving
   * authenticated HTTP callers (the layout-only route tests), and the
   * resolver that would attribute a request does not exist. That case refuses
   * rather than defaults: `PrincipalUnresolvedError` is what the caller gets,
   * not the whole inventory. The operator's own projection is unaffected —
   * production always supplies `runtime.visibility`.
   */
  const projectVisiblePlugins = (c: {
    env: unknown;
    req: { raw: Request; header(name: string): string | undefined };
  }): ((installed: readonly string[]) => readonly string[]) => {
    if (!runtime?.visibility) {
      throw new PrincipalUnresolvedError(
        'plugin visibility was not composed for this route',
      );
    }
    const caller = runtime.visibility.resolvePrincipal(c);
    const service = runtime.visibility.service;
    return (installed) => service.visiblePlugins(caller, installed);
  };
  if (runtime?.visibility)
    registerPluginVisibilityRoutes(app, runtime.visibility);
  const agentsDir = join(projectHomeDir, 'agents');
  const capture = (name: string) =>
    capturePluginRuntimeArtifact(pluginsDir, name, runtime?.packageMcpJournal);
  const artifactGeneration = (artifact: ReturnType<typeof capture>) => {
    return {
      installed: !!artifact,
      installationGeneration: artifact
        ? pluginInstallationGeneration(artifact)
        : null,
    };
  };
  const captureGeneration = (name: string) => artifactGeneration(capture(name));

  const grantReconciliation =
    runtime?.quiesceEventSubscriptions &&
    runtime.reconcileEventSubscriptions &&
    runtime.removeEngineConnections &&
    runtime.reconcileEngineConnections
      ? createPluginGrantReconciliationService({
          snapshot: async (pluginName) => {
            const artifact = await capturePluginRuntimeArtifactAsync(
              pluginsDir,
              pluginName,
              runtime?.packageMcpJournal,
            );
            return {
              ...artifactGeneration(artifact),
              providerGeneration: pluginProviderSourceGeneration(pluginName),
              grants: artifact
                ? (
                    await readPluginGrantStateAsync(
                      projectHomeDir,
                      pluginName,
                      artifact,
                    )
                  ).granted
                : [],
            };
          },
          quiesceModule: (pluginName) =>
            quiescePluginPublicServerModule(pluginsDir, pluginName),
          quiesceSubscriptions: (pluginName) =>
            runtime.quiesceEventSubscriptions!(pluginName),
          retireProviders: (pluginName, expectedGeneration) =>
            retirePluginProvidersForSourceGeneration(
              pluginName,
              expectedGeneration,
            ),
          activateProviders: async (pluginName, expected, isCurrent) => {
            const activation = await withPluginInstallationGeneration({
              pluginsDir,
              pluginName,
              expected,
              capture: () => captureGeneration(pluginName),
              effect: async () => {
                const artifact = capture(pluginName);
                if (!artifact) return 'superseded' as const;
                const manifest = artifact.manifest;
                const prepared = await preparePluginProviders(
                  pluginsDir,
                  pluginName,
                  manifest,
                  logger,
                  {
                    strict: true,
                    packageRoot: artifact.packageRoot,
                    artifact,
                    visibility: {
                      ready: () =>
                        artifact.isCurrent() &&
                        hasGrant(
                          projectHomeDir,
                          pluginName,
                          'providers.register',
                          undefined,
                          artifact,
                        ),
                      permits: () => false,
                    },
                  },
                );
                return publishGrantedPluginProviderGeneration({
                  projectHomeDir,
                  pluginName,
                  expectedProviderGeneration: expected.providerGeneration,
                  prepared,
                  isCurrent: () => isCurrent() && artifact.isCurrent(),
                  artifact,
                });
              },
            });
            return activation.kind === 'applied'
              ? activation.value
              : ('superseded' as const);
          },
          settleProviderAdapters: async (pluginName) => {
            const failures: unknown[] = [];
            try {
              await disposeRetainedPreparedPluginProviders(pluginName);
            } catch (error) {
              failures.push(error);
            }
            try {
              await runtime.settleProviderAdapterRetirements();
            } catch (error) {
              failures.push(error);
            }
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                `Provider adapter cleanup for '${pluginName}' is incomplete.`,
              );
            }
          },
          removeEngineConnections: async (pluginName, expected) => {
            const installation = await withPluginInstallationGeneration({
              pluginsDir,
              pluginName,
              expected,
              capture: () => captureGeneration(pluginName),
              effect: () =>
                withPluginProviderSourceGeneration(
                  pluginName,
                  expected.providerGeneration,
                  () => runtime.removeEngineConnections!(pluginName),
                ),
            });
            return installation.kind === 'applied' &&
              installation.value.kind === 'applied'
              ? ('removed' as const)
              : ('superseded' as const);
          },
          reconcileEngineConnections: runtime.reconcileEngineConnections,
          reconcileSubscriptions: runtime.reconcileEventSubscriptions,
        })
      : undefined;

  const commandEffects = createPluginCommandEffectService({
    store: new FilePluginCommandEffectStore(projectHomeDir),
    publishAudit: runtime?.commandEffects?.publishAudit,
    producerVersion: runtime?.commandEffects?.producerVersion,
    onSettlementConflict: runtime?.commandEffects?.onSettlementConflict,
    now: runtime?.commandEffects?.now,
    indeterminateAfterMs: runtime?.commandEffects?.indeterminateAfterMs,
  });
  registerPluginCommandEffectRoutes(app, {
    effects: commandEffects,
    resolution: runtime?.visibility
      ? { resolvePrincipal: runtime.visibility.resolvePrincipal }
      : undefined,
    // No composed runtime means no attributable, audited caller: refuse.
    isHostedDeployment: () =>
      runtime?.commandEffects?.isHostedDeployment() ?? true,
    admission: createPluginCommandEffectAdmission({
      pluginsDir,
      projectHomeDir,
      journal: runtime?.packageMcpJournal,
      effects: commandEffects,
      canSeePlugin: (principal, pluginId) =>
        runtime?.visibility?.service.canSee(principal, pluginId) ?? false,
      resolveRequirement: async (input) =>
        runtime?.commandEffects
          ? runtime.commandEffects.resolveRequirement(input)
          : 'unavailable',
      beforeRecord: runtime?.commandEffects?.beforeRecord,
    }),
  });

  // Literal reserved-segment routes (`/home-role/**`) must register before
  // any `/:name` catch-all: Hono matches in registration order, and the
  // lifecycle module's `DELETE /:name` otherwise captures `DELETE /home-role`
  // (#477). `home-role` is a reserved plugin identity: every supported
  // install path refuses the name, so only a hand-placed tree can collide —
  // and for that one name, HTTP removal is intentionally forfeited (see
  // reserved-plugin-identities.ts).
  registerPluginHomeRoleRoutes(app, {
    packageMcpJournal: runtime?.packageMcpJournal,
    eventBus,
    pluginsDir,
    projectHomeDir,
    consentChannel: runtime?.consentChannel,
    // #2067: the candidate picker is projected, through the same resolution
    // path and the same derivation as `GET /api/plugins`.
    projectVisiblePlugins,
  });
  registerPluginLifecycleRoutes(app, {
    registryTrustPolicyAuthority: runtime?.registryTrustPolicyAuthority,
    // #2067: `GET /check-updates` is operator-only; this is what refuses.
    ...(runtime?.visibility
      ? {
          visibility: { resolvePrincipal: runtime.visibility.resolvePrincipal },
        }
      : {}),
    packageMcpJournal: runtime?.packageMcpJournal,
    installationHost: runtime?.installationHost,
    agentsDir,
    buildPlugin: (pluginDir, name, manifest) =>
      buildPlugin(pluginDir, name, logger, manifest),
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
    applyConfigurationMutation: runtime?.applyConfigurationMutation,
    refreshKitObservability: runtime?.refreshKitObservability,
    settleProviderAdapterRetirements: runtime?.settleProviderAdapterRetirements,
    reconcileEngineConnections: runtime?.reconcileEngineConnections,
    removeEngineConnections: runtime?.removeEngineConnections,
    quiesceEventSubscriptions: runtime?.quiesceEventSubscriptions,
  });
  registerPluginConfigRoutes(app, {
    packageMcpJournal: runtime?.packageMcpJournal,
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
  });
  registerPluginInstallRoutes(app, {
    registryTrustPolicyAuthority: runtime?.registryTrustPolicyAuthority,
    packageMcpJournal: runtime?.packageMcpJournal,
    installationHost: runtime?.installationHost,
    agentsDir,
    applyConfigurationMutation: runtime?.applyConfigurationMutation,
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
    refreshKitObservability: runtime?.refreshKitObservability,
    settleProviderAdapterRetirements: runtime?.settleProviderAdapterRetirements,
    reconcileEngineConnections: runtime?.reconcileEngineConnections,
    quiesceEventSubscriptions: runtime?.quiesceEventSubscriptions
      ? (plugin) => runtime.quiesceEventSubscriptions!(plugin)
      : undefined,
    projectVisiblePlugins,
  });
  registerPluginHostApprovalRoutes(app, {
    packageMcpJournal: runtime?.packageMcpJournal,
    eventBus,
    pluginsDir,
    projectHomeDir,
    consentChannel: runtime?.consentChannel,
    grantReconciliation,
  });
  registerPluginPublicRoutes(app, {
    packageMcpJournal: runtime?.packageMcpJournal,
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
    grantReconciliation,
  });

  return app;
}
