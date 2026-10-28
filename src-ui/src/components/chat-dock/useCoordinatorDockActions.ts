import { useCoordinator } from '../../hooks/useCoordinator';
import { COORDINATOR_PRODUCT_NAME } from '../../lib/productNames';
import type { DockMoreAction } from './ChatDockHeaderMoreMenu';

/**
 * #3628: the chat's More-menu rows that make it (or stop it being) the
 * person's coordinator. Replacing another chat is its own, named action: the
 * server refuses a second designation unless it is asked to replace.
 * Nothing shows while the designation is unknown or the host cannot keep one.
 */
export function useCoordinatorDockActions(
  conversationId: string | undefined,
): DockMoreAction[] {
  const { state, designate, undesignate } = useCoordinator();
  if (!conversationId || state.kind !== 'ready') return [];
  const busy = designate.isPending || undesignate.isPending;
  const current = state.designation?.conversationId;
  if (current === conversationId)
    return [
      {
        key: 'coordinator-undesignate',
        label: `Stop using as ${COORDINATOR_PRODUCT_NAME}`,
        disabled: busy,
        onSelect: () => undesignate.mutate(),
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
        designate.mutate({
          conversationId,
          ...(current ? { replace: true } : {}),
        }),
    },
  ];
}
