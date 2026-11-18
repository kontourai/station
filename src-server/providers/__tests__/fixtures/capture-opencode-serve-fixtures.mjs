#!/usr/bin/env node
// Records what a real `opencode serve` (OpenCode 2.x) sends over HTTP and
// SSE, so the native OpenCode transport replays the engine's own wire rather
// than a hand-written guess. Also records one ACP<->native cross-load and
// what `opencode debug agents` prints.
//
// Usage (manual; no model account is used, a local mock model answers):
//   node src-server/providers/__tests__/fixtures/capture-opencode-serve-fixtures.mjs \
//     --opencode <path-to-opencode-2.x> --work <empty-scratch-dir> \
//     [--out <fixtures-dir>] [--port-base 47300] [--only basic,tools]
//     [--config plain]   (only for the plan-deny scenario)
//
// Isolation: OpenCode runs with HOME, XDG_* and TMPDIR inside --work, a
// fresh git project at <work>/proj, an inline mock OpenAI-compatible model on
// --port-base, and `serve` on --port-base + 1. Every process this starts is
// stopped (process group) before it exits, also on failure.
//
// Output: one `opencode-serve-<version>-<scenario>.jsonl` per scenario, lines
//   {t, kind:'http', method, path, body?, status, response}
//   {t, kind:'sse', tap, event}        one parsed `data:` frame, verbatim
//   {t, kind:'sse-comment', tap, text} a `:` comment line (heartbeat)
//   {t, kind:'sse-open'|'sse-close', tap}
//   {t, kind:'acp', dir:'->'|'<-', msg} cross-load only
//   {t, kind:'cli', args, status, stdout, stderr} debug-agents only
//   {t, kind:'finding', text}          what the scenario established
// with `t` in ms since the scenario began, plus
// `opencode-serve-<version>-openapi.json`, the served `/openapi.json`.
// Format that file with the repository's Biome before committing it
// (`node scripts/run-biome.mjs check --write <file>`); the content is unchanged.
// Everything is scrubbed before it is written: the server password, every
// absolute path under --work ({PROJ}, {HOME}, {WORK}, slash-less forms too,
// since OpenCode reports relative `subpath`s), the caller's home directory
// ({USERHOME}), the binary's directory ({BIN}), the host name and the user
// name. The privacy suite (opencode-serve-fixtures.test.ts) checks
// the committed files.
//
// Settled by the 2.3.0 capture (2026-11-13), recorded as `finding` lines:
// (a) ACP session ids are OpenCode's native session ids: `opencode acp`
//     loads a session `serve` created by its id, and a session ACP created is
//     readable by that same id over `GET /api/session/{id}` on a separate
//     serve over the same data directory (crossload).
// (b) The id of a user turn's message is the `POST /prompt` answer's
//     `data.id`; history lists the same id as that user message, and a
//     steer's own prompt answer carries its id the same way (basic, steer).
//     Every prompt is an inbox item under that same id:
//     `session.inbox.enqueued`, then `.delivered` (or `.cancelled` after
//     `DELETE /inbox/{id}`) name it as `inboxID`.
// (c) 2.x has no `debug agent <name>` (exit 1, "Unknown subcommand"), the
//     form Station's 1.x approval check runs. `debug agents --standalone`
//     prints every agent's configured `permissions` ({action, resource,
//     effect}), the same as `GET /api/agent`; it does not show approvals the
//     person saved (`GET /api/permission/saved`). Without `--standalone` it
//     starts or joins OpenCode's shared background service. So the 1.x
//     check cannot verify a 2.x engine, and over ACP Station refuses its
//     approval modes on 2.x (ruling R1) rather than rebuild the check there.
// Settled by the 2.3.0 capture (2026-11-15):
// (i) Code Mode's `opencode.session_move` to a directory inside the project
//     asks nothing under Station's confined rules, and OpenCode loads the
//     destination's own plugin before it publishes `session.moved` (move).
//     With `opencode_session_move` denied after those rules, the model is
//     not offered the tool and the call fails as unknown (move-denied).
// (j) A grandchild (a child's own child, `experimental.subagent_depth: 2`)
//     raising an ask while no feed is open: `GET /api/permission/request`
//     lists it, and `GET /api/session?parentID=` finds the child, then the
//     grandchild (subagent-gap).
// (k) After a session moves, an ask it raises while no feed is open is in
//     its own `GET /api/session/{id}/permission`, and not in the server-wide
//     `GET /api/permission/request`, which lists the server's launch
//     directory (move-gap).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  credentialScrubRows,
  scrubText,
} from './capture-opencode-serve-scrub.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${key} needs a value`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.opencode || !args.work) {
  console.error(
    'Usage: capture-opencode-serve-fixtures.mjs --opencode <bin> --work <empty-dir> [--out <dir>] [--port-base 47300] [--only a,b] [--config plain]',
  );
  process.exit(2);
}
const BIN = path.resolve(args.opencode);
const WORK = path.resolve(args.work);
const OUT = path.resolve(
  args.out ?? path.dirname(fileURLToPath(import.meta.url)),
);
const PORT_BASE = Number(args['port-base'] ?? 47300);
const MOCK_PORT = PORT_BASE;
const SERVE_PORT = PORT_BASE + 1;
/**
 * A Station-like HTTP MCP server, for `mcp-add`: it refuses a request
 * without the session's header. Station's own servers take a bearer
 * `Authorization` header; the capture names its header differently so the
 * committed fixture never holds an authorization header (privacy suite).
 */
const HTTP_MCP_HEADER = 'x-station-session';
const HTTP_MCP_PORT = PORT_BASE + 5;
const HTTP_MCP_TOKEN = 'capture-mcp-session-token';
if (!(PORT_BASE >= 1024 && PORT_BASE < 65000))
  throw new Error('--port-base out of range');

mkdirSync(WORK, { recursive: true });
if (readdirSync(WORK).length > 0)
  throw new Error(`--work must be empty: ${WORK}`);

const HOME = path.join(WORK, 'home');
const PROJ = path.join(WORK, 'proj');
const TMP = path.join(WORK, 'tmp');
for (const dir of [
  `${HOME}/config/opencode`,
  `${HOME}/data`,
  `${HOME}/state`,
  `${HOME}/cache`,
  PROJ,
  TMP,
])
  mkdirSync(dir, { recursive: true });

const PASSWORD = randomBytes(32).toString('base64url');
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- scrubbing

function pathForms(p) {
  const forms = new Set([p]);
  try {
    forms.add(realpathSync(p));
  } catch {}
  for (const form of [...forms]) forms.add(form.replace(/^\//, ''));
  return [...forms].sort((a, b) => b.length - a.length);
}

const SCRUB = [
  ...credentialScrubRows('opencode', PASSWORD),
  ...pathForms(PROJ).map((form) => [form, '{PROJ}']),
  ...pathForms(HOME).map((form) => [form, '{HOME}']),
  ...pathForms(WORK).map((form) => [form, '{WORK}']),
  ...pathForms(path.dirname(BIN)).map((form) => [form, '{BIN}']),
  ...pathForms(os.homedir()).map((form) => [form, '{USERHOME}']),
  [os.hostname(), '{HOSTNAME}'],
  [os.userInfo().username, '{USER}'],
].filter(([from]) => from && from.length >= 3);

function scrub(text) {
  return scrubText(text, SCRUB);
}

// ---------------------------------------------------------------- mock model

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part === 'string' ? part : (part.text ?? '')))
      .join('\n');
  return '';
}

