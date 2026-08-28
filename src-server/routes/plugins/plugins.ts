/**
 * Plugin Routes — top-level composer for plugin discovery, install, and public bridge routes.
 */

import { join } from 'node:path';
import { Hono } from 'hono';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { Logger } from '../../utils/logger.js';
import { buildPlugin } from './plugin-bundles.js';
import { registerPluginConfigRoutes } from './plugin-config-routes.js';
import { registerPluginHomeRoleRoutes } from './plugin-home-role-routes.js';
import { registerPluginHostApprovalRoutes } from './plugin-host-approval-routes.js';
import { registerPluginInstallRoutes } from './plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from './plugin-lifecycle-routes.js';
import { registerPluginPublicRoutes } from './plugin-public-routes.js';

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
  },
) {
  const app = new Hono();
  const pluginsDir = join(projectHomeDir, 'plugins');
  const agentsDir = join(projectHomeDir, 'agents');

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
  });
  registerPluginHomeRoleRoutes(app, {
    eventBus,
    pluginsDir,
    projectHomeDir,
    consentChannel: runtime?.consentChannel,
  });
  registerPluginPublicRoutes(app, {
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
  });

  return app;
}
