import {
  AgentSideConnection,
  type Client,
  ClientSideConnection,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { describe, expect, test, vi } from 'vitest';
import type {
  ACPProcess,
  ACPProcessOptions,
} from '../../services/acp/acp-process.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';

/**
 * Wire-level proof for the inbound (agent→client) ACP extension policy.
 *
 * The unit tests in
 * `src-server/services/acp/__tests__/acp-inbound-extension-policy.test.ts`
 * prove the handler throws. That is not the same claim as *an agent receives
 * a JSON-RPC `-32601`*: between the two sits the ACP SDK's dispatcher, which
 * turns a thrown `RequestError` into its own code and anything else into
 * `-32603`. And neither claim proves the ADAPTER is wired to the policy at
 * all — the defect being fixed was precisely a wiring line.
 *
 * So this file takes the Client object `AcpAdapter` actually built for a live
 * session, attaches it to a real `ClientSideConnection` over a real
 * ndjson stream pair, and has a real `AgentSideConnection` on the other end
 * make the request Kiro is evidenced making.
 *
 * Nothing here reads an inbound error code to infer support: Station emits
 * `-32601` and never derives anything from what a peer emits (Kiro under
 * `--agent-engine v3` answers `-32603` for unknown methods; under the
 * default engine it answers `-32601` for methods it documents). See
 * ADR 0013.
 */

/** Cross-connected in-memory ndjson streams: one for each side. */
function createStreamPair() {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    clientStream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
    agentStream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
  };
}

const CONNECTIONS: ACPConnectionConfig[] = [
  { id: 'kiro', name: 'Kiro', command: 'kiro-cli', args: [], enabled: true },
];

/**
 * Minimal ACPProcess stand-in. Its only job is to invoke `createClient`
 * during `start()` exactly as the real one does, so the test holds the
 * adapter's own Client.
 */
class ClientCapturingProcess {
  client!: Client;
  readonly initResult = {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true } },
  };
  constructor(readonly opts: ACPProcessOptions) {}
  async start() {
    this.client = this.opts.createClient(undefined as never);
    return this.initResult;
  }
  async newSession() {
    return {
      sessionId: 'native-kiro',
      modes: { availableModes: [], currentModeId: 'default' },
      configOptions: [],
    };
  }
  async destroy() {}
}

