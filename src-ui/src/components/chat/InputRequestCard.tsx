import type {
  InputRequestContent,
  InputRequestField,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import {
  inputRequestContentProblems,
  inputRequestFieldLabel,
} from '@kontourai/station-shared/input-request';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { userFacingErrorMessage } from '../../utils/errorText';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import {
  clearInputRequestDraft,
  type InputRequestDraft,
  readInputRequestDraft,
  saveInputRequestDraft,
} from './inputRequestDrafts';
import {
  RequestCard,
  type RequestCardState,
  RequestSheet,
  useRequestSheet,
} from './RequestSheet';
import './InputRequestCard.css';

export type InputRequestAction = 'accept' | 'decline' | 'cancel';

const CARD_STATE: Record<InputRequestAction, RequestCardState> = {
  accept: 'answered',
  decline: 'declined',
  cancel: 'cancelled',
};

/** The draft value that stands for "my own answer" in a choice field. */
export const CUSTOM_CHOICE = '\u0000custom';

function initialDraft(form: InputRequestForm): InputRequestDraft {
  const values: InputRequestDraft['values'] = {};
  for (const field of form.body.fields) {
    if (field.default === undefined) continue;
    values[field.name] =
      typeof field.default === 'number' ? String(field.default) : field.default;
  }
  return { values, custom: {} };
}

/**
 * Read the draft as content. An untouched or emptied optional field is left
 * out rather than sent as an empty value nobody chose; the shared validator
 * (the one the server runs again) then decides.
 */
function contentFromDraft(
  form: InputRequestForm,
  draft: InputRequestDraft,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of form.body.fields) {
    const value = draft.values[field.name];
    if (value === undefined) continue;
    const custom = draft.custom[field.name] ?? '';
    switch (field.kind) {
      case 'number':
      case 'integer':
        if (typeof value === 'string' && value.trim() !== '')
          content[field.name] = Number(value);
        continue;
      case 'choice':
        content[field.name] = value === CUSTOM_CHOICE ? { custom } : value;
        continue;
      case 'multi-choice': {
        const items = Array.isArray(value) ? value : [];
        if (items.length === 0 && !field.required) continue;
        content[field.name] = items.map((item) =>
          item === CUSTOM_CHOICE ? { custom } : item,
        );
        continue;
      }
      default:
        if (value === '' && !field.required) continue;
        content[field.name] = value;
    }
  }
  return content;
}

