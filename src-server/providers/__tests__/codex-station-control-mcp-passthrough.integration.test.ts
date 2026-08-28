/**
 * archive#1195 e2e (the Codex analog of archive#1157's own round-2 review fix):
 * end-to-end regression through the FULL seam a unit-level test of either
 * layer alone can't prove — a real (realistically-shaped) `station-control`
 * integration record, exactly as `runtime-default-agent.ts`'s
 * `createRuntimeSelfIntegration` persists it (env-bearing:
 * `STATION_API_BASE`/`STATION_PORT`), through `createSessionAgentResolver`
 * (`session-agent-resolution.ts`) and then `CodexAdapter`
 * (`codex-adapter.ts`), proving it reaches the spawn argv as a wire-safe
 * `-c mcp_servers.station-control.url=...` override — never env, never the
 * raw stdio command.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  ProviderSessionStartInput,
  SessionCapabilityDeliveryMetadata,
} from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../telemetry/metrics.js', () => ({
  adapterSessionStartDuration: { record: vi.fn() },
  appHomeSessions: { add: vi.fn() },
  providerOps: { add: vi.fn() },
  agentCapabilityUndelivered: { add: vi.fn() },
  codexToolServersDelivered: { add: vi.fn() },
}));

import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { createSessionAgentResolver } from '../../services/orchestration/session-agent-resolution.js';
import { resolveAcpPassthroughMcpServers } from '../adapters/acp-mcp-passthrough.js';
import { toPassthroughToolDef } from '../adapters/agent-tool-server-mapping.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';

class FakeWritable extends Writable {
  _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  kill(): boolean {
    this.emit('exit', 0);
    return true;
  }
}

async function flushIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function writeServerMessage(
  adapter: CodexAdapter,
  threadId: string,
  message: unknown,
): void {
  const transport = (adapter as any).transport;
  const record = transport.requireSession(threadId);
  transport.handleStdoutLine(record, JSON.stringify(message));
}

/**
 * Mirrors `runtime-default-agent.ts`'s `createRuntimeSelfIntegration` output
 * EXACTLY — this is what `configLoader.loadIntegration('station-control')`
 * actually returns in production (env-bearing), not a test-only env-less
 * fixture.
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

describe('station#1195 e2e: resolver → Codex adapter delivers the REAL station-control integration wire-safe', () => {
  test('a real env-bearing station-control record survives resolution for codex AND reaches the spawn argv as a -c mcp_servers.station-control.url override with a per-session token, never env', async () => {
    const resolver = createSessionAgentResolver({
      loadAgentSpec: async () => agentSpecWithStationControl(),
      resolveToolServer: async (id) =>
        id === 'station-control' ? realStationControlToolDef() : null,
      resolveSkillDir: async () => null,
    });

    const resolved = await resolver({
      threadId: 'thread-e2e-codex',
      provider: 'codex',
      metadata: { agentSlug: 'ops-agent' },
    });

    // Survives resolution — NOT secret-boundary-env, despite the real
    // toolDef carrying env (the same class of gap archive#1157's own round-2
    // review fix caught: a fixture that dodges the resolver's blanket
    // env filter never proves the exemption actually fires end to end).
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

    // Reaches the codex app-server spawn argv as a wire-safe URL+token
    // override — never the raw stdio command, never env.
    const processHandle = new FakeCodexProcess();
    let capturedEnv: Record<string, string> | undefined;
    let capturedArgs: string[] | undefined;
    const mintStationControlMcpAuth = vi.fn(
      (threadId: string) =>
        `http://127.0.0.1:4321/mcp/station-control?token=minted-for-${threadId}`,
    );
    const adapter = new CodexAdapter({
      processFactory: (env?: Record<string, string>, extraArgs?: string[]) => {
        capturedEnv = env;
        capturedArgs = extraArgs;
        return processHandle;
      },
      mintStationControlMcpAuth,
    } as any);

    const startSessionPromise = adapter.startSession(resolved);
    await flushIo();
    writeServerMessage(adapter, 'thread-e2e-codex', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-e2e-codex', {
      id: '2',
      result: { thread: { id: 'codex-thread-e2e' }, model: 'gpt-5-codex' },
    });
    await startSessionPromise;

    expect(mintStationControlMcpAuth).toHaveBeenCalledWith('thread-e2e-codex');
    expect(capturedArgs).toEqual([
      '-c',
      'mcp_servers.station-control.url="http://127.0.0.1:4321/mcp/station-control?token=minted-for-thread-e2e-codex"',
    ]);
    // The stale persisted port (9999) baked into the resolved record never
    // appears anywhere in the spawn call, and no env var carries it either
    // — this instance's own port (4321, via the mint closure) is the only
    // one that reaches the child.
    expect(JSON.stringify(capturedArgs)).not.toContain('9999');
    expect(JSON.stringify(capturedEnv ?? {})).not.toContain('STATION_API_BASE');
    expect(JSON.stringify(capturedEnv ?? {})).not.toContain('9999');

    await adapter.stopAll();
  });

  /**
   * archive#1684 REPLACES this case's original form ("...is STILL rejected
   * secret-boundary-env for ACP"). ACP's matrix cell now names its own
   * mechanism, so the SAME record is exempt at resolution for ACP exactly as
   * it is for Codex. What the original was really protecting — that nothing
   * env-shaped and no working station-control reaches an ACP wire without a
   * reviewed credential — is re-asserted below through the ACP delivery
   * layer, which is where the decision moved.
   */
  test('station#1684: the SAME real station-control record resolves for ACP too — and fails CLOSED at the ACP wire when no credential was minted', async () => {
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
    // The exemption never carries env — that rule is unchanged.
    expect(JSON.stringify(resolved)).not.toContain('STATION_API_BASE');
    expect(toolServersReport(resolved)?.undelivered).toEqual([]);

    // ...and the ACP wire itself, given no minted credential (the outcome
    // when the connected CLI does not advertise mcpCapabilities.http):
    const server = resolved.agent?.toolServers?.[0];
    if (!server) throw new Error('expected a resolved station-control server');
    const wire = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control'],
      resolveToolServer: async () => toPassthroughToolDef(server),
      stationControlUnavailable: {
        reason: 'engine-capability-absent',
        detail:
          'the connected engine did not advertise mcpCapabilities.http at initialize',
      },
      findAbsoluteBinary: () => '/usr/bin/node',
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });
    expect(wire.servers).toEqual([]);
    expect(wire.skipped).toEqual([
      {
        id: 'station-control',
        reason: 'engine-capability-absent',
        detail:
          'the connected engine did not advertise mcpCapabilities.http at initialize',
      },
    ]);
  });

  test('station#1684: with a minted credential the SAME record reaches the ACP wire as an http entry — token in the header, nothing else', async () => {
    const resolver = createSessionAgentResolver({
      loadAgentSpec: async () => agentSpecWithStationControl(),
      resolveToolServer: async (id) =>
        id === 'station-control' ? realStationControlToolDef() : null,
      resolveSkillDir: async () => null,
    });
    const resolved = await resolver({
      threadId: 'thread-e2e-acp-ok',
      provider: 'acp',
      metadata: { agentSlug: 'ops-agent' },
    });
    const server = resolved.agent?.toolServers?.[0];
    if (!server) throw new Error('expected a resolved station-control server');

    const wire = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control'],
      resolveToolServer: async () => toPassthroughToolDef(server),
      stationControlAuth: {
        url: 'http://127.0.0.1:4321/mcp/station-control',
        token: 'tok_e2e_acp',
      },
      logger: { warn: vi.fn() },
    });

    expect(wire.skipped).toEqual([]);
    expect(wire.servers).toEqual([
      {
        type: 'http',
        name: 'station-control',
        url: 'http://127.0.0.1:4321/mcp/station-control',
        headers: [{ name: 'Authorization', value: 'Bearer tok_e2e_acp' }],
      },
    ]);
    // The whole point of the header channel: never the raw stdio command,
    // never the persisted env, never a token in the URL.
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain('STATION_API_BASE');
    expect(serialized).not.toContain(builtinStationControlServerPath());
    expect(serialized).not.toContain('token=');
  });

  test('a third-party integration authored under the id "station-control" (wrong command/args) is NEVER exempt, even for codex, and never receives a minted token', async () => {
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
      provider: 'codex',
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
