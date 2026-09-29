#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { invokedDirectly } from './lib/module-entry.mjs';

/** Requires a configured Agent and a local workspace visible to Station.
 * This live diagnostic never installs connections or grants tools. */
export async function runSessionApiRoundtrip({
  baseUrl,
  credential,
  agent,
  workspaceDir,
  timeoutMs = 120_000,
  pollIntervalMs = 2_000,
  fetchImpl = fetch,
}) {
  if (!baseUrl || !credential || !agent || !workspaceDir)
    throw new Error(
      'STATION_API_BASE, STATION_API_CREDENTIAL, STATION_AGENT_ID and STATION_SESSION_CWD are required.',
    );
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error(
      'Use an HTTP(S) Station API base without embedded credentials.',
    );
  const directory = await mkdtemp(join(resolve(workspaceDir), '.session-api-'));
  const nonce = `SESSION-API-NONCE-${randomUUID()}`;
  const noncePath = join(directory, 'nonce.txt');

  async function request(path, body, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error('Timed out; inspect the Session before retrying.');
    const response = await fetchImpl(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(remaining),
    });
    const payload = await response.json();
    if (
      !response.ok ||
      payload.success !== true ||
      payload.receiptStatus === 'unavailable' ||
      payload.outcome === 'indeterminate'
    )
      throw new Error(
        `${path}: HTTP ${response.status}, ${payload.code ?? payload.error ?? 'unavailable receipt or unsuccessful response'}; inspect the Session before retrying.`,
      );
    return payload.data;
  }

  async function runTurn(path, body, previous) {
    const deadline = Date.now() + timeoutMs;
    const handle = await request(path, body, deadline);
    for (const key of ['conversationId', 'sessionId', 'providerTurnId'])
      if (typeof handle?.[key] !== 'string' || !handle[key])
        throw new Error(
          `Missing ${key} in foreground handle; do not retry the dispatch.`,
        );
    if (previous) {
      if (handle.conversationId !== previous.conversationId)
        throw new Error('Continuation returned a different Conversation.');
      if (
        handle.sessionId === previous.sessionId &&
        handle.providerTurnId === previous.providerTurnId
      )
        throw new Error(
          'Continuation returned the previous turn; completion is unverified.',
        );
    }
    const sessionPath = `/api/orchestration/sessions/${encodeURIComponent(handle.sessionId)}`;
    while (Date.now() < deadline) {
      const events = await request(
        `${sessionPath}/events`,
        undefined,
        deadline,
      );
      if (!Array.isArray(events)) throw new Error('Invalid event replay.');
      const turn = events.filter(
        (event) => event.turnId === handle.providerTurnId,
      );
      const resolved = new Set(
        events
          .filter((event) => event.method === 'request.resolved')
          .map((event) => event.requestId),
      );
      if (
        turn.some(
          (event) =>
            event.method === 'request.opened' && !resolved.has(event.requestId),
        )
      )
        throw new Error(
          `Approval/input pending in ${handle.sessionId}; inspect it in Station. No decision was sent.`,
        );
      if (
        turn.some(
          (event) =>
            event.method === 'turn.aborted' || event.method === 'runtime.error',
        )
      )
        throw new Error(`Turn ${handle.providerTurnId} failed or was aborted.`);
      if (turn.some((event) => event.method === 'turn.completed')) {
        const messages = await request(
          `${sessionPath}/messages`,
          undefined,
          deadline,
        );
        if (!Array.isArray(messages))
          throw new Error('Invalid message projection.');
        const text = messages
          .filter(
            (message) =>
              message.role === 'assistant' &&
              message.metadata?.turnId === handle.providerTurnId,
          )
          .flatMap((message) =>
            message.parts
              .filter((part) => part.type === 'text')
              .map((part) => part.text),
          )
          .join('');
        if (!text.includes(nonce))
          throw new Error(
            `Completed turn ${handle.providerTurnId} did not return the nonce.`,
          );
        return handle;
      }
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error(
      `Timed out waiting for ${handle.providerTurnId}; inspect the Session before retrying.`,
    );
  }

  try {
    await writeFile(noncePath, nonce, { mode: 0o600 });
    const first = await runTurn('/api/orchestration/chat', {
      target: {
        environment: { kind: 'current' },
        agent,
        workspace: { kind: 'directory', cwd: resolve(workspaceDir) },
      },
      message: `Read the file at ${noncePath} and reply with its exact contents, nothing else.`,
    });
    const continued = await runTurn(
      `/api/orchestration/chat/${encodeURIComponent(first.conversationId)}/continue`,
      {
        message:
          'Repeat the exact file contents from your previous answer, nothing else.',
      },
      first,
    );
    return { first, continued };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (invokedDirectly(import.meta.url)) {
  runSessionApiRoundtrip({
    baseUrl: process.env.STATION_API_BASE,
    credential: process.env.STATION_API_CREDENTIAL,
    agent: process.env.STATION_AGENT_ID,
    workspaceDir: process.env.STATION_SESSION_CWD,
  }).then(
    (result) =>
      console.log(
        `PASS: nonce read and continuation completed: ${JSON.stringify(result)}`,
      ),
    (error) => {
      console.error(
        `FAIL: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    },
  );
}
