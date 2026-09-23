import { Button } from '../../components/Button';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import { PluginTemplateFieldset } from './PluginTemplateFieldset';
import { useStartPluginFlow } from './useStartPluginFlow';
// Opened from the Project page, where the Plugins view stylesheet that
// owns these modal classes is not otherwise loaded.
import '../PluginManagementView.css';

/**
 * Project page → "Start a plugin in this folder". Writes a starter plugin
 * into this Project's empty folder and offers an authoring chat with an
 * opening message ready in the composer. It installs nothing.
 */
export function StartPluginModal({
  project,
  onClose,
}: {
  project: { slug: string; name: string };
  onClose: () => void;
}) {
  const flow = useStartPluginFlow(project, onClose);
  const nameHintId = 'start-plugin-name-hint';

  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onClose}
      ariaLabelledBy="start-plugin-title"
      overlayClassName="plugins__modal-overlay"
      panelClassName="plugins__modal plugins__modal--install"
    >
      <div className="plugins__modal-header">
        <h3 id="start-plugin-title" className="plugins__modal-title">
          Start a Plugin
        </h3>
        <ResponsiveDialogCloseButton
          onClick={onClose}
          label="Close start a plugin"
        />
      </div>
      <form
        className="plugins__modal-body plugins__modal-body--visible plugins__new-plugin"
        onSubmit={(event) => void flow.submit(event)}
      >
        <p className="plugins__install-hint">
          The starter files go into {project.name}'s folder. Installing the
          plugin later is a separate step, through Plugins → Install plugin.
        </p>
        <fieldset
          className="plugins__new-plugin-fields"
          disabled={flow.submitting}
        >
          <div className="editor-field">
            <label className="editor-label" htmlFor="start-plugin-name">
              Plugin name
            </label>
            <input
              id="start-plugin-name"
              className="editor-input"
              value={flow.name}
              onChange={(event) => flow.setName(event.target.value)}
              placeholder="my-plugin"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={flow.nameProblem ? true : undefined}
              aria-describedby={nameHintId}
            />
            <p
              id={nameHintId}
              className={
                flow.nameProblem
                  ? 'plugins__new-plugin-error'
                  : 'plugins__install-hint'
              }
            >
              {flow.nameProblem ??
                'Lowercase letters, digits, hyphens or periods. It names the plugin everywhere.'}
            </p>
          </div>
          <div className="editor-field">
            <label className="editor-label" htmlFor="start-plugin-title-input">
              Title <span className="editor-hint"> optional</span>
            </label>
            <input
              id="start-plugin-title-input"
              className="editor-input"
              value={flow.title}
              onChange={(event) => flow.setTitle(event.target.value)}
              placeholder={flow.displayName || 'My Plugin'}
            />
          </div>
          <PluginTemplateFieldset
            name="start-plugin-template"
            value={flow.template}
            onChange={flow.setTemplate}
          />
        </fieldset>
        {flow.error && (
          <p className="plugins__new-plugin-error" role="alert">
            {flow.error}
          </p>
        )}
        <ResponsiveSurfaceActions className="plugins__confirm-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            pending={flow.submitting}
            pendingLabel="Starting…"
            disabled={!flow.canSubmit}
          >
            Start plugin
          </Button>
        </ResponsiveSurfaceActions>
      </form>
    </ResponsiveDialogSurface>
  );
}
