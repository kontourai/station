/**
 * Plugin Routes — top-level composer for plugin discovery, install, and public bridge routes.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  disposeRetainedPreparedPluginProviders,
  pluginProviderSourceGeneration,
  replacePluginProvidersForSourceGeneration,
  retirePluginProvidersForSourceGeneration,
  withPluginProviderSourceGeneration,
} from '../../providers/registries/registry.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { computePluginContentDigest } from '../../services/plugins/plugin-content-integrity.js';
import { createPluginGrantReconciliationService } from '../../services/plugins/plugin-grant-reconciliation.js';
import { withPluginInstallationGeneration } from '../../services/plugins/plugin-installation-generation-fence.js';
import { readPluginManifestFile } from '../../services/plugins/plugin-manifest-loader.js';
import { getPluginGrants } from '../../services/plugins/plugin-permissions.js';
import type { Logger } from '../../utils/logger.js';
import { buildPlugin } from './plugin-bundles.js';
import { registerPluginConfigRoutes } from './plugin-config-routes.js';
import { registerPluginHomeRoleRoutes } from './plugin-home-role-routes.js';
import { registerPluginHostApprovalRoutes } from './plugin-host-approval-routes.js';
import { registerPluginInstallRoutes } from './plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from './plugin-lifecycle-routes.js';
import { preparePluginProviders } from './plugin-loader.js';
import { registerPluginPublicRoutes } from './plugin-public-routes.js';
import { quiescePluginPublicServerModule } from './plugin-public-server.js';

export function createPluginRoutes(
  projectHomeDir: string,
  logger: Logger,
  eventBus?: EventBus,
  runtime?: {
    /** archive#3677: the distinct-origin consent surface (host approvals). */
    consentChannel?: ConsentChannelService;
    applyConfigurationMutation: AgentConfigurationMutationRunner;
    refreshKitObservability?: () => void;
    settleProviderAdapterRetirements: () => Promise<void>;
    reconcileEngineConnections?: (plugin: string) => Promise<void>;
    removeEngineConnections?: (plugin: string) => Promise<void>;
    quiesceEventSubscriptions?: (
      pluginName?: string,
    ) => Promise<{ release(): void }>;
    reconcileEventSubscriptions?: () => Promise<{
      kind: 'applied' | 'unavailable';
    }>;
  },
) {
  const app = new Hono();
  const pluginsDir = join(projectHomeDir, 'plugins');
  const agentsDir = join(projectHomeDir, 'agents');
  const grantReconciliation =
    runtime?.quiesceEventSubscriptions &&
    runtime.reconcileEventSubscriptions &&
    runtime.removeEngineConnections &&
    runtime.reconcileEngineConnections
      ? createPluginGrantReconciliationService({
          snapshot: async (pluginName) => ({
            installed: existsSync(join(pluginsDir, pluginName, 'plugin.json')),
            installationGeneration: computePluginContentDigest(
              pluginsDir,
              pluginName,
            ),
            providerGeneration: pluginProviderSourceGeneration(pluginName),
            grants: getPluginGrants(projectHomeDir, pluginName),
          }),
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
              effect: async () => {
                const manifest = await readPluginManifestFile(
                  join(pluginsDir, pluginName, 'plugin.json'),
                );
                const prepared = await preparePluginProviders(
                  pluginsDir,
                  pluginName,
                  manifest,
                  logger,
                  { strict: true },
                );
                return replacePluginProvidersForSourceGeneration(
                  pluginName,
                  expected.providerGeneration,
                  prepared,
                  isCurrent,
                );
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

  // Literal reserved-segment routes (`/home-role/**`) must register before
  // any `/:name` catch-all: Hono matches in registration order, and the
  // lifecycle module's `DELETE /:name` otherwise captures `DELETE /home-role`
  // (#477). `home-role` is a reserved plugin identity: every supported
  // install path refuses the name, so only a hand-placed tree can collide —
  // and for that one name, HTTP removal is intentionally forfeited (see
  // reserved-plugin-identities.ts).
  registerPluginHomeRoleRoutes(app, {
    eventBus,
    pluginsDir,
    projectHomeDir,
    consentChannel: runtime?.consentChannel,
  });
  registerPluginLifecycleRoutes(app, {
    agentsDir,
    buildPlugin: (pluginDir, name) => buildPlugin(pluginDir, name, logger),
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
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
  });
  registerPluginInstallRoutes(app, {
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
  });
  registerPluginHostApprovalRoutes(app, {
    eventBus,
    pluginsDir,
    projectHomeDir,
    consentChannel: runtime?.consentChannel,
    grantReconciliation,
  });
  registerPluginPublicRoutes(app, {
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
    grantReconciliation,
  });

  return app;
}
