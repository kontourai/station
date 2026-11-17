/**
 * Epic #2376 slice 3: live qualification of progressive tool disclosure.
 *
 * Runs the REAL Codex binary against Station's real station-control HTTP route
 * with disclosure on, and a local Responses fixture in place of the model.
 * The fixture plays the model deterministically: it calls `load_tool_family`
 * for the Agents family, then calls `list_agents` only if Codex put that tool
 * in a later model request. No paid model is called.
 *
 * A case QUALIFIES only on observed facts, each recorded as EXECUTED:
 *   1. the first model request offers the family index but not `list_agents`;
 *   2. the route received `load_tool_family` and answered `loaded: true`;
 *   3. Codex listed the server's tools again after that call;
 *   4. a later model request offered `list_agents`;
 *   5. the route received `tools/call list_agents`, and the tool's own REST
 *      read reached the Station fixture;
 *   6. the tool's result came back to the model.
 *
 * Exit status: 0 when every required case qualifies, 1 when one does not (or
 * the harness itself fails), 3 when no `codex` binary is available (SKIPPED,
 * never a pass). Control cases are reported but do not set the exit status.
 *
 *   npm run qualify:tool-disclosure [-- --codex /path/to/codex] [--receipt out.json] [--case <id>]
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { findCliBinaryAsync } from '../src-server/providers/auth/cli-auth.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../src-server/routes/mcp/station-control-mcp-route.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../src-server/runtime/mcp/station-control-mcp-token.js';
import {
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

const FAMILY = 'Agents';
const FAMILY_TOOL = 'list_agents';
const AGENT_MARKER = 'disclosure-qualification-agent';
const FEATURE = 'mcp_tool_list_changed';
const CASE_DEADLINE_MS = 90_000;
const SKIPPED = 3;

/** How the engine is launched and where its Station configuration travels. */
interface QualificationCase {
  id: string;
  /** Only required cases decide the exit status; controls are reported. */
  required: boolean;
  driver: 'exec' | 'app-server';
  /** `cli`: `-c features.<FEATURE>=true` on the spawn; `thread`: inside `thread/start` config. */
  feature: 'off' | 'cli' | 'thread';
  description: string;
}

const CASES: QualificationCase[] = [
  {
    id: 'exec-flag-off',
    required: false,
    driver: 'exec',
    feature: 'off',
    description: 'codex exec, feature off (control)',
  },
  {
    id: 'exec-flag-on',
    required: true,
    driver: 'exec',
    feature: 'cli',
    description: `codex exec -c features.${FEATURE}=true`,
  },
  {
    id: 'app-server-flag-off',
    required: false,
    driver: 'app-server',
    feature: 'off',
    description:
      'codex app-server, MCP server in thread/start config as Station sends it, feature off (control)',
  },
  {
    id: 'app-server-flag-on-spawn',
    required: true,
    driver: 'app-server',
    feature: 'cli',
    description: `codex app-server -c features.${FEATURE}=true, MCP server in thread/start config`,
  },
  {
    id: 'app-server-flag-in-thread-config',
    // How Station delivers configuration, so this one gates too.
    required: true,
    driver: 'app-server',
    feature: 'thread',
    description: `codex app-server, features.${FEATURE}=true inside thread/start config`,
  },
];

const fixtureModelCatalog = {
  models: [
    {
      slug: 'disclosure-fixture',
      display_name: 'Disclosure qualification fixture',
      description: 'Local scripted fixture; no upstream model capability.',
      base_instructions: 'Follow the scripted fixture.',
      supported_reasoning_levels: [],
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority: 0,
      support_verbosity: false,
      truncation_policy: { mode: 'tokens', limit: 10000 },
      context_window: 32768,
      input_modalities: ['text'],
      experimental_supported_tools: [],
    },
  ],
};

type Json = Record<string, unknown>;
interface McpObservation {
  method: string;
  tool?: string;
  arguments?: unknown;
  status: number;
  responseText: string;
}
interface Observations {
  mcp: McpObservation[];
  rest: string[];
  /** Station-namespace tool names offered in each model request, in order. */
  offered: string[][];
  /** Each model request's function-call outputs, by call id. */
  outputs: Map<string, string>[];
  fixtureNotes: string[];
}

