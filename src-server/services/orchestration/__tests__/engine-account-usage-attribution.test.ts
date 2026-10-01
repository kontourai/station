import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { expect, test } from 'vitest';
import { usageCredentialAccountKey } from '../../../providers/app-home/app-home-profiles.js';
import { EventStore } from '../event-store.js';
import { SessionTranscriptReads } from '../session-transcript-reads.js';

test('persisted receipt attribution follows the applied profile within its process epoch and stays owner scoped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-account-attribution-'));
  const store = new EventStore(join(dir, 'events.sqlite'));
  const owner = 'usage-reader';
  const day = new Date().toISOString().slice(0, 10);
  let ordinal = 0;
  const started = (threadId: string, userId: string, ref?: string | null) =>
    store.appendEvent({
      eventId: `started-${++ordinal}`,
      provider: 'claude',
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      initialState: 'created',
      metadata: {
        userId,
        ...(ref !== undefined
          ? { usageAccountKey: usageCredentialAccountKey('claude', ref) }
          : {}),
      },
    });
  const usage = (threadId: string, turnId: string) =>
    store.appendEvent({
      eventId: `usage-${++ordinal}`,
      provider: 'claude',
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
      method: 'token-usage.updated',
      promptTokens: 10,
      completionTokens: 2,
      reportedCostUsd: 1,
    });
  try {
    started('session', owner, 'work');
    usage('session', 'work-turn');
    // Sparse reconfiguration must retain the applied account for this process.
    store.appendEvent({
      eventId: `config-${++ordinal}`,
      provider: 'claude',
      threadId: 'session',
      sessionId: 'session',
      createdAt: new Date().toISOString(),
      method: 'session.configured',
      model: 'test',
    });
    usage('session', 'sparse-turn');
    started('session', owner, null);
    usage('session', 'default-turn');
    started('session', owner);
    usage('session', 'unknown-turn');
    started('other-owner', 'private-reader', 'work');
    usage('other-owner', 'private-turn');
    const reads = new SessionTranscriptReads({
      canReadSession: () => true,
      isEphemeralSession: () => false,
      sessionAttributionFor: () => null,
      listEventPayloads: () => [],
      listUsageEventRecords: () => [],
      listUsageReceiptEvents: (options) =>
        store.listUsageReceiptEvents(options),
      listUsageCoverageEvents: (options) =>
        store.listUsageCoverageEvents(options),
      searchConversationMessages: () => [],
      readSessionThreadIds: () => [],
      requireTenantExecutionContext: () => false,
      reportDroppedUsageFigure: () => {},
    });
    const result = reads.listUsageReceipts(
      sessionReadAuthorityFromRequest(owner, undefined, undefined),
      'local',
      { from: day, to: day },
    );
    const accounts = new Map(
      result.receipts.map((receipt) => [receipt.turnId, receipt.accountKey]),
    );
    expect(accounts.size).toBe(4);
    expect(accounts.get('work-turn')).toBe(
      usageCredentialAccountKey('claude', 'work'),
    );
    expect(accounts.get('sparse-turn')).toBe(
      usageCredentialAccountKey('claude', 'work'),
    );
    expect(accounts.get('default-turn')).toBe(
      usageCredentialAccountKey('claude', null),
    );
    expect(accounts.get('unknown-turn')).toBeUndefined();
    expect(accounts.has('private-turn')).toBe(false);
    expect(
      result.receipts.filter((receipt) => receipt.turnId === 'work-turn'),
    ).toHaveLength(2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
