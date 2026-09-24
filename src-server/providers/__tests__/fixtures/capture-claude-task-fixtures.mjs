#!/usr/bin/env node
// #2456: records every SDK message of one live Claude Code turn that runs a
// foreground Task subagent and a backgrounded Task subagent, so the
// child-work conformance tripwire replays what the engine actually sends
// rather than a hand-written guess.
//
// Usage (manual, needs a logged-in `claude` CLI; spends a few cents on haiku):
//   node src-server/providers/__tests__/fixtures/capture-claude-task-fixtures.mjs <raw-out.jsonl>
//
// The output is RAW and contains machine paths and session ids. It is never
// committed as-is: `scrubClaudeTaskCapture` below rewrites it, and only the
// scrubbed file (`claude-task-subagents.jsonl`) is committed.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const PROMPT = [
  'Use the Task tool twice, with subagent_type "general-purpose":',
  '1. First, a FOREGROUND task (do not set run_in_background) with the prompt',
  '   "Reply with exactly: FOREGROUND DONE". Wait for it.',
  '2. Then a BACKGROUND task (set run_in_background: true) with the prompt',
  '   "Run the shell command `echo background-ok` and reply with its output."',
  'After launching the background task, reply with exactly: LAUNCHED.',
].join('\n');

async function capture(outFile) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'claude-task-capture-'));
  const messages = [];
  let resultSeen = false;
  const live = new Set();
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const timeout = setTimeout(() => finish('timeout'), 240_000);
  async function* prompt() {
    yield {
      type: 'user',
      message: { role: 'user', content: PROMPT },
      parent_tool_use_id: null,
      session_id: '',
    };
    // Keep stdin open until every started task settled: a closed-input run
    // kills held-back background tasks at the result.
    await done;
  }
  const settleCheck = () => {
    if (resultSeen && live.size === 0) finish('settled');
  };
  const q = query({
    prompt: prompt(),
    options: {
      cwd,
      model: 'haiku',
      agentProgressSummaries: true,
      perTaskStopAffordance: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
    },
  });
  for await (const message of q) {
    messages.push(message);
    if (message.type === 'system' && message.subtype === 'task_started') {
      live.add(message.task_id);
    }
    if (message.type === 'system' && message.subtype === 'task_notification') {
      live.delete(message.task_id);
      settleCheck();
    }
    if (message.type === 'result') {
      resultSeen = true;
      settleCheck();
    }
    if (message.type === 'result' && live.size === 0 && resultSeen) {
      // Give the engine a moment for any trailing second terminal.
      setTimeout(() => finish('settled'), 3_000);
    }
  }
  clearTimeout(timeout);
  writeFileSync(
    outFile,
    `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
  );
  return { count: messages.length, cwd };
}

/**
 * Deterministic scrub: absolute paths → /workspace/example, every uuid-shaped
 * id → a fixed placeholder (stable per original value, so cross-message
 * joins survive), request ids zeroed. Field shapes are left untouched.
 */
export function scrubClaudeTaskCapture(raw, { cwd, home }) {
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
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(keepMessage)
    .map(redactMessage)
    .map((message) => JSON.stringify(message))
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
  const out = process.argv[2];
  if (!out) {
    console.error('usage: capture-claude-task-fixtures.mjs <raw-out.jsonl>');
    process.exit(2);
  }
  const { count, cwd } = await capture(out);
  const scrubbed = scrubClaudeTaskCapture(readFileSync(out, 'utf8'), {
    cwd,
    home: process.env.HOME,
  });
  writeFileSync(`${out}.scrubbed.jsonl`, scrubbed);
  console.log(`captured ${count} messages; cwd=${cwd}`);
  process.exit(0);
}
