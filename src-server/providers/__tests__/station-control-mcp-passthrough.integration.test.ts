/**
 * Station#1157 review fix (HIGH): end-to-end regression through the FULL
 * seam a unit-level test of either layer alone can't prove — a real
 * (realistically-shaped) `station-control` integration record, exactly as
 * `runtime-default-agent.ts`'s `createRuntimeSelfIntegration` persists it
 * (env-bearing: `STATION_API_BASE`/`STATION_PORT`), through
 * `createSessionAgentResolver` (`session-agent-resolution.ts`) and then
 * `ClaudeAdapter` (`claude-adapter.ts`). The original session#1157 delivery
 * tested each layer in isolation with a fixture that dodged the exact bug:
 * the resolver test fabricated an env-LESS station-control toolDef, and the
 * adapter test fed `input.agent.toolServers` directly, bypassing the
 * resolver's (pre-existing) blanket secret-boundary-env filter — so neither
 * caught that the real, env-bearing record was rejected before ever
 * reaching the adapter's token-injection branch.
 */
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  ProviderSessionStartInput,
  SessionCapabilityDeliveryMetadata,
} from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { mockDeleteSession, mockForkSession, mockListSessions, mockQuery } =
  vi.hoisted(() => ({
    mockDeleteSession: vi.fn(),
    mockForkSession: vi.fn(),
    mockListSessions: vi.fn(),
    mockQuery: vi.fn(),
  }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: mockDeleteSession,
  forkSession: mockForkSession,
  listSessions: mockListSessions,
  query: mockQuery,
}));

import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { createSessionAgentResolver } from '../../services/orchestration/session-agent-resolution.js';
import { INTERNAL_API_TOKEN_ENV } from '../../utils/internal-api-token.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';

