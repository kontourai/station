import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
function readerFixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-open-execution-'));
  const store = new EventStore(join(home, 'events.sqlite'));
  const adapter = new GateTestAdapter();
  vi.spyOn(adapter, 'hasSession').mockResolvedValue(true);
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  cleanup.push(async () => {
    await service.shutdown();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { store, service };
}

test('opening a durable conversation observes its current Claude child and recorded connection after a Codex handoff', async () => {
  const { store, service } = readerFixture();
  const root = 'durable-codex-conversation',
    child = 'claude-current-child';
  store.upsertSession({
    threadId: root,
    provider: 'codex',
    status: 'closed',
    model: 'gpt-predecessor',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:01:00Z',
  });
  store.appendEvent({
    eventId: 'root-configured',
    threadId: root,
    sessionId: root,
    provider: 'codex',
    method: 'session.configured',
    metadata: {
      userId: 'owner',
      agentSlug: 'codex-agent',
      projectSlug: 'original-project',
    },
    createdAt: '2026-09-01T00:00:01Z',
  });
  store.reserveConversationHandoff({
    conversationId: root,
    predecessorSessionId: root,
    sessionId: child,
    idempotencyKey: 'other-client-handoff',
    targetAgentId: 'claude-agent',
    targetEnvironmentId: 'current-environment',
    targetConnectionId: 'claude-connection',
    messageDigest: 'controlled-handoff',
    createdAt: '2026-09-01T00:02:00Z',
  });
  store.upsertSession({
    threadId: child,
    provider: 'claude',
    status: 'ready',
    model: 'opus-current',
    createdAt: '2026-09-01T00:02:00Z',
    updatedAt: '2026-09-01T00:03:00Z',
  });
  store.appendEvent({
    eventId: 'child-started',
    threadId: child,
    sessionId: child,
    provider: 'claude',
    method: 'session.started',
    model: 'opus-current',
    metadata: {
      userId: 'owner',
      agentSlug: 'claude-agent',
      projectSlug: 'original-project',
      connectionId: 'claude-connection',
    },
    createdAt: '2026-09-01T00:02:01Z',
  });
  const result = await service.resolveConversationOpen(
    root,
    sessionReadAuthorityFromRequest('owner', undefined, undefined),
  );
  expect(result).toMatchObject({
    status: 'resolved',
    currentSessionId: child,
    conversation: {
      agentSlug: 'claude-agent',
      projectSlug: 'original-project',
    },
    execution: {
      sessionId: child,
      agentId: 'claude-agent',
      provider: 'claude',
      engineConnectionId: 'claude-connection',
      model: 'opus-current',
    },
  });
  expect(JSON.stringify(result)).not.toContain('resumeCursor');
  await expect(
    service.resolveConversationOpen(
      root,
      sessionReadAuthorityFromRequest('other-user', undefined, undefined),
    ),
  ).resolves.toBeNull();
});

test('an initial native launch plan is not relabeled as current model-connection evidence', async () => {
  const { store, service } = readerFixture();
  const threadId = 'native-conversation';
  store.upsertSession({
    threadId,
    provider: 'station-agent',
    status: 'ready',
    model: 'native-model',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:01:00Z',
  });
  store.appendEvent({
    eventId: 'native-start',
    threadId,
    sessionId: threadId,
    provider: 'station-agent',
    method: 'session.started',
    metadata: {
      userId: 'owner',
      agentSlug: 'station',
      modelLaunchPlan: {
        kind: 'station-resolved',
        evidence: 'catalog-accepted',
        modelConnectionId: 'native-model-connection',
        modelId: 'native-model',
      },
    },
    createdAt: '2026-09-01T00:00:01Z',
  });
  const authority = sessionReadAuthorityFromRequest(
    'owner',
    undefined,
    undefined,
  );
  const accepted = await service.resolveConversationOpen(threadId, authority);
  expect(accepted).toMatchObject({
    status: 'resolved',
    execution: {
      provider: 'station-agent',
    },
  });
  if (accepted?.status === 'resolved')
    expect(accepted.execution).not.toHaveProperty('modelConnectionId');
  store.appendEvent({
    eventId: 'native-pending',
    threadId,
    sessionId: threadId,
    provider: 'station-agent',
    method: 'session.configured',
    metadata: {
      userId: 'owner',
      agentSlug: 'station',
      modelLaunchPlan: {
        kind: 'station-resolved',
        evidence: 'catalog-pending',
        modelConnectionId: 'unaccepted-connection',
        modelId: 'other-model',
      },
    },
    createdAt: '2026-09-01T00:00:02Z',
  });
  const pending = await service.resolveConversationOpen(threadId, authority);
  expect(pending?.status).toBe('resolved');
  if (pending?.status === 'resolved')
    expect(pending.execution).not.toHaveProperty('modelConnectionId');
});
