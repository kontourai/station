import {
  canMaterializeKitProjectLayout,
  materializeKitProjectLayout,
  useCreateProjectLayoutMutation,
  useKitLayoutQuery,
  useKitRegistryQuery,
  useProjectLayoutsQuery,
  useProjectsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { Button } from '../Button';
import { Empty, ErrorState, SkeletonBlock, SkeletonList } from '../state';

function lifecycleLabel(lifecycle: string) {
  return lifecycle === 'installed'
    ? 'Installed'
    : lifecycle === 'disabled'
      ? 'Disabled'
      : 'Unavailable';
}

function availabilityMessage(
  lifecycle: string,
  status: string,
  hasProjection: boolean,
) {
  if (lifecycle !== 'installed') {
    return 'This Kit is listed here, but it isn’t installed.';
  }
  if (status !== 'enabled') {
    return 'Station hasn’t enabled this Kit’s read-only view. Check its diagnostics, then try again.';
  }
  if (!hasProjection) {
    return 'This Kit doesn’t offer a read-only view for Station to show.';
  }
  return null;
}

function kitAlreadyApplied(
  layouts:
    | Array<{ slug?: string; config?: Record<string, unknown> }>
    | undefined,
  layoutSlug: string,
  contributionRef: string,
  incarnation: number,
) {
  return (layouts ?? []).some((layout) => {
    if (layout.slug === layoutSlug) return true;
    const kit = layout.config?.kit;
    return (
      typeof kit === 'object' &&
      kit !== null &&
      (kit as { contributionRef?: unknown }).contributionRef ===
        contributionRef &&
      (kit as { incarnation?: unknown }).incarnation === incarnation
    );
  });
}

/**
 * Host-only browse and project materialization surface for portable Kits.
 * It exposes no lifecycle or operator mutation controls: those require a
 * Station approval/persistence path beyond a read-only projection.
 */
export function KitCatalog() {
  const { setLayout } = useNavigation();
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [projectSlug, setProjectSlug] = useState('');
  const {
    data: entries,
    error: entriesError,
    isLoading: entriesLoading,
  } = useKitRegistryQuery();
  const kits = entries ?? [];
  const selected = useMemo(
    () =>
      kits.find((entry) => entry.contributionRef === selectedRef) ?? kits[0],
    [kits, selectedRef],
  );
  const {
    data: projection,
    error: projectionError,
    isLoading: projectionLoading,
  } = useKitLayoutQuery(selected?.contributionRef);
  const { data: projects, isLoading: projectsLoading } = useProjectsQuery();
  const {
    data: projectLayouts,
    error: projectLayoutsError,
    isLoading: projectLayoutsLoading,
  } = useProjectLayoutsQuery(projectSlug, { enabled: !!projectSlug });
  const [message, setMessage] = useState<string | null>(null);
  const materialized = useMemo(() => {
    if (!selected || !projection) return null;
    return canMaterializeKitProjectLayout(selected, projection)
      ? materializeKitProjectLayout(selected, projection)
      : null;
  }, [projection, selected]);
  const alreadyApplied =
    selected && materialized
      ? kitAlreadyApplied(
          projectLayouts,
          materialized.slug,
          selected.contributionRef,
          selected.incarnation,
        )
      : false;
  const createLayout = useCreateProjectLayoutMutation({
    onError: (error) => setMessage(error.message),
    onSuccess: (layout, variables) => {
      setMessage(`Added ${layout.name} to ${variables.projectSlug}.`);
      setLayout(variables.projectSlug, layout.slug);
    },
  });

  useEffect(() => {
    if (!selectedRef && selected) setSelectedRef(selected.contributionRef);
  }, [selected, selectedRef]);

  if (entriesLoading && entries === undefined) {
    return <SkeletonList count={2} label="Loading portable Kits" withIcon />;
  }

  if (entriesError) {
    return (
      <ErrorState
        variant="prominent"
        title="Couldn't load portable Kits"
        description={entriesError.message}
      />
    );
  }

  if (kits.length === 0) {
    return (
      /* empty-state action: portable Kits are installed elsewhere */
      <Empty
        variant="prominent"
        label="No portable Kits are installed"
        description="When a Kit installed here offers a read-only view, it will appear here."
      />
    );
  }

  const unavailable = selected
    ? availabilityMessage(
        selected.lifecycle,
        selected.experience.status,
        Boolean(projection?.component || projection?.standardViews.length),
      )
    : null;
  const applyDisabled =
    !selected ||
    !projectSlug ||
    !materialized ||
    projectLayoutsLoading ||
    Boolean(projectLayoutsError) ||
    alreadyApplied ||
    createLayout.isPending;

  return (
    <div className="page__section-stack">
      {message && (
        <div className="page__message" role="status">
          {message}
        </div>
      )}
      <section
        className="page__card-loose registry-catalog__detail"
        data-testid="kit-registry-detail"
        aria-labelledby="kit-registry-detail-title"
      >
        <div className="page__section-label">Selected Kit</div>
        <div className="page__card-row">
          <div className="page__card-text">
            <div className="page__card-name" id="kit-registry-detail-title">
              {selected?.contributionRef}
            </div>
            <div className="page__card-desc">
              Read-only host projection, incarnation {selected?.incarnation}.
            </div>
          </div>
          {selected && (
            <span
              className={`page__tag${selected.lifecycle === 'installed' ? ' page__tag--accent' : ''}`}
            >
              {lifecycleLabel(selected.lifecycle)}
            </span>
          )}
        </div>

        {projectionLoading && (
          <SkeletonBlock count={1} label="Loading this Kit’s view" />
        )}
        {projectionError && (
          <div className="page__subtitle" role="alert">
            Could not load this Kit’s view: {projectionError.message}
          </div>
        )}
        {projectLayoutsError && (
          <div className="page__subtitle" role="alert">
            Could not verify project layouts: {projectLayoutsError.message}
          </div>
        )}
        {selected && selected.experience.diagnostics.length > 0 && (
          <ul className="page__subtitle" aria-label="Kit diagnostics">
            {selected.experience.diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.code}:${diagnostic.message}`}>
                {diagnostic.message}
              </li>
            ))}
          </ul>
        )}
        {unavailable && <div className="page__subtitle">{unavailable}</div>}
        {projection && (
          <div className="page__subtitle">
            {projection.component
              ? 'MCP app view available through Station’s hardened frame. '
              : ''}
            {projection.standardViews.length > 0
              ? `${projection.standardViews.length} read-only standard ${projection.standardViews.length === 1 ? 'view' : 'views'} available.`
              : ''}
          </div>
        )}

        <div className="page__card-footer">
          <label className="page__subtitle" htmlFor="kit-project-select">
            Apply to project
          </label>
          <select
            id="kit-project-select"
            className="page__search-input"
            value={projectSlug}
            disabled={projectsLoading}
            onChange={(event) => setProjectSlug(event.target.value)}
          >
            <option value="">Choose a project</option>
            {(projects ?? []).map(
              (project: { slug: string; name?: string }) => (
                <option key={project.slug} value={project.slug}>
                  {project.name || project.slug}
                </option>
              ),
            )}
          </select>
          <Button
            variant="primary"
            size="sm"
            disabled={applyDisabled}
            onClick={() => {
              if (!materialized || !projectSlug) return;
              setMessage(null);
              createLayout.mutate({ projectSlug, ...materialized });
            }}
          >
            {createLayout.isPending
              ? 'Adding layout...'
              : projectLayoutsLoading
                ? 'Checking project layouts...'
                : projectLayoutsError
                  ? 'Project layout check required'
                  : alreadyApplied
                    ? 'Already added'
                    : 'Add read-only layout'}
          </Button>
        </div>
      </section>

      <section className="page__card-grid" aria-label="Portable Kits">
        {kits.map((entry) => {
          const selectedCard =
            entry.contributionRef === selected?.contributionRef;
          return (
            <article
              className={`page__card-loose${selectedCard ? ' page__card-loose--selected' : ''}`}
              key={entry.contributionRef}
            >
              <div className="page__card-row">
                <div className="page__card-text">
                  <div className="page__card-name">{entry.contributionRef}</div>
                  <div className="page__card-desc">
                    {entry.experience.status} · incarnation {entry.incarnation}
                  </div>
                </div>
                <span
                  className={`page__tag${entry.lifecycle === 'installed' ? ' page__tag--accent' : ''}`}
                >
                  {lifecycleLabel(entry.lifecycle)}
                </span>
              </div>
              <div className="page__card-footer">
                <Button
                  variant="secondary"
                  size="sm"
                  aria-pressed={selectedCard}
                  onClick={() => {
                    setMessage(null);
                    setSelectedRef(entry.contributionRef);
                  }}
                >
                  View {entry.contributionRef} details
                </Button>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
