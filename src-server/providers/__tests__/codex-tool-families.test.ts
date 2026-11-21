/**
 * #2376 slice 3: Codex gets Station Control as tool families only when the
 * `codex-tool-families` preview is on, the installed Codex is at least the
 * qualified version, and station-control travels on the header-token path.
 *
 * These drive the session resolver, the real `CodexAdapter`, the runtime's
 * real Codex mint (`mintCodexStationMcpHeaderAuth`) and the real
 * station-control route: they read the `thread/start` (or `thread/resume`)
 * Station writes on the app-server pipe, take the credential from it, and
 * list tools with it as Codex would.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  ProviderSessionStartInput,
  SessionCapabilityDeliveryMetadata,
} from '@kontourai/station-contracts/provider';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../../routes/mcp/station-control-mcp-route.js';
import { createRuntimeSelfIntegration } from '../../runtime/agents/runtime-default-agent.js';
import {
  builtinStationControlServerPath,
  stationControlRuntimeIdentity,
} from '../../runtime/bootstrap/station-control-runtime-env.js';
import { createCodexBoundToolServer } from '../../runtime/mcp/station-control-in-process.js';
import {
  __resetStationControlMcpTokensForTests,
  mintCodexStationMcpHeaderAuth,
  stationControlDisclosureForToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { createSessionAgentResolver } from '../../services/orchestration/session-agent-resolution.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import {
  CODEX_VERSION_FAILURE_TTL_MS,
  CODEX_VERSION_TTL_MS,
  codexVersionAdmitsToolFamilies,
  parseCodexCliVersion,
} from '../adapters/codex-tool-families.js';
import type { CliCommandResult } from '../auth/cli-auth.js';
import {
  emit,
  FakeCodexProcess,
  flushIo,
  waitFor,
  withTimeout,
} from './codex-adapter-wire-harness.js';

const PORT = 4977;
const FEATURE = 'features.mcp_tool_list_changed';
const INDEX = ['list_tool_families', 'load_tool_family'];

const makeTempDir = trackTempDirs({ lifetime: 'file' });
let binary: string;
beforeAll(() => {
  // The probe keys its cache on the real file, so the binary must exist.
  binary = join(makeTempDir('codex-tool-families-'), 'codex');
  writeFileSync(binary, '#!/bin/sh\n');
});
afterEach(() => __resetStationControlMcpTokensForTests());

const route = createStationControlMcpRoutes({
  port: PORT,
  resolveCallerRecord: () => ({
    principal: { id: 'person:reader', source: 'session-owner' },
    localProjectId: 'project-one',
    projectSlug: 'project-one',
    projectIdSource: 'session-record',
  }),
});

async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await route.request(
    STATION_CONTROL_MCP_PATH,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
  );
  if (response.status !== 200) return { status: response.status };
  const text = await response.text();
  const messages = (response.headers.get('content-type') ?? '').includes(
    'application/json',
  )
    ? [JSON.parse(text)]
    : text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
  return {
    status: 200,
    result: messages.find((message) => 'id' in message)?.result,
  };
}

/** What Codex's `tools/list` with this credential returns. */
async function listed(token: string): Promise<string[]> {
  const { result } = await rpc(token, 'tools/list');
  return result.tools.map((tool: { name: string }) => tool.name);
}

async function loadFamily(token: string, family: string) {
  const { result } = await rpc(token, 'tools/call', {
    name: 'load_tool_family',
    arguments: { family },
  });
  return JSON.parse(result.content[0].text);
}

const control = () => ({
  id: 'station-control',
  displayName: 'Station Control',
  transport: 'stdio' as const,
  command: process.execPath,
  args: [builtinStationControlServerPath()],
});

