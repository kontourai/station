import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { getPluginRegistryProviders } from '../../providers/registries/registry.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import { isContextSafetyError } from '../../services/orchestration/context-safety.js';
import {
  rejectedInstalledPluginRecord,
  scanInstalledPluginInventory,
} from '../../services/plugins/installed-plugin-inventory.js';
import { scanPluginPromptFileSafety } from '../../services/plugins/plugin-command-skill-source.js';
import {
  findPluginContentLockCycleError,
  pluginContentLockCycleMessage,
} from '../../services/plugins/plugin-content-integrity.js';
import {
  derivePluginConsentBasis,
  isPluginConsentRefusedError,
  type PluginInstallConsent,
} from '../../services/plugins/plugin-install-consent.js';
import { readPluginManifestFile } from '../../services/plugins/plugin-manifest-loader.js';
import {
  getPermissionTier,
  PluginGrantsUnavailableError,
  readPluginGrantState,
  requiredPermissionsForManifest,
} from '../../services/plugins/plugin-permissions.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  pluginInstallSchema,
  pluginPreviewSchema,
  validate,
} from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from '../system/configuration-activation.js';
import { buildPlugin } from './plugin-bundles.js';
import {
  installPluginFromSource,
  resolvePluginRegistrySource,
} from './plugin-install-shared.js';
import {
  detectPluginConflicts,
  detectWorkspacePaneCatalogConflicts,
  fetchPluginSource,
  getPluginGitInfo,
  PluginPreviewUnsupportedDependencyError,
  resolvePluginDependencies,
} from './plugin-source.js';

interface PluginInstallRouteDeps {
  agentsDir: string;
  eventBus?: {
    emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
  };
  logger: Logger;
  pluginsDir: string;
  projectHomeDir: string;
  applyConfigurationMutation?: AgentConfigurationMutationRunner;
  refreshKitObservability?: () => void;
  settleProviderAdapterRetirements?: () => Promise<void>;
  reconcileEngineConnections?: (plugin: string) => Promise<void>;
  quiesceEventSubscriptions?: (
    pluginName: string,
  ) => Promise<{ release(): void }>;
}

