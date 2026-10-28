import { useNavigation } from '../../contexts/NavigationContext';
import {
  coordinatorStatusLine,
  useCoordinator,
} from '../../hooks/useCoordinator';
import { COORDINATOR_PRODUCT_NAME } from '../../lib/productNames';
import { Button } from '../Button';
import { ErrorState, SkeletonBlock } from '../state';

const LABEL_ID = 'home-coordinator-label';

/**
 * #3628: the person's coordinator Session, pinned on Home. One primary
 * action: open it. Without one, it says where to make one (any chat's
 * menu). A host that cannot keep one (older, or hosted) shows nothing.
 */
export function HomeCoordinatorCard() {
  const { state, retry } = useCoordinator();
  const { navigate } = useNavigation();
  if (state.kind === 'unavailable') return null;
  return (
    <section
      className="home-view__coordinator"
      aria-labelledby={LABEL_ID}
      data-testid="home-coordinator"
    >
      <div className="home-view__section-heading">
        <h2 id={LABEL_ID}>{COORDINATOR_PRODUCT_NAME}</h2>
      </div>
      {state.kind === 'loading' ? (
        <SkeletonBlock
          count={1}
          label={`Loading ${COORDINATOR_PRODUCT_NAME}`}
        />
      ) : state.kind === 'error' ? (
        <ErrorState
          variant="compact"
          title={`${COORDINATOR_PRODUCT_NAME} unavailable`}
          description="Station could not read your coordinator."
          action={
            <button type="button" onClick={retry}>
              Retry
            </button>
          }
        />
      ) : state.designation ? (
        <div className="home-view__coordinator-body">
          <p>{coordinatorStatusLine(state.delivery)}</p>
          <Button
            variant="primary"
            onClick={() =>
              navigate('/', {
                chat: state.designation!.conversationId,
                dock: 'open',
              })
            }
          >
            Talk to {COORDINATOR_PRODUCT_NAME}
          </Button>
        </div>
      ) : (
        <div className="home-view__coordinator-body">
          <p>
            Open a chat and choose Make this {COORDINATOR_PRODUCT_NAME} from its
            menu.
          </p>
        </div>
      )}
    </section>
  );
}
