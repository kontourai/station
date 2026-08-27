// @vitest-environment node

/**
 * station#1049 — the unit suite in station-agent-adapter.test.ts stubs
 * `hasAgent: () => true`, which is exactly why the real divergence (the
 * flip's `hasAgent` only consulted the in-memory active-agent set, while
 * `POST /api/agents/:slug/chat` also serves persisted-but-not-yet-active
 * agents) shipped past it undetected. This suite exercises the production
 * `createRegistryAwareHasAgent` predicate against a REAL `ConfigLoader`
 * backed by a real temp `~/.station`-shaped directory and a real, schema-
 * validated persisted agent — no stub in the loop.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ConfigLoader } from '../../domain/config-loader.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import {
  createRegistryAwareHasAgent,
  StationAgentAdapter,
} from '../adapters/station-agent-adapter.js';

function approvalDeps() {
  const eventBus = new EventBus();
  return {
    eventBus,
    approvalRegistry: new ApprovalRegistry(
      { info: () => {}, warn: () => {} },
      { eventBus },
    ),
  };
}

describe('StationAgentAdapter x real agent registry (station#1049)', () => {
  let home: string;
  let configLoader: ConfigLoader;
  // The active-agent set, exactly as it is in production: only agents that
  // registered successfully with the runtime end up here. Left empty in
  // these tests to model the real failure mode — a persisted agent whose
  // model connection didn't resolve at boot never makes it into this set,
  // even though it is a perfectly real, known agent on disk.
  let activeAgents: Map<string, unknown>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'station-agent-registry-'));
    configLoader = new ConfigLoader({ projectHomeDir: home });
    activeAgents = new Map();
    // Real, schema-validated, on-disk agent — created the same way the
    // config-loader-agents primitives create any persisted Station agent.
    await configLoader.createAgent({
      name: 'assistant',
      slug: 'assistant',
      prompt:
        'You are a helpful assistant. Answer questions to the best of your ability.',
      model: 'ollama:qwen',
    } as any);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function buildAdapter() {
    return new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: createRegistryAwareHasAgent(activeAgents, (agentId) =>
        configLoader.loadAgent(agentId),
      ),
      ...approvalDeps(),
    });
  }

  test('does NOT throw "Unknown Station agent" for a persisted-but-inactive managed agent', async () => {
    // Confirm the fixture models the real bug precisely: the agent is on
    // disk (real registry) but absent from the active set (real failure
    // mode — e.g. its model connection didn't resolve at registration).
    expect(activeAgents.has('assistant')).toBe(false);
    await expect(configLoader.loadAgent('assistant')).resolves.toMatchObject({
      name: 'assistant',
    });

    const adapter = buildAdapter();
    const session = await adapter.startSession({
      threadId: 'task-assistant-1',
      provider: 'station-agent',
      metadata: { agentId: 'assistant', taskId: 'task-assistant-1' },
    });
    expect(session.status).toBe('ready');
  });

  test('still rejects a genuinely nonexistent agent as "Unknown Station agent"', async () => {
    expect(activeAgents.has('totally-nonexistent-agent-xyz')).toBe(false);
    await expect(
      configLoader.loadAgent('totally-nonexistent-agent-xyz'),
    ).rejects.toThrow();

    const adapter = buildAdapter();
    await expect(
      adapter.startSession({
        threadId: 'task-ghost-1',
        provider: 'station-agent',
        metadata: {
          agentId: 'totally-nonexistent-agent-xyz',
          taskId: 'task-ghost-1',
        },
      }),
    ).rejects.toThrow('Unknown Station agent: totally-nonexistent-agent-xyz');
  });

  test('passes the registry-aware gate at sendTurn too, not only startSession', async () => {
    // `hasAgent` is awaited independently at `sendTurn` (the second call site
    // this fix widened). Prove the REAL predicate lets a persisted-but-inactive
    // agent PAST the gate there: with a fetch that rejects the turn (409,
    // mirroring the live unresolved-model-connection case), `sendTurn` must
    // fail with the DOWNSTREAM error — not the pre-fix "Unknown Station agent"
    // rejection the widened gate exists to prevent.
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: createRegistryAwareHasAgent(activeAgents, (agentId) =>
        configLoader.loadAgent(agentId),
      ),
      fetch: (async () =>
        new Response(null, { status: 409 })) as unknown as typeof fetch,
      ...approvalDeps(),
    });
    await adapter.startSession({
      threadId: 'task-assistant-send',
      provider: 'station-agent',
      metadata: { agentId: 'assistant', taskId: 'task-assistant-send' },
    });
    await expect(
      adapter.sendTurn({ threadId: 'task-assistant-send', input: 'hello' }),
    ).rejects.toThrow(/did not accept the task turn/);
  });

  test('surfaces the /chat 409 reason for a persisted-but-inactive agent (station#1071)', async () => {
    // The live case that motivated #1049: the agent is real and on disk, but
    // its model connection is unresolved, so /chat answers 409 with the
    // actionable reason. The widened gate lets the turn REACH /chat; #1071 is
    // the second half — that reason must survive to the caller instead of
    // being flattened to the generic rejection.
    const reason = "Agent 'assistant' is not currently launchable.";
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: createRegistryAwareHasAgent(activeAgents, (agentId) =>
        configLoader.loadAgent(agentId),
      ),
      fetch: (async () =>
        new Response(JSON.stringify({ error: reason }), {
          status: 409,
        })) as unknown as typeof fetch,
      ...approvalDeps(),
    });
    await adapter.startSession({
      threadId: 'task-assistant-reason',
      provider: 'station-agent',
      metadata: { agentId: 'assistant', taskId: 'task-assistant-reason' },
    });
    await expect(
      adapter.sendTurn({ threadId: 'task-assistant-reason', input: 'hello' }),
    ).rejects.toThrow(`Station agent did not accept the task turn: ${reason}`);
  });
});
