import { hasLocalStationForProfile } from '../../platform/client-origin-surface';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import type { NavigationView } from '../../types';
import { relativeTime } from '../../utils/relativeTime';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type {
  HomeViewNavigation,
  useHomeViewModel,
} from '../../views/home/useHomeViewModel';

type HomeViewModel = ReturnType<typeof useHomeViewModel>;

interface HomeActionSectionProps {
  continuation: HomeViewNavigation | null;
  model: HomeViewModel;
  onNavigate: (view: NavigationView) => void;
  /**
   * Whether to render the Continue card. Kept from
   * archive#3122, where a host offering its own Resume affordance above the
   * fold would otherwise put the identical item on screen twice. Home passes
   * nothing and gets the card.
   */
  showPrimary?: boolean;
}

/**
 * #1582 E5: Home's "Open last project" card named the project by its SLUG
 * while the sidebar, on the same screen, named the same project by its name.
 *
 * A `NavigationView` carries only a slug — it is a route, not a project record
 * — so the name has to come from the record the catalog already holds, keyed
 * by that slug. This is the same lookup `HomeSurface`'s `projectOpener` makes,
 * and `useProjectsQuery` is untyped in the SDK, so the two fields this reads
 * are named here rather than inferred as `any`.
 *
 * The slug remains the answer when no record matches. That is not a cosmetic
 * fallback: the section renders a skeleton until `projectsQuery` settles
 * (`actionsLoading`), so an unmatched slug here means the project is gone from
 * the catalog, and the slug is then the only handle anything has on it.
 */
function continuationProjectLabel(
  continuation: HomeViewNavigation,
  projects: { slug: string; name?: string }[] | undefined,
): string {
  const slug =
    continuation.type === 'layout'
      ? continuation.projectSlug
      : continuation.slug;
  return (projects ?? []).find((entry) => entry.slug === slug)?.name || slug;
}

interface HomeActionCardProps {
  className?: string;
  label: string;
  title: string;
  /** A third line only where it says something the title does not. */
  detail?: string;
  onClick: () => void;
}

function HomeActionCard({
  className = '',
  label,
  title,
  detail,
  onClick,
}: HomeActionCardProps) {
  return (
    <button
      type="button"
      className={`home-view__action${className ? ` ${className}` : ''}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <strong>{title}</strong>
      {detail ? <small>{detail}</small> : null}
    </button>
  );
}

/**
 * Continue-card subtitle: the agent, a model only when one was reported,
 * Failed when it is, and the compact time. No kind word ("Session", "Direct
 * chat"): the card already says it continues work.
 */
export function continueWorkDetail(
  item: Pick<
    HomeWorkItem,
    'agentLabel' | 'modelLabel' | 'lifecycleLabel' | 'updatedAt'
  >,
  now = Date.now(),
): string {
  const parts = [item.agentLabel];
  if (item.modelLabel && item.modelLabel !== 'Model not reported') {
    parts.push(item.modelLabel);
  }
  if (item.lifecycleLabel === 'Failed') parts.push('Failed');
  if (item.updatedAt > 0) parts.push(relativeTime(item.updatedAt, now));
  return parts.join(' · ');
}

export function HomeActionSection({
  continuation,
  model,
  onNavigate,
  showPrimary = true,
}: HomeActionSectionProps) {
  const profile = usePlatformProfile();
  const showLocalProject = hasLocalStationForProfile(profile);

  return (
    <section className="home-view__actions" aria-label="Work actions">
      {/* V2: a label, the thing, and a detail only where one says something
          the title does not. The helper lines ("Resume your previous
          workspace", "1 project already available") explained the cards. */}
      {showPrimary && model.primaryWorkItem && (
        <HomeActionCard
          className="home-view__action--primary"
          label="Continue"
          title={model.primaryWorkItem.title}
          detail={continueWorkDetail(model.primaryWorkItem)}
          onClick={() => model.continueWork(model.primaryWorkItem!)}
        />
      )}
      <HomeActionCard
        label="Agents"
        title="Explore agents"
        onClick={() => onNavigate({ type: 'agents' })}
      />
      {showLocalProject ? (
        <HomeActionCard
          label="Project"
          // "This Station", not "this computer": the folder lives on the
          // Station host, which is a different machine when this UI runs as
          // a remote client (e.g. the phone app paired to a desktop).
          title="Open local project"
          detail="Add a folder on this Station"
          onClick={() => onNavigate({ type: 'project-new' })}
        />
      ) : null}
      {continuation && (
        <HomeActionCard
          className="home-view__action--quiet"
          label="Last project"
          title={continuationProjectLabel(continuation, model.projects)}
          onClick={() => onNavigate(continuation)}
        />
      )}
    </section>
  );
}
