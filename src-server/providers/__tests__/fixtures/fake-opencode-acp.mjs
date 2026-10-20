#!/usr/bin/env node
// A stand-in for `opencode acp` (OpenCode 1.18.18) that honours the
// permission configuration it is launched with, for the #3290 tests.
//
// Wire shapes are copied from a recorded `opencode acp` exchange (OpenCode
// 1.18.18, a real `echo STATION_PROBE` turn on `opencode/big-pickle`):
// the initialize result, the session/new config options (`model`, and
// `mode` with `build` and `plan`), the pending `tool_call`, and the
// `session/request_permission` request (a tool call with no `name`, kind
// `execute`, empty `locations`, `rawInput.command`; options `once`,
// `always`, `reject`).
//
// Permission evaluation follows OpenCode's `agent/agent.ts` and
// `permission/index.ts`: the agent's rules are its defaults, then the user's
// own rules, then the agent's configured `permission`, and the LAST matching
// rule wins (`*` matches any characters). The user's own rules come from
// `FAKE_OPENCODE_USER_CONFIG` (standing in for `~/.config/opencode`), merged
// with `OPENCODE_CONFIG_CONTENT` as OpenCode merges inline content over its
// configuration files.
//
// A prompt names one action: `run: <command>`, `edit: <path>`,
// `fetch: <url>` or `task: <subagent>` (OpenCode keys the task permission on
// the subagent's name). Each process appends the `OPENCODE_CONFIG_CONTENT` it
// was launched with to `FAKE_OPENCODE_RECORD`, one JSON line per launch, and
// a `{ "resumed": <sessionId> }` line when it resumes a session, plus a
// `{ "pid": <pid> }` line per launch (#3290). With
// `FAKE_OPENCODE_REFUSE_RESUME=1` in its environment it refuses
// `session/resume` with a JSON-RPC error, as an engine that advertised
// resume but cannot resume this session would.
//
// #3924: an `edit: <path>` request carries what OpenCode sends, its
// permission metadata (`{ filepath, diff }`, `filepath` absolute: an absolute
// path as written, a relative one joined to the process's directory), and an allowed edit writes the file.
// An `always` answer is remembered for the permission, as OpenCode's edit
// tool asks with `always: ["*"]`: later requests for it are not sent, and a
// `{ "always": <permission> }` line is recorded. `debug agent` records a
// `{ "debugAgent": <name> }` line.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

// `debug agent <name>` prints the agent's resolved rules (#3290), as
// `opencode debug agent` does; it is not an engine launch.
const debugAgent =
  process.argv[2] === 'debug' && process.argv[3] === 'agent'
    ? process.argv[4]
    : undefined;

if (process.env.FAKE_OPENCODE_RECORD && debugAgent !== undefined) {
  appendFileSync(
    process.env.FAKE_OPENCODE_RECORD,
    `${JSON.stringify({ debugAgent })}\n`,
  );
}
if (process.env.FAKE_OPENCODE_RECORD && debugAgent === undefined) {
  appendFileSync(
    process.env.FAKE_OPENCODE_RECORD,
    `${JSON.stringify({ OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null })}\n${JSON.stringify({ pid: process.pid })}\n`,
  );
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    merged[key] =
      isObject(merged[key]) && isObject(value)
        ? mergeDeep(merged[key], value)
        : value;
  }
  return merged;
}

const config = mergeDeep(
  JSON.parse(process.env.FAKE_OPENCODE_USER_CONFIG || '{}'),
  JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'),
);

function fromConfig(permission) {
  if (typeof permission === 'string')
    return [{ permission: '*', pattern: '*', action: permission }];
  const rules = [];
  for (const [key, value] of Object.entries(permission ?? {})) {
    if (typeof value === 'string')
      rules.push({ permission: key, pattern: '*', action: value });
    else
      for (const [pattern, action] of Object.entries(value))
        rules.push({ permission: key, pattern, action });
  }
  return rules;
}

function wildcard(input, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 's').test(input);
}

