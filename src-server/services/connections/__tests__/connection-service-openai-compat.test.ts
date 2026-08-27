/**
 * Delta2 review H1 — an explicit Test Connection against a REAL
 * `OpenAICompatLLMProvider` and a real HTTP endpoint.
 *
 * Every other check-evidence test in this suite drives fake providers through
 * a mocked `createLLMProvider`, so none of them could see that
 * `OpenAICompatLLMProvider.healthCheck()` answered `res.ok` on
 * `GET /v1/models` — a status line, not a catalogue. A stub returning `200`
 * with an empty list or a non-catalogue body was therefore "healthy", and the
 * explicit test recorded `passed` off that boolean without ever asking the
 * classified catalogue/chat probe.
 *
 * These tests use the real factory, the real provider, the real ai-sdk chat
 * path and a loopback server, so the only thing faked is the provider's own
 * responses.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import type { ILLMProvider } from '../../../providers/llm/model-provider-types.js';
import { createConnectionServiceForTest } from './connection-service-test-helper.js';

interface StubBehaviour {
  /** What `GET /v1/models` answers. */
  models:
    | { status: 200; body: unknown }
    | { status: number; body?: unknown; text?: string };
  /** What `POST /v1/chat/completions` answers. */
  chat: 'stream' | { status: number; body: unknown };
}

const CHAT_STREAM = [
  `data: ${JSON.stringify({
    id: 'probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stub-model',
    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
  })}\n\n`,
  `data: ${JSON.stringify({
    id: 'probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stub-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`,
  'data: [DONE]\n\n',
].join('');

const servers: Server[] = [];

async function startStub(
  behaviour: StubBehaviour,
): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/v1/models')) {
      const { status } = behaviour.models;
      if ('text' in behaviour.models && behaviour.models.text !== undefined) {
        res.writeHead(status, { 'content-type': 'text/html' });
        res.end(behaviour.models.text);
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(behaviour.models.body ?? {}));
      return;
    }
    if (req.url?.startsWith('/v1/chat/completions')) {
      req.resume();
      if (behaviour.chat === 'stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.end(CHAT_STREAM);
        return;
      }
      res.writeHead(behaviour.chat.status, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify(behaviour.chat.body));
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

function serviceFor(config: Record<string, unknown>) {
  const connection = {
    id: 'compat-1',
    type: 'openai-compat',
    name: 'Local endpoint',
    enabled: true,
    capabilities: ['llm'],
    config,
  };
  const providerService = {
    listProviderConnections: () => [connection],
    saveProviderConnection: async () => undefined,
    deleteProviderConnection: async () => undefined,
    // Mirrors `ProviderService.checkHealth` minus its metric: the provider's
    // own health contract, nothing added. The point of these tests is what
    // that contract answers for a real OpenAI-compatible endpoint.
    checkHealth: async (provider: ILLMProvider) =>
      (await provider.healthCheck?.()) ?? false,
  } as any;
  return createConnectionServiceForTest(
    providerService,
    () => [] as any,
    async () => [],
    () => ({ connections: [] }),
    async () => ({}) as any,
    async (updates: any) => updates,
  );
}

describe('OpenAI-compatible Test Connection (delta2 review H1)', () => {
  test('a 200 with an empty catalogue cannot pass on the health boolean alone', async () => {
    const { baseUrl, requests } = await startStub({
      models: { status: 200, body: { object: 'list', data: [] } },
      chat: { status: 401, body: { error: { message: 'no key' } } },
    });
    const service = serviceFor({ baseUrl, defaultModel: 'stub-model' });

    const result = await service.testConnection('compat-1');

    expect(result.healthy).toBe(false);
    // It reached the chat route rather than stopping at `200 OK` on /models.
    expect(requests.some((entry) => entry.includes('/chat/completions'))).toBe(
      true,
    );
    // …and the listing that follows re-runs discovery, whose empty catalogue
    // is `catalog-unavailable` — the weakest observation there is. It must not
    // replace the refusal the operator's own test just recorded, or the
    // connection silently stops being gated.
    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check?.status).toBe('failed');
    expect(view.readinessEvidence?.level).toBe('discovered');
    expect(service.checkGatedModelConnectionIds()).toEqual(
      new Map([['compat-1', 'failed']]),
    );
  });

  test('a 200 with an empty catalogue earns Ready only from a working chat', async () => {
    const { baseUrl } = await startStub({
      models: { status: 200, body: { object: 'list', data: [] } },
      chat: 'stream',
    });
    const service = serviceFor({ baseUrl, defaultModel: 'stub-model' });

    const result = await service.testConnection('compat-1');

    expect(result.healthy).toBe(true);
    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check).toMatchObject({
      status: 'passed',
      source: 'explicit-test',
    });
  });

  test('a 200 whose body is not a catalogue is reachable, never Ready, without a chat proof', async () => {
    const { baseUrl } = await startStub({
      models: { status: 200, text: '<html>hello</html>' },
      chat: 'stream',
    });
    // No default model: the chat probe has nothing to send, so nothing can
    // establish chat readiness and the endpoint stays reachable-not-ready.
    const service = serviceFor({ baseUrl });

    const result = await service.testConnection('compat-1');

    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('Set a default model');
    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check?.status).toBe('catalog-unavailable');
    expect(view.readinessEvidence?.level).not.toBe('catalog-ready');
    // Reachable is not refused: it must stay recommendable.
    expect(service.checkGatedModelConnectionIds().size).toBe(0);
  });

  test('a real catalogue still passes on the first request', async () => {
    const { baseUrl, requests } = await startStub({
      models: {
        status: 200,
        body: { object: 'list', data: [{ id: 'stub-model' }] },
      },
      chat: { status: 500, body: { error: { message: 'never asked' } } },
    });
    const service = serviceFor({ baseUrl, defaultModel: 'stub-model' });

    const result = await service.testConnection('compat-1');

    expect(result.healthy).toBe(true);
    expect(requests.some((entry) => entry.includes('/chat/completions'))).toBe(
      false,
    );
  });

  test('a 404 catalogue route with working chat earns Ready', async () => {
    const { baseUrl } = await startStub({
      models: { status: 404, body: { error: 'not found' } },
      chat: 'stream',
    });
    const service = serviceFor({ baseUrl, defaultModel: 'stub-model' });

    const result = await service.testConnection('compat-1');

    expect(result.healthy).toBe(true);
    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check).toMatchObject({
      status: 'passed',
      source: 'explicit-test',
    });
  });
});