interface HarnessOptions {
  preview?: () => boolean;
  /** What `codex --version` prints; `null` is a probe that produced nothing. */
  version?: string | null;
  bound?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const child = new FakeCodexProcess();
  // The adapter's clock, which the version cache reads.
  const clock = { ms: Date.parse('2026-11-17T00:00:00.000Z') };
  const runCommand = vi.fn(
    async (): Promise<CliCommandResult | null> =>
      options.version === null
        ? null
        : {
            code: 0,
            stdout: `${options.version ?? 'codex-cli 0.167.0'}\n`,
            stderr: '',
          },
  );
  // The runtime's Codex mint closure, argument for argument.
  const mint = vi.fn(
    (
      threadId: string,
      tenantExecutionContext?: TenantExecutionContext,
      allowedTools?: readonly string[],
      generation?: number,
      toolFamilies?: true,
    ) =>
      mintCodexStationMcpHeaderAuth({
        port: PORT,
        sessionId: threadId,
        conversationId: threadId,
        serverId: 'station-control',
        tenantExecutionContext,
        allowedTools,
        coordinatorGeneration: generation,
        toolFamilies: toolFamilies === true,
      }),
  );
  const adapter = new CodexAdapter({
    processFactory: () => child as never,
    now: () => new Date(clock.ms),
    toolFamiliesEnabled: () => (options.preview ?? (() => true))(),
    findBinary: () => binary,
    runCommand,
    mintStationControlMcpAuth: mint,
    ...(options.bound
      ? {
          boundToolsEnabled: () => true,
          boundToolsEpoch: () => 1,
          resolveSourceHome: () => tmpdir(),
          createBoundTools: (input) =>
            createCodexBoundToolServer({
              ...input,
              dispatch: async () => {
                throw new Error('unexpected dispatch');
              },
            }),
        }
      : {}),
  });
  const requests = () =>
    child.stdin.lines
      .map((line) => JSON.parse(line))
      .filter((line) => typeof line.method === 'string' && 'id' in line);
  const answer = async (method: string, result: unknown) => {
    const request = await waitFor(
      () => requests().find((line) => line.method === method),
      method,
    );
    await emit(child, { id: request.id, result });
    return request;
  };
  const start = async (input: ProviderSessionStartInput, nativeId: string) => {
    const started = adapter.startSession(input);
    await flushIo();
    await answer('initialize', { userAgent: 'test' });
    const method = input.resumeCursor ? 'thread/resume' : 'thread/start';
    const request = await answer(method, { thread: { id: nativeId } });
    const session = await withTimeout(started, 'start');
    return { params: request.params, session };
  };
  return { adapter, runCommand, mint, start, options, clock };
}

/** The station-control credential in the private thread configuration. */
function credentialOf(params: { config?: Record<string, unknown> }) {
  const headers = params.config?.['mcp_servers.station-control.http_headers'] as
    | { Authorization?: string }
    | undefined;
  return headers?.Authorization?.replace(/^Bearer /, '');
}

function resolverFor(h: ReturnType<typeof harness>, codexBound = false) {
  return createSessionAgentResolver({
    loadAgentSpec: async (): Promise<AgentSpec> => ({
      name: 'Ops Agent',
      prompt: '',
      tools: { mcpServers: ['station-control'] },
    }),
    resolveToolServer: async (id) =>
      id === 'station-control'
        ? ({
            ...createRuntimeSelfIntegration().selfIntegration,
            ...stationControlRuntimeIdentity(9999),
          } as ToolDef)
        : null,
    resolveSkillDir: async () => null,
    stationInstructionsEnabled: () => true,
    codexBoundToolsEnabled: () => codexBound,
    codexToolFamiliesAdmitted: (threadId) =>
      h.adapter.toolFamiliesAdmitted(threadId),
  });
}

function firstTurnText(input: ProviderSessionStartInput): string {
  return (
    (
      input.metadata?.capabilityDelivery as
        | SessionCapabilityDeliveryMetadata
        | undefined
    )?.stationInstructions?.firstTurnText ?? ''
  );
}

