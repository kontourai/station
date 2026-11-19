/**
 * Station orchestration instructions on the Claude system-prompt append
 * channel. These drive the real `ClaudeAdapter.startSession` and read the
 * options it hands the SDK `query()` and the `session.configured` receipt.
 */
import {
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
  type StationInstructionsReceipt,
} from '@kontourai/station-contracts/provider';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { confirmStationInstructionsDelivery } from '../adapters/capability-delivery-metadata.js';

const { mockQuery, mockFindCliBinaryAsync, mockRunCliCommand } = vi.hoisted(
  () => ({
    mockQuery: vi.fn(),
    mockFindCliBinaryAsync: vi.fn(),
    mockRunCliCommand: vi.fn(),
  }),
);

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => 'linux',
}));

vi.mock('../adapters/claude-code-spawn.js', async (importOriginal) => {
  const { fakeEngineProcessModule } = await import(
    './claude-engine-process-test-utils.js'
  );
  return fakeEngineProcessModule(
    await importOriginal<typeof import('../adapters/claude-code-spawn.js')>(),
  );
});

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const { withRecordedClaudeAsks } = await import(
    './claude-engine-process-test-utils.js'
  );
  return {
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    listSessions: vi.fn(),
    query: (args: { options?: unknown }) =>
      mockQuery(withRecordedClaudeAsks(args)),
  };
});

vi.mock('../auth/cli-auth.js', () => ({
  buildCliRuntimePrerequisites: vi.fn(),
  augmentedSpawnEnv: vi.fn(),
  findCliBinaryAsync: mockFindCliBinaryAsync,
  runCliCommand: mockRunCliCommand,
}));

import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';

const AUTHORED = 'You are a specialized writing assistant.';
const INSTRUCTIONS = '## Station orchestration\n\nUse delegate_task sparingly.';

const STATION_CONTROL = {
  id: 'station-control',
  transport: 'stdio' as const,
  command: 'node',
  args: [builtinStationControlServerPath()],
};
const THIRD_PARTY = {
  id: 'third-party',
  transport: 'stdio' as const,
  command: process.execPath,
  args: ['--version'],
};

const RECEIPT: StationInstructionsReceipt = {
  version: 1,
  sections: ['orchestration'],
  digest: 'sha256:fixture',
  channel: 'system-prompt-append',
};

function emptyQuery() {
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedModels: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
  };
}

/** Start a session and return the SDK options and the configured receipt. */
async function start(options: {
  systemPrompt?: string;
  toolServers: Array<Record<string, unknown>>;
  receipt?: StationInstructionsReceipt;
  stationInstructions?: string;
}) {
  mockQuery.mockReturnValue(emptyQuery());
  const adapter = new ClaudeAdapter();
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  await adapter.startSession({
    provider: 'claude',
    threadId: 'thread-station-instructions',
    ...(options.receipt
      ? {
          metadata: {
            [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
              stationInstructions: options.receipt,
            },
          },
        }
      : {}),
    agent: {
      slug: 'my-agent',
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.stationInstructions
        ? { stationInstructions: options.stationInstructions }
        : {}),
      toolServers: options.toolServers as never,
    },
  });
  await iterator.next(); // session.started
  const configured = (await iterator.next()).value;
  const queryOptions = mockQuery.mock.calls[0]![0].options as Record<
    string,
    unknown
  >;
  await adapter.stopAll();
  return {
    queryOptions,
    delivery: configured.metadata[SESSION_CAPABILITY_DELIVERY_METADATA_KEY] as {
      stationInstructions?: StationInstructionsReceipt;
    },
  };
}

describe('Claude station instructions append', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFindCliBinaryAsync.mockReset();
    mockFindCliBinaryAsync.mockResolvedValue(null);
    mockRunCliCommand.mockReset();
    mockRunCliCommand.mockResolvedValue(null);
  });
  afterEach(() => {
    mockQuery.mockReset();
  });

  test('appends the instructions after the authored prompt when station-control is delivered, and confirms the receipt', async () => {
    const { queryOptions, delivery } = await start({
      systemPrompt: AUTHORED,
      stationInstructions: INSTRUCTIONS,
      receipt: RECEIPT,
      toolServers: [STATION_CONTROL],
    });

    expect(queryOptions.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: `${AUTHORED}\n\n${INSTRUCTIONS}`,
    });
    expect(delivery.stationInstructions).toEqual({
      ...RECEIPT,
      delivered: true,
    });
  });

  test('does not append when station-control is not in the delivered servers, and records delivered false', async () => {
    const { queryOptions, delivery } = await start({
      systemPrompt: AUTHORED,
      stationInstructions: INSTRUCTIONS,
      receipt: RECEIPT,
      toolServers: [THIRD_PARTY],
    });

    expect(queryOptions.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: AUTHORED,
    });
    expect(delivery.stationInstructions).toEqual({
      ...RECEIPT,
      delivered: false,
    });
  });

  test('never creates a systemPrompt append from the instructions alone', async () => {
    const { queryOptions, delivery } = await start({
      stationInstructions: INSTRUCTIONS,
      receipt: RECEIPT,
      toolServers: [STATION_CONTROL],
    });

    expect('systemPrompt' in queryOptions).toBe(false);
    expect(delivery.stationInstructions).toEqual({
      ...RECEIPT,
      delivered: false,
    });
  });

  test('a session with no instructions keeps the authored prompt alone and invents no receipt', async () => {
    const { queryOptions, delivery } = await start({
      systemPrompt: AUTHORED,
      toolServers: [STATION_CONTROL],
    });

    expect(queryOptions.systemPrompt).toMatchObject({ append: AUTHORED });
    expect(delivery).not.toHaveProperty('stationInstructions');
  });
});

describe('confirmStationInstructionsDelivery', () => {
  test.each([true, false])(
    'sets delivered %s on an existing receipt only',
    (delivered) => {
      const metadata = {
        other: 1,
        [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
          agentSlug: 'a',
          stationInstructions: RECEIPT,
        },
      };

      const next = confirmStationInstructionsDelivery(metadata, delivered);

      expect(next).toEqual({
        other: 1,
        [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
          agentSlug: 'a',
          stationInstructions: { ...RECEIPT, delivered },
        },
      });
      expect(RECEIPT).not.toHaveProperty('delivered');
    },
  );

  test('returns metadata untouched when there is no receipt', () => {
    const noDelivery = { other: 1 };
    const noReceipt = {
      [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: { agentSlug: 'a' },
    };

    expect(confirmStationInstructionsDelivery(noDelivery, true)).toBe(
      noDelivery,
    );
    expect(confirmStationInstructionsDelivery(noReceipt, false)).toBe(
      noReceipt,
    );
    expect(confirmStationInstructionsDelivery(undefined, true)).toBeUndefined();
  });
});
