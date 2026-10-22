import { PageSection } from '../../components/PageSection';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { ProjectKnowledgeSources } from './ProjectKnowledgeSources';
import { ResourcesSection } from './ResourcesSection';
import './ProjectSourcesSection.css';

export function ProjectSourcesSection({ slug }: { slug: string }) {
  const authority = useHostRequestAuthorityScope();
  return (
    <PageSection
      id="section-resources"
      title="Sources"
      description="Manage the repositories and knowledge stores attached to this project."
    >
      {authority ? (
        <div
          key={`${slug}:${authority.apiBase}:${authority.authorityKey}`}
          className="project-sources"
        >
          <ResourcesSection slug={slug} requestScope={authority} embedded />
          <ProjectKnowledgeSources slug={slug} authority={authority} />
        </div>
      ) : (
        <p>Connect to this Station to manage project sources.</p>
      )}
    </PageSection>
  );
}
