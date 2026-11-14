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
// name. The privacy suite (opencode-serve-fixtures.privacy.test.ts) checks
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
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    'Usage: capture-opencode-serve-fixtures.mjs --opencode <bin> --work <empty-dir> [--out <dir>] [--port-base 47300] [--only a,b]',
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
  [PASSWORD, '{PASSWORD}'],
  ...pathForms(PROJ).map((form) => [form, '{PROJ}']),
  ...pathForms(HOME).map((form) => [form, '{HOME}']),
  ...pathForms(WORK).map((form) => [form, '{WORK}']),
  ...pathForms(path.dirname(BIN)).map((form) => [form, '{BIN}']),
  ...pathForms(os.homedir()).map((form) => [form, '{USERHOME}']),
  [os.hostname(), '{HOSTNAME}'],
  [os.userInfo().username, '{USER}'],
].filter(([from]) => from && from.length >= 3);

function scrub(text) {
  let out = text;
  for (const [from, to] of SCRUB) out = out.split(from).join(to);
  return out;
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
        JSON.stringify(textOf(last.content)).slice(0, 120),
      ],
    };
  const user = textOf(last.content);
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
  if (user.includes('DO_WRITE'))
    return call('write', { path: 'created.txt', content: 'created by mock\n' });
  if (user.includes('DO_EDIT'))
    return call('edit', {
      path: 'edit-me.txt',
      oldString: 'line one',
      newString: 'line one EDITED',
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
  if (user.includes('DO_SLOW'))
    return {
      kind: 'text',
      chunks: Array.from({ length: 40 }, (_, i) => `w${i} `),
      delay: 150,
    };
  return { kind: 'text', chunks: ['mock ', 'reply: ', user.slice(-60)] };
}

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
          : { role: 'assistant', content: p.chunks.join('') };
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
      { cwd: PROJ, env: engineEnv(), encoding: 'utf8' },
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
    permissions: [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'ask' },
    ],
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

async function startServe() {
  const child = spawnOwned(
    BIN,
    [
      'serve',
      '--stdio',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(SERVE_PORT),
    ],
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

async function createSession(rec, title) {
  const created = await rec.api('POST', '/api/session', {
    title,
    location: { directory: realpathSync(PROJ) },
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
  'permission-saved',
];

// ---------------------------------------------------------------- main

function version() {
  const result = spawnSync(BIN, ['--version'], {
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
