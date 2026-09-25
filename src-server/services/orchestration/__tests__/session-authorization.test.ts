import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { SessionAuthorization } from '../session-authorization.js';

function authorization(owner: string | undefined) {
  return new SessionAuthorization({
    eventStore: {
      findSessionOwnerUserId: () => owner,
    } as never,
    personalConversationAccess: {
      // Every member of the personal account may read the operator's rows.
      canRead: (_requester, ownerId) => ownerId === LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerIds: () => [LOCAL_OPERATOR_PRINCIPAL_ID],
    },
  });
}

describe('SessionAuthorization refuses every ownerless session (#2567)', () => {
  // No owner is recorded for an unknown or made-up id either, so this is
  // also the refusal of a guessed id.
  test.each([
    ['the local operator', LOCAL_OPERATOR_PRINCIPAL_ID, { localHome: true }],
    ['the operator credential', LOCAL_OPERATOR_PRINCIPAL_ID, {}],
    ['a paired device', 'human:device:phone', {}],
    ['a WhoIs identity', 'human:tailscale-serve:owner@github', {}],
  ] as const)('%s cannot read or command it', (_label, userId, options) => {
    const authz = authorization(undefined);
    const authority = sessionReadAuthorityFromRequest(
      userId,
      undefined,
      undefined,
      'localHome' in options ? { localHomePossession: true } : undefined,
    );
    expect(authz.canReadSession('made-up-id', authority)).toBe(false);
    expect(
      authz.canReadSessionForCommand('made-up-id', userId, undefined),
    ).toBe(false);
    // It has no one to notify, either.
    expect(authz.resolveSessionPresenceSubject('made-up-id')).toBeUndefined();
  });

  test('an internal command (no caller) keeps its reach', () => {
    expect(
      authorization(undefined).canReadSessionForCommand(
        'made-up-id',
        undefined,
        undefined,
      ),
    ).toBe(true);
  });

  test('an owned session is still read by its owner and account members', () => {
    const authz = authorization(LOCAL_OPERATOR_PRINCIPAL_ID);
    for (const userId of [LOCAL_OPERATOR_PRINCIPAL_ID, 'human:device:phone']) {
      expect(
        authz.canReadSession(
          'owned',
          sessionReadAuthorityFromRequest(userId, undefined, undefined),
        ),
      ).toBe(true);
    }
  });
});

describe('SessionAuthorization has no OS-alias owner bridge', () => {
  // A row whose recorded owner is this Station's former OS alias names no
  // principal. It used to be readable by a home-possession operator (#749);
  // with the bridge gone it is readable by no caller, however local.
  test('an alias-owned row is unreadable even by the home-possession operator', () => {
    const authz = authorization('released-os-alias');
    const localHome = sessionReadAuthorityFromRequest(
      LOCAL_OPERATOR_PRINCIPAL_ID,
      undefined,
      undefined,
      { localHomePossession: true },
    );
    expect(authz.canReadSession('released', localHome)).toBe(false);
    expect(
      authz.canReadSessionForCommand(
        'released',
        LOCAL_OPERATOR_PRINCIPAL_ID,
        undefined,
      ),
    ).toBe(false);
    // An alias is only its own literal id: a caller naming it is not a
    // principal the store could have recorded, and it gains nothing either.
    expect(
      authz.canReadSession(
        'released',
        sessionReadAuthorityFromRequest('paired-device', undefined, undefined),
      ),
    ).toBe(false);
    // The owner-narrowed store reads carry no alias either.
    expect(authz.transcriptOwnerConstraint(localHome)).toEqual({
      ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerUserIds: [LOCAL_OPERATOR_PRINCIPAL_ID],
    });
  });

  test('does not leak ownerless sessions across hosted callers', () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: tenantId('tenant'), authority: 'tenant.example.test' }],
    });
    const hosted = sessionReadAuthorityFromRequest(
      LOCAL_OPERATOR_PRINCIPAL_ID,
      { tenantId: tenantId('tenant') },
      registry,
    );
    expect(authorization('released-os-alias').canReadSession('x', hosted)).toBe(
      false,
    );
    expect(authorization(undefined).canReadSession('ownerless', hosted)).toBe(
      false,
    );
  });
});

