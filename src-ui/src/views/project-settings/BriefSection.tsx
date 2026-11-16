import {
  PROJECT_GOAL_MAX_CHARS,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
} from '@kontourai/station-contracts/project-session-context';
import { useId } from 'react';
import { PageSection } from '../../components/PageSection';
import type { ProjectForm } from './types';

type SetField = <K extends keyof ProjectForm>(
  key: K,
  value: ProjectForm[K],
) => void;

/**
 * The prompts a brief answers, as placeholder structure. From Anthropic's
 * guidance for Claude Projects' instructions.
 */
export const PROJECT_BRIEF_TEMPLATE = [
  'What this Project is for:',
  'Where work happens (repository, base branch, pull request naming):',
  'How to check your own work before saying it is done:',
  "When something you need is missing: say what's missing and stop; don't substitute, mock or guess.",
  'What needs my go-ahead first:',
].join('\n\n');

/**
 * #5062: the Project brief. Every new Session in the Project starts with it,
 * on every engine. Saved with the page's Save.
 */
export function BriefSection({
  form,
  setField,
}: {
  form: ProjectForm;
  setField: SetField;
}) {
  const goalId = useId();
  const goalHintId = useId();
  const instructionsId = useId();
  const instructionsHintId = useId();
  return (
    <PageSection
      id="section-brief"
      className="project-settings__section"
      title="Brief"
      description="Every new Session in this Project starts with its goal and instructions, on any engine. Running Sessions keep the brief they started with."
    >
      <div className="project-settings__brief-field">
        <label htmlFor={goalId} className="project-settings__brief-label">
          Goal
        </label>
        <input
          id={goalId}
          className="editor-input"
          type="text"
          aria-describedby={goalHintId}
          maxLength={PROJECT_GOAL_MAX_CHARS}
          value={form.goal}
          placeholder="Ship the new export flow by Friday"
          onChange={(event) =>
            setField('goal', event.target.value.replace(/[\r\n]+/g, ' '))
          }
        />
        <p id={goalHintId} className="project-settings__brief-hint">
          One line, shown on the Project page.
        </p>
      </div>
      <div className="project-settings__brief-field">
        <label
          htmlFor={instructionsId}
          className="project-settings__brief-label"
        >
          Instructions
        </label>
        <textarea
          id={instructionsId}
          className="editor-input project-settings__brief-textarea"
          aria-describedby={instructionsHintId}
          maxLength={PROJECT_INSTRUCTIONS_MAX_CHARS}
          rows={12}
          value={form.instructions}
          placeholder={PROJECT_BRIEF_TEMPLATE}
          onChange={(event) => setField('instructions', event.target.value)}
        />
        <p
          id={instructionsHintId}
          className="project-settings__brief-hint"
          aria-live="polite"
        >
          {form.instructions.length.toLocaleString()} /{' '}
          {PROJECT_INSTRUCTIONS_MAX_CHARS.toLocaleString()} characters
        </p>
      </div>
      <dl className="project-settings__brief-kinds">
        <div>
          <dt>Brief</dt>
          <dd>Your standing instructions for every Session in this Project.</dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>Notes agents save as they work, read as background.</dd>
        </div>
        <div>
          <dt>Repository instructions</dt>
          <dd>
            Rules for one codebase, kept in its <code>AGENTS.md</code> or{' '}
            <code>CLAUDE.md</code>.
          </dd>
        </div>
      </dl>
    </PageSection>
  );
}
