/**
 * The `opencode-native-engine` Feature Preview must not retire saved smoke
 * results: an ACP connection's smoke fingerprint keeps its base shape
 * (`{type:'acp', connection}`) unless an ACP-backed adapter claims the
 * connection right now (OpenCode with the preview on).
 */
import { createHash } from 'node:crypto';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { OpenCodeAdapter } from '../../../providers/adapters/opencode-adapter.js';
import { MemoryConnectionSmokeEvidenceStore } from '../connection-smoke-evidence-store.js';
import { createConnectionServiceForTest } from './connection-service-test-helper.js';

const OPENCODE: ACPConnectionConfig = {
  id: 'opencode',
  name: 'OpenCode',
  command: '/opt/opencode/bin/opencode',
  args: ['acp'],
  enabled: true,
};
const KIRO: ACPConnectionConfig = {
  id: 'kiro',
  name: 'Kiro',
  command: 'kiro-cli',
  args: ['acp'],
  enabled: true,
};

/** The base (pre-preview) fingerprint: sorted keys, `connection` then `type`. */
function baseFingerprint(connection: ACPConnectionConfig): string {
  const sorted = Object.fromEntries(
    Object.entries(connection).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return createHash('sha256')
    .update(JSON.stringify({ connection: sorted, type: 'acp' }))
    .digest('hex');
}

async function smokedFingerprint(
  connection: ACPConnectionConfig,
  previewOn: boolean,
): Promise<string | undefined> {
  const openCode = new OpenCodeAdapter({
    getConnections: async () => [OPENCODE, KIRO],
    createAcpAdapter: () =>
      ({
        provider: 'opencode',
        metadata: { displayName: 'inner', description: '', capabilities: [] },
      }) as unknown as ProviderAdapterShape,
    nativeEnabled: () => previewOn,
  });
  const store = new MemoryConnectionSmokeEvidenceStore();
  const service = createConnectionServiceForTest(
    {
      listProviderConnections: vi.fn(() => []),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn(),
    } as any,
    () => [openCode],
    async () => [structuredClone(OPENCODE), structuredClone(KIRO)],
    () => ({
      connections: [
        { id: 'opencode', status: 'available' },
        { id: 'kiro', status: 'available' },
      ],
    }),
    async () => ({}) as any,
    vi.fn(),
    undefined,
    store,
  );
  service.setSmokeRunner(
    vi.fn().mockResolvedValue({ ok: true, durationMs: 25 }),
  );
  await service.smokeConnection(connection.id, { confirmed: true });
  return store.get(connection.id)?.configurationFingerprint;
}

describe('ACP smoke fingerprint under the OpenCode preview', () => {
  test.each([false, true])(
    'a non-OpenCode connection keeps the base fingerprint (preview on: %s)',
    async (previewOn) => {
      expect(await smokedFingerprint(KIRO, previewOn)).toBe(
        baseFingerprint(KIRO),
      );
    },
  );

  test('OpenCode with the preview off keeps the base fingerprint', async () => {
    expect(await smokedFingerprint(OPENCODE, false)).toBe(
      baseFingerprint(OPENCODE),
    );
  });

  test('OpenCode with the preview on is fingerprinted with its runtime', async () => {
    expect(await smokedFingerprint(OPENCODE, true)).not.toBe(
      baseFingerprint(OPENCODE),
    );
  });
});
