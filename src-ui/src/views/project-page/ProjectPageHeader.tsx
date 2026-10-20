import { Button } from '../../components/Button';
import { GitBadge } from '../../components/badges/GitBadge';
import { SettingsGlyph } from '../../components/icons/Glyph';
import { ProjectIcon } from '../../components/icons/ProjectIcon';

export function ProjectPageHeader({
  project,
  gitStatus,
  navigateToSettings,
}: {
  project: {
    icon?: string;
    name: string;
    description?: string;
  };
  gitStatus:
    | (Parameters<typeof GitBadge>[0]['git'] & { isRepo: true })
    | { isRepo: false }
    | null
    | undefined;
  navigateToSettings: () => void;
}) {
  return (
    <div className="project-page__header">
      <div className="project-page__identity">
        <ProjectIcon project={project} size={48} fallback="initials" />
        <div className="project-page__identity-info">
          <h2 className="project-page__name">{project.name}</h2>
          {gitStatus?.isRepo && (
            <GitBadge git={gitStatus} className="project-page__git-badge" />
          )}
          {project.description && (
            <p className="project-page__desc">{project.description}</p>
          )}
        </div>
      </div>
      <button
        type="button"
        className="project-page__settings-btn"
        aria-label="Project settings"
        onClick={navigateToSettings}
      >
        <SettingsGlyph />
        <span className="project-page__settings-label">Settings</span>
      </button>
    </div>
  );
}
/** Member identity shares the unframed Project workspace header, without operator controls. */
export function MemberProjectHeader({
  project,
  onRefresh,
  refreshDisabled,
}: {
  project: { icon?: string; name: string; description?: string };
  onRefresh: () => void;
  refreshDisabled: boolean;
}) {
  return (
    <div className="project-page__header">
      <div className="project-page__identity">
        <ProjectIcon project={project} size={48} fallback="initials" />
        <div className="project-page__identity-info">
          <p>Shared Project</p>
          <h2 className="project-page__name">{project.name}</h2>
          {project.description && (
            <p className="project-page__desc">{project.description}</p>
          )}
        </div>
      </div>
      <Button onClick={onRefresh} disabled={refreshDisabled}>
        Refresh shared work
      </Button>
    </div>
  );
}
