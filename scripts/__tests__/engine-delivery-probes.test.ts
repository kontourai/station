import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINE_CAPABILITY_MATRICES } from '../../packages/contracts/src/engine-capability-matrix.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  checkDisabledTool,
  DISABLED_TOOL_IDS,
  scenarios,
} from '../engine-delivery-probes.js';
import { renderMatrix, runMatrix } from '../lib/engine-matrix.mjs';

const exec = promisify(execFile);
const temp = trackTempDirs();
const fixture = fileURLToPath(
  new URL('../fixtures/delivery-probe-mcp.mjs', import.meta.url),
);
const clients: Client[] = [];
const previousEndpoint = process.env.STATION_DELIVERY_PROBE_MCP_ENDPOINT;
afterEach(async () => {
  if (previousEndpoint === undefined)
    delete process.env.STATION_DELIVERY_PROBE_MCP_ENDPOINT;
  else process.env.STATION_DELIVERY_PROBE_MCP_ENDPOINT = previousEndpoint;
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function toolInventory() {
  const client = new Client({ name: 'delivery-test', version: '1' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      stderr: 'pipe',
    }),
  );
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(await client.callTool({ name: 'ping', arguments: {} })).toMatchObject({
    content: [{ text: 'DELIVERY_PING_OK' }],
  });
  return names;
}

type Fault =
  | 'nonce'
  | 'artifact'
  | 'prose-only'
  | 'blocked'
  | 'prior-ping'
  | 'blocked-in-skill'
  | 'unknown-id'
  | 'unreachable'
  | 'prepare'
  | 'start'
  | 'send'
  | 'cleanup'
  | 'wrong-engine'
  | 'missing-engine';

type Request = { path: string; body?: unknown; method: string };
async function exercise(
  fault?: Fault,
  engine = 'claude',
  options: {
    maxTurns?: number;
    modelIds?: string[];
    requests?: Request[];
    onPlan?: (plan: unknown) => void;
  } = {},
) {
  if (fault !== 'unreachable')
    delete process.env.STATION_DELIVERY_PROBE_MCP_ENDPOINT;
  const root = await temp('delivery-probe-');
  const inventory = await toolInventory();
  const requests = options.requests ?? [];
  const sessions = new Map<
    string,
    { secret?: string; delivery: boolean; loaded: boolean }
  >();
  const turns = new Map<
    string,
    {
      text: string;
      outputs: string[];
      calls: string[];
      model: string;
      sessionId: string;
      artifactContent?: string;
    }
  >();
  let skillId = '';
  let serverId = '';
  let skillBody = '';
  let scriptRan = false;
  let seq = 0;
  const api = async (
    path: string,
    body?: unknown,
    method = body ? 'POST' : 'GET',
  ): Promise<{ data: unknown }> => {
    requests.push({ path, body, method });
    if (method === 'DELETE') {
      if (fault === 'cleanup' && path.startsWith('/agents/'))
        throw new Error('agent delete refused');
      return { data: {} };
    }
    if (path === '/api/connections/agents')
      return {
        data: [
          {
            id: 'engine',
            type: engine === 'acp' ? 'acp' : 'test',
            config: { provider: engine },
            enabled: true,
          },
        ],
      };
    if (path.endsWith('/models'))
      return {
        data: (engine === 'claude'
          ? ['claude-sonnet-4-5', 'claude-opus-4-5']
          : ['model-1', 'model-2']
        ).map((id) => ({ id })),
      };
    if (path === '/api/orchestration/sessions/loaded')
      return {
        data: [...sessions]
          .filter(([, session]) => session.loaded)
          .map(([threadId]) => ({ threadId, isLoaded: true })),
      };
    if (path === '/integrations' && method === 'POST') {
      serverId = (body as { id: string }).id;
      return { data: {} };
    }
    if (path.endsWith('/reconnect'))
      return {
        data: { probe: { ok: fault !== 'unreachable', error: 'offline' } },
      };
    if (path === '/integrations')
      return {
        data: [
          {
            id: serverId,
            tools: inventory
              .filter((name) => fault !== 'unknown-id' || name !== 'blocked')
              .map((toolName) => ({ toolName })),
          },
        ],
      };
    if (path.startsWith('/integrations/')) return { data: {} };
    if (path === '/api/skills/local') {
      const skill = body as { name: string; body: string };
      skillId = skill.name;
      skillBody = skill.body;
      await mkdir(join(root, skillId));
      await writeFile(join(root, skillId, 'SKILL.md'), skill.body);
      return { data: {} };
    }
    if (path.startsWith('/api/skills/'))
      return { data: { path: join(root, skillId) } };
    if (path === '/agents') {
      if (fault === 'prepare')
        throw new Error('agent create acknowledgement lost');
      return { data: {} };
    }
    if (path === '/api/orchestration/commands') {
      const command = body as {
        type: string;
        threadId?: string;
        input?: {
          threadId: string;
          metadata?: { agentSlug?: string };
          input?: string;
          modelId: string;
        };
      };
      if (command.type === 'stopSession') {
        const session = sessions.get(command.threadId ?? '');
        if (session) session.loaded = false;
        return { data: {} };
      }
      const input = command.input;
      if (!input) throw new Error('missing command input');
      if (command.type === 'startSession') {
        const delivery = !!input.metadata?.agentSlug;
        sessions.set(input.threadId, { delivery, loaded: true });
        if (delivery && fault === 'start')
          throw new Error('start acknowledgement lost');
        return { data: {} };
      }
      const session = sessions.get(input.threadId);
      if (!session || !input.input) throw new Error('missing session/input');
      if (session.delivery && fault === 'send') throw new Error('send failed');
      session.loaded = true;
      const prompt = input.input;
      let text = 'STATION_SMOKE_OK';
      let outputs: string[] = [];
      let calls: string[] = [];
      if (prompt.startsWith('Remember this secret'))
        session.secret = prompt.split(': ')[1].split('.')[0];
      else if (prompt.startsWith('Reply with exactly the secret'))
        text = session.secret ?? '';
      else if (prompt.startsWith('Create ')) outputs = [prompt.split(' ')[1]];
      else if (prompt.startsWith('Use the delivery-')) {
        const script = join(root, skillId, 'scripts/probe.mjs');
        const result = await exec(process.execPath, [script], {
          cwd: root,
          windowsHide: true,
          timeout: 5000,
        });
        scriptRan = true;
        text = fault === 'nonce' ? 'script completed' : result.stdout.trim();
        const artifact = skillBody.match(/writes (delivery-\w+\.txt)/)?.[1];
        expect(artifact).toBeDefined();
        expect(await readFile(join(root, artifact ?? ''), 'utf8')).toBe(
          result.stdout.trim(),
        );
        expect(skillBody).not.toContain(result.stdout.trim());
        expect(
          JSON.stringify(
            requests.filter(
              (request) => request.path === '/api/orchestration/commands',
            ),
          ),
        ).not.toContain(result.stdout.trim());
        outputs = fault === 'artifact' ? [] : [artifact ?? ''];
        if (fault === 'prior-ping') calls = [`mcp__${serverId}__ping`];
        if (fault === 'blocked-in-skill') calls = [`mcp__${serverId}__blocked`];
      } else if (prompt.startsWith('Call ping')) {
        text = `I used ${serverId}/ping and obeyed the policy.`;
        calls =
          fault === 'prose-only' || fault === 'prior-ping'
            ? []
            : [
                engine === 'codex'
                  ? `${serverId}/ping`
                  : `mcp__${serverId}__ping`,
              ];
        if (fault === 'blocked') calls.push(`mcp__${serverId}__blocked`);
      }
      const turnId = `turn-${++seq}`;
      turns.set(turnId, {
        text,
        outputs,
        calls,
        model: input.modelId,
        sessionId: input.threadId,
        artifactContent:
          /containing exactly (STATION_MATRIX_ARTIFACT:[\w-]+)/.exec(
            prompt,
          )?.[1],
      });
      return { data: { turnId } };
    }
    const sessionId = path.split('/')[4];
    const relevant = [...turns].filter(
      ([, turn]) => turn.sessionId === sessionId,
    );
    if (path.endsWith('/inspect')) {
      const eventId = decodeURIComponent(path.split('/').at(-2) ?? '');
      const match = relevant.find(([turnId]) => `output-${turnId}` === eventId);
      if (!match) throw new Error('Unknown output inspection');
      const [turnId, turn] = match;
      return {
        data: {
          item: { ref: { sessionId, eventId }, turnId },
          kind: 'text',
          text: turn.artifactContent,
        },
      };
    }
    if (path.endsWith('/events'))
      return {
        data: relevant.flatMap(([turnId, turn]) => [
          { method: 'turn.completed', turnId },
          ...turn.calls.map((toolName) => ({
            method: 'tool.started',
            turnId,
            toolName,
          })),
        ]),
      };
    if (path.endsWith('/messages'))
      return {
        data: relevant.map(([turnId, turn]) => ({
          role: 'assistant',
          turnId,
          parts: [{ type: 'text', text: turn.text }],
          provenance: {
            sessionId,
            turnId,
            reportedModel: { state: 'observed', value: turn.model },
            engine:
              fault === 'missing-engine'
                ? { state: 'unavailable' }
                : {
                    state: 'observed',
                    value: {
                      provider: fault === 'wrong-engine' ? 'other' : engine,
                    },
                  },
          },
        })),
      };
    if (path.endsWith('/outputs'))
      return {
        data: {
          items: relevant.flatMap(([turnId, turn]) =>
            turn.outputs.map((relativePath) => ({
              turnId,
              ref: { sessionId, eventId: `output-${turnId}` },
              descriptor: { kind: 'workspace-file', relativePath },
            })),
          ),
        },
      };
    throw new Error(`Unhandled API: ${method} ${path}`);
  };
  const result = await runMatrix({
    api,
    connectionId: 'engine',
    cwd: root,
    additionalScenarios: scenarios,
    maxTurns: options.maxTurns,
    modelIds: options.modelIds,
    onPlan: options.onPlan,
  });
  return { result, requests, scriptRan };
}

describe('engine delivery probes', () => {
  it('pins each disabled id to the real fixture MCP tools/list, on engines with a selection channel', async () => {
    const names = await toolInventory();
    for (const [engine, id] of Object.entries(DISABLED_TOOL_IDS)) {
      expect(names, engine).toContain(id);
      expect(
        ENGINE_CAPABILITY_MATRICES[
          engine === 'station-agent' ? 'station' : engine
        ].toolServers.state,
      ).not.toBe('unsupported');
      expect(checkDisabledTool(engine, names, [], 'configured')).toBe('pass');
      expect(checkDisabledTool(engine, ['ping'], [], 'configured')).toBe(
        'fail',
      );
    }
  });

  it.each(['claude', 'codex', 'acp'])(
    'registers once per %s engine across two advertised models and requests cleanup',
    async (engine) => {
      const { result, requests, scriptRan } = await exercise(undefined, engine);
      const rows = result.rows.filter((row) => row.scenario === 'delivery');
      expect(rows).toHaveLength(1);
      expect(rows[0].delivery?.toolServers.probe).toBe('pass');
      expect(scriptRan).toBe(engine === 'claude');
      expect(rows[0].turns).toHaveLength(engine === 'claude' ? 2 : 1);
      if (engine === 'claude') {
        expect(rows[0].delivery?.script.probe).toBe('pass');
        expect(rows[0].turns[0].checks).toMatchObject({
          skillNonce: 'pass',
          scriptOutput: 'pass',
          skillDelivery: 'unverified',
        });
        expect(rows[0].delivery?.skills.probe).toBe('unverified');
        expect(renderMatrix(result)).toContain(
          '| claude | skills | session | unverified |',
        );
      }
      expect(rows[0].delivery?.nativeToolPolicy.probe).toBe('unverified');
      expect(renderMatrix(result)).toContain(
        `| ${engine} | nativeToolPolicy | ${ENGINE_CAPABILITY_MATRICES[engine].toolPolicy.state} | unverified |`,
      );
      expect(result.plan).toMatchObject({
        builtInTurns: 12,
        plannedTurnCount: 14,
        additionalScenarios: [
          {
            id: 'delivery',
            scope: 'engine',
            maxTurns: 2,
            instances: 1,
            minimumPlannedTurns: 2,
          },
        ],
      });
      expect(result.sentTurns).toBe(engine === 'claude' ? 14 : 13);
      expect(rows[0].status).toBe('unverified'); // UI and skill-loading proof are absent.
      expect(
        requests.filter((request) => request.method === 'DELETE'),
      ).toHaveLength(engine === 'claude' ? 3 : 2);
      expect(
        requests.some((request) => request.path.endsWith('/tools/apply')),
      ).toBe(engine !== 'acp');
    },
  );

  it.each([
    ['nonce', 'skillNonce'],
    ['artifact', 'scriptOutput'],
    ['prose-only', 'toolServerUsed'],
    ['blocked', 'disabledTool'],
    ['blocked-in-skill', 'disabledTool'],
    ['prior-ping', 'toolServerUsed'],
  ] as const)('fails %s from recorded turn evidence', async (fault, check) => {
    const { result, requests } = await exercise(fault);
    const row = result.rows.find((row) => row.scenario === 'delivery');
    expect(row?.status).toBe('fail');
    expect(row?.turns.some((turn) => turn.checks?.[check] === 'fail')).toBe(
      true,
    );
    expect(
      requests.filter((request) => request.method === 'DELETE'),
    ).toHaveLength(3);
  });

  it.each(['wrong-engine', 'missing-engine'] as const)(
    'never verifies delivery with %s provenance',
    async (fault) => {
      const { result } = await exercise(fault);
      const row = result.rows.find((row) => row.scenario === 'delivery');
      expect(row?.delivery?.skills.probe).toBe(
        fault === 'wrong-engine' ? 'fail' : 'unverified',
      );
      expect(renderMatrix(result)).not.toContain(
        '| claude | skills | session | pass |',
      );
    },
  );

  it('renders declared delivery without a linked passing probe as unverified', async () => {
    const { result } = await exercise();
    const row = result.rows.find((row) => row.scenario === 'delivery');
    if (!row?.delivery) throw new Error('missing delivery row');
    row.turns = [];
    expect(renderMatrix(result)).toContain(
      '| claude | skills | session | unverified |',
    );
    expect(renderMatrix(result)).not.toContain(
      '| claude | skills | session | pass |',
    );
  });

  it('refuses the full delivery plan at max+1 before session or resource mutation', async () => {
    const requests: Request[] = [];
    const outcome = await exercise(undefined, 'claude', {
      maxTurns: 13,
      requests,
    }).then(
      () => 'accepted',
      (error: Error) => error.message,
    );
    expect(outcome).toBe(
      'Planned 14 turns exceeds --max-turns=13; refusing the entire run',
    );
    expect(requests.map(({ path }) => path)).toEqual([
      '/api/connections/agents',
      '/api/orchestration/providers/claude/models',
    ]);
  });

  it('publishes the delivery reservation before setup and respects a model allowlist', async () => {
    const requests: Request[] = [];
    let published: unknown;
    const { result } = await exercise(undefined, 'claude', {
      modelIds: ['claude-opus-4-5'],
      maxTurns: 6,
      requests,
      onPlan(plan) {
        expect(requests).toHaveLength(2);
        published = plan;
      },
    });
    expect(published).toEqual(result.plan);
    expect(published).toMatchObject({
      modelIds: ['claude-opus-4-5'],
      builtInTurns: 4,
      plannedTurnCount: 6,
      additionalScenarios: [
        {
          id: 'delivery',
          scope: 'engine',
          maxTurns: 2,
          instances: 1,
          minimumPlannedTurns: 2,
        },
      ],
    });
    expect(result.sentTurns).toBe(6);
    expect(result.rows.every((row) => row.model === 'claude-opus-4-5')).toBe(
      true,
    );
  });

  it('refuses an unknown disabled id before sending a probe turn', async () => {
    const { result, requests, scriptRan } = await exercise('unknown-id');
    expect(
      result.rows.find((row) => row.scenario === 'delivery'),
    ).toMatchObject({
      status: 'fail',
      turns: [],
      failure: expect.stringContaining('refusing vacuous disable check'),
    });
    expect(scriptRan).toBe(false);
    expect(
      requests.filter((request) => request.method === 'DELETE'),
    ).toHaveLength(1);
  });

  it('skips an unreachable third-party dependency before model calls and still removes its integration', async () => {
    process.env.STATION_DELIVERY_PROBE_MCP_ENDPOINT =
      'http://127.0.0.1:49179/mcp';
    const { result, requests } = await exercise('unreachable');
    const row = result.rows.find((row) => row.scenario === 'delivery');
    expect(row).toMatchObject({
      status: 'skipped',
      turns: [],
      failure: expect.stringContaining('unreachable'),
    });
    expect(renderMatrix(result)).toContain(
      '| claude | toolServers | session | unverified |',
    );
    expect(
      requests.filter((request) => request.method === 'DELETE'),
    ).toHaveLength(1);
  });

  it.each(['prepare', 'start', 'send', 'cleanup'] as const)(
    'reports %s failure and attempts every registered cleanup',
    async (fault) => {
      const { result, requests } = await exercise(fault);
      expect(result.rows.some((row) => row.status === 'fail')).toBe(true);
      expect(
        requests.filter((request) => request.method === 'DELETE'),
      ).toHaveLength(3);
      if (fault === 'cleanup')
        expect(result.rows).toContainEqual(
          expect.objectContaining({
            scenario: 'cleanup',
            status: 'fail',
            failure: expect.stringContaining('agent delete refused'),
          }),
        );
    },
  );
});
