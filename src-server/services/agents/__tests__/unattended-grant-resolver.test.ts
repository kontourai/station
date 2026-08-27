import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  unattendedGrantStoreUnavailable: { add: vi.fn() },
  unattendedGrantUses: { add: vi.fn() },
  pluginGrantsStoreCorruption: { add: vi.fn() },
  unattendedGrantOperations: { add: vi.fn() },
}));

vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLockAsync: (
        lock: string,
        options?: Parameters<typeof actual.acquireFileMutationLockAsync>[1],
      ) =>
        actual.acquireFileMutationLockAsync(lock, {
          ...options,
          birthFingerprint: () => 'unattended-grant-resolver-test',
        }),
    };
  },
);

import {
  unattendedGrantStoreUnavailable,
  unattendedGrantUses,
} from '../../../telemetry/metrics.js';
import { makeUnattendedGrantResolver } from '../unattended-grant-resolver.js';
import {
  principalKey,
  UnattendedGrantStore,
  unattendedGrantStorePath,
} from '../unattended-grant-store.js';

const homes: string[] = [];
const tool = {
  toolName: 'station-control_create_project',
  toolArgs: {},
} as any;
const voice = {
  kind: 'voice' as const,
  agentSlug: 'planner',
  sessionId: 'voice-session-1',
};

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'station-unattended-resolver-'));
  homes.push(home);
  const store = new UnattendedGrantStore(home);
  const logger = { debug: vi.fn(), error: vi.fn() };
  return {
    store,
    logger,
    resolve: makeUnattendedGrantResolver(store, { logger }),
  };
}

afterEach(() => {
  vi.mocked(unattendedGrantUses.add).mockClear();
  vi.mocked(unattendedGrantStoreUnavailable.add).mockClear();
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('makeUnattendedGrantResolver', () => {
  test('allows only the recorded non-revoked exact principal/tool grant', async () => {
    const { store, resolve } = setup();
    await store.grantTool(principalKey(voice), tool.toolName, 'operator');

    await expect(
      resolve(tool, { agentSlug: 'planner', unattendedPrincipal: voice }),
    ).resolves.toBe(true);
    await expect(
      resolve(
        { ...tool, toolName: 'station-control_delete_project' },
        { agentSlug: 'planner', unattendedPrincipal: voice },
      ),
    ).resolves.toBe(false);
    await expect(
      resolve(tool, {
        agentSlug: 'other',
        unattendedPrincipal: { ...voice, agentSlug: 'other' },
      }),
    ).resolves.toBe(false);
    await expect(resolve(tool, { agentSlug: 'planner' })).resolves.toBe(false);

    await store.revokeGrant(principalKey(voice), tool.toolName);
    await expect(
      resolve(tool, { agentSlug: 'planner', unattendedPrincipal: voice }),
    ).resolves.toBe(false);
  });

  test('records a granted use with the bounded principalKind label only', async () => {
    const { store, logger, resolve } = setup();
    await store.grantTool(principalKey(voice), tool.toolName, 'operator');

    await expect(
      resolve(tool, { agentSlug: 'planner', unattendedPrincipal: voice }),
    ).resolves.toBe(true);

    expect(unattendedGrantUses.add).toHaveBeenCalledWith(1, {
      principalKind: 'voice',
    });
    expect(unattendedGrantUses.add).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ toolName: expect.anything() }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'unattended grant authorized tool execution',
      expect.objectContaining({
        toolName: tool.toolName,
        principalKind: 'voice',
      }),
    );
  });

  test('fails closed, logs, and records a bounded counter when the store is corrupt', async () => {
    const { logger, resolve } = setup();
    mkdirSync(join(homes.at(-1)!, 'security'));
    writeFileSync(unattendedGrantStorePath(homes.at(-1)!), '{not json');

    await expect(
      resolve(tool, { agentSlug: 'planner', unattendedPrincipal: voice }),
    ).resolves.toBe(false);

    expect(logger.error).toHaveBeenCalledWith(
      'unattended grant store unavailable; denying',
      { toolName: tool.toolName, principalKind: 'voice' },
    );
    expect(unattendedGrantStoreUnavailable.add).toHaveBeenCalledWith(1, {
      principalKind: 'voice',
    });
  });
});
