import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { ANSWER_SHARE_RESTRICTED_REASON } from '@kontourai/station-shared/answer-share-projection';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnswerShareService,
  NO_CHANNEL_LOG_OBSERVER,
} from '../answer-share-service.js';
import { AnswerShareStore } from '../answer-share-store.js';

/**
 * The state ladder and the re-applied authorization (archive#1423), proven
 * without an HTTP layer. Every assertion here is about what a share HOLDER is
 * told — the population the whole feature exists to be honest to.
 */

const homes: string[] = [];
const observation = [{ eventId: 'e1', method: 'turn.completed' as const }];

function envelope() {
  return {
    envelopeVersion: 1,
    sessionId: 'thread-1',
    turnId: 'turn-1',
    outcome: 'completed',
    observedAt: '2026-08-01T00:00:00.000Z',
    engine: {
      state: 'observed',
      value: { provider: 'claude' },
      observedFrom: observation,
    },
    requestedModel: {
      state: 'observed',
      value: 'sonnet-x',
      observedFrom: observation,
    },
    reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
    tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
    usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
    routingReceipt: { state: 'unavailable', reason: 'not-captured-by-station' },
    sources: { state: 'unavailable', reason: 'not-captured-by-station' },
    trustReport: {
      state: 'referenced',
      ref: {
        kind: 'surface-trust-bundle',
        projectSlug: 'private-client',
        bundleId: 'bundle-42',
      },
      observedFrom: observation,
    },
  };
}

function messages(): ConversationMessage[] {
  return [
    { id: 'm0', role: 'user', parts: [{ type: 'text', text: 'Ask.' }] },
    {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'The shared answer.' },
        { type: 'tool-call', toolName: 'shell', result: 'SECRET-OUTPUT' },
      ],
      metadata: {
        turnId: 'turn-1',
        provenance: envelope() as never,
      },
    },
    {
      id: 'm2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'A LATER, UNSHARED answer.' }],
      metadata: { turnId: 'turn-2' },
    },
  ];
}

function harness(
  options: {
    now?: () => number;
    readSessionMessages?: (
      threadId: string,
      authority: SessionReadAuthority,
    ) => readonly ConversationMessage[];
    canUserReadSession?: (
      threadId: string,
      authority: SessionReadAuthority,
    ) => boolean;
  } = {},
) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-share-service-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const store = new AnswerShareStore({ homeDir, now: options.now });
  const readSessionMessages = vi.fn(
    options.readSessionMessages ?? (() => messages()),
  );
  return {
    store,
    readSessionMessages,
    service: new AnswerShareService({
      store,
      sessions: {
        readSessionMessages,
        canUserReadSession: options.canUserReadSession,
      },
      now: options.now,
      channelObserver: NO_CHANNEL_LOG_OBSERVER,
    }),
  };
}

