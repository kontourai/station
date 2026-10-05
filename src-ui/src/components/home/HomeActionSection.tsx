import type { ReactNode } from 'react';
import { useState } from 'react';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { useGitLocationByThreadId } from '../../hooks/useGitLocationByThreadId';
import { useProjectAccents } from '../../hooks/useProjectAccents';
import { useProjectIcons } from '../../hooks/useProjectIcons';
import { hasLocalStationForProfile } from '../../platform/client-origin-surface';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import type { NavigationView } from '../../types';
import type {
  HomeViewNavigation,
  useHomeViewModel,
} from '../../views/home/useHomeViewModel';
import { renderHomeWorkRow } from './HomeWorkRow';

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
  /** Drawn before the title: the project's accent, as the sidebar draws it. */
  leading?: ReactNode;
  /** A third line only where it says something the title does not. */
  detail?: string;
  onClick: () => void;
}

function HomeActionCard({
  className = '',
  label,
  title,
  leading,
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
      <strong className="home-view__action-title">
        {leading}
        {title}
      </strong>
      {detail ? <small>{detail}</small> : null}
    </button>
  );
}

export function HomeActionSection({
  continuation,
  model,
  onNavigate,
  showPrimary = true,
}: HomeActionSectionProps) {
  const profile = usePlatformProfile();
  const showLocalProject = hasLocalStationForProfile(profile);
  // The sidebar's colours, from the one project list it shows.
  const accents = useProjectAccents();
  const continuationSlug = continuation
    ? continuation.type === 'layout'
      ? continuation.projectSlug
      : continuation.slug
    : undefined;

  return (
    <section className="home-view__actions" aria-label="Work actions">
      {/* V2: a label, the thing, and a detail only where one says something
          the title does not. The helper lines ("Resume your previous
          workspace", "1 project already available") explained the cards. */}
      {showPrimary && model.primaryWorkItem && (
        <HomeContinueCard model={model} />
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
          leading={
            continuationSlug && accents.get(continuationSlug) ? (
              <span
                className="home-view__action-accent"
                aria-hidden="true"
                style={{ backgroundColor: accents.get(continuationSlug) }}
              />
            ) : null
          }
          title={continuationProjectLabel(continuation, model.projects)}
          onClick={() => onNavigate(continuation)}
        />
      )}
    </section>
  );
}

/**
 * Continue: the newest work as the work row itself (the lanes' row, full
 * size), so its agent icon, status, time and hover card read exactly as the
 * rows below it do, rather than a card's own summary line.
 */
export function HomeContinueCard({
  model,
  id,
  onViewActivity,
}: {
  model: HomeViewModel;
  id?: string;
  /**
   * Given when Recent work is not shown (Continue holds the only item), so
   * the way to all work stays on the page, beside this heading.
   */
  onViewActivity?: () => void;
}) {
  const coarsePointer = useCoarsePointer();
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  // The lanes' own row inputs, so the row reads exactly as theirs do.
  const gitLocationByThreadId = useGitLocationByThreadId();
  const projectAccentBySlug = useProjectAccents();
  const projectIconBySlug = useProjectIcons();
  const primary = model.primaryWorkItem;
  if (!primary) return null;
  return (
    <section
      id={id}
      className="home-view__continue"
      aria-labelledby="home-continue-label"
      tabIndex={-1}
    >
      {/* A heading at the same rung as Recent work: the page's work starts
          here, not under a smaller label. */}
      <div className="home-view__section-heading">
        <h2 id="home-continue-label">Continue</h2>
        {onViewActivity && (
          <button
            type="button"
            className="home-view__link"
            onClick={onViewActivity}
          >
            View Activity
          </button>
        )}
      </div>
      <ul className="home-view__task-list home-view__continue-list">
        {renderHomeWorkRow({
          task: { ...primary, stableId: `continue:${primary.id}` },
          isWoken: false,
          agents: model.agents,
          onOpen: () => model.continueWork(primary),
          context: {
            now: Date.now(),
            workFacts: model.workFacts,
            detailsFor,
            setDetailsFor,
            chrome: coarsePointer ? 'touch' : 'hover',
            gitLocationByThreadId,
            projectAccentBySlug,
            projectIconBySlug,
          },
        })}
      </ul>
    </section>
  );
}