/** What the mock answers: trigger words in the last user message pick a tool call. */
function plan(body) {
  const messages = body.messages || [];
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n');
  const last = messages[messages.length - 1] || {};
  const tools = (body.tools || []).map((t) => t.function?.name).filter(Boolean);
  if (system.includes('You name conversations'))
    return { kind: 'text', chunks: ['Mock ', 'title'] };
  if (last.role === 'tool')
    return {
      kind: 'text',
      chunks: [
        'Tool ',
        'finished: ',
        // Scrubbed before it is cut, so a cut never leaves part of a path.
        JSON.stringify(scrub(textOf(last.content))).slice(0, 120),
      ],
    };
  const user = textOf(last.content);
  // What an attachment reached the model as (OpenAI-compatible parts).
  if (
    Array.isArray(last.content) &&
    last.content.some((part) => part?.type === 'image_url')
  )
    return { kind: 'text', chunks: ['IMAGE_SEEN ', 'by mock'] };
  // OpenCode's compaction refuses a summary without its template headings.
  if (user.includes('<template>') || user.includes('required summary template'))
    return {
      kind: 'text',
      chunks: [
        '## Objective\n',
        'Probe the API.\n',
        '## Decisions\n',
        'None.\n',
      ],
    };
  const call = (name, input) =>
    tools.includes(name)
      ? { kind: 'tool', name, args: input }
      : { kind: 'text', chunks: [`TOOL_UNAVAILABLE ${name}`] };
  if (user.includes('DO_BASH'))
    return call('shell', {
      command: 'echo hello-from-bash',
      description: 'echo test',
    });
  if (user.includes('DO_LS'))
    return call('shell', { command: 'ls -a', description: 'list files' });
  if (user.includes('DO_WRITE'))
    return call('write', { path: 'created.txt', content: 'created by mock\n' });
  if (user.includes('DO_EDIT'))
    return call('edit', {
      path: 'edit-me.txt',
      oldString: 'line one',
      newString: 'line one EDITED',
    });
  if (user.includes('DO_MCP')) {
    const echo = tools.find((name) => /^station-echo[_-]echo$/.test(name));
    if (echo)
      return { kind: 'tool', name: echo, args: { text: 'from-station-mcp' } };
    // OpenCode's Code Mode (on by default for an added server) offers MCP
    // tools only inside its `execute` tool.
    if (tools.includes('execute'))
      return {
        kind: 'tool',
        name: 'execute',
        args: {
          code: 'const ns = tools["station-echo"] ?? tools.station_echo; return await ns.echo({ text: "from-station-mcp" });',
        },
      };
    return {
      kind: 'text',
      chunks: [`TOOL_UNAVAILABLE station-echo (${tools.join(',')})`],
    };
  }
  // Code Mode's `opencode.session_move` (2.3.0 `tool/plugin/opencode.ts`),
  // to a directory inside the project: no ask.
  if (user.includes('DO_MOVE'))
    return call('execute', {
      code: `return await tools.opencode.session_move({ directory: ${JSON.stringify(/DO_MOVE (\S+)/.exec(user)?.[1] ?? 'sub')} });`,
    });
  // A child that starts a grandchild, whose shell asks (`subagent-gap`).
  if (user.includes('DO_TASK_DEEP'))
    return call('subagent', {
      agent: 'general',
      description: 'deep child',
      prompt: 'CHILD_DEEP start a grandchild',
    });
  if (user.includes('CHILD_DEEP'))
    return call('subagent', {
      agent: 'general',
      description: 'grandchild probe',
      prompt: 'GRANDCHILD_BASH run it',
    });
  if (user.includes('GRANDCHILD_BASH'))
    return call('shell', {
      command: 'echo grandchild',
      description: 'grandchild echo',
    });
  if (user.includes('DO_TASK'))
    return call('subagent', {
      agent: 'general',
      description: 'child probe',
      prompt: 'CHILD_TASK reply with child-ok',
    });
  if (user.includes('CHILD_TASK'))
    return { kind: 'text', chunks: ['child-ok ', 'from ', 'subagent'] };
  if (user.includes('DO_QUESTION'))
    return call('question', {
      questions: [
        {
          question: 'Pick a color?',
          header: 'Color',
          options: [
            { label: 'Red', description: 'warm' },
            { label: 'Blue', description: 'cool' },
          ],
        },
      ],
    });
  // Reasoning before the reply, as a reasoning model streams it
  // (`reasoning_content`): OpenCode numbers reasoning and text parts apart.
  if (user.includes('DO_THINK_SLOW'))
    return {
      kind: 'text',
      reasoning: ['Thinking ', 'it ', 'over.'],
      chunks: Array.from({ length: 20 }, (_, i) => `t${i} `),
      delay: 150,
    };
  if (user.includes('DO_THINK'))
    return {
      kind: 'text',
      reasoning: ['Thinking ', 'it ', 'over.'],
      chunks: ['thought ', 'reply'],
    };
  if (user.includes('DO_SLOW'))
    return {
      kind: 'text',
      chunks: Array.from({ length: 40 }, (_, i) => `w${i} `),
      delay: 150,
    };
  return { kind: 'text', chunks: ['mock ', 'reply: ', user.slice(-60)] };
}

/** What each model request offered, for findings (never written as is). */
const MODEL_REQUESTS = [];

function startMockModel() {
  let requestNo = 0;
  const server = http.createServer(async (req, res) => {
    const id = ++requestNo;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'GET' && req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-1', object: 'model' }],
        }),
      );
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {}
    const p = plan(body);
    MODEL_REQUESTS.push({
      user: textOf((body.messages ?? []).at(-1)?.content).slice(0, 80),
      tools: (body.tools ?? []).map((t) => t.function?.name).filter(Boolean),
      // Code Mode lists its tools in the `execute` tool's description.
      offersSessionMove: JSON.stringify(body.tools ?? []).includes(
        'session_move',
      ),
    });
    const base = {
      id: `chatcmpl-${id}`,
      object: 'chat.completion.chunk',
      created: 0,
      model: body.model || 'mock-1',
    };
    const usage = {
      prompt_tokens: 100 + (body.messages?.length ?? 0),
      completion_tokens: 20,
      total_tokens: 120 + (body.messages?.length ?? 0),
    };
    let aborted = false;
    res.on('close', () => {
      if (!res.writableFinished) aborted = true;
    });
    if (!body.stream) {
      const message =
        p.kind === 'tool'
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${id}`,
                  type: 'function',
                  function: { name: p.name, arguments: JSON.stringify(p.args) },
                },
              ],
            }
          : {
              role: 'assistant',
              content: p.chunks.join(''),
              ...(p.reasoning
                ? { reasoning_content: p.reasoning.join('') }
                : {}),
            };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message,
              finish_reason: p.kind === 'tool' ? 'tool_calls' : 'stop',
            },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        },
      ],
    });
    if (p.kind === 'tool') {
      const argText = JSON.stringify(p.args);
      const half = Math.floor(argText.length / 2);
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${id}`,
                  type: 'function',
                  function: { name: p.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      for (const part of [argText.slice(0, half), argText.slice(half)])
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: part } }],
              },
              finish_reason: null,
            },
          ],
        });
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
    } else {
      for (const chunk of p.reasoning ?? []) {
        if (aborted) return;
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: chunk },
              finish_reason: null,
            },
          ],
        });
      }
      for (const chunk of p.chunks) {
        if (aborted) return;
        send({
          ...base,
          choices: [
            { index: 0, delta: { content: chunk }, finish_reason: null },
          ],
        });
        if (p.delay) await sleep(p.delay);
      }
      if (aborted) return;
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
    }
    send({ ...base, choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- project and config

const MCP_ECHO = `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mcp-echo', version: '0.0.1' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(msg.params?.arguments?.text) }] } });
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
});
`;

/**
 * A minimal streamable-HTTP MCP server, as a Station tool server is reached:
 * JSON-RPC over POST, answered as JSON, refusing any call without the
 * session's header. Records what it was asked.
 */
function startHttpMcp() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const authorized = req.headers[HTTP_MCP_HEADER] === HTTP_MCP_TOKEN;
    let msg;
    try {
      msg = JSON.parse(raw || 'null');
    } catch {}
    seen.push({ method: req.method, rpc: msg?.method, authorized });
    if (!authorized) return res.writeHead(401).end();
    if (req.method !== 'POST') return res.writeHead(405).end();
    if (!msg || msg.id === undefined) return res.writeHead(202).end();
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize')
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'station-echo', version: '0.0.1' },
      });
    if (msg.method === 'tools/list')
      return reply({
        tools: [
          {
            name: 'echo',
            description: 'Echo text back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      });
    if (msg.method === 'tools/call')
      return reply({
        content: [
          { type: 'text', text: `echo: ${msg.params?.arguments?.text}` },
        ],
      });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'not found' },
      }),
    );
  });
  return new Promise((resolve) =>
    server.listen(HTTP_MCP_PORT, '127.0.0.1', () => resolve({ server, seen })),
  );
}