interface CaseResult {
  id: string;
  description: string;
  required: boolean;
  verdict: 'QUALIFIED' | 'NOT_QUALIFIED';
  checks: {
    name: string;
    evidence: 'EXECUTED';
    passed: boolean;
    detail: string;
  }[];
  engineExit: string;
  modelRequests: number;
}

function stationNamespace(body: Json) {
  const tools = Array.isArray(body.tools) ? (body.tools as Json[]) : [];
  // Codex groups an MCP server's tools under one namespace per server.
  return tools.find(
    (tool) =>
      tool.type === 'namespace' &&
      typeof tool.name === 'string' &&
      tool.name.includes('station_control'),
  ) as { name: string; tools?: Json[] } | undefined;
}

function responseStream(item: Json, sequence: number): string {
  const response = {
    id: `resp_disclosure_${sequence}`,
    object: 'response',
    status: 'completed',
    model: 'disclosure-fixture',
    output: [item],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
  return [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function message(text: string, sequence: number): Json {
  return {
    type: 'message',
    id: `msg_${sequence}`,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output))
    return output
      .map((part) => (part as { text?: unknown }).text)
      .filter((text) => typeof text === 'string')
      .join('\n');
  return JSON.stringify(output);
}

/**
 * The scripted model. It never calls a tool Codex did not offer it, so a
 * family tool call proves Codex exposed the tool to the model.
 */
function startModelFixture(observed: Observations): Promise<Server> {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
      observed.fixtureNotes.push(`unmodelled ${request.method} ${request.url}`);
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw) as Json;
    const sequence = observed.offered.length + 1;
    const namespace = stationNamespace(body);
    const offered = (namespace?.tools ?? []).map((tool) => String(tool.name));
    observed.offered.push(offered);
    const outputs = new Map<string, string>();
    for (const entry of (body.input as Json[]) ?? [])
      if (entry.type === 'function_call_output')
        outputs.set(String(entry.call_id), outputText(entry.output));
    observed.outputs.push(outputs);
    const call = (callId: string, name: string, args: Json): Json => ({
      type: 'function_call',
      id: `fc_${callId}`,
      call_id: callId,
      name,
      namespace: namespace?.name,
      arguments: JSON.stringify(args),
    });
    let item: Json;
    if (!outputs.has('call_load')) {
      item = offered.includes('load_tool_family')
        ? call('call_load', 'load_tool_family', { family: FAMILY })
        : message('Station disclosure index was not offered.', sequence);
    } else if (outputs.has('call_family')) {
      item = message('Family tool result received.', sequence);
    } else if (offered.includes(FAMILY_TOOL)) {
      item = call('call_family', FAMILY_TOOL, {});
    } else if (
      !outputs.has('call_poll_2') &&
      offered.includes('list_tool_families')
    ) {
      // Give an asynchronous refresh two more model requests to land before
      // concluding the family stayed invisible.
      item = call(
        outputs.has('call_poll_1') ? 'call_poll_2' : 'call_poll_1',
        'list_tool_families',
        {},
      );
    } else {
      item = message(
        `${FAMILY_TOOL} was never offered after loading.`,
        sequence,
      );
    }
    response
      .writeHead(200, { 'content-type': 'text/event-stream' })
      .end(responseStream(item, sequence));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
}

/** Station's real station-control route with disclosure on, plus the REST read `list_agents` makes. */
async function startStation(observed: Observations) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    let rpc: Json | undefined;
    if (c.req.method === 'POST')
      rpc = (await c.req.raw
        .clone()
        .json()
        .catch(() => undefined)) as Json | undefined;
    await next();
    if (!c.req.path.startsWith('/mcp/')) return;
    const params = rpc?.params as Json | undefined;
    observed.mcp.push({
      method: rpc ? String(rpc.method) : c.req.method,
      ...(rpc?.method === 'tools/call'
        ? { tool: String(params?.name), arguments: params?.arguments }
        : {}),
      status: c.res.status,
      responseText: await c.res
        .clone()
        .text()
        .catch(() => ''),
    });
  });
  app.get('/agents', (c) => {
    observed.rest.push('GET /agents');
    return c.json({ success: true, data: [{ slug: AGENT_MARKER }] });
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  app.route(
    '/',
    createStationControlMcpRoutes({
      port,
      progressiveToolsEnabled: () => true,
      resolveCallerRecord: () => ({
        principal: { id: 'person:qualification', source: 'session-owner' },
        localProjectId: 'qualification',
        projectSlug: 'qualification',
        projectIdSource: 'session-record',
      }),
    }),
  );
  return {
    server,
    url: `http://127.0.0.1:${port}${STATION_CONTROL_MCP_PATH}`,
  };
}

function toml(value: unknown): string {
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${toml(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Starts the engine as an owned process group: Codex starts helpers of its
 * own, and the whole tree must be gone before the next case or the result.
 */
function startEngine(
  codex: string,
  args: string[],
  label: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: boolean },
) {
  const execution = executeOwnedCommand(codex, args, spawn, label, {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const child = execution.child as ChildProcess;
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-600);
  });
  let timer: NodeJS.Timeout | undefined;
  const exited: Promise<string> = Promise.race([
    execution.completion.then(
      (result: { status: number | null; signal: string | null }) => {
        const tail = stderr.trim().split('\n').at(-1);
        return `${label}: exit ${result.status ?? result.signal}${result.status !== 0 && tail ? ` (${tail})` : ''}`;
      },
    ),
    new Promise<string>((resolve) => {
      timer = setTimeout(
        () => resolve(`${label}: no exit within ${CASE_DEADLINE_MS} ms`),
        CASE_DEADLINE_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  const stop = async () => {
    const outcome = await terminateSuiteExecution(execution, {
      waitForSuiteSettlement,
      terminationGraceMs: 2_000,
      terminationForceMs: 2_000,
      processLabel: label,
    });
    if (!outcome.settled)
      throw new Error(`${label} process tree outlived its termination`);
  };
  return { child, exited, stop };
}

const PROMPT = `Load the ${FAMILY} Station tool family, then list agents.`;

async function runExec(
  codex: string,
  common: string[],
  mcp: { url: string; token: string },
  testCase: QualificationCase,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  const engine = startEngine(
    codex,
    [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-m',
      'disclosure-fixture',
      ...common,
      '-c',
      `mcp_servers.station-control.url=${toml(mcp.url)}`,
      '-c',
      `mcp_servers.station-control.http_headers=${toml({ Authorization: `Bearer ${mcp.token}` })}`,
      ...(testCase.feature === 'cli' ? ['-c', `features.${FEATURE}=true`] : []),
      PROMPT,
    ],
    'codex exec',
    { cwd, env, stdin: false },
  );
  engine.child.stdout?.resume();
  try {
    return await engine.exited;
  } finally {
    await engine.stop();
  }
}

/**
 * Station's own Codex path: `codex app-server`, with the station-control
 * server delivered as dotted keys inside `thread/start`'s private config
 * (`codex-mcp-passthrough.ts`), never on argv.
 */
async function runAppServer(
  codex: string,
  common: string[],
  mcp: { url: string; token: string },
  testCase: QualificationCase,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  const { child, exited, stop } = startEngine(
    codex,
    [
      'app-server',
      ...common,
      ...(testCase.feature === 'cli' ? ['-c', `features.${FEATURE}=true`] : []),
    ],
    'codex app-server',
    { cwd, env, stdin: true },
  );
  const pending = new Map<number, (message: Json) => void>();
  let turnCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    turnCompleted = resolve;
  });
  const serverRequests: string[] = [];
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        // Not a JSON-RPC line (a stray log); the case still stands or falls
        // on what the protocol messages show.
        continue;
      }
      if (typeof message.id === 'number' && !message.method) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } else if (message.method && message.id !== undefined) {
        // An approval or input request would mean the case is not unattended.
        serverRequests.push(String(message.method));
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'qualification answers no requests' } })}\n`,
        );
      } else if (message.method === 'turn/completed') {
        turnCompleted?.();
      }
    }
  });
  let nextId = 0;
  const send = (method: string, params: Json) =>
    new Promise<Json>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) =>
        message.error
          ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
          : resolve(message.result as Json),
      );
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  const deadline = <T>(operation: Promise<T>) =>
    Promise.race([
      operation,
      exited.then((exit) => {
        throw new Error(`engine ended early (${exit})`);
      }),
    ]);
  try {
    await deadline(
      send('initialize', {
        clientInfo: {
          name: 'station-qualification',
          title: 'Station qualification',
          version: '0',
        },
        capabilities: { experimentalApi: false },
      }),
    );
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`,
    );
    const started = await deadline(
      send('thread/start', {
        cwd,
        model: 'disclosure-fixture',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        config: {
          'mcp_servers.station-control.url': mcp.url,
          'mcp_servers.station-control.http_headers': {
            Authorization: `Bearer ${mcp.token}`,
          },
          ...(testCase.feature === 'thread'
            ? { [`features.${FEATURE}`]: true }
            : {}),
        },
      }),
    );
    const threadId = (started.thread as Json | undefined)?.id;
    await deadline(
      send('turn/start', {
        threadId,
        input: [{ type: 'text', text: PROMPT, text_elements: [] }],
      }),
    );
    await deadline(completed);
    return `codex app-server: turn completed${serverRequests.length ? `; refused server requests ${serverRequests.join(', ')}` : ''}`;
  } catch (error) {
    return `codex app-server: ${(error as Error).message}`;
  } finally {
    child.stdin?.end();
    await stop();
  }
}

