import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION } from '../../services/orchestration/session-owner-attribution.js';
import { executeExecutionTargetMessage } from '../../tools/station-control-delegation.js';
import type { createInboundWebhookRoutes } from './inbound-webhooks.js';

type TurnStarter = Parameters<
  typeof createInboundWebhookRoutes
>[0]['startTurn'];

/**
 * The inbound webhook's turn starter. A webhook turn has no request principal
 * to act for. The session it starts is recorded as the local operator's (who
 * minted the webhook token), so the operator's account can open it; a
 * session with no recorded owner is readable by no caller. It is marked
 * unattributed, though: the webhook's external sender drives it, so it acts
 * for no one and can never elevate as the operator.
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
        // An external sender drives this turn, not the operator: the session
        // is the operator's to read, but acts for no one.
        ownerAttribution: UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION,
        readAuthority: deps.readAuthorityFor(LOCAL_OPERATOR_PRINCIPAL_ID),
      },
      deps.orchestrationService,
    );
}