function prepareWorkspace() {
  writeFileSync(path.join(WORK, 'mcp-echo.mjs'), MCP_ECHO);
  writeFileSync(path.join(PROJ, 'edit-me.txt'), 'line one\nline two\n');
  const git = (...gitArgs) => {
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...gitArgs,
      ],
      { cwd: PROJ, env: engineEnv(), encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0)
      throw new Error(`git ${gitArgs.join(' ')}: ${result.stderr}`);
  };
  git('init', '-q', '-b', 'main', '.');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const config = {
    model: 'mock/mock-1',
    update: 'disable',
    share: 'manual',
    // A child may start its own child (`subagent-gap`); 2.3.0 allows one
    // level unless this is raised (`tool/plugin/subagent.ts`).
    experimental: { subagent_depth: 2 },
    // `--config plain` keeps OpenCode's own agent rules in force (no global
    // allow after them), so an agent's configured deny is what decides.
    ...(args.config === 'plain'
      ? {}
      : {
          permissions: [
            { action: '*', resource: '*', effect: 'allow' },
            { action: 'shell', resource: '*', effect: 'ask' },
          ],
        }),
    mcp: {
      servers: {
        echo: {
          type: 'local',
          command: [process.execPath, path.join(WORK, 'mcp-echo.mjs')],
        },
        broken: {
          type: 'local',
          command: [path.join(WORK, 'missing-mcp-binary')],
        },
      },
    },
    commands: {
      probecmd: {
        template: 'PROBE_COMMAND $ARGUMENTS',
        description: 'probe command',
      },
    },
    providers: {
      mock: {
        name: 'Mock',
        package: '@ai-sdk/openai-compatible',
        settings: {
          baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`,
          apiKey: 'mock-key',
        },
        models: {
          // An image-sized context, so an attached image does not set off
          // compaction (`attachment`).
          'mock-vision': {
            name: 'Mock Vision',
            capabilities: { tools: true, input: ['text', 'image'] },
            cost: { input: 1, output: 2 },
            limit: { context: 200000, output: 2000 },
          },
          'mock-1': {
            name: 'Mock One',
            capabilities: { tools: true },
            cost: { input: 1, output: 2 },
            limit: { context: 8000, output: 2000 },
          },
        },
      },
    },
  };
  writeFileSync(
    path.join(HOME, 'config/opencode/opencode.json'),
    JSON.stringify(config, null, 2),
  );
}

/** A fresh environment: nothing of the caller's except PATH. */
function engineEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME,
    XDG_CONFIG_HOME: `${HOME}/config`,
    XDG_DATA_HOME: `${HOME}/data`,
    XDG_STATE_HOME: `${HOME}/state`,
    XDG_CACHE_HOME: `${HOME}/cache`,
    TMPDIR: TMP,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    ...extra,
  };
}

// ---------------------------------------------------------------- owned processes

const owned = new Set();

function spawnOwned(command, commandArgs, options) {
  const child = spawn(command, commandArgs, { ...options, detached: true });
  owned.add(child);
  child.once('exit', () => owned.delete(child));
  return child;
}

async function stopOwned(child, { closeStdin = true } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (closeStdin) child.stdin?.end();
  if (await Promise.race([exited.then(() => true), sleep(5000)])) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  if (await Promise.race([exited.then(() => true), sleep(3000)])) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
  await exited;
}

function killAllOwned() {
  for (const child of owned) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
}
process.on('exit', killAllOwned);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    killAllOwned();
    process.exit(130);
  });

async function startServe(port = SERVE_PORT) {
  const child = spawnOwned(
    BIN,
    ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: PROJ,
      env: engineEnv({ OPENCODE_PASSWORD: PASSWORD }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (d) => {
    if (stderr.length < 8192) stderr += d;
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`serve did not report readiness: ${stderr}`)),
      30_000,
    );
    child.stdout.on('data', (d) => {
      buffer += d;
      const line = buffer.split('\n')[0];
      if (buffer.includes('\n')) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line).url);
        } catch {
          reject(new Error(`serve readiness line was not JSON: ${line}`));
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited ${code}: ${stderr}`));
    });
  });
  return { child, url: url.replace(/\/$/, '') };
}

// ---------------------------------------------------------------- recorder

class Recorder {
  constructor(base) {
    this.base = base;
    this.t0 = Date.now();
    this.lines = [];
    this.taps = [];
  }
  push(entry) {
    this.lines.push({ t: Date.now() - this.t0, ...entry });
  }
  finding(text) {
    this.push({ kind: 'finding', text });
    console.log(`  finding: ${text}`);
  }
  async api(method, apiPath, body) {
    const headers = { authorization: AUTH };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let response = null;
    if (text) {
      try {
        response = JSON.parse(text);
      } catch {
        response = text;
      }
    }
    this.push({
      kind: 'http',
      method,
      path: apiPath,
      ...(body !== undefined ? { body } : {}),
      status: res.status,
      response,
    });
    return { status: res.status, json: response };
  }
  async tap(name) {
    const tap = new Tap(this, name);
    await tap.open();
    this.taps.push(tap);
    return tap;
  }
  async close() {
    for (const tap of this.taps) tap.close();
    await sleep(100);
  }
}

class Tap {
  constructor(recorder, name) {
    this.recorder = recorder;
    this.name = name;
    this.events = [];
    this.waiters = [];
    this.ctrl = new AbortController();
    this.closed = false;
  }
  async open() {
    const res = await fetch(`${this.recorder.base}/api/event`, {
      headers: { authorization: AUTH, accept: 'text/event-stream' },
      signal: this.ctrl.signal,
    });
    if (res.status !== 200) throw new Error(`event stream ${res.status}`);
    this.recorder.push({ kind: 'sse-open', tap: this.name });
    this.read(res).catch(() => {});
    await this.waitFor((e) => e.type === 'server.connected', 10_000);
  }
  async read(res) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
        const lines = frame.split('\n');
        for (const line of lines.filter((l) => l.startsWith(':')))
          this.recorder.push({
            kind: 'sse-comment',
            tap: this.name,
            text: line.slice(1).trim(),
          });
        const data = lines
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          this.recorder.push({ kind: 'sse-unparsed', tap: this.name, data });
          continue;
        }
        const extra = lines.filter(
          (l) => l && !l.startsWith('data:') && !l.startsWith(':'),
        );
        this.recorder.push({
          kind: 'sse',
          tap: this.name,
          event,
          ...(extra.length ? { fields: extra } : {}),
        });
        this.events.push(event);
        for (const waiter of [...this.waiters])
          if (waiter.pred(event)) waiter.resolve(event);
      }
    }
  }
  waitFor(pred, ms = 30_000) {
    const found = this.events.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (event) => {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(event);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`tap ${this.name}: timed out waiting`));
      }, ms);
      this.waiters.push(waiter);
    });
  }
  count(pred) {
    return this.events.filter(pred).length;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ctrl.abort();
    this.recorder.push({ kind: 'sse-close', tap: this.name });
  }
}