function judge(observed: Observations): CaseResult['checks'] {
  const loadIndex = observed.mcp.findIndex(
    (entry) =>
      entry.method === 'tools/call' && entry.tool === 'load_tool_family',
  );
  const load = observed.mcp[loadIndex];
  const relisted =
    loadIndex >= 0 &&
    observed.mcp
      .slice(loadIndex + 1)
      .some((entry) => entry.method === 'tools/list');
  const afterLoad = observed.offered.filter((_, index) =>
    observed.outputs[index]?.has('call_load'),
  );
  const familyCall = observed.mcp.find(
    (entry) => entry.method === 'tools/call' && entry.tool === FAMILY_TOOL,
  );
  const familyOutput = observed.outputs
    .map((outputs) => outputs.get('call_family'))
    .find((output) => output !== undefined);
  const first = observed.offered[0] ?? [];
  return [
    {
      name: 'initial listing is the disclosure index only',
      evidence: 'EXECUTED',
      passed:
        first.includes('load_tool_family') && !first.includes(FAMILY_TOOL),
      detail: `first model request offered [${first.join(', ')}]`,
    },
    {
      name: 'load_tool_family reached Station and loaded the family',
      evidence: 'EXECUTED',
      passed: Boolean(load?.responseText.includes('\\"loaded\\": true')),
      detail: load
        ? `tools/call load_tool_family ${JSON.stringify(load.arguments)} -> HTTP ${load.status}`
        : 'no load_tool_family call reached the route',
    },
    {
      name: 'engine listed tools again after loading',
      evidence: 'EXECUTED',
      passed: relisted,
      detail: `MCP methods: ${observed.mcp.map((entry) => entry.tool ?? entry.method).join(' > ')}`,
    },
    {
      name: `a later model request offered ${FAMILY_TOOL}`,
      evidence: 'EXECUTED',
      passed: afterLoad.some((names) => names.includes(FAMILY_TOOL)),
      detail: `requests after loading offered: ${afterLoad.map((names) => `[${names.join(', ')}]`).join(' ') || 'none'}`,
    },
    {
      name: `${FAMILY_TOOL} call reached Station and ran its REST read`,
      evidence: 'EXECUTED',
      passed: Boolean(familyCall) && observed.rest.includes('GET /agents'),
      detail: `route call: ${familyCall ? `HTTP ${familyCall.status}` : 'none'}; REST: [${observed.rest.join(', ')}]`,
    },
    {
      name: 'family tool result returned to the model',
      evidence: 'EXECUTED',
      passed: Boolean(familyOutput?.includes(AGENT_MARKER)),
      detail: familyOutput
        ? `output carried ${familyOutput.includes(AGENT_MARKER) ? 'the' : 'no'} fixture agent`
        : 'no family tool output reached the model',
    },
  ];
}

