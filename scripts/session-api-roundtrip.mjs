#!/usr/bin/env node
/**
 * Session API round-trip proof (docs/design/chat-composer.md §4 proof standard:
 * "a scripted nonce-grade round-trip against a live instance using only
 * documented endpoints"). Companion script for docs/reference/session-api.md.
 *
 * Drives a live Station instance (`PORT` env, no other setup) through the
 * exact documented sequence for an ACP-connected agent:
 *
 *   1. POST /acp/registry/opencode/install   (idempotent: 409 already-exists is fine)
 *   2. POST /api/orchestration/commands {type:'startSession', provider:'acp', ...}
 *   3. POST /api/orchestration/commands {type:'sendTurn', ...}     asking the
 *      agent to read a nonce file this script wrote to /tmp
 *   4. GET  /api/orchestration/sessions/:threadId/events           polled until
 *      the nonce shows up inside a `content.text-delta` (or the `turn.completed`
 *      `outputText` fallback) — the canonical event methods that carry
 *      assistant-visible text (packages/contracts/src/runtime-events.ts).
 *
 * Prints a single PASS/FAIL line (plus the matched event on PASS) and exits
 * 0/1 accordingly. Starts nothing itself — point it at an already-running
 * instance via PORT.
 *
 * Along the way it auto-resolves any `request.opened` tool-permission prompt
 * with `respondToRequest`/`accept`, since the read-file turn may need one.
 */

const PORT = process.env.PORT;
if (!PORT) {
  console.error(
    "FAIL: PORT env var is required (the running instance's server port).",
  );
  process.exit(1);
}

const BASE = `http://localhost:${PORT}`;
const CONNECTION_ID = 'opencode';
const MODEL_ID = 'zai-coding-plan/glm-4.7';
const TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const threadId = `session-api-roundtrip-${runId}`;
const nonce = `SESSION-API-NONCE-${runId}`;
const nonceFilePath = `/tmp/station-session-api-nonce-${runId}.txt`;

async function fetchJson(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function dispatchCommand(command) {
  const { status, body } = await fetchJson('/api/orchestration/commands', {
    method: 'POST',
    body: JSON.stringify(command),
  });
  if (!body?.success) {
    throw new Error(
      `Command '${command.type}' failed (HTTP ${status}): ${body?.error ?? 'no error body'}`,
    );
  }
  return body;
}

/** Concatenate every `content.text-delta`'s `delta` in event order, plus any
 * `turn.completed.outputText` fallback — the exact text an assistant message
 * carries across the canonical event stream (packages/contracts/src/runtime-events.ts). */
function extractAssistantText(events) {
  let text = '';
  for (const event of events) {
    if (
      event.method === 'content.text-delta' &&
      typeof event.delta === 'string'
    ) {
      text += event.delta;
    } else if (
      event.method === 'turn.completed' &&
      typeof event.outputText === 'string'
    ) {
      text += event.outputText;
    }
  }
  return text;
}

function findOpenRequests(events) {
  const opened = new Map();
  for (const event of events) {
    if (event.method === 'request.opened') opened.set(event.requestId, event);
    if (event.method === 'request.resolved') opened.delete(event.requestId);
  }
  return [...opened.values()];
}

async function resolveOpenRequests(events) {
  for (const request of findOpenRequests(events)) {
    console.log(
      `  (auto-accepting pending request.opened: ${request.requestId} — ${request.title ?? request.requestType})`,
    );
    await dispatchCommand({
      type: 'respondToRequest',
      threadId,
      requestId: request.requestId,
      decision: 'accept',
    });
  }
}

async function main() {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(nonceFilePath, nonce, 'utf8');
  console.log(`Wrote nonce file: ${nonceFilePath}`);
  console.log(`Thread: ${threadId}`);

  console.log(`\n1. POST /acp/registry/${CONNECTION_ID}/install`);
  const install = await fetchJson(`/acp/registry/${CONNECTION_ID}/install`, {
    method: 'POST',
  });
  if (install.status !== 409 && !install.body?.success) {
    throw new Error(
      `ACP registry install failed (HTTP ${install.status}): ${install.body?.error ?? 'no error body'}`,
    );
  }
  console.log(
    install.status === 409
      ? `  connection '${CONNECTION_ID}' already installed — continuing`
      : `  installed connection '${CONNECTION_ID}'`,
  );

  console.log('\n2. POST /api/orchestration/commands {type:"startSession"}');
  await dispatchCommand({
    type: 'startSession',
    input: {
      threadId,
      provider: 'acp',
      modelId: MODEL_ID,
      cwd: '/tmp',
      metadata: { connectionId: CONNECTION_ID },
    },
  });
  console.log(
    `  session started (provider: acp, connection: ${CONNECTION_ID})`,
  );

  console.log('\n3. POST /api/orchestration/commands {type:"sendTurn"}');
  await dispatchCommand({
    type: 'sendTurn',
    input: {
      threadId,
      input: `Read the file at ${nonceFilePath} and reply with its exact contents, nothing else.`,
    },
  });
  console.log('  turn sent — polling for the reply');

  console.log(
    `\n4. GET /api/orchestration/sessions/${threadId}/events (poll, ${TIMEOUT_MS / 1000}s timeout)`,
  );
  const startedAt = Date.now();
  let lastEvents = [];
  let matchedEvent;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    const { status, body } = await fetchJson(
      `/api/orchestration/sessions/${threadId}/events`,
    );
    if (status !== 200 || !body?.success) {
      throw new Error(
        `Events replay failed (HTTP ${status}): ${body?.error ?? 'no error body'}`,
      );
    }
    lastEvents = body.data;
    await resolveOpenRequests(lastEvents);

    const assistantText = extractAssistantText(lastEvents);
    if (assistantText.includes(nonce)) {
      matchedEvent =
        lastEvents.find(
          (event) =>
            event.method === 'content.text-delta' &&
            assistantText.includes(nonce),
        ) ?? lastEvents.find((event) => event.method === 'turn.completed');
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (matchedEvent) {
    console.log(
      `\nPASS: nonce '${nonce}' found in assistant reply for thread '${threadId}' (matched event method: ${matchedEvent.method}, eventId: ${matchedEvent.eventId}).`,
    );
    process.exit(0);
  }

  console.error(
    `\nFAIL: nonce '${nonce}' not found in assistant reply within ${TIMEOUT_MS / 1000}s for thread '${threadId}'.`,
  );
  console.error(
    `  Last poll returned ${lastEvents.length} event(s): ${
      lastEvents.map((event) => event.method).join(', ') || '(none)'
    }`,
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(
    `\nFAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
