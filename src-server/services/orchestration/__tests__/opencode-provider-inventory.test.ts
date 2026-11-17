/**
 * The `opencode` provider at the orchestration seams:
 *
 * - `GET /api/orchestration/providers` (`listProviders`) lists it only
 *   while the `opencode-native-engine` Feature Preview is on.
 * - Ruling R5′: every engine start (`assertAdapterReady`) is governed by the
 *   managed policy's `acp` entry for an `opencode` session.
 */
import { join } from 'node:path';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { OpenCodeAdapter } from '../../../providers/adapters/opencode-adapter.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { installManagedEngineLimits } from '../../../security/managed-engine-limits.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

function stubAcp(): ProviderAdapterShape {
  return {
    provider: 'acp',
    metadata: { displayName: 'ACP', description: '', capabilities: [] },
    listSessions: async () => [],
    getPrerequisites: async () => [],
  } as unknown as ProviderAdapterShape;
}

describe('provider inventory under the OpenCode preview', () => {
  const makeTempDir = trackTempDirs();
  let directory: string;
  let eventStore: EventStore;

  beforeEach(() => {
    directory = makeTempDir('opencode-inventory-');
    eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
  });

  afterEach(() => {
    eventStore.close();
  });

  async function providers(previewOn: boolean): Promise<string[]> {
    const openCode = new OpenCodeAdapter({
      getConnections: async () => [],
      createAcpAdapter: () =>
        ({
          provider: 'opencode',
          metadata: { displayName: 'inner', description: '', capabilities: [] },
          listSessions: async () => [],
          getPrerequisites: async () => [],
          streamEvents: () => ({ [Symbol.asyncIterator]: () => ({}) }),
        }) as unknown as ProviderAdapterShape,
      nativeEnabled: () => previewOn,
    });
    const adapters = [stubAcp(), openCode as unknown as ProviderAdapterShape];
    const registry: IProviderAdapterRegistry = {
      register() {},
      get: (provider) =>
        adapters.find((adapter) => adapter.provider === provider),
      list: () => adapters,
    };
    const service = new OrchestrationService({
      adapterRegistry: registry,
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const listed = await service.listProviders(INTERNAL_SESSION_READ_SCOPE);
    return listed.map((row) => row.provider);
  }

  test('preview off: no opencode row', async () => {
    expect(await providers(false)).toEqual(['acp']);
  });

  test('preview on: the opencode row is listed', async () => {
    expect(await providers(true)).toEqual(['acp', 'opencode']);
  });
});

describe('managed policy at an opencode engine start (R5′)', () => {
  const makeTempDir = trackTempDirs();
  let directory: string;
  let eventStore: EventStore;

  beforeEach(() => {
    directory = makeTempDir('opencode-policy-');
    eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
  });

  afterEach(() => {
    installManagedEngineLimits(null);
    eventStore.close();
  });

  function install(allowed: string[]) {
    const parsed = parseManagedPolicyDocument({
      schemaVersion: 1,
      organization: 'Acme',
      limits: { engines: { allowed } },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    installManagedEngineLimits({
      document: parsed.document,
      summary: summarizeManagedPolicy(parsed.document),
    });
  }

  test.each([
    [['acp'], true],
    [['acp', 'claude'], true],
    [['claude'], false],
    [['codex', 'muse'], false],
  ] as const)(
    'allowed %j: an opencode start runs: %s',
    async (allowed, runs) => {
      install([...allowed]);
      const startSession = vi.fn(async (input: { threadId: string }) => ({
        provider: 'opencode',
        threadId: input.threadId,
        status: 'ready',
        createdAt: '2026-11-13T00:00:00.000Z',
        updatedAt: '2026-11-13T00:00:00.000Z',
      }));
      const openCode = {
        provider: 'opencode',
        metadata: {
          displayName: 'OpenCode',
          description: '',
          capabilities: ['agent-runtime'],
          connectionBacking: 'acp-registry',
        },
        listSessions: async () => [],
        getPrerequisites: async () => [],
        startSession,
        streamEvents: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<never>(() => undefined),
          }),
        }),
      } as unknown as ProviderAdapterShape;
      const service = new OrchestrationService({
        adapterRegistry: {
          register() {},
          get: (provider) => (provider === 'opencode' ? openCode : undefined),
          list: () => [openCode],
        },
        eventBus: new EventBus(),
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const outcome = await service
        .dispatch({
          type: 'startSession',
          input: {
            threadId: 'thread-opencode',
            provider: 'opencode',
            metadata: { connectionId: 'opencode' },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      if (runs) {
        expect(outcome).toBeUndefined();
        expect(startSession).toHaveBeenCalledTimes(1);
      } else {
        expect(outcome).toMatchObject({
          code: 'managed-policy-engine-refused',
          message: expect.stringContaining('acp is not allowed'),
        });
        expect(startSession).not.toHaveBeenCalled();
      }
    },
  );
});
