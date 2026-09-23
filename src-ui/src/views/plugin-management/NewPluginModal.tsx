import { Button } from '../../components/Button';
import { PathAutocomplete } from '../../components/PathAutocomplete';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import { hasLocalStationForProfile } from '../../platform/client-origin-surface';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import type { PluginScaffoldTemplateChoice } from './plugin-scaffold-client';
import { useNewPluginFlow } from './useNewPluginFlow';

const TEMPLATE_CHOICES: {
  value: PluginScaffoldTemplateChoice;
  label: string;
  description: string;
}[] = [
  {
    value: 'pane',
    label: 'Pane',
    description: 'One Workspace Pane with a stylesheet. The usual start.',
  },
  {
    value: 'full',
    label: 'Pane and Agent',
    description: 'Two Panes and an Agent definition.',
  },
  {
    value: 'provider',
    label: 'Server provider',
    description:
      'A server module and a branding provider. Installing it needs trusted permissions.',
  },
];

/**
 * Plugins → New plugin. Makes a Project on an empty folder, writes a starter
 * plugin into it, opens the Project, and offers an authoring chat with an
 * opening message ready in the composer. It installs nothing: the finished
 * plugin goes through Install plugin like any other.
 */
export function NewPluginModal({ onClose }: { onClose: () => void }) {
  const flow = useNewPluginFlow(onClose);
  const profile = usePlatformProfile();
  const pickFolder = hasLocalStationForProfile(profile);
  const nameHintId = 'new-plugin-name-hint';

  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onClose}
      ariaLabelledBy="new-plugin-title"
      overlayClassName="plugins__modal-overlay"
      panelClassName="plugins__modal plugins__modal--install"
    >
      <div className="plugins__modal-header">
        <h3 id="new-plugin-title" className="plugins__modal-title">
          New Plugin
        </h3>
        <ResponsiveDialogCloseButton
          onClick={onClose}
          label="Close new plugin"
        />
      </div>
      <form
        className="plugins__modal-body plugins__modal-body--visible plugins__new-plugin"
        onSubmit={(event) => void flow.submit(event)}
      >
        <fieldset
          className="plugins__new-plugin-fields"
          disabled={flow.submitting || flow.created !== null}
        >
          <div className="editor-field">
            <label className="editor-label" htmlFor="new-plugin-name">
              Plugin name
            </label>
            <input
              id="new-plugin-name"
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
            <label className="editor-label" htmlFor="new-plugin-title-input">
              Title <span className="editor-hint"> optional</span>
            </label>
            <input
              id="new-plugin-title-input"
              className="editor-input"
              value={flow.title}
              onChange={(event) => flow.setTitle(event.target.value)}
              placeholder={flow.displayName || 'My Plugin'}
            />
          </div>
          {pickFolder && (
            <div className="editor-field">
              <label className="editor-label" htmlFor="new-plugin-directory">
                Folder <span className="editor-hint"> optional</span>
              </label>
              <PathAutocomplete
                id="new-plugin-directory"
                value={flow.directory}
                onChange={flow.setDirectory}
                placeholder="/path/to/empty/folder"
                className="editor-input path-autocomplete__input"
                browsable
                autoFocus={false}
              />
              <p className="plugins__install-hint">
                Choose an empty folder, or leave this blank and Station makes
                one for the Project.
              </p>
            </div>
          )}
          <fieldset className="plugins__new-plugin-templates">
            <legend className="editor-label">Start from</legend>
            {TEMPLATE_CHOICES.map((choice) => (
              <label
                key={choice.value}
                className="plugins__new-plugin-template"
              >
                <input
                  type="radio"
                  name="new-plugin-template"
                  value={choice.value}
                  checked={flow.template === choice.value}
                  onChange={() => flow.setTemplate(choice.value)}
                />
                <span>
                  <strong>{choice.label}</strong>
                  <span className="plugins__install-hint">
                    {choice.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </fieldset>
        {flow.created && (
          <p className="plugins__install-hint" role="status">
            Project {flow.created.name} was created. Retry writes the plugin
            into that same Project.
          </p>
        )}
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
            pendingLabel="Creating…"
            disabled={!flow.canSubmit}
          >
            {flow.created ? 'Retry' : 'Create plugin'}
          </Button>
        </ResponsiveSurfaceActions>
      </form>
    </ResponsiveDialogSurface>
  );
}
