import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isContextSafetyError } from '../../services/orchestration/context-safety.js';
import { scanPluginPromptGeneration } from '../../services/plugins/plugin-command-skill-source.js';
import { readPluginManifestFileSync } from '../../services/plugins/plugin-manifest-loader.js';
import { hasGrant } from '../../services/plugins/plugin-permissions.js';

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

  const { replacePluginProviders } = await import(
    '../../providers/registries/registry.js'
  );
  if (!existsSync(pluginsDir)) {
    await replacePluginProviders([]);
    return;
  }

  const { resolvePluginProviders } = await import(
    '../../providers/resolver.js'
  );
  const { preparePluginProviderGeneration } = await import(
    '../../providers/plugin-provider-loader.js'
  );

  const overrides = await context.loadPluginOverrides();
  const { resolved, conflicts } = resolvePluginProviders(
    pluginsDir,
    overrides,
    // Fail-closed, non-throwing: when the grants store is unavailable this
    // DENIES the grant for every plugin and logs at error level, rather than
    // aborting provider loading wholesale or silently allowing (#1835).
    (pluginName) =>
      hasGrant(
        context.projectHomeDir,
        pluginName,
        'providers.register',
        context.logger,
      ),
    context.logger,
  );

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

  let prepared: Awaited<ReturnType<typeof preparePluginProviderGeneration>>;
  try {
    prepared = await preparePluginProviderGeneration(
      pluginsDir,
      resolved.map((entry) => ({
        pluginName: entry.pluginName,
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
    await replacePluginProviders(prepared);
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
