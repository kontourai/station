import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { FileMemoryAdapter } from '../adapters/file/memory-adapter.js';
import { ConfigLoader } from '../domain/config-loader.js';
import { MonitoringEmitter } from '../monitoring/emitter.js';
import type { RuntimeContext } from '../runtime/types.js';
import { ApprovalRegistry } from '../services/approvals/approval-registry.js';
import { FeedbackService } from '../services/feedback/feedback-service.js';
import { EventBus } from '../services/orchestration/event-bus.js';
import { createLogger } from '../utils/logger.js';

/** Typed partial services fail on an unexpected dependency instead of inventing behavior. */
function fixture<T extends object>(members: Partial<T>): T {
  return new Proxy(members as T, {
    get(target, key, receiver) {
      if (!(key in target))
        throw new Error(`Chat fixture does not supply ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}
export function createChatRuntimeFixture(
  home: string,
  memory: FileMemoryAdapter,
  overrides: Partial<RuntimeContext> = {},
): RuntimeContext {
  const logger = createLogger({ name: 'durable-chat-test', level: 'error' });
  const eventBus = new EventBus();
  const monitoringEvents = new EventEmitter();
  return fixture<RuntimeContext>({
    activeAgents: new Map(),
    agentSpecs: new Map(),
    agentTools: new Map(),
    agentHooksMap: new Map(),
    memoryAdapters: new Map([['assistant', memory]]),
    toolNameMapping: new Map(),
    agentFixedTokens: new Map(),
    agentStatus: new Map(),
    agentStats: new Map(),
    metricsLog: [],
    modelCatalog: undefined,
    configLoader: new ConfigLoader({ projectHomeDir: home }),
    appConfig: {
      defaultModel: 'scripted',
      invokeModel: 'scripted',
      structureModel: 'scripted',
    },
    approvalRegistry: new ApprovalRegistry(logger, { eventBus }),
    eventBus,
    logger,
    feedbackService: new FeedbackService(join(home, 'feedback')),
    monitoringEvents,
    monitoringEmitter: new MonitoringEmitter(monitoringEvents, async () => {}),
    providerService: fixture<RuntimeContext['providerService']>({
      listProviderConnections: () => [],
      getLaunchabilityRevision: () => 0,
    }),
    getAgentConfigurationRevision: () => 0,
    commitAgentConfigurationRead: async (_expected, operation) => operation(),
    getNormalizedToolName: (name) => name,
    getOriginalToolName: (name) => name,
    ...overrides,
  });
}
