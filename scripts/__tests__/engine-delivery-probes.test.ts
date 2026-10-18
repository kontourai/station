import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINE_CAPABILITY_MATRICES } from '../../packages/contracts/src/engine-capability-matrix.js';
import type { CanonicalRuntimeEvent } from '../../packages/contracts/src/runtime-events.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { validator } from '../../src-server/domain/validator.js';
import {
  type ClaudeMessageState,
  mapClaudeSdkMessage,
} from '../../src-server/providers/adapters/claude-adapter-events.js';
import { recordClaudeTurnDispatched } from '../../src-server/providers/adapters/claude-sdk-turns.js';
import {
  continueForegroundMessageSchema,
  foregroundMessageObjectSchema,
} from '../../src-server/routes/orchestration/orchestration.js';
import {
  agentCreateSchema,
  localSkillCreateSchema,
} from '../../src-server/routes/schemas/schema-definitions/content.js';
import {
  integrationEnabledSchema,
  integrationSchema,
  integrationToolsApplySchema,
} from '../../src-server/routes/schemas/schema-definitions/runtime.js';
import { assertSafeSkillName } from '../../src-server/services/agents/skill-metadata.js';
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

async function skillCaptureEvents(
  readOnly: boolean,
  skillId: string,
  fault?: Fault,
  serverId?: string,
): Promise<CanonicalRuntimeEvent[]> {
  const name = readOnly
    ? 'claude-2.1.296-script-read-local.jsonl'
    : 'claude-2.1.296-skill-invocation-local.jsonl';
  const raw = await readFile(
    new URL(
      `../../src-server/providers/__tests__/fixtures/${name}`,
      import.meta.url,
    ),
    'utf8',
  );
  // Parameterize only the probe identifier; keep the captured tool envelope/input keys.
  const messages: SDKMessage[] = raw
    .replaceAll('delivery-fixture', skillId)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const message of messages) {
    if (
      message.type === 'system' &&
      message.subtype === 'init' &&
      serverId &&
      fault !== 'no-tool-list'
    )
      message.tools.push(`mcp__${serverId}__ping`);
    if (
      message.type === 'system' &&
      message.subtype === 'init' &&
      serverId &&
      fault === 'advertised-blocked'
    )
      message.tools.push(`mcp__${serverId}__blocked`);
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content)
        if (
          block.type === 'tool_use' &&
          block.name === 'Skill' &&
          fault === 'wrong-skill'
        )
          block.input = { skill: 'another-skill' };
      if (
        (fault === 'wrong-completion' || fault === 'two-call-failed') &&
        message.message.content.some(
          (block) => block.type === 'tool_use' && block.name === 'Skill',
        )
      )
        message.message.content.push({
          type: 'tool_use',
          id: 'toolu_other',
          name: 'Read',
          input: { file_path: '/workspace/unrelated' },
        });
    }
    if (
      message.type === 'user' &&
      Array.isArray(message.message.content) &&
      message.message.content.some((block) => block.type === 'tool_result')
    ) {
      if (fault === 'wrong-completion')
        message.message.content = [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_other',
            content: 'Other call succeeded',
          },
        ];
      if (fault === 'two-call-failed')
        message.message.content = [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_skill_fixture',
            is_error: true,
            content: 'Skill failed',
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_other',
            content: 'Other call succeeded',
          },
        ];
    }
  }
  const record: ClaudeMessageState = {
    session: {
      provider: 'claude',
      threadId: 'fixture-session',
      status: 'running',
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    },
    lastSessionState: 'running',
  };
  recordClaudeTurnDispatched(record, 'fixture-turn');
  const events: CanonicalRuntimeEvent[] = [];
  for (const message of messages)
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      message,
      publish: (event) => events.push(event),
    });
  return events.filter(
    (event) =>
      event.method.startsWith('tool.') || event.method === 'session.configured',
  );
}

