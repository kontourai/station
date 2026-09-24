#!/usr/bin/env node
// #2456 / #2457: records every SDK message of one live Claude Code session
// running Task subagents, so the child-work mappers and the conformance
// tripwire replay what the engine actually sends rather than a hand-written
// guess.
//
// Usage (manual, needs a logged-in `claude` CLI; spends a few cents on haiku):
//   node src-server/providers/__tests__/fixtures/capture-claude-task-fixtures.mjs <scenario> <raw-out.jsonl>
//
// Scenarios:
//   task-subagents      one foreground and one backgrounded Task (#2456,
//                       committed as `claude-task-subagents.jsonl`, plain
//                       one-message-per-line format).
//   stop-task           a background agent runs `sleep 90`; on its first
//                       task_progress the host calls `Query.stopTask`.
//   close-kills         a background agent sleeps ~90 s; after the parent's
//                       result the prompt generator returns (input closed),
//                       as Station's stopSession closes its prompt queue.
//   progress-summary    a background agent runs four 20 s sleeps with
//                       agentProgressSummaries on.
//   subagent-permission permissionMode 'default': every canUseTool call is
//                       recorded ({toolName, agentID, toolUseID}) and allowed.
//   nested-agent        a subagent that itself spawns a subagent.
//
// Every scenario but `task-subagents` writes `{t, msg}` lines (ms since start
// plus the SDK message) and `{t, probe}` lines for what the host did — the
// same format as the `claude-2.1.281-*.jsonl` provider-turn captures.
//
// The engine is the INSTALLED `claude` CLI, passed as
// `pathToClaudeCodeExecutable` exactly as Station's adapter does, so the
// capture records that CLI's version (the `init` message's
// `claude_code_version`), not the SDK's bundled one.
//
// The output is RAW and contains machine paths and session ids. It is never
// committed as-is: `scrubClaudeTaskCapture` below rewrites it into
// `<raw-out>.scrubbed.jsonl`, and only a scrubbed file is committed.
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const backgroundAgentPrompt = (instruction) =>
  [
    'Use the Task tool once, with subagent_type "general-purpose" and',
    'run_in_background: true, with the prompt:',
    `  "${instruction} Then reply DONE."`,
    'After launching it, reply with exactly: LAUNCHED. Do not wait for it.',
  ].join('\n');

/** Grace between closing input and forcing `Query.close()`. */
const CLOSE_GRACE_MS = 30_000;

const SCENARIOS = {
  'task-subagents': {
    plain: true,
    prompt: [
      'Use the Task tool twice, with subagent_type "general-purpose":',
      '1. First, a FOREGROUND task (do not set run_in_background) with the prompt',
      '   "Reply with exactly: FOREGROUND DONE". Wait for it.',
      '2. Then a BACKGROUND task (set run_in_background: true) with the prompt',
      '   "Run the shell command `echo background-ok` and reply with its output."',
      'After launching the background task, reply with exactly: LAUNCHED.',
    ].join('\n'),
    closeWhen: 'all-tasks-settled',
  },
  'stop-task': {
    prompt: backgroundAgentPrompt(
      'Run the shell command `sleep 90` with the Bash tool.',
    ),
    // Stop the agent the first time it reports progress, then record until
    // its terminal notification.
    onMessage(message, run) {
      if (
        message.type === 'system' &&
        message.subtype === 'task_progress' &&
        run.agentTasks.has(message.task_id) &&
        !run.stopRequested
      ) {
        run.stopRequested = true;
        run.probe(`STOP_TASK ${message.task_id}`);
        run.q.stopTask(message.task_id).then(
          () => run.probe('STOP_TASK RESOLVED'),
          (error) => run.probe(`STOP_TASK REJECTED ${String(error)}`),
        );
      }
    },
    closeWhen: 'all-tasks-settled',
  },
  'close-kills': {
    // Not a bare `sleep 90`: the CLI's Bash tool refuses a standalone long
    // sleep (observed on 2.1.281), and the agent then finishes at once.
    prompt: backgroundAgentPrompt(
      'Run the shell command `for i in 1 2 3 4 5 6; do sleep 15; done; echo slept` with the Bash tool.',
    ),
    closeWhen: 'first-result',
  },
  'progress-summary': {
    prompt: backgroundAgentPrompt(
      'Run `sleep 20` four times, as four separate Bash tool calls, one after another.',
    ),
    closeWhen: 'all-tasks-settled',
  },
  'subagent-permission': {
    permissionMode: 'default',
    prompt: [
      'Use the Task tool once, with subagent_type "general-purpose" (do not',
      'set run_in_background), with the prompt:',
      // `echo` alone is auto-allowed by the CLI and never reaches canUseTool
      // (observed on 2.1.281); a file write needs an approval.
      '  "Run the shell command `touch perm-probe.txt && echo perm-ok` with the Bash tool and reply with its output."',
      'Then reply with exactly: DONE.',
    ].join('\n'),
    closeWhen: 'all-tasks-settled',
  },
  'nested-agent': {
    prompt: [
      'Use the Task tool once, with subagent_type "general-purpose" (do not',
      'set run_in_background), with the prompt:',
      '  "Use the Task tool yourself, with subagent_type general-purpose, with the',
      '   prompt: Reply with exactly INNER DONE. Then reply with its answer."',
      'Then reply with exactly: DONE.',
    ].join('\n'),
    closeWhen: 'all-tasks-settled',
  },
};

