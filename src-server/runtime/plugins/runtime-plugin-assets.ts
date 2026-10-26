import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import { migratePluginInstallTrustAtStartup } from '../../services/plugins/plugin-install-trust-migration.js';
import type { Logger } from '../../utils/logger.js';
import {
  loadRuntimePluginPrompts,
  loadRuntimePluginProviders,
} from './runtime-plugin-loader.js';

interface RuntimePluginAssetsContext {
  logger: Logger;
  projectHomeDir: string;
  packageMcpJournal?: PackageMcpAdmissionJournal;
  loadPluginOverrides: () => Promise<any>;
}

interface RuntimePluginAssetsDependencies {
  loadProviders?: typeof loadRuntimePluginProviders;
  loadPrompts?: typeof loadRuntimePluginPrompts;
  migrateInstallTrust?: typeof migratePluginInstallTrustAtStartup;
}

export async function loadRuntimePluginAssets(
  context: RuntimePluginAssetsContext,
  dependencies: RuntimePluginAssetsDependencies = {},
): Promise<void> {
  const loadProviders =
    dependencies.loadProviders ?? loadRuntimePluginProviders;
  const loadPrompts = dependencies.loadPrompts ?? loadRuntimePluginPrompts;
  const migrateInstallTrust =
    dependencies.migrateInstallTrust ?? migratePluginInstallTrustAtStartup;

  // #2998: grandfather every plugin installed before install trust records,
  // before anything loads. Logged and retried on failure; never blocks start.
  await migrateInstallTrust({
    ...(context.packageMcpJournal
      ? { packageMcpJournal: context.packageMcpJournal }
      : {}),
    logger: context.logger,
    projectHomeDir: context.projectHomeDir,
  });

  await loadProviders({
    packageMcpJournal: context.packageMcpJournal,
    logger: context.logger,
    projectHomeDir: context.projectHomeDir,
    loadPluginOverrides: context.loadPluginOverrides,
  });

  await loadPrompts({
    logger: context.logger,
    projectHomeDir: context.projectHomeDir,
  });
}
