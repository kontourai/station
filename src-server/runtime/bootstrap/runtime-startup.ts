import { randomUUID } from 'node:crypto';
import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import {
  type OrchestrationUsageRef,
  UsageAggregator,
} from '../../analytics/usage-aggregator.js';
import { DEFAULT_OLLAMA_BASE_URL } from '../../constants.js';
import { startupDefaultSelection } from '../../telemetry/metrics.js';

interface RuntimeStartupLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

interface RuntimeStartupStorageAdapter {
  listProjects(): Array<{ slug: string }>;
  listProviderConnections(): any[];
  saveProviderConnection(connection: any): Promise<void>;
}

interface RuntimeStartupConfigLoader {
  loadPluginOverrides(): Promise<Record<string, any>>;
}

interface RuntimeStartupSkillService {
  discoverSkills(projectHomeDir: string, projectSlug?: string): Promise<void>;
}

interface RuntimeStartupContext {
  projectHomeDir: string;
  appConfig: {
    disableDefaultSkillRegistries?: boolean;
    region?: string;
  };
  storageAdapter: RuntimeStartupStorageAdapter;
  configLoader: RuntimeStartupConfigLoader;
  skillService: RuntimeStartupSkillService;
  logger: RuntimeStartupLogger;
  timers: NodeJS.Timeout[];
  createUsageAggregator?: (
    projectHomeDir: string,
    orchestrationUsageRef?: OrchestrationUsageRef,
  ) => UsageAggregator;
  /**
   * archive#3245: lifetime analytics' read of the orchestration substrate.
   * A REF, not an instance: `StationRuntime` builds a fresh
   * `OrchestrationService` on every reload while reusing this aggregator, so
   * a captured one would go stale against a closed event store.
   */
  orchestrationUsageRef?: OrchestrationUsageRef;
  setIntervalImpl?: typeof setInterval;
  runStartupMigrations?: (projectHomeDir: string) => Promise<void>;
  checkBedrockCredentials?: () => Promise<boolean>;
  checkOllamaAvailability?: () => Promise<boolean>;
  registerSkillRegistryProvider?: (provider: any) => void;
  createDefaultSkillRegistryProvider?: () => Promise<any>;
}