async function mint(service: AnswerShareService, overrides: object = {}) {
  const result = await service.mint({
    sessionId: 'thread-1',
    turnId: 'turn-1',
    ...overrides,
  });
  if ('error' in result) throw new Error('expected a mint');
  return result;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('AnswerShareService.mint', () => {
  it('returns the token and NO server-derived origin or permalink', async () => {
    const { service } = harness();
    const result = await mint(service);

    // H-2. The server cannot know the origin the operator's browser is on:
    // the UI proxy rewrites `Host` to the backend, which serves neither the
    // SPA nor the `/share` route, so any origin composed here yields a link
    // that looks right and is dead. The client composes it from
    // `window.location.origin` instead.
    expect(result).toEqual({
      share: expect.objectContaining({ id: expect.any(String) }),
      token: expect.any(String),
    });
    expect(Object.keys(result).sort()).toEqual(['share', 'token']);
    expect(JSON.stringify(result)).not.toContain('http');
  });

  it('refuses to mint a permalink to a turn that has no answer', async () => {
    const { service } = harness();
    expect(
      await service.mint({ sessionId: 'thread-1', turnId: 'nope' }),
    ).toEqual({
      error: 'answer-not-found',
    });
    expect(service.list()).toHaveLength(0);
  });
});

describe('AnswerShareService management authorization', () => {
  it('filters hosted lists and refuses bravo or missing authority before revocation', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.example.test' },
        { id: 'bravo', authority: 'bravo.example.test' },
      ],
    });
    const alpha = sessionReadAuthorityFromRequest(
      'shared-user',
      { tenantId: registry.tenants[0].id },
      registry,
    );
    const bravo = sessionReadAuthorityFromRequest(
      'shared-user',
      { tenantId: registry.tenants[1].id },
      registry,
    );
    const missing = sessionReadAuthorityFromRequest(
      'shared-user',
      undefined,
      registry,
    );
    const { service, store } = harness({
      canUserReadSession: (_threadId, authority) =>
        authority.tenantExecutionContext?.tenantId === 'alpha',
    });
    const minted = await service.mint(
      { sessionId: 'thread-1', turnId: 'turn-1', ownerUserId: 'shared-user' },
      alpha,
    );
    if ('error' in minted) throw new Error('expected alpha mint');
    const revoke = vi.spyOn(store, 'revoke');

    expect(service.list(alpha)).toHaveLength(1);
    expect(service.list(bravo)).toEqual([]);
    expect(service.list(missing)).toEqual([]);
    for (const authority of [bravo, missing]) {
      await expect(service.revoke(minted.share.id, authority)).rejects.toThrow(
        'Share not found',
      );
    }
    expect(revoke).not.toHaveBeenCalled();
    expect(await service.revoke(minted.share.id, alpha)).toMatchObject({
      id: minted.share.id,
      state: 'revoked',
    });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe('AnswerShareService.view', () => {
  it('serves the shared answer and its re-projected envelope', async () => {
    const { service } = harness();
    const result = service.view((await mint(service)).token);

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.answer.blocks).toEqual([
      { type: 'text', text: 'The shared answer.' },
    ]);
    expect(result.answer.turnId).toBe('turn-1');
    expect(result.answer.omittedBlocks).toBe(0);
  });

  it('re-applies authorization to the trust-report reference and names the gap', async () => {
    const { service } = harness();
    const result = service.view((await mint(service)).token);
    if (result.state !== 'ok') throw new Error('expected ok');

    expect(result.provenance).toMatchObject({
      trustReport: {
        state: 'unavailable',
        reason: ANSWER_SHARE_RESTRICTED_REASON,
      },
    });
    // The named gap is only half the requirement — nothing about the
    // restricted artifact may travel with it.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-client');
    expect(serialized).not.toContain('bundle-42');
  });

  it('carries no tool output, tool arguments, or token into the payload', async () => {
    const { service } = harness();
    const minted = await mint(service);
    const serialized = JSON.stringify(service.view(minted.token));
    for (const forbidden of ['SECRET-OUTPUT', 'shell', minted.token]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('serves the SHARED turn, never a later answer in the same session', async () => {
    const { service } = harness();
    const result = service.view((await mint(service)).token);
    expect(JSON.stringify(result)).not.toContain('UNSHARED');
  });

  it.each([
    ['an unknown token', 'z'.repeat(43)],
    ['a malformed token', '!!!'],
    ['an empty token', ''],
  ])(
    'refuses %s with the single share-not-found state',
    async (_label, token) => {
      const { service } = harness();
      await mint(service);
      // Identical objects, not merely identical reasons: a prober must not be
      // able to tell these three apart by any field.
      expect(service.view(token)).toEqual({
        state: 'refused',
        reason: 'share-not-found',
      });
    },
  );

  it('tells a token holder that their share was revoked, and when', async () => {
    let clock = Date.parse('2026-08-01T00:00:00.000Z');
    const { service, store } = harness({ now: () => clock });
    const minted = await mint(service);
    clock += 60_000;
    await store.revoke(minted.share.id);

    expect(service.view(minted.token)).toEqual({
      state: 'refused',
      reason: 'share-revoked',
      revokedAt: '2026-08-01T00:01:00.000Z',
    });
  });

  it('tells a token holder that their share expired, and when', async () => {
    let clock = Date.parse('2026-08-01T00:00:00.000Z');
    const { service } = harness({ now: () => clock });
    const minted = await mint(service);
    clock += 8 * 24 * 60 * 60 * 1000;

    expect(service.view(minted.token)).toEqual({
      state: 'refused',
      reason: 'share-expired',
      expiresAt: minted.share.expiresAt,
    });
  });

  it('distinguishes an answer that went away from a share that was turned off', async () => {
    const { service, readSessionMessages } = harness();
    const minted = await mint(service);
    // The session still has OTHER assistant answers — this is the case where
    // a positional or "newest assistant message" fallback would quietly serve
    // a DIFFERENT answer under a link the operator minted for turn-1. The
    // only honest answer is that this one is gone.
    readSessionMessages.mockReturnValue([
      {
        id: 'm9',
        role: 'assistant',
        parts: [{ type: 'text', text: 'A DIFFERENT answer entirely.' }],
        metadata: { turnId: 'turn-99' },
      },
    ]);

    const result = service.view(minted.token);
    expect(result).toEqual({
      state: 'refused',
      reason: 'answer-no-longer-available',
    });
    expect(JSON.stringify(result)).not.toContain('A DIFFERENT answer');
  });

  it('refuses rather than substituting when the session has no answers at all', async () => {
    const { service, readSessionMessages } = harness();
    const minted = await mint(service);
    readSessionMessages.mockReturnValue([]);

    expect(service.view(minted.token)).toEqual({
      state: 'refused',
      reason: 'answer-no-longer-available',
    });
  });

  it('reports a session the reader refuses to open as unavailable rather than throwing', async () => {
    const { service, readSessionMessages } = harness();
    const minted = await mint(service);
    readSessionMessages.mockImplementation(() => {
      throw new Error('not your session');
    });

    expect(service.view(minted.token)).toEqual({
      state: 'refused',
      reason: 'answer-no-longer-available',
    });
  });

  it('re-reads the answer as the SHARER, so a share cannot outlive their own access', async () => {
    const { service, readSessionMessages } = harness();
    await mint(service, { ownerUserId: 'operator-1' });
    readSessionMessages.mockClear();
    service.view((await mint(service, { ownerUserId: 'operator-1' })).token);

    expect(readSessionMessages).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ userId: 'operator-1', mode: 'personal' }),
    );
  });

  it('does not let bravo dereference an alpha-hosted answer share', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.example.test' },
        { id: 'bravo', authority: 'bravo.example.test' },
      ],
    });
    const alpha = sessionReadAuthorityFromRequest(
      'alpha',
      { tenantId: registry.tenants[0].id },
      registry,
    );
    const bravo = sessionReadAuthorityFromRequest(
      'bravo',
      { tenantId: registry.tenants[1].id },
      registry,
    );
    const { service } = harness({
      readSessionMessages: (_threadId, authority) =>
        authority?.tenantExecutionContext?.tenantId === 'alpha'
          ? messages()
          : [],
    });
    const minted = await service.mint(
      { sessionId: 'thread-1', turnId: 'turn-1', ownerUserId: 'alpha' },
      alpha,
    );
    if ('error' in minted) throw new Error('expected alpha mint');

    expect(service.view(minted.token, bravo)).toEqual({
      state: 'refused',
      reason: 'answer-no-longer-available',
    });
  });

  it.each([
    ['no envelope at all', undefined],
    ['an envelope version this build cannot read', { envelopeVersion: 99 }],
    ['a truncated envelope', { envelopeVersion: 1, sessionId: 'thread-1' }],
    ['a non-object envelope', 'not-an-envelope'],
  ])(
    'omits provenance rather than forwarding %s to an unauthenticated viewer',
    async (_label, provenance) => {
      const { service } = harness({
        readSessionMessages: () => [
          {
            id: 'm1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Answer.' }],
            metadata: { turnId: 'turn-1', provenance: provenance as never },
          },
        ],
      });
      const result = service.view((await mint(service)).token);
      if (result.state !== 'ok') throw new Error('expected ok');
      expect(result.provenance).toBeUndefined();
      // The answer itself still renders — an unreadable envelope never takes
      // the shared answer down with it.
      expect(result.answer.blocks).toEqual([{ type: 'text', text: 'Answer.' }]);
    },
  );
});
