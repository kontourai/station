/**
 * #2561: usage receipts and their coverage evidence select the same owners a
 * transcript read may open. They used to match one exact owner id, so the
 * usage rollup read with the local operator principal would have dropped every
 * pre-principal chat (owned by the Station's former OS alias) that the same
 * caller can open.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const LEGACY_ALIAS = 'released-os-alias';

describe('usage receipts owner set (#2561)', () => {
  // Created before the store-closing hook, so it removes directories last.
  const makeTempDir = trackTempDirs();
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const step of cleanup.splice(0).reverse()) step();
  });

  function setup(usageThreads?: readonly string[]) {
    const dir = makeTempDir('usage-owner-set-');
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
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
    // Production's personal conversation access (`runtime-initialize.ts`),
    // backed by a real pairing store with no paired devices: the operator is
    // the account's only member.
    const pairingHome = makeTempDir('usage-owner-set-pairing-');
    mkdirSync(join(pairingHome, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir: pairingHome,
      environmentId: '33333333-3333-4333-8333-333333333333',
    });
    const orchestration = new OrchestrationService({
      eventStore: store,
      adoptionLedger: store.createAdoptionLedger(),
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
      legacyPersonalOwner: LEGACY_ALIAS,
      personalConversationAccess: {
        canRead: (requesterId, ownerId) =>
          pairing.canSharePersonalConversation(requesterId, ownerId),
        ownerIds: (requesterId) =>
          pairing.personalConversationOwnerIds(requesterId),
      },
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
    ) as unknown as {
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

  test('without home possession the operator principal still sees the account’s pre-principal chats, through the personal owner set', () => {
    // `personalConversationOwnerIds` names the account's members and the
    // owner set adds the legacy alias for any member, as transcript reads do.
    const orchestration = setup();
    expect(threadsFor(orchestration, false).threads).toEqual([
      'legacy-owned',
      'operator-owned',
    ]);
  });
});
