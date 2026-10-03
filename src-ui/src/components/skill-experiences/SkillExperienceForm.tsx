import { CHAT_ATTACHMENT_MAX_COUNT } from '@kontourai/station-contracts/chat-attachment';
import type { SkillExperienceDefinitionV1 } from '@kontourai/station-contracts/skill-experience';
import { useId } from 'react';
import './skill-experiences.css';

export {
  skillExperienceInputDefaults,
  skillExperienceInputErrors,
} from '@kontourai/station-shared/skill-experience-values';

export function SkillExperienceForm({
  definition,
  values,
  onChange,
  errors = {},
  disabled = false,
}: {
  definition: SkillExperienceDefinitionV1;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  const prefix = useId();
  return (
    <div className="skill-experience-form">
      {definition.inputs.map((input) => {
        const id = `${prefix}-${input.id}`;
        const hint = `${id}-hint`;
        const errorId = `${id}-error`;
        const error = Object.hasOwn(errors, input.id)
          ? errors[input.id]
          : undefined;
        const describedBy =
          [input.description ? hint : '', error ? errorId : '']
            .filter(Boolean)
            .join(' ') || undefined;
        const value = Object.hasOwn(values, input.id)
          ? values[input.id]
          : input.kind === 'attachments'
            ? ''
            : (input.default ?? '');
        return (
          <div className="skill-experience-form__field" key={input.id}>
            {input.kind !== 'attachments' ? (
              <label htmlFor={id}>
                {input.label}
                {input.required ? ' (required)' : ' (optional)'}
              </label>
            ) : (
              <strong>
                {input.label}
                {input.required ? ' (required)' : ' (optional)'}
              </strong>
            )}
            {input.description && <p id={hint}>{input.description}</p>}
            {input.kind === 'text' ? (
              <textarea
                id={id}
                value={value}
                disabled={disabled}
                aria-describedby={describedBy}
                aria-invalid={Boolean(error)}
                required={input.required}
                rows={3}
                onChange={(event) =>
                  onChange({ ...values, [input.id]: event.target.value })
                }
              />
            ) : input.kind === 'single-choice' ? (
              <select
                id={id}
                value={value}
                disabled={disabled}
                aria-describedby={describedBy}
                aria-invalid={Boolean(error)}
                required={input.required}
                onChange={(event) =>
                  onChange({ ...values, [input.id]: event.target.value })
                }
              >
                <option value="">Choose an option</option>
                {input.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <p>
                Use the chat composer to attach up to{' '}
                {Math.min(input.maxCount, CHAT_ATTACHMENT_MAX_COUNT)} files
                before starting.
              </p>
            )}
            <details>
              <summary>Why this input?</summary>
              <p>
                Author attribution: {input.provenance.origin}.{' '}
                {input.provenance.explanation}
              </p>
            </details>
            {error && (
              <p
                id={errorId}
                role="alert"
                className="skill-experience-form__error"
              >
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
