interface ProjectKnowledgeRulesEditorProps {
  rulesLoaded: boolean;
  rulesLoading: boolean;
  rulesError?: boolean;
  /** The query's actual `error` — read failure text comes from this, not a boolean. */
  rulesFailure?: unknown;
  onRetryRules?: () => void;
  rulesContent: string;
  savingRules: boolean;
  rulesSaveFailure?: unknown;
  onRulesChange: (value: string) => void;
  onSaveRules: () => void;
}

export function ProjectKnowledgeRulesEditor({
  rulesLoaded,
  rulesLoading,
  rulesError,
  rulesFailure,
  onRetryRules,
  rulesContent,
  savingRules,
  rulesSaveFailure,
  onRulesChange,
  onSaveRules,
}: ProjectKnowledgeRulesEditorProps) {
  return (
    <div className="project-page__rules-editor">
      <div className="project-page__rules-hint">
        <EngineGlyph /> Injected into every chat message&apos;s system
        instructions. Saved as <code>project-rules.md</code>.
      </div>
      {!rulesLoaded && rulesLoading ? (
        <SkeletonBlock count={1} label="Loading rules" />
      ) : // archive#771: this used to fall straight through to an EMPTY,
      // EDITABLE textarea on a settled error — no message at all, and the
      // save button's own guard (`!rulesContent.trim`) is the only thing
      // standing between that and silently clobbering saved rules.
      !rulesLoaded && rulesError ? (
        <ErrorState
          variant="compact"
          title="Couldn't load project rules"
          description={describeReadFailure(rulesFailure)}
          action={
            onRetryRules ? (
              <button type="button" onClick={onRetryRules}>
                Retry
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <textarea
            value={rulesContent}
            onChange={(event) => onRulesChange(event.target.value)}
            placeholder="Add project rules... e.g. 'Always respond in bullet points' or 'This project uses Python 3.12 with FastAPI'"
            className="project-page__rules-textarea"
          />
          <button
            type="button"
            onClick={onSaveRules}
            disabled={savingRules || !rulesContent.trim()}
            className="project-page__add-btn project-page__add-btn--primary"
          >
            {savingRules ? 'Saving…' : 'Save Rules'}
          </button>
          {rulesSaveFailure != null && (
            <ErrorState
              variant="compact"
              title="Couldn't save project rules"
              description={describeReadFailure(rulesSaveFailure)}
            />
          )}
        </>
      )}
    </div>
  );
}

import { EngineGlyph } from '../../components/icons/Glyph';
import {
  describeReadFailure,
  ErrorState,
  SkeletonBlock,
} from '../../components/state';
