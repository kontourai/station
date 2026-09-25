import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { executeExecutionTargetMessage } from '../../tools/station-control-delegation.js';
import type { createInboundWebhookRoutes } from './inbound-webhooks.js';

type TurnStarter = Parameters<
  typeof createInboundWebhookRoutes
>[0]['startTurn'];

/**
 * The inbound webhook's turn starter. A webhook turn has no request principal
 * to act for: it runs for this Station's local operator, who minted the
 * webhook token. The operator is recorded as the owner of the session it
 * starts, and the operator's authority reads it. A session with no recorded
 * owner is readable by no caller, so the operator could otherwise never open
 * the conversation a webhook started.
 */
export function createWebhookTurnStarter(deps: {
  readAuthorityFor: (userId: string) => SessionReadAuthority;
  orchestrationService: OrchestrationService;
}): TurnStarter {
  return (input) =>
    executeExecutionTargetMessage(
      {
        ...input,
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        readAuthority: deps.readAuthorityFor(LOCAL_OPERATOR_PRINCIPAL_ID),
      },
      deps.orchestrationService,
    );
}
