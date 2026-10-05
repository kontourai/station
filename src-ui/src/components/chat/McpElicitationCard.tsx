import type {
  McpElicitationContent,
  McpElicitationField,
  McpElicitationForm,
} from '@kontourai/station-contracts/mcp-elicitation';
import { validateMcpElicitationContent } from '@kontourai/station-shared/mcp-elicitation';
import { useId, useState } from 'react';
import { userFacingErrorMessage } from '../../utils/errorText';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import './HarnessQuestionCard.css';
import './McpElicitationCard.css';

/** What the person typed or chose, before it is read as form content. */
type Draft = Record<string, string | boolean | string[] | undefined>;

export type McpElicitationAction = 'accept' | 'decline' | 'cancel';

function initialDraft(form: McpElicitationForm): Draft {
  const draft: Draft = {};
  for (const field of form.fields) {
    if (field.default === undefined) continue;
    draft[field.name] =
      typeof field.default === 'number' ? String(field.default) : field.default;
  }
  return draft;
}

/**
 * Read the draft as content. An untouched or emptied optional field is left
 * out rather than sent as an empty value nobody chose; the shared validator
 * (the same one the server runs) then decides.
 */
function mcpElicitationContentFromDraft(
  form: McpElicitationForm,
  draft: Draft,
): McpElicitationContent {
  const content: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = draft[field.name];
    if (value === undefined) continue;
    if (field.kind === 'number' || field.kind === 'integer') {
      if (typeof value !== 'string' || value.trim() === '') continue;
      content[field.name] = Number(value);
      continue;
    }
    const empty = value === '' || (Array.isArray(value) && value.length === 0);
    if (empty && !field.required) continue;
    content[field.name] = value;
  }
  return validateMcpElicitationContent(form, content);
}

function inputType(field: McpElicitationField): string {
  if (field.kind !== 'string') return 'text';
  switch (field.format) {
    case 'email':
      return 'email';
    case 'uri':
      return 'url';
    case 'date':
      return 'date';
    default:
      return 'text';
  }
}

/**
 * #3284: a tool server's structured question, answered as the person this
 * turn runs for. Send, Decline and Cancel each return exactly that action to
 * the server; nothing is sent until one is pressed.
 */
