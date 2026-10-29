import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import {
  INTERNAL_TURN_CORRELATION_HEADER,
  readMcpPromptOriginRelay,
} from '../../../runtime/conversation/authorized-turn-correlation.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

test('an admitted prompt origin reaches the exact Station-agent relay', async () => {
  const home = mkdtempSync(join(tmpdir(), 'station-prompt-origin-'));
  const eventBus = new EventBus();
  const eventStore = new EventStore(join(home, 'events.sqlite'));
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );
  const adapter = new StationAgentAdapter({
    apiBase: 'http://127.0.0.1:14386',
    hasAgent: () => true,
    eventBus,
    approvalRegistry: new ApprovalRegistry(
      { info: vi.fn(), warn: vi.fn() },
      { eventBus },
    ),
    fetch: fetchMock,
  });
  const registry = {
    register() {},
    get: (provider: string) =>
      provider === 'station-agent' ? adapter : undefined,
    list: () => [adapter],
  };
  const service = new OrchestrationService({
    adapterRegistry: registry,
    eventBus,
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  try {
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: 'session',
          provider: 'station-agent',
          cwd: home,
          metadata: { agentId: 'reviewer', agentSlug: 'reviewer' },
        },
      },
      { userId: 'account-a' },
      {
        conversationIdentity: {
          conversationId: 'session',
          environmentId: 'local-environment',
        },
      },
    );
    eventStore.appendEvent({
      eventId: 'owner',
      provider: 'station-agent',
      threadId: 'session',
      createdAt: new Date().toISOString(),
      method: 'session.configured',
      sessionId: 'session',
      metadata: { userId: 'account-a', agentId: 'reviewer' },
    } as CanonicalRuntimeEvent);
    await service.dispatch(
      {
        type: 'sendTurn',
        input: {
          threadId: 'session',
          input: 'MCP prompt text',
          clientTurnId: 'client-turn',
        },
      },
      { userId: 'account-a' },
      {
        nativeMemoryReadAuthority: sessionReadAuthorityFromRequest(
          'account-a',
          undefined,
          undefined,
        ),
        mcpPromptOrigin: {
          serverId: 'mail',
          name: 'summarize',
          untrusted: true,
        },
      },
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(
      readMcpPromptOriginRelay(headers[INTERNAL_TURN_CORRELATION_HEADER]),
    ).toEqual({ serverId: 'mail', name: 'summarize', untrusted: true });
  } finally {
    await service.shutdown();
    eventStore.close();
    rmSync(home, { recursive: true, force: true });
  }
});
