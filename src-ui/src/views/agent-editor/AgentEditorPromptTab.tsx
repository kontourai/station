import type { AgentEngineValidationFinding } from '@kontourai/station-contracts/agent-validation';
import { SparkleGlyph } from '../../components/icons/Glyph';
import type { AgentEditorFormProps } from './types';
import { buildSystemPromptPrompt } from './utils';

const READONLY_TRAILER =
  "This content is saved with the agent and stays portable, but this engine won't deliver it.";

export function AgentEditorPromptTab({
  form,
  setForm,
  locked,
  validationErrors,
  enrich,
  isEnriching,
  promptIsRequired,
  finding,
}: Pick<
  AgentEditorFormProps,
  | 'form'
  | 'setForm'
  | 'locked'
  | 'validationErrors'
  | 'enrich'
  | 'isEnriching'
  | 'promptIsRequired'
> & {
  finding?: AgentEngineValidationFinding;
}) {
  const readOnly = !!finding;

  return (
    <div className="agent-editor__section">
      {finding && (
        <div className="agent-editor__capability-banner" role="status">
          {finding.message}. {READONLY_TRAILER}
        </div>
      )}
      <div className="editor-field">
        <div className="editor-label-row">
          <label className="editor-label" htmlFor="ae-prompt">
            System Instructions{' '}
            {promptIsRequired && !readOnly && (
              <span className="editor-required">*</span>
            )}
          </label>
          <button
            type="button"
            className="editor-enrich-btn"
            disabled={isEnriching || !form.name || locked || readOnly}
            aria-label="Generate system instructions"
            onClick={async () => {
              const text = await enrich(buildSystemPromptPrompt(form));
              if (text) {
                setForm((current) => ({ ...current, prompt: text.trim() }));
              }
            }}
          >
            {isEnriching ? (
              '...'
            ) : (
              <>
                <SparkleGlyph /> Generate
              </>
            )}
          </button>
        </div>
        <textarea
          id="ae-prompt"
          className="editor-textarea editor-textarea--tall editor-textarea--mono"
          name="prompt"
          value={form.prompt}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              prompt: event.target.value,
            }))
          }
          placeholder="You are a helpful assistant..."
          aria-required={promptIsRequired && !readOnly}
          disabled={locked || readOnly}
        />
        {validationErrors.prompt && (
          <span className="editor-error">{validationErrors.prompt}</span>
        )}
      </div>
    </div>
  );
}