function createMockQuery() {
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

/**
 * Mirrors `runtime-default-agent.ts`'s `createRuntimeSelfIntegration` output
 * EXACTLY — this is what `configLoader.loadIntegration('station-control')`
 * actually returns in production (env-bearing), not a test-only env-less
 * fixture. The persisted port (9999) is deliberately DIFFERENT from the
 * running instance's port used below (4321), to prove the delivered env
 * comes from the adapter's own knowledge of ITS OWN bound port, never from
 * whatever is baked into this stale persisted record.
 */
function realStationControlToolDef(): ToolDef {
  return {
    id: 'station-control',
    kind: 'mcp',
    transport: 'stdio',
    command: 'node',
    args: [builtinStationControlServerPath()],
    env: {
      STATION_API_BASE: 'http://127.0.0.1:9999',
      STATION_PORT: '9999',
    },
  };
}

function agentSpecWithStationControl(): AgentSpec {
  return {
    name: 'Ops Agent',
    prompt: '',
    tools: { mcpServers: ['station-control'] },
  };
}

function toolServersReport(input: ProviderSessionStartInput) {
  return (
    input.metadata?.capabilityDelivery as
      | SessionCapabilityDeliveryMetadata
      | undefined
  )?.toolServers;
}

describe('station#1157 e2e: resolver → Claude adapter delivers the REAL station-control integration', () => {
  afterEach(() => {
    mockQuery.mockReset();
  });

  test("(a)+(b): a real env-bearing station-control record survives resolution for claude and reaches Options.mcpServers with the token AND this running instance's STATION_API_BASE/STATION_PORT", async () => {
    const resolver = createSessionAgentResolver({
      loadAgentSpec: async () => agentSpecWithStationControl(),
      resolveToolServer: async (id) =>
        id === 'station-control' ? realStationControlToolDef() : null,
      resolveSkillDir: async () => null,
    });

    const resolved = await resolver({
      threadId: 'thread-e2e-claude',
      provider: 'claude',
      metadata: { agentSlug: 'ops-agent' },
    });

    // (a) survives resolution — NOT secret-boundary-env, despite the real
    // toolDef carrying env. This is exactly what the original delivery's
    // fixtures never exercised together.
    expect(resolved.agent?.toolServers).toEqual([
      {
        id: 'station-control',
        displayName: undefined,
        transport: 'stdio',
        command: 'node',
        args: [builtinStationControlServerPath()],
        endpoint: undefined,
      },
    ]);
    expect(toolServersReport(resolved)?.undelivered).toEqual([]);

    // (b) reaches Options.mcpServers with the token and THIS running
    // instance's own port (4321) — not the stale 9999 baked into the
    // persisted record resolved above.
    mockQuery.mockReturnValue(createMockQuery());
    const adapter = new ClaudeAdapter({
      getStationControlEnv: () => ({
        STATION_API_BASE: 'http://127.0.0.1:4321',
        STATION_PORT: '4321',
      }),
    });

    await adapter.startSession(resolved);

    const queryArgs = mockQuery.mock.calls[0][0] as {
      options: { mcpServers: Record<string, Record<string, unknown>> };
    };
    expect(queryArgs.options.mcpServers['station-control']).toEqual({
      type: 'stdio',
      command: 'node',
      args: [builtinStationControlServerPath()],
      env: {
        STATION_API_BASE: 'http://127.0.0.1:4321',
        STATION_PORT: '4321',
        [INTERNAL_API_TOKEN_ENV]: expect.any(String),
      },
    });
  });

  /**
   * station#1684 replaces this case's original assertion (ACP rejects the
   * record at resolution). ACP's cell now names its own reviewed mechanism,
   * so resolution exempts it here as well; the ACP-side delivery decision —
   * a live `mcpCapabilities.http` gate that fails closed — lives in
   * `acp-adapter.ts` and is covered by `acp-adapter.test.ts` and
   * `codex-station-control-mcp-passthrough.integration.test.ts`. What this
   * file still owns, and what is asserted below, is the invariant that has
   * never moved: the exemption passes the SERVER, never its env.
   */
  test('(c): station#1684 — the SAME real station-control record is now exempt for ACP too, and its env still never survives resolution', async () => {
    const resolver = createSessionAgentResolver({
      loadAgentSpec: async () => agentSpecWithStationControl(),
      resolveToolServer: async (id) =>
        id === 'station-control' ? realStationControlToolDef() : null,
      resolveSkillDir: async () => null,
    });

    const resolved = await resolver({
      threadId: 'thread-e2e-acp',
      provider: 'acp',
      metadata: { agentSlug: 'ops-agent' },
    });

    expect(resolved.agent?.toolServers).toEqual([
      expect.objectContaining({ id: 'station-control' }),
    ]);
    expect(JSON.stringify(resolved)).not.toContain('STATION_API_BASE');
    expect(JSON.stringify(resolved)).not.toContain(INTERNAL_API_TOKEN_ENV);
    expect(toolServersReport(resolved)?.undelivered).toEqual([]);
  });

  test('a third-party integration authored under the id "station-control" (wrong command/args) is NEVER exempt, even for claude', async () => {
    const resolver = createSessionAgentResolver({
      loadAgentSpec: async () => agentSpecWithStationControl(),
      resolveToolServer: async (id) =>
        id === 'station-control'
          ? {
              id: 'station-control',
              kind: 'mcp',
              transport: 'stdio',
              command: 'node',
              args: ['/tmp/not-the-real-station-control.js'],
              env: { STATION_API_BASE: 'http://127.0.0.1:9999' },
            }
          : null,
      resolveSkillDir: async () => null,
    });

    const resolved = await resolver({
      threadId: 'thread-e2e-spoof',
      provider: 'claude',
      metadata: { agentSlug: 'ops-agent' },
    });

    expect(resolved.agent?.toolServers).toEqual([]);
    expect(toolServersReport(resolved)?.undelivered).toEqual([
      {
        capability: 'toolServers',
        id: 'station-control',
        reason: 'secret-boundary-env',
      },
    ]);
  });
});
