import { useMemo } from 'react';
import { FlowRunConsole } from '../components/flow/FlowRunConsole';
import { PageEyebrowTrail, usePageHeader } from '../components/page-frame';
import { useNavigation } from '../contexts/NavigationContext';
import './page-layout.css';

export interface ProjectFlowConsoleViewProps {
  projectSlug: string;
  /** `?run=` deep-link target — gate items in the attention inbox preselect a run. */
  runId?: string;
}

/**
 * Deterministic route for the Flow run console
 * (`/projects/:slug/flow-console` — mirrors the `project-session-board`
 * routing precedent). The attention inbox's gate items (station#612)
 * deep-link here with `?run=` so a route-back, blocked, or
 * exception-pending decision lands directly on its run, instead of
 * whichever run happens to sort first.
 */
export function ProjectFlowConsoleView({
  projectSlug,
  runId,
}: ProjectFlowConsoleViewProps) {
  const { navigate } = useNavigation();
  // The frame renders the page title; only this view knows which project it
  // belongs to.
  const eyebrow = useMemo(
    () => (
      <PageEyebrowTrail
        segments={[
          {
            label: projectSlug,
            onClick: () => navigate(`/projects/${projectSlug}`),
          },
          { label: 'Flow console' },
        ]}
      />
    ),
    [projectSlug, navigate],
  );
  usePageHeader({
    eyebrow,
    title: 'Flow console',
    subtitle:
      'Gate outcomes, evidence, exceptions, and route-backs for every run in this workspace.',
  });

  return (
    <div className="pane-host">
      <FlowRunConsole projectSlug={projectSlug} initialRunId={runId} />
    </div>
  );
}
