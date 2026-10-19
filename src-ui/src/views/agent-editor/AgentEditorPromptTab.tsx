import type { AgentEngineValidationFinding } from '@kontourai/station-contracts/agent-validation';
import { InfoTip } from '../../components/InfoTip';
import { SparkleGlyph } from '../../components/icons/Glyph';
import type { AgentEditorFormProps } from './types';
import { buildSystemPromptPrompt } from './utils';

const DELIVERY_TRAILER =
  "This content is saved with the agent and stays portable, but this engine won't deliver it. You can edit or remove it, or choose another engine.";

export function AgentEditorPromptTab({
  form,
  setForm,
  locked,
  validationErrors,
  enrich,
  isEnriching,
  promptIsRequired,
  finding,
  firstTurnDelivery = false,
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
  firstTurnDelivery?: boolean;
}) {
  return (
    <div className="agent-editor__section">
      {finding && (
        <div className="agent-editor__capability-banner" role="status">
          {finding.message}.{' '}
          <InfoTip label="System instructions">{DELIVERY_TRAILER}</InfoTip>
        </div>
      )}
      {firstTurnDelivery && (
        <p className="agent-editor__section-desc">
          Sent with the first message in each new chat. These instructions use
          the same priority as your message.
        </p>
      )}
      <div className="editor-field">
        <div className="editor-label-row">
          <label className="editor-label" htmlFor="ae-prompt">
            Instructions{' '}
            {promptIsRequired && <span className="editor-required">*</span>}
          </label>
          <button
            type="button"
            className="editor-enrich-btn"
            disabled={isEnriching || !form.name || locked}
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
          aria-required={promptIsRequired}
          disabled={locked}
        />
        {validationErrors.prompt && (
          <span className="editor-error">{validationErrors.prompt}</span>
        )}
      </div>
    </div>
  );
}
