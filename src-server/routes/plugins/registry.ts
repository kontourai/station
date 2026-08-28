/**
 * Registry Routes — browse, install, and uninstall agents and tools
 * from pluggable registry providers.
 */

import { join } from 'node:path';
import { Hono } from 'hono';
import { unregisterPluginEngineConnections } from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import {
  getAgentRegistryProvider,
  getIntegrationRegistryProvider,
  getSkillRegistryProviders,
} from '../../providers/registries/registry.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import type { SkillService } from '../../services/agents/skill-service.js';
import {
  type StationKitMutationCandidate,
  type StationKitMutationRequest,
} from '../../services/kits/kit-observability-host.js';
import { StationKitObservabilityRegistry } from '../../services/kits/kit-observability-registry.js';
import { DistributionProfileService } from '../../services/plugins/distribution-profile-service.js';
import {
  findPluginContentLockCycleError,
  pluginContentLockCycleMessage,
} from '../../services/plugins/plugin-content-integrity.js';
import { registryOps } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  param,
  registryInstallSchema,
  skillInstallSchema,
  validate,
} from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from '../system/configuration-activation.js';
import {
  installPluginFromSource,
  type PluginLifecycleEventBus,
  readRegistryPluginAvailability,
  resolvePluginRegistryInstall,
  uninstallInstalledPlugin,
} from './plugin-install-shared.js';

interface RegistryRouteDeps {
  applyConfigurationMutation?: AgentConfigurationMutationRunner;
  approveKitOperatorAction?: (
    candidate: StationKitMutationCandidate,
  ) => boolean | Promise<boolean>;
  eventBus?: PluginLifecycleEventBus;
  kitObservabilityRegistry?: StationKitObservabilityRegistry;
  layoutCatalog?: DistributionProfileService;
  logger: Logger;
  settleProviderAdapterRetirements?: () => Promise<void>;
}

/** Remove display-only bracket qualifiers without a lazy wildcard regex.
 * Integration manifests are local project input, so this must make one pass
 * even when a malformed name contains many unclosed `[` characters. */
function stripDisplayNameQualifiers(value: string): string {
  const parts: string[] = [];
  let index = 0;
  let textStart = 0;
  while (index < value.length) {
    if (value[index] !== '[') {
      index += 1;
      continue;
    }

    const close = value.indexOf(']', index + 1);
    if (close === -1) {
      break;
    }
    parts.push(value.slice(textStart, index).trimEnd());
    index = close + 1;
    while (/\s/.test(value[index] ?? '')) index += 1;
    textStart = index;
  }
  parts.push(value.slice(textStart));
  return parts.join('').trim();
}

