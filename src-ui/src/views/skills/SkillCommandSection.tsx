import {
  skillCommandNameError,
  skillCommandSlug,
} from '@kontourai/station-contracts/skill-command';
import { Toggle } from '../../components/Toggle';
import {
  formCommandWord,
  formVariables,
  type SkillForm,
} from './skill-view-utils';

interface SkillCommandSectionProps {
  form: SkillForm;
  /** False for a package/plugin/registry skill Station must not write to. */
  editable: boolean;
  /**
   * Why the declared command is not in effect, as the SERVER resolved it
   * (a clash with another skill, or a word nobody can type). Rendered as-is:
   * a declaration that does nothing must say so rather than read as enabled.
   */
  commandDiagnostic?: string;
  onChange: (updates: Partial<SkillForm>) => void;
}

/**
 * The two facts that make a skill a slash command, plus the variables its body
 * substitutes and what the body looks like once they are filled in.
 *
 * "Runnable as /command" and "Offer to every agent" are deliberately two
 * switches, not one (`SkillCommand`): the first says the skill CAN be typed,
 * the second says it is offered without being attached to the agent. Collapsing
 * them would make "attached to these agents only" inexpressible.
 */
export function SkillCommandSection({
  form,
  editable,
  commandDiagnostic,
  onChange,
}: SkillCommandSectionProps) {
  const variables = formVariables(form);
  const commandWord = formCommandWord(form);
  /**
   * archive#3737: the server refused `Ship It` with the rule it broke, the
   * refusal never reached the screen, and this field went on promising
   * "Type /Ship It in chat." — a command that does not exist and cannot be
   * typed. The rule is the contract's, the same one the HTTP schema applies,
   * so the field cannot offer a word the save will refuse.
   */
  const commandWordError =
    form.commandEnabled && commandWord !== null
      ? skillCommandNameError(commandWord)
      : null;
  // The preview substitutes DEFAULTS only. A placeholder with no default is
  // left standing as itself rather than blanked — the reader is looking at
  // what the agent will receive, and an empty gap is not that.
  const preview = form.body.replace(
    /\{\{([\w.-]+)\}\}/g,
    (match, key: string) =>
      variables.find((variable) => variable.name === key)?.default || match,
  );

  return (
    <>
      <div className="agent-editor__section">
        <div className="editor-field editor-field--row">
          {editable ? (
            <Toggle
              checked={form.commandEnabled}
              onChange={(value) => onChange({ commandEnabled: value })}
              size="sm"
              label="Runnable as a slash command"
            />
          ) : null}
          <span className="editor-label">
            {editable
              ? 'Runnable as a slash command'
              : 'Install to workspace to make this a command'}
          </span>
        </div>

        {editable && form.commandEnabled && (
          <>
            <div className="editor-field">
              <label className="editor-label" htmlFor="skill-command-name">
                Command word
              </label>
              <input
                id="skill-command-name"
                className="editor-input"
                value={form.commandName}
                placeholder={skillCommandSlug(form.name) || 'skill-name'}
                onChange={(event) =>
                  onChange({ commandName: event.target.value })
                }
              />
              {commandWordError ? (
                <div className="editor-error" role="alert">
                  {commandWordError}
                </div>
              ) : (
                <div className="editor-help">
                  Type <code>/{commandWord || 'skill-name'}</code> in chat.
                </div>
              )}
            </div>
            <div className="editor-field editor-field--row">
              <Toggle
                checked={form.commandGlobal}
                onChange={(value) => onChange({ commandGlobal: value })}
                size="sm"
                label="Offer to every agent"
              />
              <span className="editor-label">
                Offer to every agent, without attaching it
              </span>
            </div>
          </>
        )}

        {commandDiagnostic && (
          <div className="editor-error" role="status">
            {commandDiagnostic}
          </div>
        )}
      </div>

      {variables.length > 0 && (
        <div className="agent-editor__section">
          <div className="editor-field">
            <span className="editor-label">Variables</span>
            <div className="editor-help">
              Taken from the body. Filled in from the words typed after the
              command, in this order.
            </div>
            <div className="skill-variables">
              {variables.map((variable, index) => (
                <div key={variable.name} className="skill-variables__row">
                  <code className="editor__tag">{`{{${variable.name}}}`}</code>
                  <input
                    className="editor-input"
                    aria-label={`Description for ${variable.name}`}
                    placeholder="What goes here"
                    value={variable.description ?? ''}
                    disabled={!editable}
                    onChange={(event) =>
                      onChange({
                        variables: variables.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, description: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                  <input
                    className="editor-input"
                    aria-label={`Default for ${variable.name}`}
                    placeholder="Default"
                    value={variable.default ?? ''}
                    disabled={!editable}
                    onChange={(event) =>
                      onChange({
                        variables: variables.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, default: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {form.body.trim() !== '' && (
        <div className="agent-editor__section">
          <details className="editor__expandable">
            <summary className="editor__expandable-header">
              <span className="editor__section-title">Preview</span>
            </summary>
            <div className="editor__expandable-content">
              <div className="skill-preview">{preview}</div>
            </div>
          </details>
        </div>
      )}
    </>
  );
}
