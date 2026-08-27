import { Checkbox } from '../../components/Checkbox';
import { SparkleGlyph } from '../../components/icons/Glyph';
import { LayoutIcon } from '../../components/icons/LayoutIcon';
import { ResponsiveDialogSurface } from '../../components/ResponsiveDialogSurface';

export function LayoutAssignmentModal({
  assignment,
  projects,
  quickProjectName,
  selectedProjects,
  assigningLayout,
  onClose,
  onToggleProject,
  onCreateProject,
  onAddToProjects,
}: {
  assignment: {
    pluginName: string;
    displayName: string;
    layoutSlug: string;
  };
  projects: Array<{
    slug: string;
    name: string;
    icon?: string;
    layoutCount: number;
  }>;
  quickProjectName: string;
  selectedProjects: Set<string>;
  assigningLayout: boolean;
  onClose: () => void;
  onToggleProject: (slug: string, checked: boolean) => void;
  onCreateProject: () => void;
  onAddToProjects: () => void;
}) {
  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy="layout-assignment-title"
      overlayClassName="plugins__confirm-overlay"
      panelClassName="plugins__confirm plugins__confirm--wide"
    >
      <h3 id="layout-assignment-title" className="plugins__assign-heading">
        Add Layout to Project
      </h3>
      <p className="plugins__assign-desc">
        <strong>{assignment.displayName}</strong> includes a layout. Add it to a
        project to start using it.
      </p>

      <button
        type="button"
        className="plugins__btn plugins__btn--install plugins__assign-quick-btn"
        disabled={assigningLayout}
        onClick={onCreateProject}
      >
        <SparkleGlyph /> Create &ldquo;{quickProjectName}&rdquo; Project
      </button>

      {projects.length > 0 && (
        <>
          <div className="plugins__assign-section-label">
            Or add to existing
          </div>
          <div className="plugins__assign-project-list">
            {projects.map((project) => (
              <div
                key={project.slug}
                className={`plugins__assign-project${selectedProjects.has(project.slug) ? ' plugins__assign-project--selected' : ''}`}
              >
                <Checkbox
                  checked={selectedProjects.has(project.slug)}
                  onChange={(checked) => onToggleProject(project.slug, checked)}
                >
                  <LayoutIcon layout={project} size={28} />
                  <span>{project.name}</span>
                  <span className="plugins__assign-project-count">
                    {project.layoutCount} layout
                    {project.layoutCount !== 1 ? 's' : ''}
                  </span>
                </Checkbox>
              </div>
            ))}
          </div>
          {selectedProjects.size > 0 && (
            <button
              type="button"
              className="plugins__btn plugins__btn--install plugins__assign-add-btn"
              disabled={assigningLayout}
              onClick={onAddToProjects}
            >
              Add to {selectedProjects.size} project
              {selectedProjects.size !== 1 ? 's' : ''}
            </button>
          )}
        </>
      )}

      <button type="button" className="plugins__assign-skip" onClick={onClose}>
        Skip for now
      </button>
    </ResponsiveDialogSurface>
  );
}