function inputType(field: InputRequestField): string {
  if (field.kind === 'number' || field.kind === 'integer') return 'number';
  if (field.kind !== 'string') return 'text';
  if (field.secret) return 'password';
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

function sourceLabel(form: InputRequestForm): string {
  return form.source.startsWith('mcp:') ? 'Tool server request' : 'Question';
}

/**
 * #3390: the one renderer for a `station.input-request/v1` form — a harness
 * question or a tool server's elicitation. It reads only the contract. Send,
 * Decline and Cancel each return exactly that action; nothing is sent until
 * one is pressed. Send runs the shared validator first, marks every invalid
 * field (`aria-invalid`, its message tied to the field) and moves focus to
 * the first.
 *
 * Desktop answers inline. A phone keeps a compact card in the transcript and
 * opens the form in the shared request sheet (#3331); dismissing the sheet
 * only hides it, and the draft and the request both survive.
 */
export function InputRequestCard({
  form,
  draftKey,
  onRespond,
}: {
  form: InputRequestForm;
  /**
   * Saves the non-secret answers on this device under this key while the
   * request is open. Absent: nothing is saved.
   */
  draftKey?: string;
  onRespond: (
    action: InputRequestAction,
    content?: InputRequestContent,
  ) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<InputRequestDraft>(() =>
    initialDraft(form),
  );
  const [pending, setPending] = useState<InputRequestAction>();
  const [done, setDone] = useState<InputRequestAction>();
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<boolean>();
  const edited = useRef(false);
  const controls = useRef(new Map<string, HTMLElement>());
  const focusField = useRef<string | undefined>(undefined);
  const isMobile = useIsMobile();
  const sheet = useRequestSheet(!done);
  const hasSecret = form.body.fields.some(
    (field) => 'secret' in field && field.secret,
  );

  useEffect(() => {
    if (!draftKey) return;
    let active = true;
    void readInputRequestDraft(draftKey, form).then((stored) => {
      if (active && stored && !edited.current)
        setDraft((previous) => ({
          values: { ...previous.values, ...stored.values },
          custom: { ...previous.custom, ...stored.custom },
        }));
    });
    return () => {
      active = false;
    };
  }, [draftKey, form]);

  useEffect(() => {
    if (!draftKey || !edited.current || done) return;
    let active = true;
    void saveInputRequestDraft(draftKey, form, draft).then((ok) => {
      if (active) setSaved(ok);
    });
    return () => {
      active = false;
    };
  }, [draftKey, form, draft, done]);

  // After a refused Send, focus the first invalid field once it is marked.
  useEffect(() => {
    const name = focusField.current;
    if (!name) return;
    focusField.current = undefined;
    controls.current.get(name)?.focus();
  });

  const update = (name: string, value: InputRequestDraft['values'][string]) => {
    edited.current = true;
    setSaved(undefined);
    setError(undefined);
    setFieldErrors(({ [name]: _cleared, ...rest }) => rest);
    setDraft((previous) => ({
      ...previous,
      values: { ...previous.values, [name]: value },
    }));
  };
  const updateCustom = (name: string, text: string) => {
    edited.current = true;
    setSaved(undefined);
    setError(undefined);
    setFieldErrors(({ [name]: _cleared, ...rest }) => rest);
    setDraft((previous) => ({
      ...previous,
      custom: { ...previous.custom, [name]: text },
    }));
  };

  const respond = async (action: InputRequestAction) => {
    if (pending || done) return;
    let content: InputRequestContent | undefined;
    if (action === 'accept') {
      const candidate = contentFromDraft(form, draft);
      const problems = inputRequestContentProblems(form, candidate);
      const first = form.body.fields.find(
        (field) => problems.fields[field.name],
      );
      if (first || problems.form) {
        setFieldErrors(problems.fields);
        setError(problems.form);
        if (first) focusField.current = first.name;
        return;
      }
      content = candidate as InputRequestContent;
    }
    setPending(action);
    setError(undefined);
    try {
      await onRespond(action, content);
      setDone(action);
      if (draftKey) await clearInputRequestDraft(draftKey);
    } catch (problem) {
      setError(userFacingErrorMessage(problem));
    } finally {
      setPending(undefined);
    }
  };

  if (done && !isMobile)
    return (
      <section className="input-request-card" role="status">
        {done === 'accept'
          ? `Sent to ${form.requester}`
          : done === 'decline'
            ? `Declined ${form.requester}’s request`
            : `Cancelled ${form.requester}’s request`}
      </section>
    );

  const fieldId = (field: InputRequestField) => `${id}:${field.name}`;
  const errorId = (field: InputRequestField) => `${fieldId(field)}:error`;
  const descriptionId = (field: InputRequestField) =>
    `${fieldId(field)}:description`;
  const describedBy = (field: InputRequestField) =>
    [
      field.description ? descriptionId(field) : '',
      fieldErrors[field.name] ? errorId(field) : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const invalid = (field: InputRequestField) =>
    fieldErrors[field.name] ? true : undefined;
  const register =
    (field: InputRequestField, first: boolean) =>
    (node: HTMLElement | null) => {
      if (!first) return;
      if (node) controls.current.set(field.name, node);
      else controls.current.delete(field.name);
    };
  const label = (field: InputRequestField) => (
    <>
      {inputRequestFieldLabel(field)}
      {field.required ? (
        <span className="input-request-card__required"> (required)</span>
      ) : null}
    </>
  );
  const description = (field: InputRequestField) =>
    field.description ? (
      <span
        id={descriptionId(field)}
        className="input-request-card__description"
      >
        {field.description}
      </span>
    ) : null;
  const fieldError = (field: InputRequestField) =>
    fieldErrors[field.name] ? (
      <span id={errorId(field)} className="input-request-card__field-error">
        {fieldErrors[field.name]}
      </span>
    ) : null;

  const customInput = (
    field: Extract<InputRequestField, { kind: 'choice' | 'multi-choice' }>,
  ) => {
    const props = {
      id: `${fieldId(field)}:custom`,
      'aria-label': `Your answer to ${inputRequestFieldLabel(field)}`,
      'aria-invalid': invalid(field),
      'aria-describedby': describedBy(field),
      autoComplete: 'off',
      maxLength: 12000,
      value: draft.custom[field.name] ?? '',
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        updateCustom(field.name, event.target.value),
    };
    return field.secret ? (
      <input {...props} type="password" />
    ) : (
      <textarea {...props} rows={2} />
    );
  };

  const renderField = (field: InputRequestField) => {
    const value = draft.values[field.name];
    if (
      field.kind === 'boolean' ||
      field.kind === 'choice' ||
      field.kind === 'multi-choice'
    ) {
      const multiple = field.kind === 'multi-choice';
      const options =
        field.kind === 'boolean'
          ? [
              { value: 'true', label: 'Yes', description: undefined },
              { value: 'false', label: 'No', description: undefined },
            ]
          : [
              ...field.options,
              ...(field.allowCustom
                ? [
                    {
                      value: CUSTOM_CHOICE,
                      label: 'Other',
                      description: 'Answer in your own words',
                    },
                  ]
                : []),
            ];
      const selected = (option: string) =>
        field.kind === 'boolean'
          ? value === (option === 'true')
          : multiple
            ? Array.isArray(value) && value.includes(option)
            : value === option;
      const choose = (option: string) => {
        if (field.kind === 'boolean') update(field.name, option === 'true');
        else if (!multiple) update(field.name, option);
        else {
          const current = Array.isArray(value) ? value : [];
          update(
            field.name,
            current.includes(option)
              ? current.filter((item) => item !== option)
              : [...current, option],
          );
        }
      };
      return (
        <fieldset
          key={field.name}
          className="input-request-card__group"
          aria-describedby={describedBy(field)}
          aria-invalid={invalid(field)}
        >
          <legend>{label(field)}</legend>
          {description(field)}
          {multiple && (
            <span className="input-request-card__hint">Select any</span>
          )}
          <div className="input-request-card__options">
            {options.map((option, index) => (
              <label key={option.value} className="input-request-card__option">
                <input
                  ref={register(field, index === 0)}
                  type={multiple ? 'checkbox' : 'radio'}
                  name={fieldId(field)}
                  checked={selected(option.value)}
                  aria-invalid={invalid(field)}
                  onChange={() => choose(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <span>{option.description}</span>}
                </span>
              </label>
            ))}
          </div>
          {field.kind !== 'boolean' &&
            field.allowCustom &&
            selected(CUSTOM_CHOICE) &&
            customInput(field)}
          {fieldError(field)}
        </fieldset>
      );
    }
    const numeric = field.kind === 'number' || field.kind === 'integer';
    return (
      <div key={field.name} className="input-request-card__field">
        <label htmlFor={fieldId(field)}>{label(field)}</label>
        {description(field)}
        <input
          ref={register(field, true)}
          id={fieldId(field)}
          type={inputType(field)}
          {...(numeric
            ? {
                step: field.kind === 'integer' ? 1 : 'any',
                ...(field.minimum !== undefined ? { min: field.minimum } : {}),
                ...(field.maximum !== undefined ? { max: field.maximum } : {}),
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
          aria-invalid={invalid(field)}
          aria-describedby={describedBy(field)}
          autoComplete="off"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => update(field.name, event.target.value)}
        />
        {fieldError(field)}
      </div>
    );
  };

  // On a phone the Send button sits in the sheet's pinned footer, outside the
  // form element; `form=` keeps it this form's submit button, so Enter in a
  // field still submits and the same validation runs.
  const formId = `${id}:form`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void respond('accept');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === 'Enter' &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (!event.repeat) event.currentTarget.requestSubmit();
    }
  };
  const body = (
    <>
      {form.message && (
        <p className="input-request-card__message">{form.message}</p>
      )}
      <p className="input-request-card__provenance">
        Your answer goes to {form.requester}. Share only what you would give it
        directly.
      </p>
      <fieldset disabled={!!pending} className="input-request-card__fields">
        <legend className="sr-only">{form.requester} form</legend>
        {form.body.fields.map(renderField)}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {Object.keys(fieldErrors).length > 0 && (
        <p className="sr-only" role="alert">
          {`Check ${Object.keys(fieldErrors).length === 1 ? 'the marked answer' : 'the marked answers'} before sending.`}
        </p>
      )}
    </>
  );
  const draftStatus = draftKey ? (
    <span
      className="input-request-card__draft"
      role="status"
      title={
        hasSecret
          ? 'Private answers are not saved'
          : 'Draft saved on this device'
      }
    >
      {/* A private answer is never saved, so "Saved" would overclaim. */}
      {hasSecret
        ? 'Private'
        : saved === true
          ? 'Saved'
          : saved === false
            ? 'In this tab'
            : ''}
    </span>
  ) : null;
  const actions = (
    <ActionRow
      className="input-request-card__actions"
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
          form={isMobile ? formId : undefined}
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
  );
  const title = `${form.requester} needs your input`;

  if (isMobile)
    return (
      <>
        <RequestCard
          asker={title}
          question={form.message || inputRequestFieldLabel(form.body.fields[0])}
          state={done ? CARD_STATE[done] : 'pending'}
          onAnswer={sheet.show}
          triggerRef={sheet.triggerRef}
          notice={
            // A Send that fails after the sheet was dismissed would
            // otherwise report only inside a sheet nobody can see.
            !sheet.open && error ? <p role="alert">{error}</p> : null
          }
        />
        {sheet.open && (
          <RequestSheet
            title={title}
            subtitle={sourceLabel(form)}
            onDismiss={sheet.dismiss}
            returnFocusTarget={sheet.triggerRef.current}
            actions={actions}
          >
            <form
              id={formId}
              className="input-request-card"
              aria-label={`Answer ${form.requester}`}
              noValidate
              onSubmit={submit}
              onKeyDown={onKeyDown}
            >
              {body}
              {draftStatus}
            </form>
          </RequestSheet>
        )}
      </>
    );

  return (
    <form
      className="input-request-card"
      aria-label={`Answer ${form.requester}`}
      noValidate
      onSubmit={submit}
      onKeyDown={onKeyDown}
    >
      <div className="input-request-card__heading">
        <strong>{title}</strong>
        <span>{sourceLabel(form)}</span>
      </div>
      {body}
      <div className="input-request-card__footer">
        {draftStatus}
        {/* #3045: two labelled actions; Cancel (dismiss without choosing) is
            in the overflow menu, and still returns `cancel`, not `decline`. */}
        {actions}
      </div>
    </form>
  );
}
