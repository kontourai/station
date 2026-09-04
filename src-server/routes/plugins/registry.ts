/**
 * Registry Routes — browse, install, and uninstall agents and tools
 * from pluggable registry providers.
 */

import { join } from 'node:path';
import { type Context, Hono } from 'hono';
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
import {
  isPluginConsentRefusedError,
  type PluginInstallConsent,
} from '../../services/plugins/plugin-install-consent.js';
import { registryOps } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  param,
  registryInstallSchema,
  registryPluginInstallSchema,
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
      const mutation = await captureConfigurationMutation(
        deps?.applyConfigurationMutation,
        async (beginMutation) =>
          uninstallInstalledPlugin(item.plugin!, {
            ...pluginInstallDeps,
            beginConfigurationMutation: beginMutation,
          }),
        { rediscoverSkills: true },
      );
      registryOps.add(1, {
        operation: 'remove-layout',
        source: 'plugin',
        outcome: mutation.value.success ? 'success' : 'failed',
      });
      return c.json(
        {
          ...mutation.value,
          success: mutation.activation?.status !== 'pending',
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
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

  app.post(
    '/agents/install',
    validate(registryPluginInstallSchema),
    async (c) => {
      const body = getBody(c);
      const { id } = body;
      registryOps.add(1, { operation: 'install-agent', item: id });

      // A JSON-manifest registry serves the same catalog through the agent
      // face and the plugin face (`register-manifest-registry.ts`), so an id
      // this surface offers can be a PLUGIN — code contributions, a build
      // step, a consent basis. Installing that through the provider's raw
      // tree copy skipped all three: the tree landed without `dist/bundle.js`
      // and its layout components could never register (#765 D1). An id the
      // plugin registry resolves takes the one complete install path;
      // anything else remains a plain provider install, exactly as before.
      if (pluginInstallDeps) {
        let registryPlugin: { source: string } | null = null;
        try {
          registryPlugin = await resolvePluginRegistryInstall(id);
        } catch (error: unknown) {
          return c.json({ success: false, message: errorMessage(error) }, 500);
        }
        if (registryPlugin) {
          return installRegistryPlugin(c, body);
        }
      }

      const result = await getAgentRegistryProvider().install(id);
      if (result.success) {
        // Refresh ACP modes so the new agent appears
        await refreshACPModes().catch(() => {});
      }
      return c.json(result, result.success ? 200 : 500);
    },
  );

  app.delete('/agents/:id', async (c) => {
    const id = param(c, 'id');
    registryOps.add(1, { operation: 'uninstall-agent', item: id });

    // Mirror of the install branch above: a registry PLUGIN installed through
    // the full pipeline wrote agent definitions, grants, and integrations,
    // and the provider's raw uninstall (delete tree, drop alias) would leave
    // all of that behind. The shared uninstall removes what the shared
    // install created. An id the plugin registry does not resolve falls
    // through to the provider, exactly as before.
    if (pluginInstallDeps) {
      let registryPlugin: { source: string } | null = null;
      try {
        registryPlugin = await resolvePluginRegistryInstall(id);
      } catch (error: unknown) {
        return c.json({ success: false, message: errorMessage(error) }, 500);
      }
      if (registryPlugin) {
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
            { rediscoverSkills: true },
          );
          if (mutation.value.success) {
            try {
              refreshInstalledKits();
            } catch (error: unknown) {
              deps?.logger?.warn(
                'Kit observability refresh failed after registry removal',
                { error: errorMessage(error) },
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
      }
    }

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

  /**
   * The one registry install path for PLUGINS, whichever catalog face listed
   * them. A JSON-manifest registry serves its plugin catalog through the
   * agent-registry surface too (`register-manifest-registry.ts`), and the
   * agent install route used to answer that with the provider's raw tree
   * copy: no `buildPlugin`, no consent gate, no `plugins:installed` event.
   * The copy "succeeded", `dist/bundle.js` never existed, and every layout
   * component the plugin declared rendered as "Unsupported layout tab"
   * forever (#765 D1). Routing both faces here means a registry plugin is
   * either installed completely — built, consent-checked, announced — or
   * refused with a sentence that says what to do, never half-installed.
   */
  const installRegistryPlugin = async (
    c: Context,
    body: {
      id: string;
      skip?: string[];
      consent?: {
        permissions: string[];
        contentDigest: string;
        dependencies?: string[];
        dependencyApprovals?: Array<{
          id: string;
          permissions: string[];
          contentDigest: string;
          dependencies: string[];
        }>;
      };
    },
  ) => {
    const { id, skip, consent: consentBody } = body;
    if (!pluginInstallDeps) {
      return c.json(
        { success: false, message: 'Plugin install dependencies unavailable' },
        500,
      );
    }
    // archive#4288. Without a decision in the request this route installs on
    // one click with no preview and no prompt, so it holds no operator
    // decision and says so rather than passing a decision nobody made — the
    // installer then refuses exactly what such a caller could not have
    // disclosed. The Registry view closes that gap the same way the Plugins
    // view does: it previews the resolved source and carries the operator's
    // answer here, bound to the digest of the bytes that were shown.
    const consent: PluginInstallConsent = consentBody
      ? {
          kind: 'operator-decision',
          permissions: consentBody.permissions,
          contentDigest: consentBody.contentDigest,
          dependencies: consentBody.dependencies ?? [],
          ...(consentBody.dependencyApprovals
            ? { dependencyApprovals: consentBody.dependencyApprovals }
            : {}),
        }
      : {
          kind: 'no-operator-decision',
          caller: 'the plugin registry',
        };
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
            skip ?? [],
            { ...pluginInstallDeps, beginConfigurationMutation: beginMutation },
            {
              registryId: id,
              registryKey: registryInstall.registryKey,
              consent,
            },
          );
          await deps?.settleProviderAdapterRetirements?.();
          return installed;
        },
        { rediscoverSkills: true },
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
          // Activation can only narrow a successful install. It must never
          // turn the installer's `success: false` into a 200/success response:
          // that false success makes Registry optimistically mark the card
          // installed even though the next inventory read remains empty.
          success:
            mutation.value.success && mutation.activation?.status !== 'pending',
          ...configurationActivationPayload(mutation.activation),
        },
        mutation.value.success
          ? configurationMutationStatus(mutation.activation, 200)
          : 500,
      );
    } catch (error: unknown) {
      // Same refusal, same shape as the direct install route: the request and
      // the plugin disagree about what was approved. Earlier dependency effects
      // may have been compensated; failed rollback is not a simple consent 400.
      if (isPluginConsentRefusedError(error)) {
        deps?.logger?.warn(
          'Registry plugin install refused: consent did not cover the source',
          { plugin: error.pluginName, reason: error.reason },
        );
        return c.json(
          {
            success: false,
            message: errorMessage(error),
            consent: {
              reason: error.reason,
              required: error.required,
              consented: error.consented,
            },
          },
          400,
        );
      }
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
  };

  app.post(
    '/plugins/install',
    validate(registryPluginInstallSchema),
    async (c) => {
      const body = getBody(c);
      registryOps.add(1, { operation: 'install-plugin', item: body.id });
      return installRegistryPlugin(c, body);
    },
  );

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
        { rediscoverSkills: true },
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
