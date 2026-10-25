import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { parseWalkthrough } from '@kontourai/station-contracts/walkthrough';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type CallToolResult,
  CallToolResultSchema,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ProjectFileTransactions } from '../../domain/project-file-transactions.js';
import { createWalkthroughRoutes } from '../../routes/walkthroughs.js';
import {
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
} from '../../runtime/mcp/station-control-caller.js';
import { claudeInProcessStationControlOptions } from '../../runtime/mcp/station-control-in-process.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { createStationControlAuthorityGuard } from '../../security/station-control-authority-guard.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../services/operations/action-operation-service.js';
import { WalkthroughService } from '../../services/walkthroughs/walkthrough-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
} from '../../utils/internal-api-token.js';

const resolveRecord: StationControlCallerRecordResolver = () => ({
  principal: { id: 'human:local:reviewer', source: 'session-owner' },
  localProjectId: 'project-alpha',
  projectIdSource: 'session-record',
  projectSlug: 'alpha',
});
let home: string,
  server: ReturnType<typeof serve>,
  priorBase: string | undefined;
const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'station-walkthrough-mcp-'));
  const root = join(home, 'projects', 'alpha', 'walkthroughs', 'w1');
  await mkdir(root, { recursive: true });
  const manifest = parseWalkthrough({
    schema: 'station.walkthrough/v1',
    id: 'w1',
    createdAt: '2026-10-24T00:00:00Z',
    source: { adapter: 'test-capture', adapterVersion: '1', durationMs: 10000 },
    capture: { platform: 'web' },
    coverage: {
      transcript: 'absent',
      frames: 'present',
      marks: 'absent',
      elements: 'absent',
      route: 'absent',
      console: 'absent',
      network: 'absent',
    },
    events: Array.from({ length: 5 }, (_, i) => ({
      kind: 'frame',
      tMs: i * 1000,
      frameId: `f${i}`,
      file: `f${i}.jpg`,
      width: 1,
      height: 1,
      reasons: ['interval'],
    })),
  });
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  for (let i = 0; i < 5; i++) await writeFile(join(root, `f${i}.jpg`), jpeg);
  const service = new WalkthroughService({
    files: new ProjectFileTransactions(home),
    operations: new ActionOperationService(new FileActionOperationStore(home)),
    resolver: {
      resolveFfmpeg: async () => {
        throw new Error('read must not resolve tools');
      },
    },
    transcriber: {
      transcribeFile: async () => {
        throw new Error('read must not transcribe');
      },
    },
    diagnostic: () => {},
  });
  const app = new Hono();
  // Fixture substitutes HTTP authentication only; real token resolution, policy guard,
  // in-process registration, SDK reads, route authorization and storage all execute.
  app.use('*', async (c, next) => {
    if (c.req.header(INTERNAL_API_TOKEN_HEADER) !== getInternalApiToken())
      return c.json({ success: false, error: 'auth required' }, 401);
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'internal',
      credential: getInternalApiToken(),
      authority: undefined,
      source: 'bearer',
    });
    await next();
  });
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, resolveRecord),
      isOperatorPrincipal: () => false,
    }),
  );
  app.route(
    '/api/projects/:projectSlug/walkthroughs',
    createWalkthroughRoutes({
      service,
      project: (slug) => ({
        id: slug === 'alpha' ? 'project-alpha' : 'project-other',
      }),
      authorize: async (request) => {
        const a = stationControlRequestAuthority(request);
        return a?.kind === 'caller' &&
          a.caller.principal?.id === 'human:local:reviewer'
          ? { kind: 'project-admin', principalId: 'human:local:reviewer' }
          : undefined;
      },
      actor: () => ({ accountId: 'human:local:reviewer' }),
      diagnostic: () => {},
    }),
  );
  priorBase = process.env.STATION_API_BASE;
  await new Promise<void>((resolve) => {
    server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => {
        process.env.STATION_API_BASE = `http://127.0.0.1:${info.port}`;
        resolve();
      },
    );
  });
});
afterAll(async () => {
  if (priorBase === undefined) delete process.env.STATION_API_BASE;
  else process.env.STATION_API_BASE = priorBase;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});
async function connect() {
  const instance = claudeInProcessStationControlOptions(
    () => resolveRecord,
  ).createInProcessStationControl('walkthrough-reviewer');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const bridge: Parameters<typeof instance.connect>[0] = {
    start: () => serverSide.start(),
    close: () => serverSide.close(),
    send: (message: unknown) =>
      serverSide.send(JSONRPCMessageSchema.parse(message)),
  };
  serverSide.onmessage = (message, extra) => bridge.onmessage?.(message, extra);
  await instance.connect(bridge);
  const client = new Client({ name: 'walkthrough-test', version: '1' });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await instance.close();
    },
  };
}
async function call(client: Client, input: Parameters<Client['callTool']>[0]) {
  return CallToolResultSchema.parse(await client.callTool(input));
}
function textData(result: CallToolResult) {
  const block = result.content?.find((c) => c.type === 'text');
  if (block?.type !== 'text') throw new Error('text missing');
  return JSON.parse(block.text);
}
describe('in-process station-control Walkthrough reads', () => {
  test('advertises closed inputs and refuses authority or excessive page fields', async () => {
    const { client, close } = await connect();
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ['list_walkthroughs', 'get_walkthrough']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
      for (const [name, args] of [
        ['list_walkthroughs', { projectSlug: 'alpha', ownerId: 'someone' }],
        ['list_walkthroughs', { projectSlug: 'alpha', limit: 51 }],
        ['get_walkthrough', { projectSlug: 'alpha', id: 'w1', limit: 5 }],
        ['get_walkthrough', { projectSlug: 'alpha', id: 'w1', host: 'other' }],
      ] as const) {
        const result = await client
          .callTool({ name, arguments: args })
          .catch((error) => ({ isError: true, error }));
        expect(result.isError).toBe(true);
      }
    } finally {
      await close();
    }
  });
  test('reads the Project manifest and exact JPEG bytes in bounded pages through policy and storage', async () => {
    const { client, close } = await connect();
    try {
      const list = await call(client, {
        name: 'list_walkthroughs',
        arguments: { projectSlug: 'alpha' },
      });
      expect(textData(list)).toMatchObject({ success: true });
      expect(
        textData(list).data.items.map((i: { id: string }) => i.id),
      ).toEqual(['w1']);
      const first = await call(client, {
        name: 'get_walkthrough',
        arguments: { projectSlug: 'alpha', id: 'w1' },
      });
      expect(first.isError).not.toBe(true);
      expect(textData(first).data.manifest.id).toBe('w1');
      expect(textData(first).data.nextCursor).toBe(4);
      expect(
        first.content?.filter((c) => c.type === 'image').map((c) => c.data),
      ).toEqual(Array(4).fill(jpeg.toString('base64')));
      const second = await call(client, {
        name: 'get_walkthrough',
        arguments: { projectSlug: 'alpha', id: 'w1', cursor: 4 },
      });
      expect(second.content?.filter((c) => c.type === 'image')).toHaveLength(1);
      expect(textData(second).data.nextCursor).toBeUndefined();
      const other = await call(client, {
        name: 'list_walkthroughs',
        arguments: { projectSlug: 'other' },
      });
      expect(other.isError).toBe(true);
      const missing = await call(client, {
        name: 'get_walkthrough',
        arguments: { projectSlug: 'alpha', id: 'missing' },
      });
      expect(missing.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
