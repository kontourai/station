import {
  coordinatorStatusLine,
  useCoordinator,
} from '../../hooks/useCoordinator';
import { COORDINATOR_PRODUCT_NAME } from '../../lib/productNames';

/** A persistent notice in the designated chat when its engine lacks tools. */
export function CoordinatorToolsNotice({
  conversationId,
}: {
  conversationId?: string;
}) {
  const { state } = useCoordinator();
  if (
    !conversationId ||
    state.kind !== 'ready' ||
    state.designation?.conversationId !== conversationId ||
    (!state.delivery?.toolsUnavailable && !state.delivery?.toolsRestarted)
  )
    return null;
  return (
    <div className="session-history-error" role="status">
      {state.delivery?.toolsUnavailable
        ? coordinatorStatusLine(state.delivery)
        : `${COORDINATOR_PRODUCT_NAME} restarted its session to pick up Station tools. The conversation continues here.`}
    </div>
  );
}
