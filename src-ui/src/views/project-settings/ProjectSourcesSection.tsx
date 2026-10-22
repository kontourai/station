import { PageSection } from '../../components/PageSection';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { ProjectKnowledgeSources } from './ProjectKnowledgeSources';
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
      description="Manage the repositories and knowledge stores attached to this project."
    >
      {authority ? (
        <div
          key={`${projectId}:${slug}:${authority.apiBase}:${authority.authorityKey}`}
          className="project-sources"
        >
          <ResourcesSection slug={slug} requestScope={authority} embedded />
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
        </div>
      ) : (
        <p>Connect to this Station to manage project sources.</p>
      )}
    </PageSection>
  );
}