test('personal sharing applies consistently to direct reads and transcript owner constraints', () => {
  const canRead = vi.fn(
    (requester: string, owner: string) =>
      requester === 'phone' &&
      ['desktop', LOCAL_OPERATOR_PRINCIPAL_ID].includes(owner),
  );
  const authz = new SessionAuthorization({
    eventStore: { findSessionOwnerUserId: () => 'desktop' } as never,
    personalConversationAccess: {
      canRead,
      ownerIds: (id) =>
        id === 'phone'
          ? ['phone', 'desktop', LOCAL_OPERATOR_PRINCIPAL_ID]
          : undefined,
    },
  });
  const phone = sessionReadAuthorityFromRequest('phone', undefined, undefined);
  expect(authz.canReadSession('conversation', phone)).toBe(true);
  expect(
    authz.canReadSessionForCommand('conversation', 'phone', undefined),
  ).toBe(true);
  expect(
    authz.canReadSessionForCommand('conversation', 'stranger', undefined),
  ).toBe(false);
  expect(authz.transcriptOwnerConstraint(phone).ownerUserIds).toEqual([
    'phone',
    'desktop',
    LOCAL_OPERATOR_PRINCIPAL_ID,
  ]);
  expect(
    authz.canReadSession('conversation', {
      userId: 'phone',
      mode: 'personal',
    } as never),
  ).toBe(false);
  expect(
    authz.transcriptOwnerConstraint({
      userId: 'phone',
      mode: 'personal',
    } as never).ownerUserIds,
  ).toBeUndefined();
});

test('hosted reads never consult the personal sharing policy', () => {
  const canRead = vi.fn(() => true);
  const ownerIds = vi.fn(() => ['anyone']);
  const authz = new SessionAuthorization({
    requireTenantExecutionContext: () => true,
    eventStore: {
      findSessionOwnerUserId: () => 'different-owner',
      readSessions: () => [],
    } as never,
    personalConversationAccess: { canRead, ownerIds },
  });
  const registry = parseHostedTenantRegistry({
    schemaVersion: 1,
    tenants: [{ id: tenantId('tenant'), authority: 'tenant.example.test' }],
  });
  const authority = sessionReadAuthorityFromRequest(
    'reader',
    { tenantId: tenantId('tenant') },
    registry,
  );
  expect(authz.canReadSession('conversation', authority)).toBe(false);
  expect(
    authz.canReadSessionForCommand('conversation', 'reader', undefined),
  ).toBe(false);
  expect(
    authz.transcriptOwnerConstraint(authority).ownerUserIds,
  ).toBeUndefined();
  expect(canRead).not.toHaveBeenCalled();
  expect(ownerIds).not.toHaveBeenCalled();
});

describe('SessionAuthorization.sessionActingPrincipal (Station #90 lane D)', () => {
  function actingPrincipal(
    owner: string | undefined,
    options: { hosted?: boolean } = {},
  ) {
    return new SessionAuthorization({
      eventStore: {
        findSessionOwnerAttribution: () => ({
          ...(owner ? { ownerUserId: owner } : {}),
          unattributedAgent: false,
        }),
      } as never,
      requireTenantExecutionContext: () => options.hosted === true,
    }).sessionActingPrincipal('thread');
  }

  test('reads the recorded owner, and never infers one', () => {
    expect(actingPrincipal('human:test:alice')).toEqual({
      id: 'human:test:alice',
      source: 'session-owner',
    });
    // No alias bridge: an alias-owned row acts for its literal owner, which
    // is not the local operator.
    expect(actingPrincipal('released-os-alias')).toEqual({
      id: 'released-os-alias',
      source: 'session-owner',
    });
    // An ownerless session acts for no one: nothing maps it to the local
    // operator any more.
    expect(actingPrincipal(undefined)).toBeUndefined();
  });

  test('a session an agent started without a verified principal acts for no one, whatever owner it records (B2)', () => {
    const authz = (unattributedAgent: boolean) =>
      new SessionAuthorization({
        eventStore: {
          findSessionOwnerAttribution: () => ({
            ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
            unattributedAgent,
          }),
        } as never,
      }).sessionActingPrincipal('child');
    expect(authz(true)).toBeUndefined();
    expect(authz(false)).toEqual({
      id: LOCAL_OPERATOR_PRINCIPAL_ID,
      source: 'session-owner',
    });
  });

  test('an ownerless session acts for no one on a hosted host either', () => {
    expect(actingPrincipal(undefined, { hosted: true })).toBeUndefined();
    expect(actingPrincipal('human:test:alice', { hosted: true })).toEqual({
      id: 'human:test:alice',
      source: 'session-owner',
    });
  });
});