async function runCase(
  codex: string,
  testCase: QualificationCase,
): Promise<CaseResult> {
  const observed: Observations = {
    mcp: [],
    rest: [],
    offered: [],
    outputs: [],
    fixtureNotes: [],
  };
  const home = mkdtempSync(join(tmpdir(), 'station-disclosure-qualification-'));
  const model = await startModelFixture(observed);
  const station = await startStation(observed);
  const sessionId = `disclosure-qualification-${testCase.id}`;
  // The runtime's own mint shape for a Codex header credential, with the
  // per-token disclosure switch that every production mint leaves off.
  const { token } = mintStationControlMcpToken(
    sessionId,
    'http-header-token',
    undefined,
    undefined,
    undefined,
    'station-control',
    undefined,
    () => true,
    true,
  );
  const catalogPath = join(home, 'models.json');
  writeFileSync(catalogPath, JSON.stringify(fixtureModelCatalog));
  const modelPort = (model.address() as AddressInfo).port;
  const common = [
    '-c',
    `model_catalog_json=${toml(catalogPath)}`,
    '-c',
    'model_provider="disclosure-fixture"',
    '-c',
    `model_providers.disclosure-fixture=${toml({
      name: 'Disclosure qualification fixture',
      base_url: `http://127.0.0.1:${modelPort}/v1`,
      wire_api: 'responses',
      env_key: 'DISCLOSURE_FIXTURE_KEY',
    })}`,
  ];
  // A fresh home: no operator config, credentials or history reach the run.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: home,
    DISCLOSURE_FIXTURE_KEY: 'synthetic-fixture-key',
  };
  let engineExit: string;
  try {
    const run = testCase.driver === 'exec' ? runExec : runAppServer;
    engineExit = await run(
      codex,
      common,
      { url: station.url, token },
      testCase,
      env,
      home,
    );
  } finally {
    revokeStationControlMcpToken(sessionId);
    model.close();
    station.server.close();
    rmSync(home, { recursive: true, force: true });
  }
  const checks = judge(observed);
  return {
    id: testCase.id,
    description: testCase.description,
    required: testCase.required,
    verdict: checks.every((check) => check.passed)
      ? 'QUALIFIED'
      : 'NOT_QUALIFIED',
    checks,
    engineExit:
      observed.fixtureNotes.length > 0
        ? `${engineExit}; fixture: ${observed.fixtureNotes.join('; ')}`
        : engineExit,
    modelRequests: observed.offered.length,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      codex: { type: 'string' },
      receipt: { type: 'string' },
      case: { type: 'string', multiple: true },
    },
  });
  // Station's own resolver, so the binary is the one Station would launch.
  const codex =
    values.codex !== undefined
      ? existsSync(values.codex)
        ? values.codex
        : null
      : await findCliBinaryAsync('codex');
  if (!codex) {
    console.log(
      `SKIPPED: no \`codex\` binary ${values.codex ? `at ${values.codex}` : 'on this host'} (pass --codex <path>). Nothing was qualified.`,
    );
    return SKIPPED;
  }
  const version = await new Promise<string>((resolve) => {
    const child = spawn(codex, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let text = '';
    child.stdout.on('data', (chunk) => (text += chunk));
    child.once('error', () => resolve('unknown'));
    child.once('exit', () => resolve(text.trim() || 'unknown'));
  });
  const selected = values.case?.length
    ? CASES.filter((testCase) => values.case?.includes(testCase.id))
    : CASES;
  if (selected.length === 0)
    throw new Error(`No case matches ${values.case?.join(', ')}`);
  console.log(`Tool-disclosure qualification: ${codex} (${version})`);
  const results: CaseResult[] = [];
  for (const testCase of selected) {
    const result = await runCase(codex, testCase);
    results.push(result);
    console.log(
      `\n${result.verdict} ${result.id}${result.required ? '' : ' (control)'}: ${result.description}`,
    );
    console.log(
      `  ${result.engineExit}; ${result.modelRequests} model requests`,
    );
    for (const check of result.checks)
      console.log(
        `  ${check.passed ? 'pass' : 'FAIL'} [${check.evidence}] ${check.name}: ${check.detail}`,
      );
  }
  const failed = results.filter(
    (result) => result.required && result.verdict !== 'QUALIFIED',
  );
  const receipt = {
    schema: 'station.tool-disclosure-qualification/v1',
    engine: { binary: codex, version },
    feature: FEATURE,
    results,
    outcome: failed.length ? 'FAIL' : 'PASS',
  };
  if (values.receipt)
    writeFileSync(values.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    failed.length
      ? `\nFAIL: required case(s) did not qualify: ${failed.map((result) => result.id).join(', ')}`
      : '\nPASS: every required case qualified.',
  );
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(
      `FAIL: qualification harness error: ${(error as Error).stack ?? error}`,
    );
    process.exit(1);
  },
);
