import type { CoordinatorDelivery } from '@kontourai/station-contracts/coordinator';
import { useToast } from '../../contexts/ToastContext';
import {
  CoordinatorRefusal,
  coordinatorStatusLine,
  useCoordinator,
} from '../../hooks/useCoordinator';
import { COORDINATOR_PRODUCT_NAME } from '../../lib/productNames';
import type { DockMoreAction } from './ChatDockHeaderMoreMenu';

/** What the person is told once the chat is the coordinator. */
function designatedMessage(delivery: CoordinatorDelivery | undefined): string {
  if (
    delivery?.wakes === 'blocked' ||
    delivery?.toolsPending ||
    delivery?.toolsUnavailable
  )
    return `This chat is ${COORDINATOR_PRODUCT_NAME}. ${coordinatorStatusLine(delivery)}`;
  return `This chat is ${COORDINATOR_PRODUCT_NAME}.`;
}

function refusalMessage(error: unknown): string {
  const code = error instanceof CoordinatorRefusal ? error.code : undefined;
  if (code === 'coordinator_conversation_taken')
    return `This chat is someone else's ${COORDINATOR_PRODUCT_NAME}.`;
  if (code === 'coordinator_already_designated')
    return `Another chat is ${COORDINATOR_PRODUCT_NAME}. Reopen this menu to replace it.`;
  return `Station couldn't change ${COORDINATOR_PRODUCT_NAME}. Try again.`;
}

/**
 * #3628: the chat's More-menu rows that make it (or stop it being) the
 * person's coordinator. Replacing another chat is its own, named action: the
 * server refuses a second designation unless it is asked to replace.
 * Nothing shows while the designation is unknown or the host cannot keep one.
 * Every outcome is told: tools that arrive only with the next Session, a chat
 * Station cannot deliver to yet, and a refusal.
 */
export function useCoordinatorDockActions(
  conversationId: string | undefined,
): DockMoreAction[] {
  const { state, designate, undesignate } = useCoordinator();
  const { showToast } = useToast();
  if (!conversationId || state.kind !== 'ready') return [];
  const busy = designate.isPending || undesignate.isPending;
  const current = state.designation?.conversationId;
  if (current === conversationId)
    return [
      {
        key: 'coordinator-undesignate',
        label: `Stop using as ${COORDINATOR_PRODUCT_NAME}`,
        disabled: busy,
        onSelect: () =>
          undesignate.mutate(undefined, {
            onError: (error) =>
              showToast(
                refusalMessage(error),
                undefined,
                undefined,
                undefined,
                'error',
              ),
          }),
      },
    ];
  return [
    {
      key: 'coordinator-designate',
      label: current
        ? `Make this ${COORDINATOR_PRODUCT_NAME} instead`
        : `Make this ${COORDINATOR_PRODUCT_NAME}`,
      disabled: busy,
      onSelect: () =>
        designate.mutate(
          { conversationId, ...(current ? { replace: true } : {}) },
          {
            onSuccess: (data) =>
              showToast(
                designatedMessage(data.delivery),
                undefined,
                undefined,
                undefined,
                data.delivery?.wakes === 'blocked' ? 'warning' : 'success',
              ),
            onError: (error) =>
              showToast(
                refusalMessage(error),
                undefined,
                undefined,
                undefined,
                'error',
              ),
          },
        ),
    },
  ];
}