const sid = (e) => e.data?.sessionID;
const is = (type, session) => (e) =>
  e.type === type && (!session || sid(e) === session);
const TERMINAL = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

/** Wait until `session` has no running execution and none starts for `quietMs`. */
async function settled(
  tap,
  session,
  { minExecutions = 1, quietMs = 1500 } = {},
) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const started = tap.count(is('session.execution.started', session));
    const ended = tap.count((e) => TERMINAL.has(e.type) && sid(e) === session);
    if (started >= minExecutions && ended >= started) {
      await sleep(quietMs);
      if (tap.count(is('session.execution.started', session)) === started)
        return;
    }
    if (Date.now() > deadline)
      throw new Error(`session ${session} did not settle`);
    await sleep(100);
  }
}

async function createSession(rec, title, extra = {}) {
  const created = await rec.api('POST', '/api/session', {
    title,
    location: { directory: realpathSync(PROJ) },
    ...extra,
  });
  if (created.status !== 200)
    throw new Error(`session.create ${created.status}`);
  return created.json.data.id;
}

async function userMessages(rec, session) {
  const list = await rec.api(
    'GET',
    `/api/session/${session}/message?order=asc`,
  );
  return (list.json?.data ?? []).filter((m) => m.type === 'user');
}

// ---------------------------------------------------------------- scenarios

const S = {};

S.basic = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'basic');
  const prompt = await rec.api('POST', `/api/session/${s}/prompt`, {
    text: 'hello basic',
  });
  await A.waitFor(is('session.execution.succeeded', s));
  const users = await userMessages(rec, s);
  await rec.api('GET', `/api/session/${s}`);
  await rec.api('GET', '/api/session/active');
  if (users[0]?.id !== prompt.json?.data?.id)
    throw new Error('prompt answer id is not the user message id');
  rec.finding(
    `(b) POST /prompt answered data.id=${prompt.json.data.id} (type ${prompt.json.data.type}, delivery ${prompt.json.data.delivery}); GET /message lists the user message under the same id`,
  );
};

S.tools = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'tools');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_WRITE now' });
  await settled(A, s);
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_EDIT now' });
  await settled(A, s, { minExecutions: 2 });
  await rec.api('GET', `/api/session/${s}/diff`);
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
};

async function permissionScenario(rec, decision) {
  const A = await rec.tap('A');
  const s = await createSession(rec, `permission-${decision}`);
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_BASH please' });
  const asked = await A.waitFor(is('permission.asked', s));
  await rec.api('GET', `/api/session/${s}/permission`);
  await rec.api('GET', '/api/permission/request');
  const body =
    decision === 'once'
      ? { decision: 'once' }
      : { decision: 'reject', message: 'not now' };
  await rec.api(
    'POST',
    `/api/session/${s}/permission/${asked.data.id}/reply`,
    body,
  );
  await A.waitFor(is('permission.replied', s));
  await settled(A, s);
  await rec.api(
    'POST',
    `/api/session/${s}/permission/${asked.data.id}/reply`,
    body,
  );
  await rec.api('GET', '/api/permission/saved');
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
}

S['permission-allow'] = (rec) => permissionScenario(rec, 'once');
S['permission-reject'] = (rec) => permissionScenario(rec, 'reject');

// An approval saved with `always`: what `GET /api/permission/saved` lists
// afterwards, beside the agent rules it is evaluated after. Run last: the
// saved approval stays in the project and would change later scenarios.
S['permission-saved'] = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'permission-saved');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_BASH please' });
  const asked = await A.waitFor(is('permission.asked', s));
  await rec.api('POST', `/api/session/${s}/permission/${asked.data.id}/reply`, {
    decision: 'always',
  });
  await A.waitFor(is('permission.replied', s));
  await settled(A, s);
  await rec.api('GET', '/api/permission/saved');
  await rec.api('GET', '/api/agent/build');
};

S.question = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'question');
  await rec.api('POST', `/api/session/${s}/prompt`, {
    text: 'DO_QUESTION now',
  });
  const created = await A.waitFor(
    (e) => e.type === 'form.created' && e.data?.form?.sessionID === s,
  );
  const form = created.data.form ?? created.data;
  await rec.api('GET', `/api/session/${s}/form`);
  const field = Array.isArray(form.fields)
    ? (form.fields[0]?.id ?? form.fields[0]?.key)
    : Object.keys(form.fields ?? {})[0];
  // The probe saw the array form refused and a plain string accepted.
  await rec.api('POST', `/api/session/${s}/form/${form.id}/reply`, {
    answer: { [field]: 'Red' },
  });
  await A.waitFor((e) => e.type === 'form.replied');
  await settled(A, s);
};

S.steer = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'steer');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_BASH steer' });
  const asked = await A.waitFor(is('permission.asked', s));
  // While the tool step is held: one steer withdrawn, one delivered.
  const withdrawn = await rec.api('POST', `/api/session/${s}/prompt`, {
    text: 'STEER-withdrawn',
    delivery: 'steer',
  });
  await rec.api('GET', `/api/session/${s}/inbox`);
  await rec.api('DELETE', `/api/session/${s}/inbox/${withdrawn.json.data.id}`);
  const steer = await rec.api('POST', `/api/session/${s}/prompt`, {
    text: 'STEER-delivered',
    delivery: 'steer',
  });
  await rec.api('POST', `/api/session/${s}/permission/${asked.data.id}/reply`, {
    decision: 'once',
  });
  const steerId = steer.json.data.id;
  await A.waitFor(
    (e) =>
      e.type === 'session.inbox.delivered' &&
      sid(e) === s &&
      e.data.inboxID === steerId,
  );
  await settled(A, s);
  await rec.api('GET', `/api/session/${s}/inbox`);
  const users = await userMessages(rec, s);
  rec.finding(
    `(b) every prompt is an inbox item: its answer's data.id is the inboxID of session.inbox.enqueued/delivered (or .cancelled after DELETE) and the user message id in history. Steer ${steerId} delivered and in history: ${users.some((m) => m.id === steerId)}; withdrawn steer in history: ${users.some((m) => m.id === withdrawn.json.data.id)}`,
  );
};

S.interrupt = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'interrupt');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_SLOW stream' });
  await A.waitFor(is('session.text.delta', s));
  await sleep(800);
  await rec.api('POST', `/api/session/${s}/interrupt`);
  await A.waitFor(is('session.execution.interrupted', s), 10_000);
  await sleep(300);
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
  await rec.api('POST', `/api/session/${s}/interrupt`);
};

S.revert = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'revert');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_WRITE first' });
  await settled(A, s);
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_EDIT second' });
  await settled(A, s, { minExecutions: 2 });
  const users = await userMessages(rec, s);
  const target = users[users.length - 1];
  await rec.api('POST', `/api/session/${s}/revert/stage`, {
    messageID: target.id,
    files: true,
  });
  await rec.api('GET', `/api/session/${s}`);
  await rec.api('DELETE', `/api/session/${s}/revert`);
  await rec.api('POST', `/api/session/${s}/revert/stage`, {
    messageID: target.id,
    files: true,
  });
  await rec.api('POST', `/api/session/${s}/revert/commit`);
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
  await sleep(300);
};

