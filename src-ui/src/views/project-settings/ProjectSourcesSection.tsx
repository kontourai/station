import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { ProjectKnowledgeSources } from './ProjectKnowledgeSources';
import { ProjectOperatorSetup } from './ProjectOperatorSetup';
import { ProjectRepositoryAttachment } from './ProjectRepositoryAttachment';
import { ProjectS3Sources } from './ProjectS3Sources';
import { ProjectWorkspaceSelection } from './ProjectWorkspaceSelection';
import { ResourcesSection } from './ResourcesSection';
import './ProjectSourcesSection.css';

export function ProjectSourcesSection({
  slug,
  projectId,
}: {
  slug: string;
  projectId?: string;
}) {
  const authority = useHostRequestAuthorityScope();
  const { navigate } = useNavigation();
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
          <ProjectKnowledgeSources
            slug={slug}
            projectId={projectId}
            authority={authority}
          />
          <details className="project-sources__group">
            <summary>Repositories and folders</summary>
            <p className="project-sources__hint">
              Bring in code when you need it. Other Project files and
              connections stay available.
            </p>
            {projectId && (
              <ProjectRepositoryAttachment
                slug={slug}
                projectId={projectId}
                authority={authority}
              />
            )}
            <details className="project-sources__diagnostics">
              <summary>Working copies and repair</summary>
              <ResourcesSection slug={slug} requestScope={authority} embedded />
            </details>
          </details>
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
                navigate(`/projects/${encodeURIComponent(slug)}/edit`, {
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
            <details className="project-sources__group">
              <summary>Where Agent work starts</summary>
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
            </details>
          )}
        </div>
      ) : (
        <p>Connect to this Station to manage project sources.</p>
      )}
    </PageSection>
  );
}