function installedClaudeExecutable() {
  const found = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  return realpathSync(found);
}

async function capture(scenarioName, outFile) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario: ${scenarioName}`);
  const cwd = mkdtempSync(path.join(tmpdir(), 'claude-task-capture-'));
  const started = Date.now();
  const lines = [];
  const live = new Set();
  const agentTasks = new Set();
  let resultSeen = false;
  let finish;
  let forceClose;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const run = {
    q: undefined,
    agentTasks,
    stopRequested: false,
    probe(text) {
      lines.push({ t: Date.now() - started, probe: text });
    },
  };
  const timeout = setTimeout(() => {
    run.probe('TIMEOUT');
    finish('timeout');
  }, 300_000);
  async function* prompt() {
    yield {
      type: 'user',
      message: { role: 'user', content: scenario.prompt },
      parent_tool_use_id: null,
      session_id: '',
    };
    // Keep stdin open until the scenario's close point: a closed-input run
    // kills held-back background tasks at the result.
    await done;
    run.probe('CLOSE INPUT');
    // Station's stopSession follows a closed queue with `Query.close()`;
    // do the same if the iterator has not ended on its own by then.
    forceClose = setTimeout(() => {
      run.probe('QUERY CLOSE');
      run.q.close();
    }, CLOSE_GRACE_MS);
  }
  const permissionMode = scenario.permissionMode ?? 'bypassPermissions';
  const q = query({
    prompt: prompt(),
    options: {
      cwd,
      model: 'haiku',
      pathToClaudeCodeExecutable: installedClaudeExecutable(),
      agentProgressSummaries: true,
      perTaskStopAffordance: true,
      permissionMode,
      ...(permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      persistSession: false,
      ...(permissionMode === 'default'
        ? {
            canUseTool: async (toolName, toolInput, options) => {
              run.probe(
                `CAN_USE_TOOL ${JSON.stringify({
                  toolName,
                  agentID: options.agentID ?? null,
                  toolUseID: options.toolUseID ?? null,
                })}`,
              );
              return { behavior: 'allow', updatedInput: toolInput };
            },
          }
        : {}),
    },
  });
  run.q = q;
  const settleCheck = () => {
    if (scenario.closeWhen === 'first-result' && resultSeen) {
      finish('first-result');
      return;
    }
    if (resultSeen && live.size === 0) {
      // Give the engine a moment for any trailing second terminal.
      setTimeout(() => finish('settled'), 3_000);
    }
  };
  try {
    for await (const message of q) {
      if (scenario.plain) lines.push(message);
      else lines.push({ t: Date.now() - started, msg: message });
      if (message.type === 'system' && message.subtype === 'task_started') {
        if (message.owned_by_subagent !== true) live.add(message.task_id);
        if (message.task_type === 'local_agent') {
          agentTasks.add(message.task_id);
        }
      }
      scenario.onMessage?.(message, run);
      if (
        message.type === 'system' &&
        message.subtype === 'task_notification'
      ) {
        live.delete(message.task_id);
        settleCheck();
      }
      if (message.type === 'result') {
        resultSeen = true;
        settleCheck();
      }
    }
    run.probe('ITERATOR END');
  } catch (error) {
    run.probe(`ITERATOR THREW ${String(error).split('\n')[0]}`);
  }
  clearTimeout(timeout);
  clearTimeout(forceClose);
  finish('iterator-end');
  const body = scenario.plain
    ? lines.filter((line) => !('probe' in line))
    : lines;
  writeFileSync(
    outFile,
    `${body.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
  return { count: body.length, cwd };
}