S.subagent = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'subagent');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_TASK now' });
  const created = await A.waitFor(
    (e) => e.type === 'session.created' && e.data?.parentID === s,
  );
  const child = created.data.sessionID;
  await settled(A, child);
  await settled(A, s, { quietMs: 3000 });
  await rec.api('GET', `/api/session?parentID=${s}`);
  await rec.api('GET', `/api/session/${child}/message?order=asc`);
};

S.reconnect = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'reconnect');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_SLOW stream' });
  await A.waitFor(is('session.text.delta', s));
  await sleep(800);
  A.close();
  await sleep(2000);
  const B = await rec.tap('B');
  // What a client re-reads on reconnect while the turn still runs: status,
  // history so far, pending asks and forms, the inbox (PLAN A.4).
  await rec.api('GET', '/api/session/active');
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
  await rec.api('GET', `/api/session/${s}/permission`);
  await rec.api('GET', `/api/session/${s}/form`);
  await rec.api('GET', `/api/session/${s}/inbox`);
  await B.waitFor(is('session.execution.succeeded', s), 30_000);
  await rec.api('GET', `/api/session/${s}`);
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
};

S.compact = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'compact');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'message one' });
  await settled(A, s);
  await rec.api('POST', `/api/session/${s}/compact`, {});
  await A.waitFor(
    (e) =>
      (e.type === 'session.compaction.ended' ||
        e.type === 'session.compaction.failed') &&
      sid(e) === s,
  );
  await sleep(300);
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
};

S.mcp = async (rec) => {
  await rec.tap('A');
  await rec.api('GET', '/api/mcp');
  await rec.api('POST', '/api/experimental/mcp/echo/disconnect');
  await rec.api('GET', '/api/mcp');
  await rec.api('POST', '/api/experimental/mcp/echo/connect');
  await sleep(1500);
  await rec.api('GET', '/api/mcp');
};

S.catalog = async (rec) => {
  const A = await rec.tap('A');
  await rec.api('GET', '/api/info');
  await rec.api('GET', '/api/agent');
  await rec.api('GET', '/api/agent/build');
  await rec.api('GET', '/api/command');
  await rec.api('GET', '/api/model');
  await rec.api('GET', '/api/model/default');
  await rec.api('GET', '/api/permission/saved');
  const s = await createSession(rec, 'catalog');
  await rec.api('POST', `/api/session/${s}/command`, {
    name: 'probecmd',
    text: 'xyz',
  });
  await settled(A, s);
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
};

S.crossload = async (rec) => {
  const A = await rec.tap('A');
  const native = await createSession(rec, 'crossload-native');
  await rec.api('POST', `/api/session/${native}/prompt`, {
    text: 'hello native',
  });
  await settled(A, native);

  const acp = new AcpPeer(rec);
  try {
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'fixture-capture', version: '0.0.1' },
    });
    const loaded = await acp.request('session/load', {
      sessionId: native,
      cwd: realpathSync(PROJ),
      mcpServers: [],
    });
    const replayed = acp.updates.filter(
      (m) => m.params?.sessionId === native,
    ).length;
    rec.finding(
      `(a) native->ACP: session/load of serve's ${native} ${loaded.error ? `failed ${JSON.stringify(loaded.error)}` : `succeeded and replayed ${replayed} updates`}`,
    );
    const created = await acp.request('session/new', {
      cwd: realpathSync(PROJ),
      mcpServers: [],
    });
    const acpSession = created.result.sessionId;
    const prompted = await acp.request('session/prompt', {
      sessionId: acpSession,
      prompt: [{ type: 'text', text: 'hello acp' }],
    });
    const viaNative = await rec.api('GET', `/api/session/${acpSession}`);
    const messages = await rec.api(
      'GET',
      `/api/session/${acpSession}/message?order=asc`,
    );
    const users = (messages.json?.data ?? []).filter((m) => m.type === 'user');
    rec.finding(
      `(a) ACP->native: ACP session/new id ${acpSession} (stop ${prompted.result?.stopReason}); GET /api/session/${acpSession} on the separate serve -> ${viaNative.status}, id equal: ${viaNative.json?.data?.id === acpSession}; user messages ${users.map((m) => m.text).join('|')}; the serve's own SSE saw ${A.count((e) => sid(e) === acpSession)} events for it`,
    );
    if (loaded.error || viaNative.json?.data?.id !== acpSession)
      throw new Error('cross-load did not hold');
  } finally {
    await acp.stop();
  }
};

class AcpPeer {
  constructor(rec) {
    this.rec = rec;
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.child = spawnOwned(BIN, ['acp'], {
      cwd: PROJ,
      env: engineEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.resume();
    let buffer = '';
    this.child.stdout.on('data', (d) => {
      buffer += d;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.trim()) this.onMessage(JSON.parse(line));
      }
    });
  }
  send(msg) {
    this.rec.push({ kind: 'acp', dir: '->', msg });
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  onMessage(msg) {
    this.rec.push({ kind: 'acp', dir: '<-', msg });
    if (msg.id !== undefined && !msg.method) {
      this.pending.get(msg.id)?.(msg);
      this.pending.delete(msg.id);
      return;
    }
    if (msg.method) this.updates.push(msg);
    if (msg.method && msg.id !== undefined)
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'not supported by the capture client' },
      });
  }
  request(method, params, ms = 60_000) {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`acp ${method} timed out`)),
        ms,
      );
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }
  stop() {
    return stopOwned(this.child);
  }
}

S['debug-agents'] = async (rec) => {
  for (const cliArgs of [
    ['debug', 'agents', '--standalone'],
    // The form Station's 1.x approval check runs.
    ['debug', 'agent', 'build'],
  ]) {
    const result = spawnSync(BIN, cliArgs, {
      windowsHide: true,
      cwd: PROJ,
      env: engineEnv(),
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    let stdout = result.stdout;
    try {
      stdout = JSON.parse(result.stdout);
    } catch {}
    rec.push({
      kind: 'cli',
      args: cliArgs,
      status: result.status,
      stdout,
      stderr: result.stderr,
    });
  }
  rec.finding(
    '(c) `debug agents --standalone` lists agents with their configured permissions; `debug agent build` is not a 2.x command',
  );
};

// ---------------------------------------------------------------- governed sessions

// Station's session rulesets as `openCodeNativeApprovalRules`
// (opencode-approval-native.ts) builds them; kept in step by hand. Asks
// only: full access sends none, and Station answers what is asked.
const FULL_RULES = [];
const CONFINED_RULES = [
  'shell',
  'edit',
  'webfetch',
  'websearch',
  'external_directory',
  '*_*',
  'subagent',
].map((action) => ({ action, resource: '*', effect: 'ask' }));

async function askAndAnswer(rec, tap, s, text, decision = 'once') {
  const before = tap.count(is('permission.asked', s));
  const started = tap.count(is('session.execution.started', s));
  await rec.api('POST', `/api/session/${s}/prompt`, { text });
  const asks = () => tap.events.filter(is('permission.asked', s));
  await tap.waitFor(() => asks().length > before);
  const asked = asks()[before];
  await rec.api('POST', `/api/session/${s}/permission/${asked.data.id}/reply`, {
    decision,
  });
  await settled(tap, s, { minExecutions: started + 1 });
  return asked;
}

// The real server just after it reports ready: `/api/info` answers before
// the agent catalog is loaded, so `GET /api/agent/{id}` is briefly 404.
// Its own server on the next port, so the shared one stays warm.
S.boot = async (rec) => {
  const boot = await startServe(SERVE_PORT + 1);
  const base = rec.base;
  rec.base = boot.url;
  try {
    for (let i = 0; i < 200; i += 1) {
      const info = await rec.api('GET', '/api/info').catch(() => undefined);
      if (info?.status === 200) break;
      await sleep(25);
    }
    let notFound = 0;
    for (let i = 0; i < 200; i += 1) {
      const agent = await rec.api('GET', '/api/agent/build');
      if (agent.status === 200) break;
      if (agent.status === 404) notFound += 1;
      await sleep(25);
    }
    rec.finding(
      `GET /api/agent/build answered 404 ${notFound} time(s) after /api/info was 200`,
    );
  } finally {
    rec.base = base;
    await stopOwned(boot.child);
  }
};

// Station's approval mode changes between turns: full access, then Ask
// (PATCH the session's rules), then the agent switches; then what PATCH
// does with `permissions: null` and with `[]`.
S['mode-switch'] = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'mode-switch', {
    agent: 'build',
    permissions: FULL_RULES,
  });
  // With no session rules the agent's decide; this capture's config asks
  // for shell, and Station's full access answers `once`.
  await askAndAnswer(rec, A, s, 'DO_BASH full');
  rec.finding(
    `full access: ${A.count(is('permission.asked', s))} permission asks for DO_BASH, answered once`,
  );
  await rec.api('GET', '/api/agent/build');
  await rec.api('GET', '/api/permission/saved');
  await rec.api('PATCH', `/api/session/${s}`, { permissions: CONFINED_RULES });
  await askAndAnswer(rec, A, s, 'DO_BASH ask');
  rec.finding(
    `after PATCH to Ask's rules: ${A.count(is('permission.asked', s))} permission ask(s)`,
  );
  await rec.api('GET', '/api/agent/plan');
  await rec.api('POST', `/api/session/${s}/agent`, { agent: 'plan' });
  await sleep(300);
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'hello plan' });
  await settled(A, s, { minExecutions: 3 });
  const kept = await rec.api('PATCH', `/api/session/${s}`, {
    permissions: null,
  });
  const afterNull = await rec.api('GET', `/api/session/${s}`);
  const cleared = await rec.api('PATCH', `/api/session/${s}`, {
    permissions: [],
  });
  const afterEmpty = await rec.api('GET', `/api/session/${s}`);
  rec.finding(
    `PATCH permissions:null -> ${kept.status}, rules after: ${JSON.stringify(afterNull.json?.data?.permissions ?? null).length} chars; PATCH permissions:[] -> ${cleared.status}, rules after: ${JSON.stringify(afterEmpty.json?.data?.permissions ?? null)}`,
  );
};

