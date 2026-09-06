import type { NavigationView } from '../../types';
import type {
  HomeViewNavigation,
  useHomeViewModel,
} from '../../views/home/useHomeViewModel';
import { SkeletonBlock } from '../state';

const OPEN_NEW_CHAT_EVENT = 'station:open-new-chat';

type HomeViewModel = ReturnType<typeof useHomeViewModel>;

interface HomeActionSectionProps {
  continuation: HomeViewNavigation | null;
  model: HomeViewModel;
  onNavigate: (view: NavigationView) => void;
  /**
   * Whether to render the "continue most recent work" card. Kept from
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
export function continuationProjectLabel(
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
  detail: string;
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
      <small>{detail}</small>
    </button>
  );
}

function projectAvailability(count: number): string {
  return count
    ? `${count} project${count === 1 ? '' : 's'} already available`
    : 'Choose a working directory';
}

export function HomeActionSection({
  continuation,
  model,
  onNavigate,
  showPrimary = true,
}: HomeActionSectionProps) {
  if (model.actionsLoading) {
    return (
      <SkeletonBlock
        count={3}
        className="home-view__actions home-view__actions--loading"
        label="Loading Home actions"
      />
    );
  }
  return (
    <section className="home-view__actions" aria-label="Work actions">
      {showPrimary && model.primaryWorkItem && (
        <HomeActionCard
          className="home-view__action--primary"
          label="Continue most recent work"
          title={model.primaryWorkItem.title}
          detail={`${model.primaryWorkItem.kindLabel} · ${model.primaryWorkItem.agentLabel} · ${model.primaryWorkItem.modelLabel}`}
          onClick={() => model.continueWork(model.primaryWorkItem!)}
        />
      )}
      {/*
        One card, two honest states. With something runnable it recommends it
        by name; with nothing runnable it stops recommending and asks for the
        setup instead — the picker it opens is where the per-engine Enable
        lives, so the destination is the same and only the promise changes.
      */}
      <HomeActionCard
        label={model.startReady ? 'Start direct chat' : 'Set up an agent'}
        title={
          model.startReady
            ? 'Write a message and begin'
            : 'Finish setting up an engine to chat'
        }
        detail={model.startIdentity}
        onClick={() => window.dispatchEvent(new Event(OPEN_NEW_CHAT_EVENT))}
      />
      <HomeActionCard
        label="Open local project"
        title="Add a folder from this computer"
        detail={projectAvailability(model.projects.length)}
        onClick={() => onNavigate({ type: 'project-new' })}
      />
      {continuation && (
        <HomeActionCard
          className="home-view__action--quiet"
          label="Open last project"
          title={continuationProjectLabel(continuation, model.projects)}
          detail="Resume your previous workspace"
          onClick={() => onNavigate(continuation)}
        />
      )}
    </section>
  );
}
