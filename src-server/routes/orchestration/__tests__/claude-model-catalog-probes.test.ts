import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderSessionStartInput } from '@kontourai/station-contracts/provider';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
} from '../../../providers/adapter-shape.js';
import { ClaudeAdapter } from '../../../providers/adapters/claude-adapter.js';
import { CLAUDE_DEFAULT_MODEL } from '../../../providers/adapters/claude-models.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

/**
 * #2482, through the real `OrchestrationService`, the real picker route and
 * the real `ClaudeAdapter`: the only thing faked is the Agent SDK's `query()`,
 * which is where every Claude catalog probe spawns a Claude Code process. A
 * probe is a `query()` whose `supportedModels()` is called; a session is a
 * `query()` that carries a prompt stream and is never asked for models.
 */
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  query: mockQuery,
}));

// Never resolve or spawn the host's own `claude`: the test must not pass or
// fail on whether the developer's machine has one installed.
vi.mock('../../../providers/auth/cli-auth.js', () => ({
  buildCliRuntimePrerequisites: vi.fn(),
  augmentedSpawnEnv: vi.fn(),
  findCliBinaryAsync: vi.fn().mockResolvedValue(null),
  runCliCommand: vi.fn().mockResolvedValue(null),
}));

const catalogProbes: Array<{ supportedModels: ReturnType<typeof vi.fn> }> = [];

function sdkQuery() {
  const handle = {
    async *[Symbol.asyncIterator]() {},
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedModels: vi.fn(async () => {
      catalogProbes.push(handle);
      // Answer on a later tick so concurrent readers genuinely overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [{ value: 'sonnet', displayName: 'Sonnet' }];
    }),
    close: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
  };
  return handle;
}

const roots: string[] = [];
const stores: EventStore[] = [];

beforeEach(() => {
  catalogProbes.length = 0;
  mockQuery.mockReset();
  mockQuery.mockImplementation(() => sdkQuery());
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function serviceFor(adapter: ProviderAdapterShape) {
  const root = mkdtempSync(join(tmpdir(), 'station-claude-catalog-probes-'));
  roots.push(root);
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  stores.push(store);
  return new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
}

test('a Claude start with its default model spawns no catalog probe', async () => {
  const service = serviceFor(new ClaudeAdapter());

  await service.dispatch({
    type: 'startSession',
    input: { threadId: 'claude-default-start', provider: 'claude' },
  });

  expect(catalogProbes).toHaveLength(0);
  // The one `query()` is the session itself, launched with the default.
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockQuery.mock.calls[0]![0].options.model).toBe(CLAUDE_DEFAULT_MODEL);
  await service.shutdown();
});

test('a Claude start and turn naming a model spawn no catalog probe', async () => {
  const service = serviceFor(new ClaudeAdapter());

  await service.dispatch({
    type: 'startSession',
    input: {
      threadId: 'claude-named-start',
      provider: 'claude',
      modelId: 'opus',
    },
  });
  expect(catalogProbes).toHaveLength(0);
  expect(mockQuery.mock.calls.at(-1)![0].options.model).toBe('opus');
  await service.dispatch({
    type: 'sendTurn',
    input: {
      threadId: 'claude-named-start',
      input: 'hello',
      modelId: 'haiku',
    },
  });

  expect(catalogProbes).toHaveLength(0);
  await service.shutdown();
});

test('ten concurrent picker requests share one Claude catalog probe', async () => {
  const service = serviceFor(new ClaudeAdapter());
  const app = createOrchestrationRoutes(service, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
  });

  const responses = await Promise.all(
    Array.from({ length: 10 }, () => app.request('/providers/claude/models')),
  );

  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: [{ id: 'sonnet', name: 'Sonnet', originalId: 'sonnet' }],
    });
  }
  expect(catalogProbes).toHaveLength(1);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  await service.shutdown();
});

/** An adapter whose catalog rewrites a public alias to a dated wire id. */
class RewritingCatalogAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'claude adapter whose catalog rewrites aliases',
    capabilities: ['agent-runtime'],
    defaultModel: 'sonnet',
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
  readonly listModels = vi.fn(async () => [
    { id: 'sonnet', name: 'Sonnet', originalId: 'claude-sonnet-4-6-20260701' },
  ]);
  readonly started: ProviderSessionStartInput[] = [];

  override async startSession(input: ProviderSessionStartInput) {
    this.started.push(input);
    const now = new Date().toISOString();
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      createdAt: now,
      updatedAt: now,
    };
  }
}

test('an adapter whose catalog rewrites aliases still validates and rewrites', async () => {
  const adapter = new RewritingCatalogAdapter();
  const service = serviceFor(adapter);

  await service.dispatch({
    type: 'startSession',
    input: { threadId: 'rewriting-start', provider: 'claude' },
  });

  expect(adapter.listModels).toHaveBeenCalledTimes(1);
  expect(adapter.started[0]?.modelId).toBe('claude-sonnet-4-6-20260701');
  await service.shutdown();
});
