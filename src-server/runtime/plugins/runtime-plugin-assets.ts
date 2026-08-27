import type { Logger } from '../../utils/logger.js';
import {
  loadRuntimePluginPrompts,
  loadRuntimePluginProviders,
} from './runtime-plugin-loader.js';

interface RuntimePluginAssetsContext {
  logger: Logger;
  projectHomeDir: string;
  loadPluginOverrides: () => Promise<any>;
}

interface RuntimePluginAssetsDependencies {
  loadProviders?: typeof loadRuntimePluginProviders;
  loadPrompts?: typeof loadRuntimePluginPrompts;
}

export async function loadRuntimePluginAssets(
  context: RuntimePluginAssetsContext,
  dependencies: RuntimePluginAssetsDependencies = {},
): Promise<void> {
  const loadProviders =
    dependencies.loadProviders ?? loadRuntimePluginProviders;
  const loadPrompts = dependencies.loadPrompts ?? loadRuntimePluginPrompts;

  await loadProviders({
    logger: context.logger,
    projectHomeDir: context.projectHomeDir,
    loadPluginOverrides: context.loadPluginOverrides,
  });

  await loadPrompts({
    logger: context.logger,
    projectHomeDir: context.projectHomeDir,
  });
}
