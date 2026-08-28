import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { createSessionWorkItemModule } from '../session-work-item-module.js';

const personal = sessionReadAuthorityFromRequest('owner', undefined, undefined);
const hostedAlpha = sessionReadAuthorityFromRequest(
  'owner',
  { tenantId: 'alpha' as any },
  {
    schemaVersion: 1,
    tenants: [{ id: 'alpha' as any, authority: 'alpha.example.test' }],
    authorityToTenant: { 'alpha.example.test': 'alpha' as any },
  },
);
const hostedBeta = sessionReadAuthorityFromRequest(
  'owner',
  { tenantId: 'beta' as any },
  {
    schemaVersion: 1,
    tenants: [
      { id: 'alpha' as any, authority: 'alpha.example.test' },
      { id: 'beta' as any, authority: 'beta.example.test' },
    ],
    authorityToTenant: {
      'alpha.example.test': 'alpha' as any,
      'beta.example.test': 'beta' as any,
    },
  },
);

function observation(overrides: Record<string, unknown> = {}) {
  return {
    version: 'station.session-work-item/v1',
    associationId: 'association-a',
    sessionId: 'session-a',
    conversationId: 'conversation-a',
    eventId: 'event-a',
    turnId: 'turn-a',
    toolCallId: 'call-a',
    relation: 'created',
    provider: { id: 'github', host: 'github.com' },
    workItemRef: 'github:kontourai/station#235',
    repository: { owner: 'kontourai', name: 'station' },
    nativeId: '1234567890',
    observedAt: '2026-08-28T12:00:00.000Z',
    ...overrides,
  };
}

describe('SessionWorkItemModule', () => {
  test('requires exact Session/conversation lineage and never crosses a child Session', () => {
    const list = vi.fn(({ sessionId, conversationId }) =>
      sessionId === 'session-a' && conversationId === 'conversation-a'
        ? [observation()]
        : [],
    );
    const module = createSessionWorkItemModule({
      eventStore: {
        conversationForSession: (sessionId: string) =>
          sessionId === 'session-a'
            ? { sessionId, conversationId: 'conversation-a', ordinal: 0 }
            : sessionId === 'session-child'
              ? {
                  sessionId,
                  conversationId: 'conversation-a',
                  ordinal: 1,
                  predecessorSessionId: 'session-a',
                }
              : undefined,
        listSessionWorkItemObservations: list,
      } as never,
      canReadSession: () => true,
    });
    expect(
      module.read({
        sessionId: 'session-a',
        conversationId: 'conversation-a',
        authority: personal,
        current: () => true,
      }),
    ).toMatchObject({ status: 'found' });
    expect(
      module.read({
        sessionId: 'session-child',
        conversationId: 'conversation-a',
        authority: personal,
        current: () => true,
      }),
    ).toEqual({ status: 'found', projection: expect.any(Object) });
    expect(
      module.read({
        sessionId: 'session-a',
        conversationId: 'conversation-other',
        authority: personal,
        current: () => true,
      }),
    ).toEqual({ status: 'not-found' });
    expect(list).toHaveBeenCalledTimes(2);
  });

  test('fences personal, hosted tenant, and current-principal drift before publication', () => {
    const allow = true;
    let current = true;
    let driftAfterRead = false;
    const canReadSession = vi.fn(
      (_sessionId: string, authority: typeof personal) =>
        allow &&
        (authority.mode === 'personal' ||
          authority.tenantExecutionContext?.tenantId === 'alpha'),
    );
    const module = createSessionWorkItemModule({
      eventStore: {
        conversationForSession: () => ({
          sessionId: 'session-a',
          conversationId: 'conversation-a',
          ordinal: 0,
        }),
        listSessionWorkItemObservations: () => {
          if (driftAfterRead) current = false;
          return [observation()];
        },
      } as never,
      canReadSession,
    });
    expect(
      module.read({
        sessionId: 'session-a',
        conversationId: 'conversation-a',
        authority: personal,
        current: () => current,
      }),
    ).toMatchObject({ status: 'found' });
    expect(
      module.read({
        sessionId: 'session-a',
        conversationId: 'conversation-a',
        authority: hostedAlpha,
        current: () => current,
      }),
    ).toMatchObject({ status: 'found' });
    expect(
      module.read({
        sessionId: 'session-a',
        conversationId: 'conversation-a',
        authority: hostedBeta,
        current: () => current,
      }),
    ).toEqual({ status: 'not-found' });
    driftAfterRead = true;
    expect(
      module.read({
        sessionId: 'session-a',
        conversationId: 'conversation-a',
        authority: personal,
        current: () => current,
      }),
    ).toEqual({ status: 'not-found' });
    expect(canReadSession).toHaveBeenCalled();
  });

  test('quarantines corrupt observation data without exposing it', () => {
    const module = createSessionWorkItemModule({
      eventStore: {
        conversationForSession: () => ({
          sessionId: 'session-a',
          conversationId: 'conversation-a',
          ordinal: 0,
        }),
        listSessionWorkItemObservations: () => [{ rawResult: 'do not leak' }],
      } as never,
      canReadSession: () => true,
    });
    expect(
      module.read({
        sessionId: 'session-a',
        conversationId: 'conversation-a',
        authority: personal,
        current: () => true,
      }),
    ).toEqual({ status: 'unavailable' });
  });

  test('fails closed when initial principal, ACL, or lineage callbacks throw', () => {
    const module = createSessionWorkItemModule({
      eventStore: {
        conversationForSession: () => {
          throw new Error('lineage unavailable');
        },
        listSessionWorkItemObservations: () => [observation()],
      } as never,
      canReadSession: () => {
        throw new Error('principal drift');
      },
    });
    expect(
      module.read({
        sessionId: 'session-a',
        conversationId: 'conversation-a',
        authority: personal,
        current: () => true,
      }),
    ).toEqual({ status: 'unavailable' });
  });
});
