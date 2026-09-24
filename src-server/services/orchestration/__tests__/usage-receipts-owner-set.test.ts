/**
 * #2561: usage receipts and their coverage evidence select the same owners a
 * transcript read may open. They used to match one exact owner id, so the
 * usage rollup read with the local operator principal would have dropped every
 * pre-principal chat (owned by the Station's former OS alias) that the same
 * caller can open.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const LEGACY_ALIAS = 'released-os-alias';

describe('usage receipts owner set (#2561)', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const step of cleanup.splice(0).reverse()) step();
  });

  function setup(usageThreads?: readonly string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'usage-owner-set-'));
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanup.push(() => store.close());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'));
    for (const [threadId, owner] of [
      ['operator-owned', LOCAL_OPERATOR_PRINCIPAL_ID],
      ['legacy-owned', LEGACY_ALIAS],
      ['someone-else', 'human:tailscale-serve:someone@example'],
    ] as const) {
      store.appendEvent({
        eventId: `${threadId}:start`,
        threadId,
        sessionId: threadId,
        provider: 'claude',
        method: 'session.started',
        createdAt: '2026-09-04T00:00:00.000Z',
        metadata: { userId: owner },
      } as never);
      if (usageThreads && !usageThreads.includes(threadId)) continue;
      store.appendEvent({
        eventId: `${threadId}:usage`,
        threadId,
        turnId: `${threadId}:turn`,
        provider: 'claude',
        method: 'token-usage.updated',
        createdAt: '2026-09-04T00:00:01.000Z',
        promptTokens: 1,
      } as never);
    }
    vi.useRealTimers();
    const orchestration = new OrchestrationService({
      eventStore: store,
      adoptionLedger: store.createAdoptionLedger(),
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
      legacyPersonalOwner: LEGACY_ALIAS,
    });
    return orchestration;
  }

  const threadsFor = (
    orchestration: OrchestrationService,
    localHomePossession: boolean,
  ) => {
    const result = orchestration.listUsageReceipts(
      sessionReadAuthorityFromRequest(
        LOCAL_OPERATOR_PRINCIPAL_ID,
        undefined,
        undefined,
        localHomePossession ? { localHomePossession: true } : undefined,
      ),
      'local',
      { from: '2026-09-01', to: '2026-09-07' },
    ) as {
      receipts: Array<{ threadId: string }>;
      coverage: { state: string };
    };
    return {
      threads: [...new Set(result.receipts.map((r) => r.threadId))].sort(),
      coverage: result.coverage.state,
    };
  };

  test('the home-possession operator sees its own and its pre-principal chats, never another person’s', () => {
    const orchestration = setup();
    const read = threadsFor(orchestration, true);
    expect(read.threads).toEqual(['legacy-owned', 'operator-owned']);
    expect(read.coverage).not.toBe('unknown');
  });

  test('coverage evidence comes from the same owners as the receipts', () => {
    // Only the pre-principal chat has usage. Coverage selected by the
    // operator id alone would find no observations and report `unknown`
    // beside a receipt the same read returned.
    const orchestration = setup(['legacy-owned']);
    const read = threadsFor(orchestration, true);
    expect(read.threads).toEqual(['legacy-owned']);
    expect(read.coverage).not.toBe('unknown');
  });

  test('without home possession the operator principal sees only its own chats', () => {
    const orchestration = setup();
    expect(threadsFor(orchestration, false).threads).toEqual([
      'operator-owned',
    ]);
  });
});
