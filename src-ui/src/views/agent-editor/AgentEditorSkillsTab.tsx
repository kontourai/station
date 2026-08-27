import type { AgentEngineValidationFinding } from '@kontourai/station-contracts/agent-validation';
import { resolveSkillCommandName } from '@kontourai/station-contracts/skill-command';
import { Checkbox } from '../../components/Checkbox';
import type { AgentEditorFormProps } from './types';

const READONLY_TRAILER =
  "This content is saved with the agent and stays portable, but this engine won't deliver it.";

export function AgentEditorSkillsTab({
  form,
  setForm,
  locked,
  availableSkills,
  onNavigate,
  onOpenAddModal,
  finding,
  engineDefaultSkillsHint,
}: Pick<
  AgentEditorFormProps,
  | 'form'
  | 'setForm'
  | 'locked'
  | 'availableSkills'
  | 'onNavigate'
  | 'onOpenAddModal'
> & {
  finding?: AgentEngineValidationFinding;
  /**
   * Station#975 D-1 §4.2 engine-default hint: the bound connection's own
   * `config.provideSkills` count, shown only when the surface is
   * deliverable and the agent hasn't authored its own skills (so the
   * connection default will apply).
   */
  engineDefaultSkillsHint?: number;
}) {
  const readOnly = !!finding;
  const effectiveLocked = locked || readOnly;

  return (
    <>
      {finding && (
        <div className="agent-editor__section">
          <div className="agent-editor__capability-banner" role="status">
            {finding.message}. {READONLY_TRAILER}
          </div>
        </div>
      )}
      <div className="agent-editor__section">
        <div className="editor-field">
          <div className="editor-label-row">
            <span className="editor-label">Skills</span>
            <span className="editor-label-row__actions">
              <span className="editor__tools-server-count">
                {form.skills.length} enabled
              </span>
              <button
                type="button"
                className="editor-enrich-btn"
                onClick={() => onNavigate({ type: 'guidance', tab: 'skills' })}
              >
                + new
              </button>
              {!effectiveLocked && (
                <button
                  type="button"
                  className="editor-enrich-btn"
                  onClick={() => onOpenAddModal('skills')}
                >
                  + Add
                </button>
              )}
            </span>
          </div>
          {!readOnly &&
            !!engineDefaultSkillsHint &&
            form.skills.length === 0 && (
              <span className="editor-hint">
                {`This engine connection's default provides ${engineDefaultSkillsHint} skill(s) when the agent doesn't set its own.`}
              </span>
            )}
          {form.skills.length === 0 ? (
            <div className="editor__tools-empty">
              No skills enabled.{' '}
              {!effectiveLocked && availableSkills.length > 0 && (
                <button
                  type="button"
                  className="editor__tools-link"
                  onClick={() => onOpenAddModal('skills')}
                >
                  Add skills
                </button>
              )}
            </div>
          ) : (
            <div className="editor__tools-server">
              <div className="editor__tools-list">
                {availableSkills
                  .filter((skill: any) => form.skills.includes(skill.name))
                  .map((skill: any) => (
                    <div
                      key={skill.name}
                      className="editor__tool-item editor__tool-item--active"
                    >
                      <Checkbox
                        checked={true}
                        disabled={effectiveLocked}
                        onChange={() => {
                          if (effectiveLocked) {
                            return;
                          }
                          setForm((current) => ({
                            ...current,
                            skills: current.skills.filter(
                              (entry: string) => entry !== skill.name,
                            ),
                          }));
                        }}
                      />
                      <div className="editor__tool-info">
                        <div className="editor__tool-name">
                          {skill.name}
                          {/* A skill the agent can also RUN as a command. The
                              chip is derived from the skill's own resolved
                              command, not from the fact that it is attached. */}
                          {resolveSkillCommandName(skill) && (
                            <code className="editor__tool-command">
                              /{resolveSkillCommandName(skill)}
                            </code>
                          )}
                        </div>
                        {skill.description && (
                          <div className="editor__tool-desc">
                            {skill.description}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