export async function checkOllamaAvailability(): Promise<boolean> {
  try {
    // Fast-fail: an unreachable Ollama host would otherwise hang the
    // /api/system/status check (and the app's first paint) on the default
    // fetch timeout.
    const response = await fetch(`${DEFAULT_OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function getActiveRuntimeProjectSlug(
  storageAdapter: Pick<RuntimeStartupStorageAdapter, 'listProjects'>,
): string | undefined {
  return storageAdapter.listProjects()[0]?.slug;
}

export function shouldRegisterRuntimeDefaultSkillRegistry(
  disableDefaultSkillRegistries: boolean | undefined,
  pluginOverrides: Record<string, any>,
): boolean {
  const pluginDisabled =
    pluginOverrides['aws-internal']?.settings?.disableDefaultSkillRegistries;
  return !disableDefaultSkillRegistries && !pluginDisabled;
}

export function initializeRuntimeUsageAggregator(
  projectHomeDir: string,
  timers: NodeJS.Timeout[],
  logger: RuntimeStartupLogger,
  createUsageAggregator: (
    projectHomeDir: string,
    orchestrationUsageRef?: OrchestrationUsageRef,
  ) => UsageAggregator = (homeDir, orchestrationUsageRef) =>
    new UsageAggregator(homeDir, orchestrationUsageRef),
  setIntervalImpl: typeof setInterval = setInterval,
  orchestrationUsageRef?: OrchestrationUsageRef,
): UsageAggregator {
  const usageAggregator = createUsageAggregator(
    projectHomeDir,
    orchestrationUsageRef,
  );
  logger.debug('Usage aggregator initialized');
  usageAggregator.fullRescan().catch(() => {});
  timers.push(
    setIntervalImpl(
      () => {
        usageAggregator.fullRescan().catch(() => {});
      },
      30 * 60 * 1000,
    ),
  );
  return usageAggregator;
}

export async function seedRuntimeDefaultProviderConnection(
  context: Pick<
    RuntimeStartupContext,
    'storageAdapter' | 'appConfig' | 'logger'
  > & {
    checkBedrockCredentials?: () => Promise<boolean>;
    checkOllamaAvailability?: () => Promise<boolean>;
  },
): Promise<void> {
  const existingProviders = context.storageAdapter.listProviderConnections();
  if (
    existingProviders.some((connection) =>
      connection.capabilities?.includes?.('llm'),
    )
  ) {
    startupDefaultSelection.add(1, {
      selected_provider: 'existing',
      selected_runtime: EXECUTION_MODE.STATION,
      fallback: false,
      reason: 'existing_llm_provider',
    });
    return;
  }

  // Detect Ollama but do NOT auto-write an enabled model connection.
  // Silent seed left dogfood with "Configured: Ollama needs attention" when
  // nothing was listening on 11434 later. Detection stays on system status /
  // Connections ("Add detected Ollama"); engines (Claude/Codex) remain the
  // PATH-adopt path. First-run onboarding should own enabling a model.
  try {
    const hasOllama = await (context.checkOllamaAvailability?.() ?? false);
    if (hasOllama) {
      context.logger.info(
        'Ollama is reachable; not auto-seeding a model connection (add via Connections or onboarding)',
        { baseUrl: DEFAULT_OLLAMA_BASE_URL },
      );
      startupDefaultSelection.add(1, {
        selected_provider: 'none',
        selected_runtime: EXECUTION_MODE.STATION,
        fallback: false,
        reason: 'ollama_detected_not_seeded',
      });
      // Fall through to Bedrock only when no LLM provider exists yet — Ollama
      // being up is a hint, not a configured chat path.
    }
  } catch (error) {
    context.logger.debug('Failed to check Ollama availability for seeding', {
      error,
    });
    startupDefaultSelection.add(1, {
      selected_provider: 'none',
      selected_runtime: EXECUTION_MODE.STATION,
      fallback: false,
      reason: 'ollama_detection_error',
    });
  }

  try {
    const hasCreds = await (context.checkBedrockCredentials?.() ?? false);
    if (!hasCreds) {
      startupDefaultSelection.add(1, {
        selected_provider: 'none',
        selected_runtime: EXECUTION_MODE.STATION,
        fallback: false,
        reason: 'no_detected_provider',
      });
      return;
    }

    await context.storageAdapter.saveProviderConnection({
      id: randomUUID(),
      type: 'bedrock',
      name: 'Amazon Bedrock',
      config: context.appConfig.region
        ? { region: context.appConfig.region }
        : {},
      enabled: true,
      capabilities: ['llm'],
    });
    context.logger.info('Seeded default Bedrock provider connection');
    startupDefaultSelection.add(1, {
      selected_provider: 'bedrock',
      selected_runtime: EXECUTION_MODE.STATION,
      fallback: true,
      reason: 'bedrock_credentials_detected',
    });
  } catch (error) {
    context.logger.debug('Failed to check Bedrock credentials for seeding', {
      error,
    });
    startupDefaultSelection.add(1, {
      selected_provider: 'none',
      selected_runtime: EXECUTION_MODE.STATION,
      fallback: false,
      reason: 'bedrock_detection_error',
    });
  }
}

export async function prepareRuntimeStartup(
  context: RuntimeStartupContext,
): Promise<UsageAggregator> {
  const activeProject = getActiveRuntimeProjectSlug(context.storageAdapter);
  const overrides = await context.configLoader.loadPluginOverrides();

  if (
    shouldRegisterRuntimeDefaultSkillRegistry(
      context.appConfig.disableDefaultSkillRegistries,
      overrides,
    )
  ) {
    const provider = await context.createDefaultSkillRegistryProvider?.();
    if (provider) {
      context.registerSkillRegistryProvider?.(provider);
    }
  }

  await context.skillService.discoverSkills(
    context.projectHomeDir,
    activeProject,
  );

  const usageAggregator = initializeRuntimeUsageAggregator(
    context.projectHomeDir,
    context.timers,
    context.logger,
    context.createUsageAggregator,
    context.setIntervalImpl,
    context.orchestrationUsageRef,
  );

  await context.runStartupMigrations?.(context.projectHomeDir);
  await seedRuntimeDefaultProviderConnection(context);

  return usageAggregator;
}
