import { CHAT_ATTACHMENT_MAX_COUNT } from '@kontourai/station-contracts/chat-attachment';
import type { SkillExperienceDefinitionV1 } from '@kontourai/station-contracts/skill-experience';
import { useId } from 'react';
import './skill-experiences.css';

export function SkillExperienceForm({
  definition,
  values,
  onChange,
  errors = {},
  disabled = false,
  attachmentChoices = [],
  attachmentAssignments,
  onAttachmentsChange,
}: {
  definition: Pick<SkillExperienceDefinitionV1, 'inputs'>;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
  attachmentChoices?: Array<{ id: string; name: string }>;
  attachmentAssignments?: Record<string, string[]>;
  onAttachmentsChange?: (assignments: Record<string, string[]>) => void;
}) {
  const prefix = useId();
  return (
    <div className="skill-experience-form">
      {definition.inputs.map((input) => {
        const id = `${prefix}-${input.id}`;
        const hint = `${id}-hint`;
        const errorId = `${id}-error`;
        const selectedFiles =
          new Map(Object.entries(attachmentAssignments ?? {})).get(input.id) ??
          (definition.inputs.filter((field) => field.kind === 'attachments')
            .length === 1
            ? attachmentChoices.map((file) => file.id)
            : []);
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
              <div>
                <p>
                  Attach files in the chat composer, then choose up to{' '}
                  {Math.min(input.maxCount, CHAT_ATTACHMENT_MAX_COUNT)} for{' '}
                  {input.label.toLowerCase()}.
                </p>
                {onAttachmentsChange &&
                  attachmentChoices.map((file) => (
                    <label
                      className="skill-experience-form__attachment"
                      key={file.id}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${input.label}: ${file.name}`}
                        checked={selectedFiles.includes(file.id)}
                        disabled={
                          disabled ||
                          (!selectedFiles.includes(file.id) &&
                            selectedFiles.length >=
                              Math.min(
                                input.maxCount,
                                CHAT_ATTACHMENT_MAX_COUNT,
                              ))
                        }
                        onChange={(event) =>
                          onAttachmentsChange({
                            ...attachmentAssignments,
                            [input.id]: event.target.checked
                              ? [...selectedFiles, file.id]
                              : selectedFiles.filter((id) => id !== file.id),
                          })
                        }
                      />
                      {file.name}
                    </label>
                  ))}
              </div>
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
