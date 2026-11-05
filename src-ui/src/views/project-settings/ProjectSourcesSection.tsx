import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import {
  useActiveStationName,
  useCachedStationStatus,
} from '../../hooks/useActiveStationName';
import { LearningReviewPanel } from '../learning-review/LearningReviewPanel';
import { ProjectKnowledgeSources } from './ProjectKnowledgeSources';
import { ProjectOperatorSetup } from './ProjectOperatorSetup';
import { ProjectRepositoryAttachment } from './ProjectRepositoryAttachment';
import { ProjectRepositorySources } from './ProjectRepositorySources';
import { ProjectS3Sources } from './ProjectS3Sources';
import { ProjectWorkingConfiguration } from './ProjectWorkingConfiguration';
import { ProjectWorkspaceSelection } from './ProjectWorkspaceSelection';
import { ResourcesSection } from './ResourcesSection';
import './ProjectSourcesSection.css';

export function ProjectSourcesSection({
  slug,
  projectId,
  stationName: suppliedStationName,
  onNavigateToSection,
  hrefForSection,
}: {
  slug: string;
  projectId?: string;
  stationName?: string;
  onNavigateToSection?: (section: string) => void;
  hrefForSection?: (section: string) => string;
}) {
  const [repairOpen, setRepairOpen] = useState(false);
  const repairSummary = useRef<HTMLElement>(null);
  const authority = useHostRequestAuthorityScope();
  const { navigate } = useNavigation();
  const station = useActiveStationName();
  const reportedHost = useCachedStationStatus()?.devicePresentation?.hostName;
  const host = suppliedStationName ?? reportedHost;
  const stationName =
    [station, host && host !== station ? host : undefined]
      .filter(Boolean)
      .join(' · ') || 'Connected Station (name unavailable)';
  return (
    <PageSection
      id="section-resources"
      title="Sources"
      description="Bring the files, repositories and connections you need into this Project."
    >
      {authority ? (
        <div
          key={`${projectId}:${slug}:${authority.apiBase}:${authority.authorityKey}`}
          className="project-sources"
        >
          <section
            className="project-sources__group"
            aria-label="Project repositories"
          >
            {projectId && (
              <ProjectRepositorySources
                slug={slug}
                projectId={projectId}
                authority={authority}
                stationName={stationName}
                onRepair={() => {
                  setRepairOpen(true);
                  repairSummary.current?.focus();
                  repairSummary.current?.scrollIntoView({ block: 'start' });
                }}
              />
            )}
            <details className="project-sources__diagnostics">
              <summary>Add a repository</summary>
              {projectId && (
                <ProjectRepositoryAttachment
                  slug={slug}
                  projectId={projectId}
                  authority={authority}
                  stationName={stationName}
                />
              )}
            </details>
            <details
              className="project-sources__diagnostics"
              open={repairOpen}
              onToggle={(event) => setRepairOpen(event.currentTarget.open)}
            >
              <summary ref={repairSummary}>Advanced: checkout repair</summary>
              <p className="project-sources__hint">
                Filesystem paths below belong to {stationName}.
              </p>
              <ResourcesSection
                slug={slug}
                requestScope={authority}
                stationName={stationName}
                workspaceHref={hrefForSection?.('workspace')}
                onNavigateToWorkspace={
                  onNavigateToSection
                    ? () => onNavigateToSection('workspace')
                    : undefined
                }
                embedded
              />
            </details>
          </section>
          <ProjectKnowledgeSources
            slug={slug}
            projectId={projectId}
            authority={authority}
          />

          <section
            className="project-sources__group"
            aria-label="Connected services"
          >
            <h3>Connections</h3>
            <p className="project-sources__hint">
              Choose the services this Project can use. Each connection keeps
              its own account and access rules.
            </p>
            <Button
              onClick={() =>
                onNavigateToSection
                  ? onNavigateToSection('tools')
                  : navigate(`/projects/${encodeURIComponent(slug)}/edit`, {
                      section: 'tools',
                    })
              }
            >
              Manage connections
            </Button>
          </section>
          {projectId && (
            <ProjectS3Sources
              slug={slug}
              projectId={projectId}
              authority={authority}
            />
          )}
          {projectId && (
            <LearningReviewPanel
              slug={slug}
              projectId={projectId}
              authority={authority}
            />
          )}
          {projectId && (
            <details className="project-sources__group">
              <summary>Where new chats start</summary>
              <ProjectWorkspaceSelection
                slug={slug}
                projectId={projectId}
                authority={authority}
              />
              <ProjectOperatorSetup
                slug={slug}
                projectId={projectId}
                authority={authority}
              />
              <ProjectWorkingConfiguration
                slug={slug}
                projectId={projectId}
                authority={authority}
              />
            </details>
          )}
        </div>
      ) : (
        <p>Connect to this Station to manage project sources.</p>
      )}
    </PageSection>
  );
}
