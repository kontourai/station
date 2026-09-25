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
    legacyPersonalOwner: 'released-os-alias',
    ownerlessSessionAccess: 'deny',
  });
}

describe('SessionAuthorization legacy personal-owner bridge (#749)', () => {
  test('admits only the local operator with Station-home possession', () => {
    const authz = authorization('released-os-alias');
    const localHome = sessionReadAuthorityFromRequest(
      LOCAL_OPERATOR_PRINCIPAL_ID,
      undefined,
      undefined,
      { localHomePossession: true },
    );

    expect(authz.canReadSession('released', localHome)).toBe(true);
    // An operator credential is not evidence that this request owns this
    // Station home, and a paired/WhoIs identity never gets that provenance.
    expect(
      authz.canReadSession(
        'released',
        sessionReadAuthorityFromRequest(
          LOCAL_OPERATOR_PRINCIPAL_ID,
          undefined,
          undefined,
        ),
      ),
    ).toBe(false);
    expect(
      authz.canReadSession(
        'released',
        sessionReadAuthorityFromRequest('paired-device', undefined, undefined),
      ),
    ).toBe(false);
    expect(
      authz.canReadSession(
        'released',
        sessionReadAuthorityFromRequest('whois:operator', undefined, undefined),
      ),
    ).toBe(false);
    expect(
      authz.canReadSession(
        'released',
        sessionReadAuthorityFromRequest(
          'released-os-alias',
          undefined,
          undefined,
        ),
      ),
    ).toBe(false);
  });

  test('does not leak legacy or ownerless sessions across hosted/guessed callers', () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: tenantId('tenant'), authority: 'tenant.example.test' }],
    });
    const hosted = sessionReadAuthorityFromRequest(
      LOCAL_OPERATOR_PRINCIPAL_ID,
      { tenantId: tenantId('tenant') },
      registry,
    );
    const legacy = authorization('released-os-alias');
    expect(legacy.canReadSession('released', hosted)).toBe(false);
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
    ownerlessSessionAccess: 'deny',
    legacyPersonalOwner: 'old-owner',
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
    'old-owner',
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

test('personal sharing admits a member to legacy OS-alias sessions as the operator’s history, and nobody else (#2611)', () => {
  // Pinned so the policy and the bridge's doc cannot drift apart again: the
  // sharing check judges the alias as the local operator, before the bridge.
  const canRead = vi.fn(
    (requester: string, owner: string) =>
      requester === 'phone' && owner === LOCAL_OPERATOR_PRINCIPAL_ID,
  );
  const withSharing = new SessionAuthorization({
    eventStore: { findSessionOwnerUserId: () => 'released-os-alias' } as never,
    ownerlessSessionAccess: 'deny',
    legacyPersonalOwner: 'released-os-alias',
    personalConversationAccess: { canRead, ownerIds: () => undefined },
  });
  const phone = sessionReadAuthorityFromRequest('phone', undefined, undefined);
  const stranger = sessionReadAuthorityFromRequest(
    'stranger',
    undefined,
    undefined,
  );
  expect(withSharing.canReadSession('released', phone)).toBe(true);
  expect(canRead).toHaveBeenCalledWith('phone', LOCAL_OPERATOR_PRINCIPAL_ID);
  expect(withSharing.canReadSession('released', stranger)).toBe(false);
  // Without a sharing policy the bridge is the whole rule: a paired device is
  // refused (see the bridge test above).
  expect(
    authorization('released-os-alias').canReadSession('released', phone),
  ).toBe(false);
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
    options: {
      ownerless?: 'deny' | 'single-user-compat';
      hosted?: boolean;
    } = {},
  ) {
    return new SessionAuthorization({
      eventStore: {
        findSessionOwnerAttribution: () => ({
          ...(owner ? { ownerUserId: owner } : {}),
          unattributedAgent: false,
        }),
      } as never,
      legacyPersonalOwner: 'released-os-alias',
      ownerlessSessionAccess: options.ownerless ?? 'single-user-compat',
      requireTenantExecutionContext: () => options.hosted === true,
    }).sessionActingPrincipal('thread');
  }

  test('reads the recorded owner, and names how an operator mapping was derived', () => {
    expect(actingPrincipal('human:test:alice')).toEqual({
      id: 'human:test:alice',
      source: 'session-owner',
    });
    expect(actingPrincipal('released-os-alias')).toEqual({
      id: LOCAL_OPERATOR_PRINCIPAL_ID,
      source: 'legacy-personal-owner',
    });
    expect(actingPrincipal(undefined)).toEqual({
      id: LOCAL_OPERATOR_PRINCIPAL_ID,
      source: 'ownerless-single-operator',
    });
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
        ownerlessSessionAccess: 'single-user-compat',
      }).sessionActingPrincipal('child');
    expect(authz(true)).toBeUndefined();
    expect(authz(false)).toEqual({
      id: LOCAL_OPERATOR_PRINCIPAL_ID,
      source: 'session-owner',
    });
  });

  test('an ownerless session acts for no one on a deny or hosted host, and a legacy alias never maps in hosted mode', () => {
    expect(actingPrincipal(undefined, { ownerless: 'deny' })).toBeUndefined();
    expect(actingPrincipal(undefined, { hosted: true })).toBeUndefined();
    expect(
      actingPrincipal('released-os-alias', { hosted: true }),
    ).toBeUndefined();
    expect(actingPrincipal('human:test:alice', { hosted: true })).toEqual({
      id: 'human:test:alice',
      source: 'session-owner',
    });
  });
});
