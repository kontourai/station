/**
 * `GET /api/orchestration/providers` (`listProviders`) lists the `opencode`
 * provider only while the `opencode-native-engine` Feature Preview is on;
 * with it off the inventory is the base one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { OpenCodeAdapter } from '../../../providers/adapters/opencode-adapter.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
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
  let directory: string;
  let eventStore: EventStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'opencode-inventory-'));
    eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
  });

  afterEach(() => {
    eventStore.close();
    rmSync(directory, { recursive: true, force: true });
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