async function adapterClientForLiveSession(): Promise<{
  client: Client;
  warn: ReturnType<typeof vi.fn>;
  events: CanonicalRuntimeEvent[];
  stop: () => Promise<void>;
}> {
  const warn = vi.fn();
  let captured: ClientCapturingProcess | undefined;
  const adapter = new AcpAdapter({
    getConnections: async () => CONNECTIONS,
    logger: { debug: () => {}, warn, error: () => {}, info: () => {} },
    processFactory: (opts) => {
      captured = new ClientCapturingProcess(opts);
      return captured as unknown as ACPProcess;
    },
  });
  const events: CanonicalRuntimeEvent[] = [];
  const drained = (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  await adapter.startSession({
    provider: 'acp',
    threadId: 'inbound-extension-wire',
    cwd: '/tmp/project',
    metadata: { connectionId: 'kiro' },
  });
  if (!captured?.client) throw new Error('adapter did not build a Client');
  return {
    client: captured.client,
    warn,
    events,
    stop: async () => {
      await adapter.stopAll();
      await drained;
    },
  };
}

describe('inbound ACP extension requests reach the wire as -32601', () => {
  test("Kiro's token-refresh callback is refused, not answered", async () => {
    const { client, warn, stop } = await adapterClientForLiveSession();
    const { clientStream, agentStream } = createStreamPair();
    // The client end serves the ADAPTER's own Client — the object under test.
    new ClientSideConnection(() => client, clientStream);
    const agent = new AgentSideConnection(() => ({}) as never, agentStream);

    // `_kiro/auth/getAccessToken` — Kiro's host-mediated token-refresh
    // callback (kirodotdev/Kiro#10416). Under `--agent-engine v3` it is
    // sent to the CLIENT twice before `initialize` is answered; under the
    // default engine it fires lazily on token expiry. Before this change
    // it received `{}` — an empty object handed back AS the refreshed
    // token, which Station never computed.
    let thrown: { code?: number; message?: string } | undefined;
    try {
      await agent.extMethod('_kiro/auth/getAccessToken', {});
    } catch (error) {
      thrown = error as { code?: number; message?: string };
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe(-32601);
    expect(String(thrown?.message)).toContain('_kiro/auth/getAccessToken');
    // ...and the refusal is observable without an OTLP collector.
    expect(
      warn.mock.calls.some(
        (call) =>
          (call[0] as { method?: string } | undefined)?.method ===
          '_kiro/auth/getAccessToken',
      ),
    ).toBe(true);

    await stop();
  });

  test('a non-credential unknown request is refused the same way', async () => {
    const { client, stop } = await adapterClientForLiveSession();
    const { clientStream, agentStream } = createStreamPair();
    new ClientSideConnection(() => client, clientStream);
    const agent = new AgentSideConnection(() => ({}) as never, agentStream);

    // Also observed inbound live (ADR 0013). Refused for the ordinary
    // reason, with the same code — a probing agent learns nothing.
    await expect(
      agent.extMethod('_kiro/terminal/shell_type', {}),
    ).rejects.toMatchObject({ code: -32601 });

    await stop();
  });

  test('an unrecognized NOTIFICATION is still ignored, not refused', async () => {
    // The spec says SHOULD ignore. This is existing behavior; it is asserted
    // here so the refusal change cannot silently take notifications with it.
    const { client, stop } = await adapterClientForLiveSession();
    const { clientStream, agentStream } = createStreamPair();
    new ClientSideConnection(() => client, clientStream);
    const agent = new AgentSideConnection(() => ({}) as never, agentStream);

    await expect(
      agent.extNotification('_kiro.dev/mcp/server_init_failure', {
        server: 'whatever',
      }),
    ).resolves.toBeUndefined();

    // A request on the same connection still refuses — proves the connection
    // is live and the notification's silence was ignoring, not a dead pipe.
    await expect(
      agent.extMethod('_kiro.dev/mcp/server_init_failure', {}),
    ).rejects.toMatchObject({ code: -32601 });

    await stop();
  });
});

describe('a refused CREDENTIAL request is legible to the user', () => {
  test('emits one actionable runtime.warning per session per method', async () => {
    const { client, events, stop } = await adapterClientForLiveSession();
    const { clientStream, agentStream } = createStreamPair();
    new ClientSideConnection(() => client, clientStream);
    const agent = new AgentSideConnection(() => ({}) as never, agentStream);

    // Kiro under `--agent-engine v3` sends this twice before `initialize`.
    await expect(
      agent.extMethod('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      agent.extMethod('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });

    const warnings = events.filter(
      (event) =>
        event.method === 'runtime.warning' &&
        (event as { code?: string }).code === 'acp.credential-request-refused',
    );
    // Deduped: one warning, not one per request.
    expect(warnings).toHaveLength(1);
    const message = (warnings[0] as { message: string }).message;
    // Actionable, not a bare method-not-found: it names what was asked for,
    // that Station holds no such credential, and what the user can do.
    expect(message).toContain('token refresh');
    expect(message).toContain('never supplies one');
    expect(message).toContain('sign in with its own CLI');
    expect(message).toContain('start a new chat');
    // It must NOT assert a diagnosis Station did not compute.
    expect(message).not.toContain('your token expired');
    // The method name rides `details`, not the toast body — the warning
    // surfaces as a 5s toast (turnHandlers.ts) plus a session-diagnostics
    // row, NOT a transcript message, so the body stays readable in 5s.
    expect(
      (warnings[0] as { details?: Record<string, unknown> }).details,
    ).toMatchObject({
      method: '_kiro/auth/getAccessToken',
      connectionId: 'kiro',
    });

    await stop();
  });

  test('an ordinary unknown method raises no user-facing warning', async () => {
    // Surfacing every refusal would train users to ignore the one that
    // matters. `_kiro/terminal/shell_type` is a routine protocol non-event.
    const { client, events, stop } = await adapterClientForLiveSession();
    const { clientStream, agentStream } = createStreamPair();
    new ClientSideConnection(() => client, clientStream);
    const agent = new AgentSideConnection(() => ({}) as never, agentStream);

    await expect(
      agent.extMethod('_kiro/terminal/shell_type', {}),
    ).rejects.toMatchObject({ code: -32601 });

    expect(
      events.filter(
        (event) =>
          (event as { code?: string }).code ===
          'acp.credential-request-refused',
      ),
    ).toHaveLength(0);

    await stop();
  });
});
