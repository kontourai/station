import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
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
