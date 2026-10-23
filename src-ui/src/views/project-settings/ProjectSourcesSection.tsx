import { PageSection } from '../../components/PageSection';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { ProjectKnowledgeSources } from './ProjectKnowledgeSources';
import { ProjectOperatorSetup } from './ProjectOperatorSetup';
import { ProjectRepositoryAttachment } from './ProjectRepositoryAttachment';
import { ProjectS3Sources } from './ProjectS3Sources';
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
  return (
    <PageSection
      id="section-resources"
      title="Sources"
      description="Manage the repositories and knowledge sources attached to this project."
    >
      {authority ? (
        <div
          key={`${projectId}:${slug}:${authority.apiBase}:${authority.authorityKey}`}
          className="project-sources"
        >
          <ResourcesSection slug={slug} requestScope={authority} embedded />
          {projectId && (
            <ProjectRepositoryAttachment
              slug={slug}
              projectId={projectId}
              authority={authority}
            />
          )}
          <ProjectKnowledgeSources
            slug={slug}
            projectId={projectId}
            authority={authority}
          />
          {projectId && (
            <ProjectS3Sources
              slug={slug}
              projectId={projectId}
              authority={authority}
            />
          )}
          {projectId && (
            <ProjectOperatorSetup
              slug={slug}
              projectId={projectId}
              authority={authority}
            />
          )}
        </div>
      ) : (
        <p>Connect to this Station to manage project sources.</p>
      )}
    </PageSection>
  );
}
