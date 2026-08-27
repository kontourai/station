#!/usr/bin/env node
/**
 * CLI / agent end-to-end lane.
 *
 * Boots a REAL Station server (temp home, unique ports), then exercises the
 * full managed-agent path against a local Ollama model — the flow that has no
 * other live coverage and where a string of "green in unit tests, broken
 * against the real runtime" bugs hid (tool install schema, tool forwarding to
 * the model, UIBlock render extraction). It asserts:
 *
 *   1. The builtin tool installs and LOADS into the agent (catches the schema
 *      and loader bugs).
 *   2. The tool is FORWARDED to the model in the chat request (catches the
 *      VoltAgent base-tool gate bug — deterministic: we inspect the outgoing
 *      request, not whether the model chooses to call it).
 *   3. CLI surface: `station chat <agent> "<msg>"` connects, streams, exits 0.
 *
 * Deliberately NOT asserted: that the model calls the tool with valid args and
 * renders — that depends on a small local model's tool-calling and would be
 * flaky. The render-extraction chain is covered by deterministic unit tests
 * (ToolLifecycleHandler / strands-stream-events); this lane covers the live
 * integration up to the model boundary.
 *
 * Creds-free: uses Ollama. SKIPS cleanly (exit 0) when Ollama or a model is
 * unavailable, so it is safe to run anywhere — it only adds signal when a local
 * model is present. Run via `npm run verify:cli-e2e`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFreePort } from './lib/free-ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLLAMA = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
// Assigned in main() from a free OS-allocated port (shared with the e2e suite) —
// no hardcoded port, so concurrent runs / leftover servers can't collide.
let PORT;
let API;

const log = (...a) => console.log('[cli-e2e]', ...a);
const skip = (msg) => {
  log(`SKIP — ${msg}`);
  process.exit(0);
};
const fail = (msg) => {
  console.error(`[cli-e2e] FAIL — ${msg}`);
  process.exit(1);
};

async function ollamaModel() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const models = (await res.json()).models || [];
    return models[0]?.name || null;
  } catch {
    return null;
  }
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json().catch(() => ({}));
}

async function waitReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${API}/api/agents`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const model = await ollamaModel();
  if (!model) skip(`Ollama not reachable at ${OLLAMA} (or no model pulled)`);
  log(`using Ollama model: ${model}`);

  if (!existsSync(join(ROOT, 'dist-server/command-station.js'))) {
    skip(
      'dist-server not built — run `./station` build or `npm run build:server` first',
    );
  }

  // Free OS-allocated port (no hardcoding → no collision with stale/parallel runs).
  PORT = await findFreePort();
  API = `http://127.0.0.1:${PORT}`;
  log(`server port: ${PORT}`);

  const home = mkdtempSync(join(tmpdir(), 'station-cli-e2e-'));
  const server = spawn('node', ['dist-server/command-station.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      // STATION_HOME isolates the data dir; a wrong/missing var silently falls
      // back to the real ~/.station.
      STATION_HOME: home,
      PORT: String(PORT),
      MCP_UI_FRAME_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  let failure = null;
  try {
    if (!(await waitReady())) {
      throw new Error(`server did not become ready\n${serverLog.slice(-800)}`);
    }
    log('server ready');

    // Configure the managed agent: install builtin tool, wire Ollama, create agent.
    await api('POST', '/api/registry/integrations/install', {
      id: 'render-component',
    });
    await api('POST', '/api/connections', {
      kind: 'model',
      type: 'ollama',
      name: 'Local Ollama',
      config: { baseUrl: OLLAMA },
      enabled: true,
      capabilities: ['llm'],
    });
    await api('POST', '/agents', {
      name: 'CLI E2E',
      slug: 'cli-e2e',
      prompt:
        'When asked for a card, you MUST call the render_component tool with type=card.',
      model,
      tools: { mcpServers: ['render-component'] },
    });
    log('agent configured');

    // (1) The builtin tool installed + LOADED into the agent's tool set.
    const tools = (await api('GET', '/agents/cli-e2e/tools')).data || [];
    const loaded = tools.map((t) => t.toolName || t.name);
    if (!loaded.includes('render_component')) {
      throw new Error(
        `render_component did not load into the agent (schema/loader gap). loaded: ${JSON.stringify(loaded)}`,
      );
    }
    log(`tool loaded: ${JSON.stringify(loaded)}`);

    // (2) The tool is FORWARDED to the model — inspect the outgoing chat
    //     request's tools array (deterministic; independent of whether the
    //     small model chooses to call it). This is the VoltAgent base-tool gate.
    const res = await fetch(`${API}/api/agents/cli-e2e/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: 'Show a card titled Ship with body it works.',
        options: {},
      }),
      signal: AbortSignal.timeout(150000),
    });
    const text = await res.text();
    let forwarded = false;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      const toolsInReq = ev?.request?.body?.tools;
      if (Array.isArray(toolsInReq)) {
        const names = toolsInReq.map((t) => t.function?.name || t.name);
        if (names.includes('render_component')) forwarded = true;
      }
    }
    if (!forwarded) {
      throw new Error(
        'render_component was NOT forwarded to the model in the chat request (base-tool gate regression)',
      );
    }
    log('tool forwarded to the model ✓');

    // (3) CLI surface: `station chat` against the running instance.
    const chat = await run(
      './station',
      ['chat', 'cli-e2e', 'Say hello in one short sentence.'],
      { env: { STATION_API_BASE: API } },
    );
    if (chat.code !== 0) {
      throw new Error(
        `station chat exited ${chat.code}\n${chat.stderr.slice(-400)}`,
      );
    }
    if (!chat.stdout.trim()) {
      throw new Error('station chat produced no output');
    }
    log(`CLI chat OK: "${chat.stdout.trim().slice(0, 60)}…"`);

    log('PASS — install + load + forward + CLI chat verified live (Ollama)');
  } catch (err) {
    failure = err;
  } finally {
    server.kill('SIGKILL');
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  }

  if (failure) fail(failure.message);
}

main().catch((e) => fail(e.message));
