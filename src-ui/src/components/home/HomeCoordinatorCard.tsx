import { useNavigation } from '../../contexts/NavigationContext';
import {
  coordinatorStatusLine,
  useCoordinator,
  useCoordinatorPicture,
} from '../../hooks/useCoordinator';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { COORDINATOR_PRODUCT_NAME } from '../../lib/productNames';
import { Button } from '../Button';
import { Empty, ErrorState, SkeletonBlock } from '../state';

const LABEL_ID = 'home-coordinator-label';

/**
 * #3628: the person's coordinator Session, pinned on Home. One primary
 * action: open it. Without one, it says where to make one (any chat's
 * menu). A host that cannot keep one (older, or hosted) shows nothing.
 */
export function HomeCoordinatorCard() {
  const { state, retry } = useCoordinator();
  const { navigate } = useNavigation();
  const pictureEnabled = useSurfaceVisibilityFlags().has('coordinator-picture');
  const picture = useCoordinatorPicture(
    pictureEnabled && state.kind === 'ready' && Boolean(state.designation),
  );
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
      {pictureEnabled && state.kind === 'ready' && state.designation && (
        <div className="home-view__coordinator-picture">
          <h3>Working picture</h3>
          <p>
            Maintained by your coordinator; check the work for its current
            state.
          </p>
          {picture.isPending ? (
            <SkeletonBlock count={1} label="Loading working picture" />
          ) : picture.isError ? (
            <ErrorState
              variant="compact"
              title="Working picture unavailable"
              action={
                <button type="button" onClick={() => void picture.refetch()}>
                  Retry
                </button>
              }
            />
          ) : picture.data?.length ? (
            <ul>
              {picture.data.map((item) => (
                <li key={item.conversationId}>
                  <strong>
                    {item.status === 'waiting'
                      ? 'Waiting on you'
                      : item.status === 'finished'
                        ? 'Just finished'
                        : 'In flight'}
                  </strong>
                  : <span>{item.summary}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty variant="compact" label="Nothing here yet" />
          )}
        </div>
      )}
    </section>
  );
}