describe('admission for a new Codex Session', () => {
  test('admitted: the feature rides thread/start, the credential lists only the index until a family loads, and the instructions say so', async () => {
    const h = harness();
    const resolved = await resolverFor(h)({
      threadId: 'families-on',
      cwd: tmpdir(),
      provider: 'codex',
      metadata: { agentSlug: 'ops-agent' },
    });
    expect(firstTurnText(resolved)).toContain('list_tool_families');
    const { params, session } = await h.start(resolved, 'native-on');
    expect(params.config).toMatchObject({ [FEATURE]: true });
    expect(params.dynamicTools).toBeUndefined();
    const token = credentialOf(params)!;
    expect(await listed(token)).toEqual(INDEX);
    expect(await loadFamily(token, 'Agents')).toMatchObject({ loaded: true });
    const after = await listed(token);
    expect(after).toEqual(expect.arrayContaining(['list_agents', ...INDEX]));
    expect(session.resumeCursor).toMatchObject({
      codexThreadId: 'native-on',
      toolFamilies: true,
    });
    // The version was read from the binary a session spawn resolves.
    expect(h.runCommand).toHaveBeenCalledWith(binary, ['--version']);
    await h.adapter.stopSession('families-on');
  });

  test.each([
    ['the preview is off', { preview: () => false }],
    [
      'Codex is older than the qualified 0.167.0',
      { version: 'codex-cli 0.166.9' },
    ],
    [
      'a pre-release of 0.167.0 precedes it',
      { version: 'codex-cli 0.167.0-alpha.3' },
    ],
    ['the version probe produced nothing', { version: null }],
    ['the version output is unrecognised', { version: 'codex 0.170.0' }],
  ] as const)(
    'static catalog when %s: no feature, every tool listed, no families line',
    async (_label, options) => {
      const h = harness(options);
      const resolved = await resolverFor(h)({
        threadId: 'families-off',
        cwd: tmpdir(),
        provider: 'codex',
        metadata: { agentSlug: 'ops-agent' },
      });
      expect(firstTurnText(resolved)).not.toContain('list_tool_families');
      const { params, session } = await h.start(resolved, 'native-off');
      expect(params.config).not.toHaveProperty(FEATURE);
      const tools = await listed(credentialOf(params)!);
      expect(tools).toContain('list_agents');
      expect(tools).not.toContain('load_tool_family');
      expect(session.resumeCursor).not.toHaveProperty('toolFamilies');
      expect(h.mint.mock.calls[0]).toHaveLength(1);
      await h.adapter.stopSession('families-off');
    },
  );

  test('the preview off never probes the version', async () => {
    const h = harness({ preview: () => false });
    await expect(h.adapter.toolFamiliesAdmitted()).resolves.toBe(false);
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  test('a shim that switches Codex versions is re-read once the answer expires', async () => {
    // A mise or asdf shim keeps its path, size and time while the Codex
    // behind it changes, so only the answer's age can retire it.
    const h = harness({ version: 'codex-cli 0.167.0' });
    await expect(h.adapter.toolFamiliesAdmitted()).resolves.toBe(true);
    h.options.version = 'codex-cli 0.164.0';
    h.clock.ms += CODEX_VERSION_TTL_MS - 1;
    await expect(h.adapter.toolFamiliesAdmitted()).resolves.toBe(true);
    expect(h.runCommand).toHaveBeenCalledOnce();
    h.clock.ms += 1;
    await expect(h.adapter.toolFamiliesAdmitted()).resolves.toBe(false);
    expect(h.runCommand).toHaveBeenCalledTimes(2);
  });

  test('a failed probe is held briefly, then retried', async () => {
    const h = harness({ version: null });
    await expect(h.adapter.toolFamiliesAdmitted()).resolves.toBe(false);
    h.clock.ms += CODEX_VERSION_FAILURE_TTL_MS - 1;
    await expect(h.adapter.toolFamiliesAdmitted()).resolves.toBe(false);
    // Repeated starts inside the hold do not each wait out a hanging probe.
    expect(h.runCommand).toHaveBeenCalledOnce();
    h.options.version = 'codex-cli 0.167.0';
    h.clock.ms += 1;
    await expect(h.adapter.toolFamiliesAdmitted()).resolves.toBe(true);
    expect(h.runCommand).toHaveBeenCalledTimes(2);
  });

  test('one Session start probes once, and the start uses the answer its instructions got', async () => {
    const h = harness({ version: 'codex-cli 0.167.0' });
    const resolved = await resolverFor(h)({
      threadId: 'families-shared',
      cwd: tmpdir(),
      provider: 'codex',
      metadata: { agentSlug: 'ops-agent' },
    });
    expect(firstTurnText(resolved)).toContain('list_tool_families');
    // The shim switches and the version answer expires before the engine
    // starts; the start still keeps the families its instructions promised.
    h.options.version = 'codex-cli 0.164.0';
    h.clock.ms += CODEX_VERSION_TTL_MS + 1;
    const { params } = await h.start(resolved, 'native-shared');
    expect(params.config).toMatchObject({ [FEATURE]: true });
    expect(await listed(credentialOf(params)!)).toEqual(INDEX);
    expect(h.runCommand).toHaveBeenCalledOnce();
    // The answer was used once: the next start asks again.
    await expect(
      h.adapter.toolFamiliesAdmitted('families-shared'),
    ).resolves.toBe(false);
    await h.adapter.stopSession('families-shared');
  });

  test('a held yes only narrows: the preview switched off before the start withdraws it', async () => {
    let preview = true;
    const h = harness({ preview: () => preview });
    await expect(
      h.adapter.toolFamiliesAdmitted('families-narrow'),
    ).resolves.toBe(true);
    preview = false;
    await expect(
      h.adapter.toolFamiliesAdmitted('families-narrow'),
    ).resolves.toBe(false);
  });

  test('a start composed as bound holds a no, so a preview flip before the start cannot admit it', async () => {
    const h = harness({ version: 'codex-cli 0.167.0' });
    await expect(
      h.adapter.toolFamiliesAdmitted('families-bound', false),
    ).resolves.toBe(false);
    // The bound-tools preview turned off between composing and starting:
    // the start is now eligible, but its instructions carry no families
    // line, so it must still get the whole catalog.
    await expect(
      h.adapter.toolFamiliesAdmitted('families-bound'),
    ).resolves.toBe(false);
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  test('turning the preview off leaves a running admitted Session its index and families', async () => {
    let preview = true;
    const h = harness({ preview: () => preview });
    const resolved = await resolverFor(h)({
      threadId: 'families-switch',
      cwd: tmpdir(),
      provider: 'codex',
      metadata: { agentSlug: 'ops-agent' },
    });
    const { params } = await h.start(resolved, 'native-switch');
    const token = credentialOf(params)!;
    preview = false;
    // Codex re-lists only after list_changed, so this Session keeps the
    // index it was given; its index tools and families must still answer.
    expect(await listed(token)).toEqual(INDEX);
    expect(await loadFamily(token, 'Agents')).toMatchObject({ loaded: true });
    expect(await listed(token)).toContain('list_agents');
    // New Sessions follow the preview.
    await expect(h.adapter.toolFamiliesAdmitted()).resolves.toBe(false);
    await h.adapter.stopSession('families-switch');
  });

  test('never on the Codex bound catalog: no header credential, no feature, no families line', async () => {
    const h = harness({ bound: true });
    const resolved = await resolverFor(
      h,
      true,
    )({
      threadId: 'families-bound',
      cwd: tmpdir(),
      provider: 'codex',
      metadata: { agentSlug: 'ops-agent' },
    });
    expect(firstTurnText(resolved)).not.toContain('list_tool_families');
    const { params, session } = await h.start(resolved, 'native-bound');
    expect(h.mint).not.toHaveBeenCalled();
    expect(params.config ?? {}).not.toHaveProperty(FEATURE);
    expect(
      params.dynamicTools.map((tool: { name: string }) => tool.name),
    ).toContain('list_agents');
    expect(session.resumeCursor).not.toHaveProperty('toolFamilies');
    await h.adapter.stopSession('families-bound');
  });

  test('a coordinator-derived server is on the header path and is admitted', async () => {
    const h = harness();
    const { params } = await h.start(
      {
        provider: 'codex',
        threadId: 'families-coordinator',
        cwd: tmpdir(),
        agent: {
          toolServers: [
            {
              ...control(),
              coordinatorDerived: true,
              coordinatorGeneration: 0,
            },
          ],
        },
      } as never,
      'native-coordinator',
    );
    expect(h.mint).toHaveBeenCalledWith(
      'families-coordinator',
      undefined,
      undefined,
      0,
      true,
    );
    expect(params.config).toMatchObject({ [FEATURE]: true });
    // A coordinator credential's route call also needs a designated caller
    // record; what matters here is that the credential starts at the index.
    const disclosure = stationControlDisclosureForToken(credentialOf(params)!);
    expect(disclosure).toBeDefined();
    expect(disclosure!.has('Agents')).toBe(false);
    await h.adapter.stopSession('families-coordinator');
  });
});

describe('resume', () => {
  const input = (resumeCursor?: Record<string, unknown>) =>
    ({
      provider: 'codex',
      threadId: 'families-resume',
      cwd: tmpdir(),
      agent: { toolServers: [control()] },
      ...(resumeCursor ? { resumeCursor } : {}),
    }) as never;

  test('a thread that started with families resumes with a fresh credential at the index; the old one is dead', async () => {
    const first = harness();
    const started = await first.start(input(), 'native-f');
    const original = credentialOf(started.params)!;
    await loadFamily(original, 'Agents');
    expect(await listed(original)).toContain('list_agents');
    await first.adapter.stopSession('families-resume');

    const second = harness();
    const resumed = await second.start(
      input(started.session.resumeCursor as Record<string, unknown>),
      'native-f',
    );
    expect(resumed.params.config).toMatchObject({ [FEATURE]: true });
    const fresh = credentialOf(resumed.params)!;
    expect(fresh).not.toBe(original);
    // Loaded families belonged to the old credential: the model must reload,
    // which the live qualification's resume case shows Codex lets it do.
    expect(await listed(fresh)).toEqual(INDEX);
    expect((await rpc(original, 'tools/list')).status).toBe(401);
    expect(resumed.session.resumeCursor).toMatchObject({
      codexThreadId: 'native-f',
      toolFamilies: true,
    });
    await second.adapter.stopSession('families-resume');
  });

  test('a continuation that serves the bound catalog beside the header server gets no families', async () => {
    // A source-affinity continuation with the bound preview on serves the
    // persisted catalog on the bound channel and still mints the header
    // server; that header server is not given families.
    const h = harness({ bound: true });
    const { params, session } = await h.start(
      input({
        codexThreadId: 'native-sa',
        toolFamilies: true,
        sourceAffinity: { kind: 'codex-config-home', ref: 'a'.repeat(64) },
      }),
      'native-sa',
    );
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.mint.mock.calls[0]).not.toContain(true);
    expect(params.config).toHaveProperty('mcp_servers.station-control.url');
    expect(params.config).not.toHaveProperty(FEATURE);
    // Not listed through the route: the bound server's in-process mint for
    // this Session replaces the header credential (a slice-2 behaviour of
    // this continuation, reported separately), so it answers 401 here.
    expect(session.resumeCursor).toMatchObject({ toolFamilies: true });
    await h.adapter.stopSession('families-resume');
  });

  test('a thread that started without families keeps the static catalog on resume', async () => {
    const h = harness();
    const { params, session } = await h.start(
      input({ codexThreadId: 'native-s' }),
      'native-s',
    );
    expect(params.config).not.toHaveProperty(FEATURE);
    expect(await listed(credentialOf(params)!)).toContain('list_agents');
    expect(session.resumeCursor).not.toHaveProperty('toolFamilies');
    await h.adapter.stopSession('families-resume');
  });

  test('with the preview now off, a families thread resumes with every tool and keeps its marker', async () => {
    const h = harness({ preview: () => false });
    const { params, session } = await h.start(
      input({ codexThreadId: 'native-p', toolFamilies: true }),
      'native-p',
    );
    expect(params.config).not.toHaveProperty(FEATURE);
    expect(await listed(credentialOf(params)!)).toContain('list_agents');
    expect(session.resumeCursor).toMatchObject({ toolFamilies: true });
    await h.adapter.stopSession('families-resume');
  });
});

describe('version parsing', () => {
  test.each([
    ['codex-cli 0.167.0', true],
    ['codex-cli 0.167.1', true],
    ['codex-cli 0.168.0-alpha.1', true],
    ['codex-cli 1.0.0', true],
    ['codex-cli 0.167.0-alpha.3', false],
    ['codex-cli 0.166.99', false],
    ['codex-cli 0.164.0', false],
    ['codex-cli', false],
    ['codex-cli 0.167', false],
    ['', false],
  ])('%j admits families: %s', (stdout, admitted) => {
    expect(codexVersionAdmitsToolFamilies(stdout)).toBe(admitted);
  });

  test('reads the release from `codex --version` output', () => {
    expect(parseCodexCliVersion('codex-cli 0.167.0\n')).toEqual({
      core: [0, 167, 0],
      prerelease: false,
    });
  });
});
