import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isContextSafetyError } from '../../services/orchestration/context-safety.js';
import { scanInstalledPluginInventory } from '../../services/plugins/installed-plugin-inventory.js';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import { scanPluginPromptGeneration } from '../../services/plugins/plugin-command-skill-source.js';
import { readPluginManifestFileSync } from '../../services/plugins/plugin-manifest-loader.js';
import { hasGrant } from '../../services/plugins/plugin-permissions.js';
import {
  capturePluginRuntimeArtifact,
  type PluginRuntimeArtifact,
} from '../../services/plugins/plugin-runtime-artifact.js';

interface RuntimeLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

interface RuntimePluginLoaderContext {
  logger: RuntimeLogger;
  projectHomeDir: string;
  loadPluginOverrides: () => Promise<any>;
  packageMcpJournal?: PackageMcpAdmissionJournal;
}

export async function loadRuntimePluginPrompts(
  context: Pick<RuntimePluginLoaderContext, 'logger' | 'projectHomeDir'>,
): Promise<void> {
  const pluginsDir = join(context.projectHomeDir, 'plugins');
  if (!existsSync(pluginsDir)) return;

  for (const name of readdirSync(pluginsDir)) {
    const manifestPath = join(pluginsDir, name, 'plugin.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    try {
      readPluginManifestFileSync(manifestPath);
      // Nothing is PUBLISHED any more — plugin prompt files are read in place
      // as command skills at discovery. What survives here is the boundary
      // check: a prompt source escaping the plugin root, a symlinked file, or
      // hidden-channel text is reported at boot rather than only when the
      // registry next rebuilds. Same scanner discovery uses, so the two cannot
      // disagree about what is unsafe.
      scanPluginPromptGeneration(join(pluginsDir, name), name);
    } catch (error) {
      if (isContextSafetyError(error)) {
        context.logger.warn(
          'Skipped unsafe plugin manifest during prompt load',
          {
            error: error.message,
            plugin: name,
          },
        );
      } else {
        context.logger.warn(
          'Skipped invalid plugin prompts during prompt load',
          {
            error: error instanceof Error ? error.message : String(error),
            plugin: name,
          },
        );
      }
    }
  }
}

export async function loadRuntimePluginProviders(
  context: RuntimePluginLoaderContext,
): Promise<void> {
  const pluginsDir = join(context.projectHomeDir, 'plugins');

  const { resolvePluginProviders } = await import(
    '../../providers/resolver.js'
  );
  const {
    capturePluginProviderGeneration,
    preparePluginProviderGeneration,
    publishPluginProviderGeneration,
  } = await import('../../providers/plugin-provider-loader.js');
  let prepared: Awaited<ReturnType<typeof preparePluginProviderGeneration>>;
  try {
    const overrides = await context.loadPluginOverrides();
    const artifacts = new Map<string, PluginRuntimeArtifact>();
    const {
      basis,
      candidates: { resolved, conflicts },
    } = await capturePluginProviderGeneration(context.projectHomeDir, () => {
      const names = new Set(
        scanInstalledPluginInventory(pluginsDir, context.logger).flatMap(
          (entry) => (entry.state === 'valid' ? [entry.manifest.name] : []),
        ),
      );
      const selected = context.packageMcpJournal?.selectedInstallations();
      if (selected?.state === 'unavailable')
        throw new Error('Plugin installation inventory unavailable.');
      for (const installed of selected?.installations ?? [])
        names.add(installed.pluginId);
      for (const name of [...names].sort()) {
        const artifact = capturePluginRuntimeArtifact(
          pluginsDir,
          name,
          context.packageMcpJournal,
        );
        if (artifact) artifacts.set(name, artifact);
      }
      return resolvePluginProviders(
        pluginsDir,
        overrides,
        (name) =>
          hasGrant(
            context.projectHomeDir,
            name,
            'providers.register',
            context.logger,
            artifacts.get(name),
          ),
        context.logger,
        [...artifacts.values()].map((artifact) => artifact.manifest),
      );
    });
    for (const conflict of conflicts) {
      context.logger.warn(
        'Provider conflict — multiple plugins provide singleton type',
        {
          type: conflict.type,
          layout: conflict.layout,
          candidates: conflict.candidates,
        },
      );
    }
    prepared = await preparePluginProviderGeneration(
      pluginsDir,
      resolved.map((entry) => ({
        pluginName: entry.pluginName,
        packageRoot: artifacts.get(entry.pluginName)!.packageRoot,
        visibility: {
          ready: () => {
            const artifact = artifacts.get(entry.pluginName)!;
            return (
              artifact.isCurrent() &&
              hasGrant(
                context.projectHomeDir,
                entry.pluginName,
                'providers.register',
                context.logger,
                artifact,
              )
            );
          },
          permits: () => false,
        },
        artifact: {
          ...artifacts.get(entry.pluginName)!,
          isCurrent: () => {
            const artifact = artifacts.get(entry.pluginName)!;
            return (
              artifact.isCurrent() &&
              hasGrant(
                context.projectHomeDir,
                entry.pluginName,
                'providers.register',
                context.logger,
                artifact,
              )
            );
          },
        },
        manifest: {
          name: entry.pluginName,
          version: '0.0.0',
          providers: [
            {
              type: entry.type,
              module: entry.module,
              layout: entry.layout,
            },
          ],
          displayName: entry.pluginName,
        },
      })),
      context.logger,
    );
    prepared = await publishPluginProviderGeneration(
      basis,
      prepared,
      artifacts,
    );
  } catch (error) {
    const failure = error as {
      pluginName?: unknown;
      providerType?: unknown;
    };
    context.logger.error(
      error instanceof Error ? error.message : 'Plugin provider staging failed',
      typeof failure.pluginName === 'string' &&
        typeof failure.providerType === 'string'
        ? { plugin: failure.pluginName, type: failure.providerType }
        : {},
    );
    return;
  }
  for (const entry of prepared) {
    context.logger.info('Registered plugin provider', {
      plugin: entry.source,
      type: entry.type,
    });
  }
}
