import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { tenantQualifiedAccountId } from '../../runtime/conversation/authorized-turn-correlation.js';
import { resolveClientOriginForRequest } from '../../security/runtime-request-security.js';
import type { ActionOperationActor } from './action-operation-service.js';

/** Actor facts come only from authenticated request/session authority. */
export function actionOperationActorForRequest(
  request: Request,
  authority: SessionReadAuthority,
  canReadSession: (sessionId: string) => boolean | Promise<boolean>,
): ActionOperationActor {
  const origin = resolveClientOriginForRequest(request);
  return {
    // Tenant-qualified account coordinate for account-scoped operation rows.
    accountId: tenantQualifiedAccountId(
      authority.userId,
      authority.tenantExecutionContext?.tenantId,
    ),
    ...(origin.actor.kind === 'device'
      ? { machineId: origin.actor.deviceId }
      : {}),
    canReadSession,
  };
}