// A governed session (Ask's rules): an edit, the same shell command twice,
// then another shell command, each asked and answered once. What each ask
// names (`resources`, `save`) is what a session grant is scoped by.
S.governed = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'governed', {
    agent: 'build',
    permissions: CONFINED_RULES,
  });
  const asks = [];
  for (const text of [
    'DO_EDIT one',
    'DO_BASH two',
    'DO_BASH three',
    'DO_LS four',
  ])
    asks.push(await askAndAnswer(rec, A, s, text));
  rec.finding(
    `asks: ${asks.map((a) => `${a.data.action} ${JSON.stringify(a.data.resources)} save ${JSON.stringify(a.data.save ?? null)}`).join('; ')}`,
  );
};

// An interrupt while a permission ask is pending: what the engine says of
// the ask, and what a late answer to it gets.
S['interrupt-pending'] = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'interrupt-pending', {
    agent: 'build',
    permissions: CONFINED_RULES,
  });
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_BASH wait' });
  const asked = await A.waitFor(is('permission.asked', s));
  await rec.api('POST', `/api/session/${s}/interrupt`);
  await A.waitFor(is('session.execution.interrupted', s), 10_000);
  await sleep(500);
  const listed = await rec.api('GET', `/api/session/${s}/permission`);
  const late = await rec.api(
    'POST',
    `/api/session/${s}/permission/${asked.data.id}/reply`,
    { decision: 'once' },
  );
  rec.finding(
    `after interrupt: permission.replied ${A.count(is('permission.replied', s))}, pending listed ${(listed.json?.data ?? []).length}, late reply -> ${late.status}`,
  );
};

// Stopping a session with an ask pending: Station rejects the ask, then
// interrupts the execution.
S['stop-pending'] = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'stop-pending', {
    agent: 'build',
    permissions: CONFINED_RULES,
  });
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_BASH stop' });
  const asked = await A.waitFor(is('permission.asked', s));
  await rec.api('POST', `/api/session/${s}/permission/${asked.data.id}/reply`, {
    decision: 'reject',
  });
  await rec.api('POST', `/api/session/${s}/interrupt`);
  await A.waitFor((e) => TERMINAL.has(e.type) && sid(e) === s, 10_000);
  await sleep(300);
  rec.finding(
    `stop: ended ${A.events.find((e) => TERMINAL.has(e.type) && sid(e) === s)?.type}`,
  );
};

// Run with `--config plain`: the plan agent's `edit * deny` decides on its
// own, but with Station's asks after it the session's `edit * ask` wins
// (last match), so OpenCode asks; Station evaluates the agent's rules alone,
// finds the deny, and rejects the ask without a person.
S['plan-deny'] = async (rec) => {
  const A = await rec.tap('A');
  // The first scenario on a fresh server: its agent catalog may still be
  // loading (404, as `boot` records); a replay repeats the last answer.
  for (let i = 0; i < 100; i += 1) {
    if ((await rec.api('GET', '/api/agent/plan')).status === 200) break;
    await sleep(50);
  }
  const s = await createSession(rec, 'plan-deny', {
    agent: 'plan',
    permissions: CONFINED_RULES,
  });
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_EDIT plan' });
  const asked = await A.waitFor(is('permission.asked', s));
  await rec.api('POST', `/api/session/${s}/permission/${asked.data.id}/reply`, {
    decision: 'reject',
  });
  await settled(A, s);
  const failed = A.events.find(is('session.tool.failed', s));
  rec.finding(
    `plan agent with Station's asks after its deny: asks ${A.count(is('permission.asked', s))} (${asked.data.action} ${JSON.stringify(asked.data.resources)}), Station rejected; edit failed: ${JSON.stringify(failed?.data?.error ?? null)}`,
  );
};

// A long session: more messages than one history page (OpenCode's default
// is 50), then the reads a reconnect makes, newest first, following each
// page's `cursor.next` to the start. Their shape (`data`, `cursor.previous`,
// `cursor.next`) is what the replay pages a synthesized history with.
// A reply after reasoning: both parts of the one assistant message are
// `ordinal: 0`, since OpenCode numbers each kind of part on its own.
S.reasoning = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'reasoning');
  await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_THINK now' });
  await A.waitFor(is('session.execution.succeeded', s));
  const history = await rec.api('GET', `/api/session/${s}/message?order=asc`);
  const assistant = (history.json?.data ?? []).find(
    (m) => m.type === 'assistant',
  );
  const started = A.events
    .filter(
      (e) =>
        e.data?.sessionID === s &&
        (e.type === 'session.reasoning.started' ||
          e.type === 'session.text.started'),
    )
    .map((e) => `${e.type}#${e.data.ordinal}`);
  rec.finding(
    `reasoning: assistant content ${JSON.stringify((assistant?.content ?? []).map((part) => part.type))}; live parts ${started.join(', ')}`,
  );
};

// The feed drops while a reply that followed reasoning streams: history read
// on reconnect lists the reasoning part before the text it must complete.
S['reasoning-reconnect'] = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'reasoning-reconnect');
  await rec.api('POST', `/api/session/${s}/prompt`, {
    text: 'DO_THINK_SLOW stream',
  });
  await A.waitFor(is('session.text.delta', s));
  await sleep(800);
  A.close();
  await sleep(2000);
  const B = await rec.tap('B');
  await rec.api('GET', '/api/session/active');
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
  await rec.api('GET', `/api/session/${s}/permission`);
  await rec.api('GET', `/api/session/${s}/form`);
  await rec.api('GET', `/api/session/${s}/inbox`);
  await B.waitFor(is('session.execution.succeeded', s), 30_000);
  await rec.api('GET', `/api/session/${s}`);
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
};

