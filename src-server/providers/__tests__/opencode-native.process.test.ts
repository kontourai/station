/**
 * The native OpenCode transport against a real OpenCode 2.x: the real
 * `OpenCodeAdapter`, server pool and `opencode serve` child, with fresh
 * HOME/XDG directories and a local OpenAI-compatible model that answers with
 * text or one scripted shell call. A governed (Ask) session must ask before
 * the shell runs, take a decline, and keep working.
 *
 * Optional: it needs a 2.x binary whose API Station verified, from
 * `STATION_TEST_OPENCODE_2_BINARY` or PATH. Without one it skips loudly,
 * with the reason in its title; it never passes without running.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { ProviderAdapterShape } from '../adapter-shape.js';
import { OpenCodeAdapter } from '../adapters/opencode-adapter.js';
import { realOpenCode2, warnSkipped } from './opencode-real-binary.js';

const real = await realOpenCode2();
warnSkipped('OpenCode native transport', real);

type Event = CanonicalRuntimeEvent & Record<string, unknown>;

function lastUserText(body: {
  messages?: Array<{ role: string; content: unknown }>;
}): { role: string; text: string } {
  const last = body.messages?.at(-1);
  const content = last?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === 'string' ? part : String(part?.text ?? ''),
            )
            .join('\n')
        : '';
  return { role: last?.role ?? '', text };
}

/** An OpenAI-compatible streaming model: a shell call for DO_BASH, else text. */
function startMockModel(): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1' }] }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    const tools: string[] = (body.tools ?? []).map(
      (tool: { function?: { name?: string } }) => tool.function?.name,
    );
    const last = lastUserText(body);
    const base = { id: 'c', object: 'chat.completion.chunk', model: 'mock-1' };
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const call =
      last.role === 'user' &&
      last.text.includes('DO_BASH') &&
      tools.includes('shell');
    const text =
      last.role === 'tool' ? 'shell finished' : `native reply: ${last.text}`;
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Mock title' },
              finish_reason: 'stop',
            },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    send({ role: 'assistant', content: '' });
    if (call) {
      send({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: {
              name: 'shell',
              arguments: JSON.stringify({
                command: 'echo native-probe',
                description: 'probe',
              }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
    } else {
      send({ content: text });
      send({}, 'stop');
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
}

describe.skipIf(!real.binary)(
  `OpenCode over its own server, real engine${real.skip ? ` (SKIPPED: ${real.skip})` : ` ${real.version}`}`,
  () => {
    const makeTempDir = trackTempDirs({ lifetime: 'file' });
    let model: http.Server;
    let adapter: OpenCodeAdapter;
    let project: string;
    const events: Event[] = [];
    let pump: Promise<void>;

    async function waitFor(
      predicate: (event: Event) => boolean,
      timeoutMs = 60_000,
    ): Promise<Event> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline)
          throw new Error(
            `timed out; saw ${events.map((event) => event.method).join(', ')}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    beforeAll(async () => {
      model = await startMockModel();
      const port = (model.address() as AddressInfo).port;
      const root = realpathSync(makeTempDir('opencode-native-'));
      const home = join(root, 'home');
      project = join(root, 'project');
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_STATE_HOME: join(home, 'state'),
        XDG_CACHE_HOME: join(home, 'cache'),
        TMPDIR: join(root, 'tmp'),
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
      };
      for (const dir of [
        join(home, 'config', 'opencode'),
        join(home, 'data'),
        join(home, 'state'),
        join(home, 'cache'),
        join(root, 'tmp'),
        project,
      ])
        mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(home, 'config', 'opencode', 'opencode.json'),
        JSON.stringify({
          model: 'mock/mock-1',
          update: 'disable',
          share: 'manual',
          providers: {
            mock: {
              name: 'Mock',
              package: '@ai-sdk/openai-compatible',
              settings: {
                baseURL: `http://127.0.0.1:${port}/v1`,
                apiKey: 'mock-key',
              },
              models: {
                'mock-1': {
                  name: 'Mock One',
                  capabilities: { tools: true },
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      );
      const binary = real.binary as string;
      const connection: ACPConnectionConfig = {
        id: 'real-opencode',
        name: 'OpenCode',
        command: binary,
        args: ['acp'],
        enabled: true,
      };
      adapter = new OpenCodeAdapter({
        getConnections: async () => [connection],
        nativeEnabled: () => true,
        findBinary: async () => binary,
        launchEnv: async () => env,
        // This test is about the native transport: falling back is a failure.
        createAcpAdapter: () =>
          ({
            provider: 'opencode',
            metadata: {
              displayName: 'inner',
              description: '',
              capabilities: [],
            },
            startSession: async () => {
              throw new Error('fell back to ACP');
            },
            streamEvents: () => ({
              [Symbol.asyncIterator]: () => ({
                next: () => new Promise<never>(() => undefined),
              }),
            }),
            stopAll: async () => undefined,
          }) as unknown as ProviderAdapterShape,
      });
      pump = (async () => {
        for await (const event of adapter.streamEvents())
          events.push(event as Event);
      })();
    }, 60_000);

    afterAll(async () => {
      // Stops every server the pool started.
      await adapter?.stopAll();
      await pump;
      await new Promise((resolve) => model?.close(resolve));
    }, 30_000);

    test('a governed session asks before the shell runs, takes a decline, and keeps working', async () => {
      await adapter.startSession({
        threadId: 'native-1',
        provider: 'opencode',
        cwd: project,
        metadata: { connectionId: 'real-opencode' },
        modelOptions: { approvalMode: 'ask' },
      });
      expect(
        await waitFor((event) => event.method === 'session.started'),
      ).toMatchObject({ metadata: { openCodeTransport: 'native' } });
      expect(events.some((event) => event.method === 'runtime.warning')).toBe(
        false,
      );

      const shell = await adapter.sendTurn({
        threadId: 'native-1',
        input: 'DO_BASH please',
      });
      const asked = await waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === shell.turnId,
      );
      expect(asked).toMatchObject({ payload: { toolName: 'shell' } });
      await adapter.respondToRequest(
        'native-1',
        asked.requestId as string,
        'decline',
      );
      expect(
        await waitFor(
          (event) =>
            event.method === 'request.resolved' &&
            event.requestId === asked.requestId,
        ),
      ).toMatchObject({ status: 'denied', acknowledgement: 'engine' });
      await waitFor(
        (event) =>
          event.method === 'turn.completed' && event.turnId === shell.turnId,
      );

      const hello = await adapter.sendTurn({
        threadId: 'native-1',
        input: 'hello native',
      });
      expect(
        await waitFor(
          (event) =>
            event.method === 'turn.completed' && event.turnId === hello.turnId,
        ),
      ).toMatchObject({ outputText: 'native reply: hello native' });
      await adapter.stopSession('native-1');
    }, 120_000);
  },
);