export function McpElicitationCard({
  form,
  onRespond,
}: {
  form: McpElicitationForm;
  onRespond: (
    action: McpElicitationAction,
    content?: McpElicitationContent,
  ) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(form));
  const [pending, setPending] = useState<McpElicitationAction>();
  const [done, setDone] = useState<McpElicitationAction>();
  const [error, setError] = useState<string>();

  const update = (name: string, value: Draft[string]) => {
    setError(undefined);
    setDraft((previous) => ({ ...previous, [name]: value }));
  };

  const respond = async (action: McpElicitationAction) => {
    if (pending || done) return;
    let content: McpElicitationContent | undefined;
    if (action === 'accept') {
      try {
        content = mcpElicitationContentFromDraft(form, draft);
      } catch (problem) {
        setError(userFacingErrorMessage(problem));
        return;
      }
    }
    setPending(action);
    setError(undefined);
    try {
      await onRespond(action, content);
      setDone(action);
    } catch (problem) {
      setError(userFacingErrorMessage(problem));
    } finally {
      setPending(undefined);
    }
  };

  if (done)
    return (
      <section className="harness-question-card" role="status">
        {done === 'accept'
          ? `Sent to ${form.serverId}`
          : done === 'decline'
            ? `Declined ${form.serverId}’s request`
            : `Cancelled ${form.serverId}’s request`}
      </section>
    );

  const fieldId = (field: McpElicitationField) => `${id}:${field.name}`;
  const describedBy = (field: McpElicitationField) =>
    field.description ? `${fieldId(field)}:description` : undefined;
  const label = (field: McpElicitationField) => (
    <>
      {field.title?.trim() || field.name}
      {field.required ? (
        <span className="mcp-elicitation-card__required"> (required)</span>
      ) : null}
    </>
  );
  const description = (field: McpElicitationField) =>
    field.description ? (
      <span
        id={`${fieldId(field)}:description`}
        className="mcp-elicitation-card__description"
      >
        {field.description}
      </span>
    ) : null;

  return (
    <form
      className="harness-question-card mcp-elicitation-card"
      aria-label={`Answer ${form.serverId}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void respond('accept');
      }}
    >
      <div className="harness-question-card__heading">
        <strong>{form.serverId} needs your input</strong>
        <span>Tool server request</span>
      </div>
      <p className="mcp-elicitation-card__message">{form.message}</p>
      <p className="mcp-elicitation-card__provenance">
        Your answer goes to the {form.serverId} tool server. Share only what you
        would give it directly.
      </p>
      <fieldset disabled={!!pending} className="mcp-elicitation-card__fields">
        <legend className="sr-only">{form.serverId} form</legend>
        {form.fields.map((field) => {
          const value = draft[field.name];
          switch (field.kind) {
            case 'boolean':
            case 'choice':
            case 'multi-choice': {
              const options =
                field.kind === 'boolean'
                  ? [
                      { value: 'true', label: 'Yes' },
                      { value: 'false', label: 'No' },
                    ]
                  : field.options;
              const multiple = field.kind === 'multi-choice';
              const selected = (option: string) =>
                field.kind === 'boolean'
                  ? value === (option === 'true')
                  : multiple
                    ? Array.isArray(value) && value.includes(option)
                    : value === option;
              return (
                <fieldset
                  key={field.name}
                  className="mcp-elicitation-card__group"
                  aria-describedby={describedBy(field)}
                >
                  <legend>{label(field)}</legend>
                  {description(field)}
                  <div className="harness-question-card__options">
                    {options.map((option) => (
                      <label
                        key={option.value}
                        className="harness-question-card__option"
                      >
                        <input
                          type={multiple ? 'checkbox' : 'radio'}
                          name={fieldId(field)}
                          checked={selected(option.value)}
                          onChange={() => {
                            if (field.kind === 'boolean')
                              update(field.name, option.value === 'true');
                            else if (!multiple)
                              update(field.name, option.value);
                            else {
                              const current = Array.isArray(value) ? value : [];
                              update(
                                field.name,
                                current.includes(option.value)
                                  ? current.filter(
                                      (item) => item !== option.value,
                                    )
                                  : [...current, option.value],
                              );
                            }
                          }}
                        />
                        <span>
                          <strong>{option.label}</strong>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            }
            default:
              return (
                <label
                  key={field.name}
                  className="harness-question-card__custom mcp-elicitation-card__field"
                  htmlFor={fieldId(field)}
                >
                  <span>{label(field)}</span>
                  {description(field)}
                  <input
                    id={fieldId(field)}
                    type={
                      field.kind === 'number' || field.kind === 'integer'
                        ? 'number'
                        : inputType(field)
                    }
                    {...(field.kind === 'number' || field.kind === 'integer'
                      ? {
                          step: field.kind === 'integer' ? 1 : 'any',
                          ...(field.minimum !== undefined
                            ? { min: field.minimum }
                            : {}),
                          ...(field.maximum !== undefined
                            ? { max: field.maximum }
                            : {}),
                          inputMode:
                            field.kind === 'integer'
                              ? ('numeric' as const)
                              : ('decimal' as const),
                        }
                      : {})}
                    {...(field.kind === 'string' && field.format === 'date-time'
                      ? { placeholder: '2026-10-05T09:30:00Z' }
                      : {})}
                    aria-required={field.required}
                    aria-describedby={describedBy(field)}
                    autoComplete="off"
                    value={typeof value === 'string' ? value : ''}
                    onChange={(event) => update(field.name, event.target.value)}
                  />
                </label>
              );
          }
        })}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {/* #3045: two labelled actions; Cancel (dismiss without choosing) is
          in the overflow menu, and still returns `cancel`, not `decline`. */}
      <ActionRow
        className="harness-question-card__actions"
        overflowLabel="More answer options"
        secondary={
          <Button
            variant="secondary"
            disabled={!!pending}
            pending={pending === 'decline'}
            pendingLabel="Declining…"
            onClick={() => void respond('decline')}
          >
            Decline
          </Button>
        }
        primary={
          <Button
            type="submit"
            variant="primary"
            disabled={!!pending && pending !== 'accept'}
            pending={pending === 'accept'}
            pendingLabel="Sending…"
          >
            Send
          </Button>
        }
        overflow={[
          {
            key: 'cancel',
            label: 'Cancel without answering',
            disabled: !!pending,
            onSelect: () => void respond('cancel'),
          },
        ]}
      />
    </form>
  );
}