const AGENT_DEFAULTS = {
  build: { '*': 'allow' },
  plan: { '*': 'allow', edit: { '*': 'deny' } },
  general: { '*': 'allow' },
  explore: { '*': 'deny', grep: 'allow', glob: 'allow', read: 'allow' },
};
const AGENT_TOOLS = {
  explore: { grep: true, glob: true, read: true, bash: true },
};

function resolvedRules(agent) {
  return [
    ...fromConfig(AGENT_DEFAULTS[agent]),
    ...fromConfig(config.permission),
    ...fromConfig(config.agent?.[agent]?.permission),
  ];
}

if (debugAgent !== undefined) {
  if (!AGENT_DEFAULTS[debugAgent] && !config.agent?.[debugAgent]) {
    process.stderr.write(`Agent ${debugAgent} not found\n`);
    process.exit(1);
  }
  const rules = resolvedRules(debugAgent);
  // OpenCode's `Permission.disabled`: a tool whose last rule (by permission
  // only) denies every pattern is hidden, reported as `false`.
  const disabled = (tool) => {
    const permission = tool === 'write' ? 'edit' : tool;
    const last = rules.findLast((rule) =>
      wildcard(permission, rule.permission),
    );
    return last?.pattern === '*' && last.action === 'deny';
  };
  const tools = Object.fromEntries(
    Object.keys(
      AGENT_TOOLS[debugAgent] ?? {
        bash: true,
        edit: true,
        write: true,
        task: true,
        question: true,
        read: true,
        webfetch: true,
      },
    ).map((tool) => [tool, !disabled(tool)]),
  );
  process.stdout.write(
    `${JSON.stringify({ name: debugAgent, permission: rules, tools })}\n`,
  );
  process.exit(0);
}

function evaluate(agent, permission, pattern) {
  const rules = resolvedRules(agent);
  return (
    rules.findLast(
      (rule) =>
        wildcard(permission, rule.permission) &&
        wildcard(pattern, rule.pattern),
    )?.action ?? 'ask'
  );
}

const MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'opencode/big-pickle',
  options: [{ value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' }],
};
// The session starts in `default_agent`, as OpenCode's does; a user's
// primary agents are advertised as modes beside build and plan.
let mode = config.default_agent ?? 'build';
const userPrimaryModes = Object.entries(config.agent ?? {})
  .filter(([, value]) => isObject(value) && value.mode === 'primary')
  .map(([name]) => ({ value: name, name }));
const configOptions = () => [
  MODEL_OPTION,
  {
    id: 'mode',
    name: 'Session Mode',
    category: 'mode',
    type: 'select',
    currentValue: mode,
    options: [
      {
        value: 'build',
        name: 'build',
        description:
          'The default agent. Executes tools based on configured permissions.',
      },
      {
        value: 'plan',
        name: 'plan',
        description: 'Plan mode. Disallows all edit tools.',
      },
      ...userPrimaryModes,
    ],
  },
];

let nextOutgoingId = 0;
const waiting = new Map();
function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}
function request(method, params) {
  const id = nextOutgoingId++;
  write({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
function update(sessionId, payload) {
  write({
    method: 'session/update',
    params: { sessionId, update: payload },
  });
}

const ACTIONS = {
  run: { permission: 'bash', kind: 'execute', title: 'bash', key: 'command' },
  edit: { permission: 'edit', kind: 'edit', title: 'edit', key: 'filePath' },
  fetch: {
    permission: 'webfetch',
    kind: 'fetch',
    title: 'webfetch',
    key: 'url',
  },
  task: {
    permission: 'task',
    kind: 'think',
    title: 'task',
    key: 'subagent_type',
  },
  // An MCP tool: its permission is the tool's own `<server>_<tool>` name.
  mcp: { permission: undefined, kind: 'other', title: 'mcp', key: 'tool' },
};

let callCounter = 0;
const alwaysAllowed = new Set();
async function prompt(sessionId, text) {
  // The action is the last `<verb>: <target>` line: Station may put its own
  // context ahead of the typed text.
  const match = [...text.matchAll(/^(run|edit|fetch|task|mcp):\s*(.+)$/gm)].at(
    -1,
  );
  if (!match) return { stopReason: 'end_turn' };
  const target = match[2].trim();
  const action =
    match[1] === 'mcp'
      ? { ...ACTIONS.mcp, permission: target, title: target }
      : ACTIONS[match[1]];
  const toolCallId = `call_fixture_${++callCounter}`;
  // As OpenCode's edit and write tools do: an absolute path is passed on as
  // written (the file system then resolves `link/..` through the link), a
  // relative one is joined to the directory.
  const editPath =
    match[1] === 'edit'
      ? isAbsolute(target)
        ? target
        : join(process.cwd(), target)
      : undefined;
  const rawInput = editPath
    ? { filepath: editPath, diff: '' }
    : { [action.key]: target };
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: action.title,
    kind: action.kind,
    status: 'pending',
    locations: [],
    rawInput: {},
  });
  const verdict = evaluate(
    mode,
    action.permission,
    match[1] === 'mcp' ? '*' : target,
  );
  let allowed =
    verdict === 'allow' ||
    (verdict === 'ask' && alwaysAllowed.has(action.permission));
  if (verdict === 'ask' && !allowed) {
    const response = await request('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId,
        title: editPath ?? target,
        kind: action.kind,
        status: 'pending',
        locations: [],
        rawInput,
      },
      options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    });
    const optionId =
      response?.outcome?.outcome === 'selected'
        ? response.outcome.optionId
        : undefined;
    allowed = optionId === 'once' || optionId === 'always';
    if (optionId === 'always') {
      alwaysAllowed.add(action.permission);
      if (process.env.FAKE_OPENCODE_RECORD) {
        appendFileSync(
          process.env.FAKE_OPENCODE_RECORD,
          `${JSON.stringify({ always: action.permission })}\n`,
        );
      }
    }
  }
  if (allowed && editPath) {
    mkdirSync(dirname(editPath), { recursive: true });
    writeFileSync(editPath, 'written by the fixture\n');
  }
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: allowed ? 'completed' : 'failed',
    kind: action.kind,
    title: target,
    rawInput,
    ...(allowed
      ? {
          content: [
            {
              type: 'content',
              content: { type: 'text', text: `${action.permission} ran` },
            },
          ],
          rawOutput: { output: `${action.permission} ran` },
        }
      : {
          rawOutput: {
            error:
              verdict === 'deny'
                ? 'The user has specified a rule which prevents you from using this specific tool call.'
                : 'The user rejected permission to use this specific tool call.',
          },
        }),
  });
  return { stopReason: 'end_turn' };
}

async function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message.result);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      write({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true, sse: true },
            promptCapabilities: { embeddedContext: true, image: true },
            sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
          },
          authMethods: [
            {
              description: 'Run `opencode auth login` in the terminal',
              name: 'Login with opencode',
              id: 'opencode-login',
            },
          ],
          agentInfo: { name: 'OpenCode', version: '1.18.18' },
        },
      });
      return;
    case 'session/new':
      write({
        id,
        result: {
          sessionId: 'ses_fixture00000000000000000',
          configOptions: configOptions(),
        },
      });
      return;
    case 'session/load':
      write({ id, result: { configOptions: configOptions() } });
      return;
    case 'session/resume':
      if (process.env.FAKE_OPENCODE_REFUSE_RESUME === '1') {
        write({
          id,
          error: { code: -32603, message: 'Internal error: session not found' },
        });
        return;
      }
      if (process.env.FAKE_OPENCODE_RECORD) {
        appendFileSync(
          process.env.FAKE_OPENCODE_RECORD,
          `${JSON.stringify({ resumed: params.sessionId })}\n`,
        );
      }
      write({ id, result: { configOptions: configOptions() } });
      return;
    case 'session/set_config_option':
      if (params.configId === 'mode') mode = params.value;
      write({ id, result: { configOptions: configOptions() } });
      return;
    case 'session/prompt': {
      const text = (params.prompt ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      write({ id, result: await prompt(params.sessionId, text) });
      return;
    }
    case 'session/cancel':
      return;
    default:
      if (id !== undefined)
        write({
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