export function createRegistryRoutes(
  configLoader: ConfigLoader,
  refreshACPModes: () => Promise<void>,
  reloadSkills?: () => Promise<void>,
  skillService?: SkillService,
  deps?: RegistryRouteDeps,
) {
  const app = new Hono();
  const projectHomeDir = configLoader.getProjectHomeDir();
  const layoutCatalog =
    deps?.layoutCatalog ?? new DistributionProfileService(projectHomeDir);
  const pluginInstallDeps = deps
    ? {
        agentsDir: join(projectHomeDir, 'agents'),
        buildPlugin: async (pluginDir: string, name: string) => {
          const { buildPlugin } = await import('./plugin-bundles.js');
          return buildPlugin(pluginDir, name, deps.logger);
        },
        eventBus: deps.eventBus,
        logger: deps.logger,
        pluginsDir: join(projectHomeDir, 'plugins'),
        projectHomeDir,
        removeEngineConnections: (plugin: string) =>
          unregisterPluginEngineConnections(configLoader, plugin).then(
            () => undefined,
          ),
      }
    : null;
  const kitObservabilityRegistry = deps?.kitObservabilityRegistry;
  const refreshInstalledKits = () =>
    kitObservabilityRegistry?.discoverInstalled([
      join(projectHomeDir, 'kits'),
      join(projectHomeDir, 'plugins'),
    ]);

  // ── Portable Kit observability ──────────────────────────
  // Discovery only reads installed local composition. A catalog listing never
  // fetches, executes, or grants a Kit contribution.
  app.get('/kits', (c) => {
    if (!kitObservabilityRegistry) {
      return c.json({ success: true, data: [] });
    }
    return c.json({ success: true, data: kitObservabilityRegistry.list() });
  });

  app.get('/kits/:id/layout', (c) => {
    const contributionRef = param(c, 'id');
    // MCP app metadata is not ownership provenance. Until Station carries an
    // explicit Kit package/plugin -> integration binding, runtime layouts are
    // deliberately limited to the portable read-only standard views.
    const entry = kitObservabilityRegistry?.get(contributionRef);
    if (!entry) return c.json({ success: false, error: 'Kit not found' }, 404);
    // `mcpComponent`, when present, is the existing mcp-tool-ui contract that
    // LayoutRenderer already resolves through the hardened frame. Standard
    // views are intentionally data-only and read-only until a host surface
    // chooses their presentation.
    return c.json({
      success: true,
      data: {
        component: entry.experience.mcpComponent,
        standardViews: entry.experience.standardViews,
      },
    });
  });

  app.post('/kits/:id/disable', async (c) => {
    try {
      const data = await kitObservabilityRegistry?.disable(param(c, 'id'));
      if (!data) return c.json({ success: false, error: 'Kit not found' }, 404);
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/kits/:id/enable', async (c) => {
    try {
      const data = await kitObservabilityRegistry?.enable(param(c, 'id'));
      if (!data) return c.json({ success: false, error: 'Kit not found' }, 404);
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/kits/:id/actions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!isRecord(body) || typeof body.intent !== 'string') {
      return c.json(
        { success: false, error: 'A declared Kit action intent is required' },
        400,
      );
    }
    const registry = kitObservabilityRegistry;
    if (!registry)
      return c.json({ success: false, error: 'Kit not found' }, 404);
    const candidate = registry.prepareMutation(
      param(c, 'id'),
      body.intent as StationKitMutationRequest['intent'],
    );
    if ('allowed' in candidate) {
      return c.json({ success: false, data: candidate }, 403);
    }
    const approved =
      (await deps?.approveKitOperatorAction?.(candidate)) ?? false;
    // Re-resolve the immutable action identity after the asynchronous approval
    // before the caller can observe an approved action.
    const data = registry.confirmMutation(candidate, approved);
    const stale = data.reason.includes('changed while approval was pending');
    return c.json(
      { success: data.allowed, data },
      data.allowed ? 200 : stale ? 409 : 403,
    );
  });

  // ── Layout Catalog ─────────────────────────────────────
  // Listing is local-only. Registry sources are policy declarations and never
  // authorize a fetch, install, or plugin execution merely by being visible.
  app.get('/layouts', (c) => {
    registryOps.add(1, { operation: 'list-layouts', outcome: 'success' });
    return c.json({ success: true, data: layoutCatalog.listLayouts() });
  });

  app.get('/layouts/installed', (c) => {
    registryOps.add(1, {
      operation: 'list-layouts-installed',
      outcome: 'success',
    });
    return c.json({
      success: true,
      data: layoutCatalog.listInstalledLayouts(),
    });
  });

  app.post('/layouts/:id/enable', (c) => {
    try {
      const item = layoutCatalog.setEnabled(param(c, 'id'), true);
      registryOps.add(1, {
        operation: 'enable-layout',
        source: item.source,
        outcome: 'success',
      });
      return c.json({ success: true, data: item });
    } catch (error: unknown) {
      registryOps.add(1, { operation: 'enable-layout', outcome: 'rejected' });
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/layouts/:id/disable', (c) => {
    try {
      const item = layoutCatalog.setEnabled(param(c, 'id'), false);
      registryOps.add(1, {
        operation: 'disable-layout',
        source: item.source,
        outcome: 'success',
      });
      return c.json({ success: true, data: item });
    } catch (error: unknown) {
      registryOps.add(1, { operation: 'disable-layout', outcome: 'rejected' });
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/layouts/:id/install', (c) => {
    try {
      const item = layoutCatalog.getLayout(param(c, 'id'));
      if (!item)
        return c.json({ success: false, error: 'Layout not found' }, 404);
      if (item.source !== 'builtin') {
        return c.json(
          {
            success: false,
            error: 'Layout plugins install through an explicit plugin action',
          },
          409,
        );
      }
      const installed = layoutCatalog.installBuiltin(item.id);
      registryOps.add(1, {
        operation: 'install-layout',
        source: 'builtin',
        outcome: 'success',
      });
      return c.json({ success: true, data: installed });
    } catch (error: unknown) {
      registryOps.add(1, { operation: 'install-layout', outcome: 'rejected' });
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.delete('/layouts/:id', async (c) => {
    try {
      const item = layoutCatalog.getLayout(param(c, 'id'));
      if (!item)
        return c.json({ success: false, error: 'Layout not found' }, 404);
      if (item.source === 'builtin') {
        const removed = layoutCatalog.removeBuiltin(item.id);
        registryOps.add(1, {
          operation: 'remove-layout',
          source: 'builtin',
          outcome: 'success',
        });
        return c.json({ success: true, data: removed });
      }
      if (!pluginInstallDeps || !item.plugin) {
        return c.json(
          {
            success: false,
            error: 'Plugin lifecycle dependencies unavailable',
          },
          500,
        );
      }
      const removed = await uninstallInstalledPlugin(
        item.plugin,
        pluginInstallDeps,
      );
      registryOps.add(1, {
        operation: 'remove-layout',
        source: 'plugin',
        outcome: removed.success ? 'success' : 'failed',
      });
      return c.json(removed, removed.success ? 200 : 500);
    } catch (error: unknown) {
      registryOps.add(1, { operation: 'remove-layout', outcome: 'rejected' });
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // ── Agent Registry ─────────────────────────────────────

  app.get('/agents', async (c) => {
    registryOps.add(1, { operation: 'list-agents' });
    const items = await getAgentRegistryProvider().listAvailable();
    return c.json({ success: true, data: items });
  });

  app.get('/agents/installed', async (c) => {
    registryOps.add(1, { operation: 'list-agents-installed' });
    const items = await getAgentRegistryProvider().listInstalled();
    return c.json({ success: true, data: items });
  });

  app.post('/agents/install', validate(registryInstallSchema), async (c) => {
    const { id } = getBody(c);
    registryOps.add(1, { operation: 'install-agent', item: id });

    const result = await getAgentRegistryProvider().install(id);
    if (result.success) {
      // Refresh ACP modes so the new agent appears
      await refreshACPModes().catch(() => {});
    }
    return c.json(result, result.success ? 200 : 500);
  });

  app.delete('/agents/:id', async (c) => {
    const id = param(c, 'id');
    registryOps.add(1, { operation: 'uninstall-agent', item: id });
    const result = await getAgentRegistryProvider().uninstall(id);
    if (result.success) {
      await refreshACPModes().catch(() => {});
    }
    return c.json(result, result.success ? 200 : 500);
  });

  // ── Integration Registry ──────────────────────────────────────

  app.get('/integrations', async (c) => {
    registryOps.add(1, { operation: 'list-integrations' });
    const raw = await getIntegrationRegistryProvider().listAvailable();
    // Filter malformed entries, deduplicate, clean names
    const seen = new Set<string>();
    const items = raw
      .filter((i: any) => i.id && i.id.length > 2 && /^[a-z0-9]/.test(i.id))
      .filter((i: any) => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      })
      .map((i: any) => ({
        ...i,
        displayName: stripDisplayNameQualifiers(i.displayName || i.id),
        description:
          (i.description || '')
            .replace(/^#\s.*\n?/, '')
            .replace(/\\n/g, ' ')
            .trim() || undefined,
      }));
    return c.json({ success: true, data: items });
  });

  app.get('/integrations/installed', async (c) => {
    registryOps.add(1, { operation: 'list-integrations-installed' });
    const items = await getIntegrationRegistryProvider().listInstalled();
    return c.json({ success: true, data: items });
  });

  app.post(
    '/integrations/install',
    validate(registryInstallSchema),
    async (c) => {
      const { id } = getBody(c);
      registryOps.add(1, { operation: 'install-integration', item: id });

      const result = await getIntegrationRegistryProvider().install(id);
      if (!result.success) return c.json(result, 500);

      // Auto-generate integration.json from provider metadata
      const toolDef = await getIntegrationRegistryProvider().getToolDef(id);
      if (toolDef) {
        let existing:
          | Awaited<ReturnType<ConfigLoader['loadIntegration']>>
          | undefined;
        try {
          existing = await configLoader.loadIntegration(toolDef.id);
        } catch {
          // A first registry install has no prior Station-owned binding map.
        }
        if (Object.keys(existing?.secretEnvRefs ?? {}).length > 0) {
          return c.json(
            {
              success: false,
              error:
                'Unbind secret bindings before changing an integration execution configuration.',
            },
            409,
          );
        }
        const persisted = { ...toolDef, enabled: false };
        // Registry/provider metadata is untrusted relative to the operator
        // binding authority. It can never author a reference.
        delete persisted.secretEnvRefs;
        await configLoader.saveIntegration(toolDef.id, persisted);
      }

      return c.json(result);
    },
  );

  app.delete('/integrations/:id', async (c) => {
    const id = param(c, 'id');
    registryOps.add(1, { operation: 'uninstall-integration', item: id });
    const result = await getIntegrationRegistryProvider().uninstall(id);
    if (result.success) {
      await configLoader.deleteIntegration(id).catch(() => {});
    }
    return c.json(result, result.success ? 200 : 500);
  });

  app.post('/integrations/sync', async (c) => {
    await getIntegrationRegistryProvider().sync();
    return c.json({ success: true });
  });

  // ── Skill Registry ──────────────────────────────────────

  app.get('/skills', async (c) => {
    registryOps.add(1, { operation: 'list-skills' });
    const entries = getSkillRegistryProviders();
    if (entries.length === 0) return c.json({ success: true, data: [] });
    const results = await Promise.all(
      entries.map(async (e) => e.provider.listAvailable()),
    );
    const seen = new Set<string>();
    const data = results.flat().filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    return c.json({ success: true, data });
  });

  app.get('/skills/installed', async (c) => {
    registryOps.add(1, { operation: 'list-skills-installed' });
    const data = skillService ? skillService.listSkills() : [];
    return c.json({ success: true, data });
  });

  app.post('/skills/install', validate(skillInstallSchema), async (c) => {
    const { id } = getBody(c);
    registryOps.add(1, { operation: 'install-skill', item: id });
    if (!skillService)
      return c.json(
        { success: false, message: 'SkillService not available' },
        500,
      );
    const result = await skillService.installSkill(
      id,
      configLoader.getProjectHomeDir(),
    );
    if (result.success && reloadSkills) await reloadSkills().catch(() => {});
    return c.json(result, result.success ? 200 : 500);
  });

  app.delete('/skills/:id', async (c) => {
    const id = param(c, 'id');
    registryOps.add(1, { operation: 'uninstall-skill', item: id });
    if (!skillService)
      return c.json(
        { success: false, message: 'SkillService not available' },
        500,
      );
    const result = await skillService.removeSkill(
      id,
      configLoader.getProjectHomeDir(),
    );
    if (result.success && reloadSkills) await reloadSkills().catch(() => {});
    return c.json(result, result.success ? 200 : 500);
  });

  app.post('/skills/:id/update', async (c) => {
    const id = param(c, 'id');
    registryOps.add(1, { operation: 'update-skill', item: id });
    if (!skillService)
      return c.json(
        { success: false, message: 'SkillService not available' },
        500,
      );
    const unresult = await skillService.removeSkill(
      id,
      configLoader.getProjectHomeDir(),
    );
    if (!unresult.success) return c.json(unresult, 500);
    const result = await skillService.installSkill(
      id,
      configLoader.getProjectHomeDir(),
    );
    if (result.success && reloadSkills) await reloadSkills().catch(() => {});
    return c.json(result, result.success ? 200 : 500);
  });

  app.get('/skills/:id/content', async (c) => {
    const id = param(c, 'id');
    for (const { provider } of getSkillRegistryProviders()) {
      if (!provider.getContent) continue;
      const body = await provider.getContent(id);
      if (body) return c.json({ success: true, data: body });
    }
    return c.json({ success: false, error: 'Skill not found' }, 404);
  });

  // ── Plugin Registry ──────────────────────────────────────

  app.get('/plugins', async (c) => {
    registryOps.add(1, { operation: 'list-plugins' });
    const items = await readRegistryPluginAvailability(
      configLoader.getProjectHomeDir(),
    );
    return c.json({ success: true, data: items });
  });

  app.get('/plugins/installed', async (c) => {
    registryOps.add(1, { operation: 'list-plugins-installed' });
    const items = (
      await readRegistryPluginAvailability(configLoader.getProjectHomeDir())
    ).filter((item: any) => item.installed);
    return c.json({ success: true, data: items });
  });

  app.post('/plugins/install', validate(registryInstallSchema), async (c) => {
    const { id } = getBody(c);
    registryOps.add(1, { operation: 'install-plugin', item: id });
    if (!pluginInstallDeps) {
      return c.json(
        { success: false, message: 'Plugin install dependencies unavailable' },
        500,
      );
    }
    try {
      const registryInstall = await resolvePluginRegistryInstall(id);
      if (!registryInstall) {
        return c.json(
          { success: false, message: `Plugin '${id}' not found in registry` },
          404,
        );
      }
      const mutation = await captureConfigurationMutation(
        deps?.applyConfigurationMutation,
        async (beginMutation) => {
          const installed = await installPluginFromSource(
            registryInstall.source,
            [],
            { ...pluginInstallDeps, beginConfigurationMutation: beginMutation },
            {
              registryId: id,
              registryKey: registryInstall.registryKey,
              // archive#4288. This route installs on one click with no
              // preview and no prompt, so it holds no operator decision and
              // says so rather than passing a decision nobody made. The
              // installer refuses exactly what this route could not have
              // disclosed — a registry plugin deriving a consent-needing
              // permission — and leaves everything else alone. Closing the
              // rest of the gap means giving the Registry view the same
              // preview-then-approve flow the Plugins view has, which is its
              // own change.
              consent: {
                kind: 'no-operator-decision',
                caller: 'the plugin registry',
              },
            },
          );
          await deps?.settleProviderAdapterRetirements?.();
          return installed;
        },
      );
      if (mutation.value.success) {
        try {
          refreshInstalledKits();
        } catch (error: unknown) {
          deps?.logger?.warn(
            'Kit observability refresh failed after registry install',
            {
              error: errorMessage(error),
            },
          );
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
      // The same refusal the direct install route answers 409 to, through the
      // same derivation — this is the second route that can observe it, and
      // two routes describing one refusal differently is how the reader learns
      // not to trust either (archive#4309 follow-up).
      const lockCycle = findPluginContentLockCycleError(error);
      if (lockCycle) {
        deps?.logger?.warn(
          'Registry plugin install refused: plugin content lock cycle',
          { plugins: lockCycle.plugins, cycle: lockCycle.cycle },
        );
        return c.json(
          {
            success: false,
            message: pluginContentLockCycleMessage(lockCycle),
            lockCycle: lockCycle.plugins,
          },
          409,
        );
      }
      return c.json(
        {
          success: false,
          message: errorMessage(error),
        },
        error instanceof Error && error.message.includes('ambiguous')
          ? 400
          : 500,
      );
    }
  });

  app.delete('/plugins/:id', async (c) => {
    const id = param(c, 'id');
    registryOps.add(1, { operation: 'uninstall-plugin', item: id });
    if (!pluginInstallDeps) {
      return c.json(
        { success: false, message: 'Plugin install dependencies unavailable' },
        500,
      );
    }
    try {
      const mutation = await captureConfigurationMutation(
        deps?.applyConfigurationMutation,
        async (beginMutation) => {
          const removed = await uninstallInstalledPlugin(id, {
            ...pluginInstallDeps,
            beginConfigurationMutation: beginMutation,
          });
          await deps?.settleProviderAdapterRetirements?.();
          return removed;
        },
      );
      if (mutation.value.success) {
        try {
          refreshInstalledKits();
        } catch (error: unknown) {
          deps?.logger?.warn(
            'Kit observability refresh failed after registry removal',
            {
              error: errorMessage(error),
            },
          );
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
      const message =
        error instanceof Error
          ? errorMessage(error)
          : `No provider could uninstall ${id}`;
      return c.json(
        { success: false, message },
        message === 'Plugin not found' ? 404 : 500,
      );
    }
  });

  return app;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