/**
 * Deterministic scrub: absolute paths → /workspace/example, every uuid-shaped
 * id → a fixed placeholder (stable per original value, so cross-message
 * joins survive), request ids zeroed. Field shapes are left untouched.
 * Handles both line formats: a bare SDK message, or `{t, msg}` / `{t, probe}`.
 */
export function scrubClaudeTaskCapture(raw, { cwd, home, user }) {
  const uuidMap = new Map();
  const uuidRe =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  let text = raw;
  const roots = [cwd, cwd && path.resolve('/private', cwd.replace(/^\//, ''))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const root of roots) text = text.split(root).join('/workspace/example');
  if (home) text = text.split(home).join('/home/example');
  text = text.replace(/\/private\/var\/folders\/[^"\\]*/g, '/tmp/example');
  text = text.replace(/\/var\/folders\/[^"\\]*/g, '/tmp/example');
  text = text.replace(uuidRe, (match) => {
    const key = match.toLowerCase();
    if (!uuidMap.has(key)) {
      const n = String(uuidMap.size + 1).padStart(12, '0');
      uuidMap.set(key, `00000000-0000-4000-8000-${n}`);
    }
    return uuidMap.get(key);
  });
  text = text.replace(/req_[A-Za-z0-9]+/g, 'req_00000000000000000000000000');
  // The CLI's per-user temp root encodes the uid and the ORIGINAL cwd in a
  // directory name (`/private/tmp/claude-<uid>/-private-var-folders-...`).
  text = text.replace(
    /\/(?:private\/)?tmp\/claude-\d+\/[^/"\\]+/g,
    '/tmp/claude/-workspace-example',
  );
  // A username can survive in prose the model wrote (a `pwd` echo, a path in
  // a summary); replace it wherever it stands alone.
  if (user) {
    text = text.replace(new RegExp(`\\b${user}\\b`, 'g'), 'example');
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => ('probe' in line ? true : keepMessage(line.msg ?? line)))
    .map((line) => {
      if ('probe' in line) return line;
      if ('msg' in line) return { ...line, msg: redactMessage(line.msg) };
      return redactMessage(line);
    })
    .map((line) => JSON.stringify(line))
    .join('\n')
    .concat('\n');
}

/**
 * Only what the task mappers read plus the turn skeleton around it. Stream
 * deltas, hooks, rate-limit and thinking-token frames carry nothing about
 * child work and some carry host details (hook commands).
 */
const DROPPED_SYSTEM = new Set([
  'hook_started',
  'hook_response',
  'thinking_tokens',
]);
function keepMessage(message) {
  if (message.type === 'stream_event') return false;
  if (message.type === 'rate_limit_event') return false;
  if (message.type === 'system' && DROPPED_SYSTEM.has(message.subtype))
    return false;
  return true;
}

/**
 * `init` enumerates the capturing user's installed skills, plugins, agents,
 * slash commands and MCP servers. None of it is read by a task mapper, so it
 * is emptied rather than committed.
 */
function redactMessage(message) {
  // A thinking block's `signature` is an opaque blob that embeds request
  // identifiers; no mapper reads it.
  if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
    return {
      ...message,
      message: {
        ...message.message,
        content: message.message.content.map((block) =>
          block?.type === 'thinking' ? { ...block, signature: '' } : block,
        ),
      },
    };
  }
  if (message.type === 'system' && message.subtype === 'init') {
    return {
      ...message,
      tools: ['Task', 'Bash'],
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      agents: ['general-purpose'],
      plugins: [],
      ...(message.memory_paths ? { memory_paths: {} } : {}),
      ...(message.messaging_socket_path
        ? { messaging_socket_path: '/tmp/example.sock' }
        : {}),
    };
  }
  return message;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [scenario, out] = process.argv.slice(2);
  if (!scenario || !out) {
    console.error(
      `usage: capture-claude-task-fixtures.mjs <${Object.keys(SCENARIOS).join('|')}> <raw-out.jsonl>`,
    );
    process.exit(2);
  }
  const { count, cwd } = await capture(scenario, out);
  const scrubbed = scrubClaudeTaskCapture(readFileSync(out, 'utf8'), {
    cwd,
    home: process.env.HOME,
    user: process.env.USER,
  });
  writeFileSync(`${out}.scrubbed.jsonl`, scrubbed);
  console.log(`captured ${count} lines; cwd=${cwd}`);
  process.exit(0);
}