S.history = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'history');
  for (let i = 0; i < 22; i += 1) {
    await rec.api('POST', `/api/session/${s}/prompt`, { text: `turn ${i}` });
    await settled(A, s, { minExecutions: i + 1, quietMs: 200 });
  }
  const defaultPage = await rec.api(
    'GET',
    `/api/session/${s}/message?order=asc`,
  );
  let page = await rec.api(
    'GET',
    `/api/session/${s}/message?order=desc&limit=30`,
  );
  let total = page.json?.data?.length ?? 0;
  let pages = 1;
  while (page.json?.cursor?.next && (page.json?.data?.length ?? 0) > 0) {
    page = await rec.api(
      'GET',
      `/api/session/${s}/message?cursor=${encodeURIComponent(page.json.cursor.next)}&limit=30`,
    );
    total += page.json?.data?.length ?? 0;
    pages += 1;
  }
  const mixed = await rec.api(
    'GET',
    `/api/session/${s}/message?order=desc&cursor=x`,
  );
  rec.finding(
    `history: default page ${defaultPage.json?.data?.length} messages; newest first in ${pages} pages of 30: ${total} messages; cursor with order -> ${mixed.status}`,
  );
};

// A prompt with an image attached the way OpenCode's own ACP layer sends
// one (`cli/src/acp/turn.ts`: `files: [{uri, name}]`, a data URI).
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
S.attachment = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'attachment', {
    model: { providerID: 'mock', id: 'mock-vision' },
  });
  await rec.api('POST', `/api/session/${s}/prompt`, {
    text: 'What is in the picture?',
    files: [{ uri: `data:image/png;base64,${PIXEL_PNG}`, name: 'pixel.png' }],
  });
  await settled(A, s);
  const history = await rec.api('GET', `/api/session/${s}/message?order=asc`);
  const reply = (history.json?.data ?? [])
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.content ?? [])
    .map((part) => part.text ?? '')
    .join('');
  rec.finding(`attachment: the model answered ${JSON.stringify(reply)}`);
};

// A Station-like HTTP tool server added at runtime to the server's default
// location (the directory it was started in), the way OpenCode's ACP layer
// adds a client's servers (`cli/src/acp/sessions.ts` registerMcp), then one
// tool call through it.
S['mcp-add'] = async (rec) => {
  const mcp = await startHttpMcp();
  try {
    const A = await rec.tap('A');
    const added = await rec.api('PUT', '/api/experimental/mcp/station-echo', {
      config: {
        type: 'remote',
        url: `http://127.0.0.1:${HTTP_MCP_PORT}/mcp`,
        headers: { [HTTP_MCP_HEADER]: HTTP_MCP_TOKEN },
        oauth: false,
      },
    });
    const listed = await rec.api('GET', '/api/mcp');
    const s = await createSession(rec, 'mcp-add');
    await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_MCP' });
    await settled(A, s);
    const called = mcp.seen.filter((entry) => entry.rpc === 'tools/call');
    const station = (listed.json?.data ?? []).find(
      (server) => server.name === 'station-echo',
    );
    rec.finding(
      `mcp-add: PUT -> ${added.status}; listed ${JSON.stringify(station?.status ?? null)}; tools/call ${called.length} (authorized ${called.every((entry) => entry.authorized)}); unauthorized requests ${mcp.seen.filter((entry) => !entry.authorized).length}`,
    );
  } finally {
    await new Promise((resolve) => mcp.server.close(resolve));
    mcp.server.closeAllConnections?.();
  }
};

/** A read the capture makes for itself, not recorded (it would be replayed). */
async function unrecorded(rec, apiPath) {
  const res = await fetch(rec.base + apiPath, {
    headers: { authorization: AUTH },
  });
  return res.status === 200 ? res.json() : undefined;
}

/**
 * A sub-directory of the project holding OpenCode project code: a plugin
 * that writes `marker` (the time it ran) when OpenCode loads it.
 */
function plantNestedPlugin(name, marker) {
  const dir = path.join(PROJ, name);
  mkdirSync(path.join(dir, '.opencode', 'plugin'), { recursive: true });
  writeFileSync(
    path.join(dir, '.opencode', 'plugin', 'planted.ts'),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, String(Date.now()));\nexport const Planted = async () => ({});\n`,
  );
  return dir;
}

/**
 * Code Mode's `opencode.session_move` to a sub-directory inside the
 * project under Station's confined (Ask) rules: no ask, the session moves
 * (`session.moved`), and OpenCode loads the destination's own project code
 * (a planted plugin) while it resolves the destination
 * (`core/src/session/move.ts` `resolveDestination` builds the location's
 * context before anything is published).
 */
S.move = async (rec) => {
  const marker = path.join(WORK, 'move-plugin-ran');
  const sub = plantNestedPlugin('sub', marker);
  try {
    const A = await rec.tap('A');
    const s = await createSession(rec, 'move', {
      agent: 'build',
      permissions: CONFINED_RULES,
    });
    await rec.api('POST', `/api/session/${s}/prompt`, { text: 'DO_MOVE sub' });
    const moved = await A.waitFor(is('session.moved', s));
    await settled(A, s);
    const ran = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
    rec.finding(
      `session_move inside the project under the confined rules: ${A.count(is('permission.asked', s))} ask(s); session.moved names location.directory ${JSON.stringify(moved.data.location?.directory)}; the nested plugin ${ran ? (ran <= moved.created ? 'ran before the event was published' : 'ran after the event was published') : 'never ran'}`,
    );
    await rec.api('GET', `/api/session/${s}`);
  } finally {
    rmSync(sub, { recursive: true, force: true });
  }
};

/**
 * The same move with Station's deny for the Code Mode tool after the
 * confined rules: OpenCode leaves a wholly denied tool out of the catalog
 * (`core/src/tool.ts` `whollyDisabled`), so the call fails, nothing moves
 * and the plugin never loads.
 */
S['move-denied'] = async (rec) => {
  const marker = path.join(WORK, 'move-denied-plugin-ran');
  const sub = plantNestedPlugin('sub-denied', marker);
  try {
    const A = await rec.tap('A');
    const s = await createSession(rec, 'move-denied', {
      agent: 'build',
      permissions: [
        ...CONFINED_RULES,
        { action: 'opencode_session_move', resource: '*', effect: 'deny' },
      ],
    });
    const before = MODEL_REQUESTS.length;
    await rec.api('POST', `/api/session/${s}/prompt`, {
      text: 'DO_MOVE sub-denied',
    });
    await settled(A, s);
    const offered = MODEL_REQUESTS.slice(before).filter((r) =>
      r.user.includes('DO_MOVE'),
    );
    rec.finding(
      `with opencode_session_move denied: session.moved ${A.count(is('session.moved', s))} time(s); the plugin ${existsSync(marker) ? 'ran' : 'never ran'}; the model was offered session_move in ${offered.filter((r) => r.offersSessionMove).length} of ${offered.length} request(s)`,
    );
    await rec.api('GET', `/api/session/${s}`);
  } finally {
    rmSync(sub, { recursive: true, force: true });
  }
};

/**
 * A child, and a grandchild (a child's own child, `parentID` the child),
 * started while the feed was down, the grandchild's shell asking: what a
 * client reads on reconnect to find them and the ask (the session list by
 * `parentID`, the location's pending asks and forms), then the ask
 * answered on the new feed.
 */
S['subagent-gap'] = async (rec) => {
  const A = await rec.tap('A');
  const s = await createSession(rec, 'subagent-gap');
  await rec.api('POST', `/api/session/${s}/prompt`, {
    text: 'DO_TASK_DEEP now',
  });
  await A.waitFor(is('session.execution.started', s));
  A.close();
  // Wait, unseen, for an ask from a session that is not this one.
  const deadline = Date.now() + 30_000;
  let ask;
  while (!ask) {
    if (Date.now() > deadline) {
      const kids = await unrecorded(rec, `/api/session?parentID=${s}`);
      const kid = kids?.data?.[0]?.id;
      const said = kid
        ? await unrecorded(rec, `/api/session/${kid}/message?order=asc`)
        : undefined;
      throw new Error(
        `no descendant ask: children ${JSON.stringify(kids?.data?.map((k) => k.id))}; child said ${JSON.stringify(said?.data?.map((m) => [m.type, m.content?.map((c) => c.text ?? c.type)]))}`.slice(
          0,
          2000,
        ),
      );
    }
    await sleep(200);
    const listed = await unrecorded(rec, '/api/permission/request');
    ask = (listed?.data ?? []).find((item) => item.sessionID !== s);
  }
  const B = await rec.tap('B');
  await rec.api('GET', '/api/session/active');
  await rec.api('GET', `/api/session/${s}/message?order=asc`);
  const children = await rec.api('GET', `/api/session?parentID=${s}`);
  const child = children.json?.data?.[0]?.id;
  const grandchildren = await rec.api('GET', `/api/session?parentID=${child}`);
  const grandchild = grandchildren.json?.data?.[0]?.id;
  await rec.api('GET', `/api/session?parentID=${grandchild}`);
  await rec.api('GET', `/api/session/${s}/permission`);
  await rec.api('GET', `/api/session/${s}/form`);
  await rec.api('GET', '/api/permission/request');
  await rec.api('GET', '/api/form');
  await rec.api('GET', `/api/session/${s}/inbox`);
  rec.finding(
    `the ask raised during the gap came from ${ask.sessionID === grandchild ? 'the grandchild' : ask.sessionID === child ? 'the child' : 'another session'}; the grandchild's parentID is ${grandchildren.json?.data?.[0]?.parentID === child ? 'the child' : 'something else'}`,
  );
  await rec.api(
    'POST',
    `/api/session/${ask.sessionID}/permission/${ask.id}/reply`,
    { decision: 'once' },
  );
  await B.waitFor(is('session.execution.succeeded', s), 60_000);
  await sleep(1500);
  await rec.api('GET', `/api/session?parentID=${s}`);
};

