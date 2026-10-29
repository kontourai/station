/**
 * #3957: what the real OpenCode does with the ACP client write, and that
 * Station neither writes for it nor loses the engine.
 *
 * OpenCode 1.18.18 writes each allowed edit's proposed content through the
 * client (`fs/write_text_file`) at the permission's `filepath`, whatever the
 * client advertised, and does not wait for the answer. For `apply_patch` (the
 * edit tool it gives a `gpt-` model) that path is worktree-relative. This
 * drives the real `AcpAdapter` against the real `opencode` binary with a
 * local OpenAI-compatible model that answers with one scripted `apply_patch`
 * call, with fresh HOME/XDG directories and Station's working directory
 * moved to an empty one, under Auto. Hosts without `opencode` skip loudly.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { findCliBinaryAsync } from '../auth/cli-auth.js';

const opencodeBinary = await findCliBinaryAsync('opencode');

if (!opencodeBinary)
  console.warn(
    'ENFORCEMENT UNVERIFIED (#3957): no `opencode` binary on this host; the client-write probe did not run.',
  );

const PATCH = '*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch';

/** One scripted `apply_patch` call on the first request that offers tools. */
function mockModel(): Promise<Server> {
  let sent = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let tools: unknown[] = [];
      try {
        tools = JSON.parse(body).tools ?? [];
      } catch {}
      const scripted = tools.length > 0 && !sent;
      if (scripted) sent = true;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-5-mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (scripted) {
        chunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ patchText: PATCH }),
                },
              },
            ],
          },
          null,
        );
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: 'done' }, null);
        chunk({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
}

describe.skipIf(!opencodeBinary)(
  `OpenCode's client write under the real engine${opencodeBinary ? '' : ' (SKIPPED: no opencode binary)'}`,
  () => {
    const makeTempDir = trackTempDirs({ lifetime: 'file' });
    const saved = { ...process.env };
    const savedCwd = process.cwd();
    let server: Server;
    let repo: string;
    let stationCwd: string;

    beforeAll(async () => {
      server = await mockModel();
      const root = realpathSync(makeTempDir('opencode-client-write-'));
      repo = join(root, 'repo');
      stationCwd = join(root, 'station-cwd');
      for (const dir of [repo, stationCwd, join(root, 'home')])
        mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const port = (server.address() as AddressInfo).port;
      Object.assign(process.env, {
        HOME: join(root, 'home'),
        XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
        XDG_DATA_HOME: join(root, 'xdg', 'data'),
        XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
        XDG_STATE_HOME: join(root, 'xdg', 'state'),
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: 'mock/gpt-5-mock',
          provider: {
            mock: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Mock',
              options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' },
              models: { 'gpt-5-mock': { name: 'gpt-5-mock', tool_call: true } },
            },
          },
        }),
      });
      // A relative client path would resolve here, in Station's process.
      process.chdir(stationCwd);
    });

    afterAll(() => {
      process.chdir(savedCwd);
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      server?.close();
    });

    test('an Auto apply_patch is applied by OpenCode, nothing is written in Station’s directory, and the engine keeps running', async () => {
      const connection: ACPConnectionConfig = {
        id: 'real-opencode',
        name: 'OpenCode',
        command: opencodeBinary as string,
        args: ['acp'],
        enabled: true,
      };
      const adapter = new AcpAdapter({
        getConnections: async () => [connection],
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      const events: CanonicalRuntimeEvent[] = [];
      const drained = (async () => {
        for await (const event of adapter.streamEvents()) events.push(event);
      })();
      const turn = async (input: string) => {
        const from = events.length;
        const { turnId } = await adapter.sendTurn({
          provider: 'acp',
          threadId: 'patch',
          input,
          confinement: 'workspace',
          modelOptions: { approvalMode: 'auto' },
        } as never);
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const since = events.slice(from);
          if (
            since.some(
              (event) =>
                (event.method === 'turn.completed' &&
                  (event as { turnId?: string }).turnId === turnId) ||
                event.method === 'session.exited',
            )
          )
            return since;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('the turn did not settle');
      };
      try {
        await adapter.startSession({
          provider: 'acp',
          threadId: 'patch',
          cwd: repo,
          confinement: 'workspace',
          metadata: { connectionId: 'real-opencode' },
          modelOptions: { approvalMode: 'auto' },
        } as never);
        const first = await turn('add the file');
        expect(first.some((event) => event.method === 'request.opened')).toBe(
          false,
        );
        expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toBe('hi\n');
        // Give OpenCode's unawaited client write time to be answered.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(readdirSync(stationCwd)).toEqual([]);
        const second = await turn('and again');
        expect(second.some((event) => event.method === 'turn.completed')).toBe(
          true,
        );
        expect(events.some((event) => event.method === 'session.exited')).toBe(
          false,
        );
        expect(existsSync(join(stationCwd, 'hello.txt'))).toBe(false);
      } finally {
        await adapter.stopAll();
        await drained;
      }
    }, 240_000);
  },
);