type Fault =
  | 'read-echo'
  | 'wrong-artifact'
  | 'wrong-skill'
  | 'wrong-completion'
  | 'two-call-failed'
  | 'ping-error'
  | 'ping-wrong-id'
  | 'advertised-blocked'
  | 'ping-missing'
  | 'ping-wrong-output'
  | 'blocked-rejected'
  | 'no-tool-list'
  | 'refused-create'
  | 'nonce'
  | 'read-only'
  | 'failed-skill'
  | 'no-invocation'
  | 'no-script-proof'
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
  const created = new Set<string>();
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
      events?: CanonicalRuntimeEvent[];
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
    if (
      method === 'DELETE' &&
      /^\/(?:agents|api\/skills|integrations)\/[^/]+$/.test(path)
    ) {
      if (fault === 'cleanup' && path.startsWith('/agents/'))
        throw new Error('agent delete refused');
      if (!created.delete(path))
        throw new Error(`404: ${path} was never created`);
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
    if (path === '/api/agents')
      return {
        data: [
          {
            slug: 'matrix',
            executionDefault: true,
            execution: { agentConnectionId: 'engine' },
          },
        ],
      };
    if (path.startsWith('/api/agents/')) {
      if (!created.has(path.replace('/api/agents/', '/agents/')))
        throw new Error('404: Agent not found');
      return {
        data: {
          slug: skillId,
          execution: {
            agentConnectionId:
              engine === 'station-agent' ? undefined : 'engine',
          },
        },
      };
    }
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
      serverId = integrationSchema.parse(body).id;
      created.add(`/integrations/${serverId}`);
      return { data: {} };
    }
    if (/^\/integrations\/[^/]+\/reconnect$/.test(path) && method === 'POST')
      return {
        data: { probe: { ok: fault !== 'unreachable', error: 'offline' } },
      };
    if (path === '/integrations' && method === 'GET')
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
    if (
      /^\/integrations\/[^/]+\/tools\/apply$/.test(path) &&
      method === 'POST'
    ) {
      integrationToolsApplySchema.parse(body);
      return { data: {} };
    }
    if (/^\/integrations\/[^/]+\/enabled$/.test(path) && method === 'POST') {
      integrationEnabledSchema.parse(body);
      return { data: {} };
    }
    if (path === '/api/skills/local' && method === 'POST') {
      const skill = localSkillCreateSchema.parse(body);
      assertSafeSkillName(skill.name);
      skillId = skill.name;
      created.add(`/api/skills/${skillId}`);
      skillBody = skill.body;
      await mkdir(join(root, skillId));
      await writeFile(join(root, skillId, 'SKILL.md'), skill.body);
      return { data: {} };
    }
    if (/^\/api\/skills\/[^/]+$/.test(path) && method === 'GET')
      return { data: { path: join(root, skillId) } };
    if (path === '/agents' && method === 'POST') {
      const agent = agentCreateSchema.parse(body);
      if (
        agent.skills !== undefined &&
        (!Array.isArray(agent.skills) ||
          agent.skills.some((name) => name !== skillId))
      )
        throw new Error('Unknown skills');
      const { slug, ...spec } = agent;
      validator.validateAgentSpec(spec, slug);
      skillId = String(agent.slug);
      if (fault === 'refused-create') throw new Error('Agent create refused');
      created.add(`/agents/${skillId}`);
      if (fault === 'prepare')
        throw new Error('agent create acknowledgement lost');
      return { data: {} };
    }
    if (path === '/api/orchestration/commands' && method === 'POST') {
      const command = body as { type: string; threadId?: string };
      if (command.type !== 'stopSession')
        throw new Error('Unknown orchestration command');
      const session = sessions.get(command.threadId ?? '');
      if (session) session.loaded = false;
      return { data: {} };
    }
    if (
      method === 'POST' &&
      (path === '/api/orchestration/chat' ||
        /^\/api\/orchestration\/chat\/[^/]+\/continue$/.test(path))
    ) {
      const first = path === '/api/orchestration/chat';
      const parsed = first
        ? foregroundMessageObjectSchema.parse(body)
        : continueForegroundMessageSchema.parse(body);
      const value = body as {
        conversationId?: string;
        target?: { agent: string; model: { override: string } };
        message: string;
        model?: { override: string };
      };
      const threadId = first
        ? value.conversationId!
        : decodeURIComponent(path.split('/')[4]);
      if (first) {
        const delivery = value.target?.agent === skillId;
        sessions.set(threadId, { delivery, loaded: true });
        if (delivery && fault === 'start')
          throw new Error('start acknowledgement lost');
      }
      const input = {
        threadId,
        input: parsed.message,
        modelId: value.target?.model.override ?? value.model?.override ?? '',
      };
      const session = sessions.get(threadId);
      if (!session) throw new Error('missing session');
      if (session.delivery && fault === 'send') throw new Error('send failed');
      session.loaded = true;
      const prompt = input.input;
      let text = 'STATION_SMOKE_OK';
      let outputs: string[] = [];
      let calls: string[] = [];
      let captured: CanonicalRuntimeEvent[] = [];
      let receiptContent: string | undefined;
      if (prompt.startsWith('Remember this secret'))
        session.secret = prompt.split(': ')[1].split('.')[0];
      else if (prompt.startsWith('Reply with exactly the secret'))
        text = session.secret ?? '';
      else if (prompt.startsWith('Create ')) outputs = [prompt.split(' ')[1]];
      else if (prompt.startsWith('Use the delivery-')) {
        const script = join(root, skillId, 'scripts/probe.mjs');
        const result =
          fault === 'read-echo'
            ? {
                stdout:
                  /const nonce = (.*);/.exec(
                    await readFile(script, 'utf8'),
                  )?.[1] ?? '',
              }
            : await exec(process.execPath, [script], {
                cwd: root,
                windowsHide: true,
                timeout: 5000,
              });
        scriptRan = fault !== 'read-echo';
        text =
          fault === 'nonce' || fault === 'no-script-proof'
            ? 'script completed'
            : result.stdout.trim();
        const artifact = skillBody.match(/writes (delivery-\w+\.txt)/)?.[1];
        expect(artifact).toBeDefined();
        if (scriptRan)
          expect(await readFile(join(root, artifact ?? ''), 'utf8')).toBe(
            result.stdout.trim(),
          );
        receiptContent =
          fault === 'read-echo'
            ? 'read only'
            : fault === 'wrong-artifact'
              ? JSON.stringify({
                  ...JSON.parse(result.stdout.trim()),
                  proof: '0'.repeat(64),
                })
              : result.stdout.trim();
        expect(skillBody).not.toContain(result.stdout.trim());
        expect(
          JSON.stringify(
            requests.filter((request) =>
              request.path.startsWith('/api/orchestration/chat'),
            ),
          ),
        ).not.toContain(result.stdout.trim());
        outputs =
          fault === 'artifact' || fault === 'no-script-proof'
            ? []
            : [artifact ?? ''];
        if (engine === 'claude' && fault !== 'no-invocation')
          captured = await skillCaptureEvents(
            fault === 'read-only' || fault === 'read-echo',
            skillId,
            fault,
            serverId,
          );
        if (fault === 'failed-skill')
          captured = captured.map((event) =>
            event.method === 'tool.completed'
              ? { ...event, status: 'error' }
              : event,
          );
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
        if (fault === 'blocked' || fault === 'blocked-rejected')
          calls.push(`mcp__${serverId}__blocked`);
      }
      const turnId = `turn-${++seq}`;
      turns.set(turnId, {
        text,
        outputs,
        calls,
        model: input.modelId,
        sessionId: input.threadId,
        events: captured,
        artifactContent:
          receiptContent ??
          /containing exactly (STATION_MATRIX_ARTIFACT:[\w-]+)/.exec(
            prompt,
          )?.[1],
      });
      return {
        data: {
          providerTurnId: turnId,
          sessionId: input.threadId,
          conversationId: input.threadId,
        },
      };
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
          ...(turn.events?.map((event) => ({ ...event, turnId })) ?? []),
          ...turn.calls.flatMap((toolName, index) => {
            const toolCallId = `${turnId}-call-${index}`;
            const started = {
              method: 'tool.started',
              turnId,
              toolName,
              toolCallId,
            };
            if (fault === 'ping-missing' && toolName.endsWith('ping'))
              return [started];
            return [
              started,
              {
                method: 'tool.completed',
                turnId,
                toolName,
                toolCallId:
                  fault === 'ping-wrong-id' && toolName.endsWith('ping')
                    ? 'unrelated-call'
                    : toolCallId,
                status:
                  (fault === 'ping-error' && toolName.endsWith('ping')) ||
                  (fault === 'blocked-rejected' && toolName.endsWith('blocked'))
                    ? 'error'
                    : 'success',
                output: toolName.endsWith('ping')
                  ? fault === 'ping-wrong-output'
                    ? 'No such tool'
                    : 'DELIVERY_PING_OK'
                  : fault === 'blocked-rejected'
                    ? 'No such tool'
                    : 'DISABLED_TOOL_WAS_CALLED',
              },
            ];
          }),
        ]),
      };
    if (path.endsWith('/messages'))
      return {
        data: relevant.map(([turnId, turn]) => ({
          role: 'assistant',
          parts: [{ type: 'text', text: turn.text }],
          metadata: {
            turnId,
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
      expect(
        checkDisabledTool(engine, names, [], 'configured', [
          'mcp__configured__ping',
        ]),
      ).toBe('pass');
      expect(checkDisabledTool(engine, ['ping'], [], 'configured')).toBe(
        'fail',
      );
    }
  });

  it.each(['claude', 'codex', 'acp', 'station-agent'])(
    'registers once per %s engine across two advertised models and requests cleanup',
    async (engine) => {
      const { result, requests, scriptRan } = await exercise(undefined, engine);
      const rows = result.rows.filter((row) => row.scenario === 'delivery');
      expect(rows).toHaveLength(1);
      expect(rows[0].delivery?.toolServers.probe).toBe('pass');
      const hasSkill = ['claude', 'station-agent'].includes(engine);
      expect(scriptRan).toBe(hasSkill);
      expect(rows[0].turns).toHaveLength(hasSkill ? 2 : 1);
      if (engine === 'claude') {
        expect(rows[0].delivery?.script.probe).toBe('pass');
        expect(rows[0].turns[0].checks).toMatchObject({
          scriptExecuted: 'pass',
          skillDelivery: 'pass',
        });
        expect(rows[0].delivery?.skills.probe).toBe('pass');
        expect(renderMatrix(result)).toContain(
          '| claude | skills | session | pass |',
        );
      }
      if (engine !== 'acp')
        expect(rows[0].delivery?.disabledTool.probe).toBe(
          engine === 'claude' ? 'pass' : 'unverified',
        );
      expect(rows[0].delivery?.nativeToolPolicy.probe).toBe('unverified');
      expect(renderMatrix(result)).toContain(
        `| ${engine} | nativeToolPolicy | ${ENGINE_CAPABILITY_MATRICES[engine === 'station-agent' ? 'station' : engine].toolPolicy.state} | unverified |`,
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
      expect(result.sentTurns).toBe(hasSkill ? 14 : 13);
      if (engine !== 'claude') {
        expect(rows[0].delivery?.skills.probe).toBe('unverified');
        expect(rows[0].delivery?.skills.reason).toContain(
          'No captured skill-invocation shape',
        );
      }
      expect(rows[0].status).toBe('unverified'); // No UI observer was supplied.
      expect(
        requests.filter((request) => request.method === 'DELETE'),
      ).toHaveLength(hasSkill ? 3 : 2);
      expect(
        requests.some((request) => request.path.endsWith('/tools/apply')),
      ).toBe(engine !== 'acp');
    },
  );

  it.each(['nonce', 'artifact', 'read-echo', 'wrong-artifact'] as const)(
    'rejects non-execution script evidence: %s',
    async (fault) => {
      const { result } = await exercise(fault);
      const row = result.rows.find((row) => row.scenario === 'delivery');
      expect(row?.turns[0].checks?.scriptExecuted).toBe('fail');
      expect(row?.delivery?.script.probe).not.toBe('pass');
    },
  );
  it.each(['wrong-skill', 'wrong-completion', 'two-call-failed'] as const)(
    'matches skill name and completion identity: %s',
    async (fault) => {
      const { result } = await exercise(fault);
      const row = result.rows.find((row) => row.scenario === 'delivery');
      expect(row?.delivery?.skills.probe).toBe(
        fault === 'two-call-failed' ? 'fail' : 'unverified',
      );
      expect(row?.delivery?.script.probe).not.toBe('pass');
    },
  );
  it.each([
    'ping-error',
    'ping-missing',
    'ping-wrong-output',
    'ping-wrong-id',
  ] as const)('requires a successful MCP result: %s', async (fault) => {
    const { result } = await exercise(fault);
    expect(
      result.rows.find((row) => row.scenario === 'delivery')?.turns.at(-1)
        ?.checks?.toolServerUsed,
    ).toBe('fail');
    expect(
      result.rows.find((row) => row.scenario === 'delivery')?.delivery
        ?.disabledTool.probe,
    ).toBe('pass');
  });
  it.each(['blocked-rejected', 'no-tool-list', 'advertised-blocked'] as const)(
    'does not confuse attempted blocking with a breach: %s',
    async (fault) => {
      const { result } = await exercise(fault);
      expect(
        result.rows.find((row) => row.scenario === 'delivery')?.turns.at(-1)
          ?.checks?.disabledTool,
      ).toBe(
        fault === 'no-tool-list' || fault === 'advertised-blocked'
          ? 'unverified'
          : 'pass',
      );
    },
  );
  it('reports cleanup of a refused create as unconfirmed instead of pretending DELETE succeeded', async () => {
    const { result } = await exercise('refused-create');
    expect(result.rows).toContainEqual(
      expect.objectContaining({
        scenario: 'cleanup',
        failure: expect.stringContaining('404: /agents/'),
      }),
    );
  });

  it('keeps a missing invocation record unverified rather than treating script access as skill delivery', async () => {
    const { result } = await exercise('no-invocation');
    const row = result.rows.find((row) => row.scenario === 'delivery');
    expect(row?.delivery?.skills).toMatchObject({
      probe: 'unverified',
      reason: 'No skill-invocation event recorded in this turn',
    });
  });

  it('forwards every cleanup DELETE through the matrix wrapper to the API transport', async () => {
    const { requests } = await exercise();
    const cleanup = requests.slice(-3);
    expect(cleanup.map(({ method }) => method)).toEqual([
      'DELETE',
      'DELETE',
      'DELETE',
    ]);
    expect(cleanup.map(({ path }) => path)).toEqual([
      expect.stringMatching(/^\/agents\/delivery-/),
      expect.stringMatching(/^\/api\/skills\/delivery-/),
      expect.stringMatching(/^\/integrations\/probe/),
    ]);
  });

  it.each([
    ['no-script-proof', 'scriptExecuted'],
    ['read-only', 'skillDelivery'],
    ['failed-skill', 'skillDelivery'],
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
    expect(renderMatrix(result)).toContain(
      '| claude | toolServers | session | pass |',
    );
    row.turns = [];
    expect(renderMatrix(result)).toContain(
      '| claude | toolServers | session | unverified |',
    );
    expect(renderMatrix(result)).not.toContain(
      '| claude | toolServers | session | pass |',
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
    expect(outcome).toContain(
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
    expect(result.reservedBillableRequests).toBe(6);
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