/**
 * A session moved (Code Mode's `opencode.session_move`, inside the
 * project) and then, while the feed was down, asking for a shell command:
 * what a client reads on reconnect. The session's own lists
 * (`GET /api/session/{id}/permission`, `/form`) follow it to its new
 * directory; the server-wide lists (`/api/permission/request`, `/api/form`)
 * are the server's launch directory's, which no longer holds it.
 */
S['move-gap'] = async (rec) => {
  const sub = path.join(PROJ, 'sub-gap');
  mkdirSync(sub, { recursive: true });
  try {
    const A = await rec.tap('A');
    const s = await createSession(rec, 'move-gap', {
      agent: 'build',
      permissions: CONFINED_RULES,
    });
    await rec.api('POST', `/api/session/${s}/prompt`, {
      text: 'DO_MOVE sub-gap',
    });
    await A.waitFor(is('session.moved', s));
    await settled(A, s);
    A.close();
    await rec.api('POST', `/api/session/${s}/prompt`, {
      text: 'DO_BASH moved',
    });
    const deadline = Date.now() + 30_000;
    let ask;
    while (!ask) {
      if (Date.now() > deadline)
        throw new Error('no ask from the moved session');
      await sleep(200);
      ask = (await unrecorded(rec, `/api/session/${s}/permission`))?.data?.[0];
    }
    const B = await rec.tap('B');
    await rec.api('GET', '/api/session/active');
    await rec.api('GET', `/api/session/${s}/message?order=desc&limit=50`);
    await rec.api('GET', `/api/session/${s}/permission`);
    await rec.api('GET', `/api/session/${s}/form`);
    const global = await rec.api('GET', '/api/permission/request');
    await rec.api('GET', '/api/form');
    await rec.api('GET', `/api/session?parentID=${s}`);
    await rec.api('GET', `/api/session/${s}/inbox`);
    rec.finding(
      `after the move, the session's own list holds its ask; the server-wide list ${(global.json?.data ?? []).some((item) => item.id === ask.id) ? 'holds it too' : 'does not'}`,
    );
    await rec.api('POST', `/api/session/${s}/permission/${ask.id}/reply`, {
      decision: 'once',
    });
    await B.waitFor(is('session.execution.succeeded', s), 60_000);
    await sleep(1500);
  } finally {
    rmSync(sub, { recursive: true, force: true });
  }
};

const ORDER = [
  'basic',
  'tools',
  'permission-allow',
  'permission-reject',
  'question',
  'steer',
  'interrupt',
  'revert',
  'subagent',
  'reconnect',
  'compact',
  'mcp',
  'catalog',
  'crossload',
  'debug-agents',
  'boot',
  'mode-switch',
  'governed',
  'interrupt-pending',
  'stop-pending',
  'permission-saved',
  'history',
  'attachment',
  'mcp-add',
  'move',
  'move-denied',
  'subagent-gap',
  'move-gap',
  'reasoning',
  'reasoning-reconnect',
];
// Captured separately, with `--config plain --only plan-deny`.
const PLAIN_ONLY = new Set(['plan-deny']);

// ---------------------------------------------------------------- main

function version() {
  const result = spawnSync(BIN, ['--version'], {
    windowsHide: true,
    env: engineEnv(),
    encoding: 'utf8',
    timeout: 20_000,
  });
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? '');
  if (!match || Number(match[1]) < 2)
    throw new Error(`Not an OpenCode 2.x binary: ${result.stdout}`);
  return match[0];
}

function writeFixture(name, lines) {
  const file = path.join(OUT, name);
  writeFileSync(
    file,
    scrub(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`),
  );
  console.log(`wrote ${file}`);
}

async function main() {
  const ver = version();
  prepareWorkspace();
  const mock = await startMockModel();
  const serve = await startServe();
  try {
    const only = args.only ? args.only.split(',') : undefined;
    const openapi = await fetch(`${serve.url}/openapi.json`, {
      headers: { authorization: AUTH },
    });
    if (openapi.status !== 200)
      throw new Error(`/openapi.json ${openapi.status}`);
    if (!only || only.includes('openapi')) {
      const file = path.join(OUT, `opencode-serve-${ver}-openapi.json`);
      writeFileSync(
        file,
        scrub(`${JSON.stringify(await openapi.json(), null, 2)}\n`),
      );
      console.log(`wrote ${file}`);
    }
    for (const name of only ?? ORDER) {
      if (name === 'openapi') continue;
      const scenario = S[name];
      if (!scenario) throw new Error(`Unknown scenario ${name}`);
      if (PLAIN_ONLY.has(name) !== (args.config === 'plain'))
        throw new Error(
          `${name} is captured ${PLAIN_ONLY.has(name) ? 'only' : 'never'} with --config plain`,
        );
      console.log(`--- ${name}`);
      const rec = new Recorder(serve.url);
      rec.push({ kind: 'meta', scenario: name, opencodeVersion: ver });
      try {
        await scenario(rec);
      } finally {
        await rec.close();
      }
      writeFixture(`opencode-serve-${ver}-${name}.jsonl`, rec.lines);
    }
  } finally {
    await stopOwned(serve.child);
    await new Promise((resolve) => mock.close(resolve));
    mock.closeAllConnections?.();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    killAllOwned();
    process.exit(1);
  },
);
