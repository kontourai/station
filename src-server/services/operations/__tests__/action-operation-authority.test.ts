import {
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  actionOperationAccountId,
  actionOperationActorForRequest,
} from '../action-operation-authority.js';

describe('action operation request authority', () => {
  test('uses the verified device identity and ignores a forged header', () => {
    const request = new Request('http://station.test/api/action-operations', {
      headers: { 'X-Station-Device-Id': 'forged-device' },
    });
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'not-persisted',
      authority: 'device-credential',
      deviceId: 'verified-device',
      source: 'bearer',
    });
    const actor = actionOperationActorForRequest(
      request,
      sessionReadAuthorityFromRequest('operator', undefined, undefined),
      () => true,
    );
    expect(actor).toMatchObject({
      accountId: 'operator',
      machineId: 'verified-device',
    });
  });

  test('does not invent a machine identity for an operator credential', () => {
    const request = new Request('http://station.test/api/action-operations');
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'not-persisted',
      authority: 'operator-credential',
      source: 'session',
    });
    expect(
      actionOperationActorForRequest(
        request,
        sessionReadAuthorityFromRequest('operator', undefined, undefined),
        () => true,
      ),
    ).not.toHaveProperty('machineId');
  });

  test('uses the fleet correlation account derivation for equal user ids in different hosted tenants', () => {
    const alpha = sessionReadAuthorityFromRequest(
      'same-user',
      { tenantId: tenantId('tenant-alpha') },
      { tenants: [{ id: 'tenant-alpha' }, { id: 'tenant-bravo' }] } as any,
    );
    const bravo = sessionReadAuthorityFromRequest(
      'same-user',
      { tenantId: tenantId('tenant-bravo') },
      { tenants: [{ id: 'tenant-alpha' }, { id: 'tenant-bravo' }] } as any,
    );
    expect(actionOperationAccountId(alpha)).not.toBe(
      actionOperationAccountId(bravo),
    );
  });
});
