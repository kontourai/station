/**
 * #3628: the runtime binds the `coordinator-session` preview, off by default,
 * and hands that one selector to the Claude adapter grant, its in-process
 * caller records, `initializeRuntime` and the route composition.
 */
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerFromToken,
} from '../../mcp/station-control-caller.js';
import {
  coordinatorGeneration,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { StationRuntime } from '../station-runtime.js';

class StopComposition extends Error {}
const composed = vi.hoisted(() => ({
  initialize: undefined as Record<string, unknown> | undefined,
  routes: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../runtime-initialize-deps.js', async (original) => ({
  ...(await original<typeof import('../runtime-initialize-deps.js')>()),
  createRuntimeInitializationDeps: (context: Record<string, unknown>) => {
    composed.initialize = context;
    throw new StopComposition();
  },
}));
vi.mock('../../routes/runtime-routes.js', async (original) => ({
  ...(await original<typeof import('../../routes/runtime-routes.js')>()),
  configureRuntimeRoutes: (context: Record<string, unknown>) => {
    composed.routes = context;
    throw new StopComposition();
  },
}));

const makeTempDir = trackTempDirs();
const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  setLevel: vi.fn(),
  getLevel: vi.fn(() => 'info' as const),
};
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function runtimeWithDesignation() {
  const home = makeTempDir('station-runtime-coordinator-');
  const registry = new FeaturePreviewRegistry(home, logger);
  const store = new EventStore(join(home, 'orchestration.sqlite'));
  stores.push(store);
  store.coordinatorStore().designate({
    conversationId: 'chat-a',
    actor: { userId: 'owner' },
    replace: false,
    now: 1,
  });
  const runtime = Object.create(StationRuntime.prototype) as any;
  runtime.featurePreviews = registry;
  runtime.logger = logger;
  runtime.orchestrationEventStore = store;
  runtime.orchestrationService = {
    resolveSessionActingPrincipal: () => ({
      id: 'owner',
      source: 'session-owner',
    }),
    firstStartedMetadataOfThread: () => undefined,
  };
  runtime.bindCoordinatorSessionPreview();
  return { runtime, registry, store };
}

describe('#3628 coordinator-session preview in the runtime', () => {
  test('is offered off, and the Claude adapter treats the designated chat as ordinary until it is on', async () => {
    const { runtime, registry } = runtimeWithDesignation();
    expect(registry.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'coordinator-session', enabled: false }),
      ]),
    );
    expect(runtime.isClaudeCoordinatorSession('chat-a')).toBe(false);
    await registry.setEnabled('coordinator-session', true);
    expect(runtime.isClaudeCoordinatorSession('chat-a')).toBe(true);
    await registry.setEnabled('coordinator-session', false);
    expect(runtime.isClaudeCoordinatorSession('chat-a')).toBe(false);
  });

  test('a designation-derived credential is refused while the preview is off', async () => {
    const { runtime, registry } = runtimeWithDesignation();
    runtime.storageAdapter = {
      getProject: () => {
        throw new Error('no projects');
      },
    };
    // The sources the in-process Claude, Codex and learning callers use.
    const resolver = createStationControlCallerRecordResolver(
      runtime.stationControlRecordSources(),
    );
    const generation = coordinatorGeneration('chat-a');
    const minted = mintStationControlMcpToken(
      'chat-a',
      'url-token',
      undefined,
      undefined,
      undefined,
      'coordinator-control',
      undefined,
      () => coordinatorGeneration('chat-a') === generation,
    );
    expect(resolveStationControlCallerFromToken(minted.token, resolver)).toBe(
      null,
    );
    await registry.setEnabled('coordinator-session', true);
    expect(
      resolveStationControlCallerFromToken(minted.token, resolver),
    ).toMatchObject({ sessionId: 'chat-a' });
  });

  test('initializeRuntime and the routes receive the bound selector', async () => {
    const runtime = new StationRuntime({
      projectHomeDir: makeTempDir('station-runtime-coordinator-compose-'),
      port: 43198,
      logLevel: 'error',
    }) as any;
    try {
      const bound = runtime.coordinatorSessionPreview;
      expect(bound).toBeDefined();
      // Composition stops at the captured call; the failed-start cleanup
      // that follows is not under test.
      await runtime.runInitialize(undefined).catch(() => {});
      expect(composed.initialize?.coordinatorSessionPreview).toBe(bound);
      runtime.stationEnvironmentId = 'station-test';
      runtime.runtimeSearch = { stop() {}, close: async () => {} };
      expect(() => runtime.configureRoutes(new Hono())).toThrow(
        StopComposition,
      );
      expect(composed.routes?.coordinatorSessionPreview).toBe(bound);
    } finally {
      runtime.runtimeSearch = undefined;
      await runtime.shutdown();
    }
  });
});