export function registerPluginInstallRoutes(
  app: Hono,
  deps: PluginInstallRouteDeps,
): void {
  const {
    agentsDir,
    applyConfigurationMutation,
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
    refreshKitObservability,
    settleProviderAdapterRetirements,
    reconcileEngineConnections,
    quiesceEventSubscriptions,
  } = deps;

  app.get('/', async (c) => {
    const plugins = [];

    for (const entry of scanInstalledPluginInventory(pluginsDir, logger)) {
      if (entry.state === 'rejected') {
        plugins.push(rejectedInstalledPluginRecord(entry));
        continue;
      }
      try {
        const manifest = entry.manifest;
        const bundlePath = join(
          pluginsDir,
          entry.directoryName,
          'dist',
          'bundle.js',
        );
        const pluginDir = join(pluginsDir, entry.directoryName);
        const git = await getPluginGitInfo(pluginDir, logger);
        const declared = requiredPermissionsForManifest(manifest);
        // archive#4288: EFFECTIVE grants, plus the derived binding state and
        // the names it withheld. `missing` therefore includes anything the
        // content change took away — and `withheld` is what tells the reader
        // that it was taken away rather than never given.
        const grantState = readPluginGrantState(projectHomeDir, manifest.name);
        const granted = grantState.granted;
        const missing = declared
          .filter((permission: string) => !granted.includes(permission))
          .map((permission: string) => ({
            permission,
            tier: getPermissionTier(permission),
          }));

        plugins.push({
          name: manifest.name,
          displayName: manifest.displayName,
          version: manifest.version,
          description: manifest.description,
          hasBundle: existsSync(bundlePath),
          hasSettings:
            Array.isArray(manifest.settings) && manifest.settings.length > 0,
          layout: manifest.layout,
          workspacePanes: manifest.workspacePanes,
          agents: manifest.agents,
          providers: manifest.providers,
          links: manifest.links,
          git,
          permissions: {
            declared,
            granted,
            missing,
            contentBinding: grantState.binding,
            withheld: grantState.withheld,
          },
        });
      } catch (error: unknown) {
        if (error instanceof PluginGrantsUnavailableError) {
          // The grants store is one file for every plugin: listing the
          // plugins with empty grant lists would render "nothing granted" as
          // fact (archive#1835). Surface the unavailable state for the whole list.
          logger.error(
            'Plugin grants store unavailable while listing plugins',
            {
              path: error.storePath,
              error: errorMessage(error),
            },
          );
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              grantsUnavailable: true,
            },
            503,
          );
        }
        logger.error('Failed to read plugin manifest', {
          plugin: entry.directoryName,
          error: errorMessage(error),
        });
      }
    }

    return c.json({ plugins });
  });

  app.post('/preview', validate(pluginPreviewSchema), async (c) => {
    try {
      const { source: bodySource, registryId } = getBody(c);
      let source = bodySource;
      // The Registry view previews by catalog id: its listings carry provider
      // labels, not source paths, so the server resolves the id through the
      // same registry providers the install itself would use. `code` lets a
      // caller distinguish "this id is not a plugin" (an agent-face entry it
      // should install as before) from a broken plugin source.
      if (!source && registryId) {
        const resolved = await resolvePluginRegistrySource(registryId);
        if (!resolved) {
          return c.json(
            {
              valid: false,
              error: `Plugin '${registryId}' not found in registry`,
              code: 'registry-plugin-not-found',
              components: [],
              conflicts: [],
            },
            404,
          );
        }
        source = resolved;
      }
      if (!source) {
        return c.json(
          {
            valid: false,
            error: 'source or registryId is required',
            components: [],
            conflicts: [],
          },
          400,
        );
      }

      const result = await fetchPluginSource(source, pluginsDir, logger);
      if ('error' in result) {
        return c.json({
          valid: false,
          error: result.error,
          components: [],
          conflicts: [],
        });
      }

      const { tempDir } = result;
      try {
        const manifest = await readPluginManifestFile(
          join(tempDir, 'plugin.json'),
        );
        // Preview refuses exactly what install refuses, through the SAME scan
        // (`collectPluginPromptFiles`). A preview that reported "valid" for a
        // plugin the installer will reject is worse than refusing late: the
        // user approves it on the strength of a look that never happened.
        const blockedPromptFiles = scanPluginPromptFileSafety(
          tempDir,
          manifest.name,
        );
        if (blockedPromptFiles.length > 0) {
          return c.json(
            {
              valid: false,
              error: `Blocked potentially unsafe context in prompt files for plugin '${manifest.name}'.`,
              findings: blockedPromptFiles,
              components: [],
              conflicts: [],
            },
            400,
          );
        }
        const conflicts = [
          ...detectPluginConflicts(manifest, agentsDir, pluginsDir, logger),
          ...detectWorkspacePaneCatalogConflicts(manifest, projectHomeDir),
        ];
        const components: Array<{
          type: string;
          id: string;
          detail?: string;
          conflict?: (typeof conflicts)[0];
          skippable?: boolean;
        }> = [];

        for (const agent of manifest.agents || []) {
          const slug = agent.slug;
          const conflict = conflicts.find(
            (entry) => entry.type === 'agent' && entry.id === slug,
          );
          components.push({
            type: 'agent',
            id: slug,
            detail: agent.source,
            conflict,
          });
        }

        if (manifest.layout) {
          const conflict = conflicts.find(
            (entry) =>
              entry.type === 'layout' && entry.id === manifest.layout?.slug,
          );
          components.push({
            type: 'layout',
            id: manifest.layout.slug,
            detail: manifest.layout.source,
            conflict,
          });
        }

        for (const pane of manifest.workspacePanes ?? []) {
          const conflict = conflicts.find(
            (entry) => entry.type === 'pane' && entry.id === pane.id,
          );
          components.push({
            type: 'pane',
            id: pane.id,
            detail: `${pane.renderer.kind}:${pane.rendererId}`,
            conflict,
            skippable: false,
          });
        }

        for (const provider of manifest.providers || []) {
          components.push({
            type: 'provider',
            id: provider.type,
            detail: provider.module,
          });
        }

        for (const toolId of manifest.integrations?.required || []) {
          const installed = existsSync(
            join(projectHomeDir, 'integrations', toolId, 'integration.json'),
          );
          components.push({
            type: 'tool',
            id: toolId,
            detail: installed ? 'already installed' : 'will install',
          });
        }

        const dependencies = await resolvePluginDependencies(
          manifest,
          pluginsDir,
          () => ({
            // A READ route, so it hands the resolver an installer that cannot
            // install (archive#4288, review LOW). `resolvePluginDependencies`
            // only ever calls `listAvailable`, and this closure used to carry
            // a live provider install anyway — inert today, and a loaded gun
            // for whoever adds a call to it. The refusal names the route so
            // the mistake reads as a mistake rather than a provider outage.
            async install(id: string): Promise<never> {
              throw new Error(
                `Plugin preview must not install ${id}: /preview stages and reports, it never mutates.`,
              );
            },
            async listAvailable() {
              const entries = await Promise.all(
                getPluginRegistryProviders().map((entry) =>
                  entry.provider.listAvailable(),
                ),
              );
              return entries.flat();
            },
          }),
          logger,
          undefined,
          source,
        );
        const git = await getPluginGitInfo(tempDir, logger);
        // archive#4288: the preview already staged and validated everything a
        // consent decision needs, and then threw it away. It now RETURNS it,
        // so the operator can be asked before `POST /install` writes anything
        // — and so the answer can be bound to these exact bytes.
        const consentBasis = derivePluginConsentBasis(tempDir, manifest);
        if (consentBasis === null) {
          return c.json(
            {
              valid: false,
              error: `Plugin '${manifest.name}' source could not be read`,
              components: [],
              conflicts: [],
            },
            400,
          );
        }

        return c.json({
          valid: true,
          manifest,
          components,
          conflicts,
          dependencies,
          git,
          contentDigest: consentBasis.contentDigest,
          permissions: {
            required: consentBasis.required,
            autoGranted: consentBasis.autoGranted,
            pendingConsent: consentBasis.pendingConsent,
          },
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      if (error instanceof PluginPreviewUnsupportedDependencyError) {
        return c.json(
          {
            valid: false,
            error: errorMessage(error),
            code: 'unsupported-plugin-dependency',
            components: [],
            conflicts: [],
          },
          400,
        );
      }
      if (isContextSafetyError(error)) {
        return c.json(
          {
            valid: false,
            error: error.message,
            findings: error.findings,
            components: [],
            conflicts: [],
          },
          400,
        );
      }
      return c.json(
        {
          valid: false,
          error: errorMessage(error),
          components: [],
          conflicts: [],
        },
        500,
      );
    }
  });

  app.post('/install', validate(pluginInstallSchema), async (c) => {
    try {
      const { source, skip, consent } = getBody(c);
      // archive#4288. Refused before the source is even staged: this route is
      // how an operator admits a plugin's code into the shell's own document,
      // and the permission derivation cannot see the contributions that run
      // there (`layout`, `workspacePanes`, `entrypoint`, `agents` — eight of
      // eleven). So the decision is required unconditionally rather than only
      // when the derivation happens to produce something, and what it binds is
      // the DIGEST of the reviewed bytes, which covers every contribution.
      if (!consent) {
        return c.json(
          {
            success: false,
            error:
              'Plugin installs need an approval taken before anything is written. Preview the plugin, then install it from that preview.',
            consent: { reason: 'missing' },
          },
          400,
        );
      }
      const operatorDecision: PluginInstallConsent = {
        kind: 'operator-decision',
        permissions: consent.permissions,
        contentDigest: consent.contentDigest,
        dependencies: consent.dependencies ?? [],
        ...(consent.dependencyApprovals
          ? { dependencyApprovals: consent.dependencyApprovals }
          : {}),
      };
      const mutation = await captureConfigurationMutation(
        applyConfigurationMutation,
        async (beginMutation) => {
          const installed = await installPluginFromSource(
            source,
            skip,
            {
              agentsDir,
              beginConfigurationMutation: beginMutation,
              buildPlugin: (pluginDir, name) =>
                buildPlugin(pluginDir, name, logger),
              eventBus,
              logger,
              pluginsDir,
              projectHomeDir,
              settleProviderAdapterRetirements,
              reconcileEngineConnections,
              quiesceEventSubscriptions,
            },
            { consent: operatorDecision },
          );
          return installed;
        },
        { rediscoverSkills: true },
      );
      if (mutation.value.success) {
        try {
          refreshKitObservability?.();
        } catch (error: unknown) {
          logger.warn('Kit observability refresh failed after plugin install', {
            error: errorMessage(error),
          });
        }
      }
      return c.json(
        {
          ...mutation.value,
          success: mutation.activation?.status !== 'pending',
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      if (isContextSafetyError(error)) {
        return c.json(
          {
            success: false,
            error: error.message,
            findings: error.findings,
          },
          400,
        );
      }
      if (isPluginConsentRefusedError(error)) {
        // 400 and not 500: the request and the plugin disagree about what was
        // approved. Earlier dependency effects may already have been rolled
        // back. A 400 does not claim the request performed no earlier writes.
        // Failed rollback remains an aggregate and must not be reported as 400.
        logger.warn(
          'Plugin install refused: consent did not cover the source',
          {
            plugin: error.pluginName,
            reason: error.reason,
          },
        );
        return c.json(
          {
            success: false,
            // Through the route-catch sanitizer like every other outward
            // message here, not raw: this sentence names the plugin, and a
            // plugin's name comes from its own manifest.
            error: errorMessage(error),
            consent: {
              reason: error.reason,
              required: error.required,
              consented: error.consented,
            },
          },
          400,
        );
      }
      const lockCycle = findPluginContentLockCycleError(error);
      if (lockCycle) {
        // 409, not 500: this is refused concurrency, not a broken install.
        // Another plugin operation holds a content lock this one needs, and
        // the acquisition was refused rather than allowed to deadlock, so
        // retrying once that operation finishes is the right move. It says
        // nothing about what this request had already done before the
        // refusal — dependencies installed ahead of it are rolled back by the
        // install's own failure path, which is changed and reverted, not
        // untouched. A 500 with the sentence buried in it tells the operator
        // none of that.
        logger.warn('Plugin install refused: plugin content lock cycle', {
          plugins: lockCycle.plugins,
          cycle: lockCycle.cycle,
        });
        return c.json(
          {
            success: false,
            error: pluginContentLockCycleMessage(lockCycle),
            lockCycle: lockCycle.plugins,
          },
          409,
        );
      }
      logger.error('Plugin install failed', { error: errorMessage(error) });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });
}
