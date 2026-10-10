import type {
  InputRequestBody,
  InputRequestContent,
  InputRequestCustomAnswer,
  InputRequestDecisionBody,
  InputRequestDecisionOption,
  InputRequestField,
  InputRequestForm,
  InputRequestOption,
  InputRequestOutcome,
  InputRequestResponse,
  InputRequestSource,
  InputRequestStringFormat,
  InputRequestValue,
} from '@kontourai/station-contracts/input-request';
import {
  INPUT_REQUEST_HEADER_MAX_CHARS,
  INPUT_REQUEST_SCHEMA,
} from '@kontourai/station-contracts/input-request';
import type { ApprovalStatus } from '@kontourai/station-contracts/runtime-events';

/**
 * #3390: the one reader and validator for `station.input-request/v1`. The
 * browser renders and checks with it; the server runs the same check again
 * against the exact request event it opened, so a client that skips the
 * check gains nothing.
 *
 * Bounds are refused, never cut down: a form missing a field its source
 * asked for would return content the source did not get to ask about.
 */
export const INPUT_REQUEST_MAX_FIELDS = 32;
export const INPUT_REQUEST_MAX_OPTIONS = 64;
export const INPUT_REQUEST_MAX_MESSAGE_CHARS = 8000;
export const INPUT_REQUEST_MAX_TEXT_CHARS = 12000;
const MAX_NAME_CHARS = 256;
const MAX_LABEL_CHARS = 512;
const MAX_DESCRIPTION_CHARS = 2000;

const FORMATS = new Set<InputRequestStringFormat>([
  'email',
  'uri',
  'date',
  'date-time',
]);

function plainPrototype(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * An untrusted object, read by its own keys only. A plain or null-prototype
 * object becomes a null-prototype snapshot of its own enumerable keys, so no
 * later read can reach an inherited property (`Object.create({ kind:
 * 'form' })` has no `kind` here). Anything else — an array, a class
 * instance, an object with any other prototype — is refused (null).
 */
export function ownRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!plainPrototype(value)) return null;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value))
    snapshot[key] = (value as Record<string, unknown>)[key];
  return snapshot;
}
const own = ownRecord;

/**
 * An untrusted array, read by its own indexes only: a plain array becomes a
 * fresh copy with each element read once (a hole reads as `undefined`).
 * Anything else — not an array, or an array with another prototype — is
 * refused (null). The ingress companion of {@link ownRecord}.
 */
export function ownArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return null;
  const length = value.length;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1)
    copy.push(Object.hasOwn(value, index) ? value[index] : undefined);
  return copy;
}

/**
 * A field-keyed dictionary with no prototype, so a field named `constructor`
 * or `toString` reads as itself and never as something inherited.
 */
function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Stored requests are read strictly: a key this version does not define is
 * a refusal, not something to drop. That is what keeps a decision's
 * `effect` from ever riding inside a form. A JSON `"__proto__"` key is an
 * own key like any other, and so refused too. `ownRecord` snapshots are
 * null-prototype, which this accepts.
 */
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return (
    plainPrototype(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function optionalText(value: unknown, max: number): boolean {
  return value === undefined || text(value, max);
}

function optionalCount(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}

function optionalFinite(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isFinite(value))
  );
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/** Copy only the keys that are present, so a read value equals its input. */
function present<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function readOption(input: unknown): InputRequestOption | null {
  const value = own(input);
  if (
    !value ||
    !onlyKeys(value, ['value', 'label', 'description']) ||
    !text(value.value, MAX_LABEL_CHARS) ||
    !text(value.label, MAX_LABEL_CHARS) ||
    !optionalText(value.description, MAX_DESCRIPTION_CHARS)
  )
    return null;
  return present({
    value: value.value,
    label: value.label,
    description: value.description as string | undefined,
  });
}

function readOptions(input: unknown): InputRequestOption[] | null {
  const value = ownArray(input);
  if (!value || value.length < 1 || value.length > INPUT_REQUEST_MAX_OPTIONS)
    return null;
  const options: InputRequestOption[] = [];
  for (const item of value) {
    const option = readOption(item);
    if (!option || options.some((other) => other.value === option.value))
      return null;
    options.push(option);
  }
  return options;
}

/**
 * A field named `__proto__` is refused. JSON parsers keep it as an own key,
 * but the request route's schema (Zod) drops it and object spreads
 * reinterpret it, so an answer to it could never arrive intact. Every other
 * name, `constructor` or `toString` included, is an ordinary field.
 */
const REFUSED_FIELD_NAMES = new Set(['__proto__']);

const BASE_KEYS = [
  'name',
  'header',
  'title',
  'description',
  'required',
  'kind',
];

/** A present header is a real label: never blank, never over the bound. */
function optionalHeader(value: unknown): boolean {
  return (
    value === undefined ||
    (text(value, INPUT_REQUEST_HEADER_MAX_CHARS) && value.trim() !== '')
  );
}

/** Read one field from untrusted storage, or null when it is not one. */
export function readInputRequestField(
  input: unknown,
): InputRequestField | null {
  const value = own(input);
  if (
    !value ||
    !text(value.name, MAX_NAME_CHARS) ||
    !value.name ||
    REFUSED_FIELD_NAMES.has(value.name) ||
    typeof value.required !== 'boolean' ||
    !optionalHeader(value.header) ||
    !optionalText(value.title, MAX_LABEL_CHARS) ||
    !optionalText(value.description, MAX_DESCRIPTION_CHARS)
  )
    return null;
  const base = present({
    name: value.name,
    header: value.header as string | undefined,
    title: value.title as string | undefined,
    description: value.description as string | undefined,
    required: value.required,
  });
  switch (value.kind) {
    case 'string': {
      if (
        !onlyKeys(value, [
          ...BASE_KEYS,
          'minLength',
          'maxLength',
          'format',
          'default',
          'secret',
        ]) ||
        !optionalCount(value.minLength) ||
        !optionalCount(value.maxLength) ||
        (value.format !== undefined &&
          !FORMATS.has(value.format as InputRequestStringFormat)) ||
        !optionalText(value.default, INPUT_REQUEST_MAX_TEXT_CHARS) ||
        !optionalBoolean(value.secret)
      )
        return null;
      return present({
        ...base,
        kind: 'string' as const,
        minLength: value.minLength as number | undefined,
        maxLength: value.maxLength as number | undefined,
        format: value.format as InputRequestStringFormat | undefined,
        default: value.default as string | undefined,
        secret: value.secret as boolean | undefined,
      });
    }
    case 'number':
    case 'integer': {
      if (
        !onlyKeys(value, [...BASE_KEYS, 'minimum', 'maximum', 'default']) ||
        !optionalFinite(value.minimum) ||
        !optionalFinite(value.maximum) ||
        !optionalFinite(value.default)
      )
        return null;
      return present({
        ...base,
        kind: value.kind,
        minimum: value.minimum as number | undefined,
        maximum: value.maximum as number | undefined,
        default: value.default as number | undefined,
      });
    }
    case 'boolean':
      if (
        !onlyKeys(value, [...BASE_KEYS, 'default']) ||
        !optionalBoolean(value.default)
      )
        return null;
      return present({
        ...base,
        kind: 'boolean' as const,
        default: value.default as boolean | undefined,
      });
    case 'choice': {
      if (
        !onlyKeys(value, [
          ...BASE_KEYS,
          'options',
          'default',
          'allowCustom',
          'secret',
        ]) ||
        !optionalBoolean(value.allowCustom) ||
        !optionalBoolean(value.secret)
      )
        return null;
      const options = readOptions(value.options);
      if (
        !options ||
        (value.default !== undefined &&
          !options.some((option) => option.value === value.default))
      )
        return null;
      return present({
        ...base,
        kind: 'choice' as const,
        options,
        default: value.default as string | undefined,
        allowCustom: value.allowCustom as boolean | undefined,
        secret: value.secret as boolean | undefined,
      });
    }
    case 'multi-choice': {
      if (
        !onlyKeys(value, [
          ...BASE_KEYS,
          'options',
          'minItems',
          'maxItems',
          'default',
          'allowCustom',
          'secret',
        ]) ||
        !optionalCount(value.minItems) ||
        !optionalCount(value.maxItems) ||
        !optionalBoolean(value.allowCustom) ||
        !optionalBoolean(value.secret)
      )
        return null;
      const options = readOptions(value.options);
      const fallback =
        value.default === undefined ? undefined : ownArray(value.default);
      if (
        !options ||
        (value.default !== undefined &&
          (!fallback ||
            new Set(fallback).size !== fallback.length ||
            fallback.some(
              (item) => !options.some((option) => option.value === item),
            )))
      )
        return null;
      return present({
        ...base,
        kind: 'multi-choice' as const,
        options,
        minItems: value.minItems as number | undefined,
        maxItems: value.maxItems as number | undefined,
        default: fallback as string[] | undefined,
        allowCustom: value.allowCustom as boolean | undefined,
        secret: value.secret as boolean | undefined,
      });
    }
    default:
      return null;
  }
}

function readSource(value: unknown): InputRequestSource | null {
  if (!text(value, MAX_LABEL_CHARS)) return null;
  if (value === 'approval') return value;
  const match = /^(harness|mcp):(.+)$/.exec(value);
  return match ? (value as InputRequestSource) : null;
}

/**
 * Read a stored form request (a `request.opened` payload's `inputRequest`).
 * Refuses anything that is not exactly a v1 form: an unknown key anywhere, a
 * bound exceeded, a duplicate field or option, and any `decision` body. A
 * decision is never read from a payload a source wrote; Station derives it
 * from the approval request itself ({@link approvalDecisionBody}).
 */
export function readInputRequestForm(input: unknown): InputRequestForm | null {
  const value = own(input);
  const body = own(value?.body);
  if (
    !value ||
    !onlyKeys(value, ['schema', 'source', 'requester', 'message', 'body']) ||
    value.schema !== INPUT_REQUEST_SCHEMA ||
    !text(value.requester, MAX_LABEL_CHARS) ||
    !text(value.message, INPUT_REQUEST_MAX_MESSAGE_CHARS) ||
    !body ||
    !onlyKeys(body, ['kind', 'fields']) ||
    body.kind !== 'form' ||
    !ownArray(body.fields) ||
    (body.fields as unknown[]).length > INPUT_REQUEST_MAX_FIELDS
  )
    return null;
  const source = readSource(value.source);
  if (!source || source === 'approval') return null;
  const fields: InputRequestField[] = [];
  for (const item of ownArray(body.fields) ?? []) {
    const field = readInputRequestField(item);
    if (!field || fields.some((other) => other.name === field.name))
      return null;
    fields.push(field);
  }
  return {
    schema: INPUT_REQUEST_SCHEMA,
    source,
    requester: value.requester,
    message: value.message,
    body: { kind: 'form', fields },
  };
}

// --- Legacy stored harness questions ------------------------------------

/**
 * The pre-#3390 `payload.questionnaire` shape, exactly as the Claude and
 * Codex adapters wrote it. Read so stored requests keep rendering and
 * answering; nothing writes it any more.
 */
interface LegacyHarnessQuestion {
  id: string;
  header: string;
  prompt: string;
  options: Array<{ id: string; label: string; description: string }>;
  multiple: boolean;
  allowCustom: boolean;
  secret: boolean;
}

/** @internal Shared with the deprecated `harness-questions` module. */
export function readLegacyHarnessQuestions(
  input: unknown,
): LegacyHarnessQuestion[] | null {
  const value = own(input);
  if (
    !value ||
    !ownArray(value.questions) ||
    (value.questions as unknown[]).length < 1 ||
    (value.questions as unknown[]).length > 16
  )
    return null;
  const questions: LegacyHarnessQuestion[] = [];
  for (const item of ownArray(value.questions) ?? []) {
    const question = own(item);
    if (
      !question ||
      typeof question.id !== 'string' ||
      !question.id ||
      question.id.length > 256 ||
      typeof question.header !== 'string' ||
      typeof question.prompt !== 'string' ||
      !question.prompt.trim() ||
      typeof question.multiple !== 'boolean' ||
      typeof question.allowCustom !== 'boolean' ||
      typeof question.secret !== 'boolean' ||
      !ownArray(question.options) ||
      (question.options as unknown[]).length > 32
    )
      return null;
    const options: LegacyHarnessQuestion['options'] = [];
    for (const entry of ownArray(question.options) ?? []) {
      const option = own(entry);
      if (
        !option ||
        typeof option.id !== 'string' ||
        !option.id ||
        option.id.length > 256 ||
        typeof option.label !== 'string' ||
        !option.label.trim() ||
        typeof option.description !== 'string' ||
        options.some((item) => item.id === option.id)
      )
        return null;
      options.push({
        id: option.id,
        label: option.label,
        description: option.description,
      });
    }
    if (
      questions.some((item) => item.id === question.id) ||
      (!options.length && !question.allowCustom)
    )
      return null;
    questions.push({
      id: question.id,
      header: question.header,
      prompt: question.prompt,
      options,
      multiple: question.multiple,
      allowCustom: question.allowCustom,
      secret: question.secret,
    });
  }
  return questions;
}

/**
 * One harness question as a form field: free text when it offers no
 * options, otherwise a (multi-)choice field. Every harness question must be
 * answered, so every field is required and a multi-choice field needs at
 * least one item (a custom answer counts).
 */
export function harnessQuestionField(question: {
  id: string;
  header?: string;
  prompt: string;
  options: Array<{ id: string; label: string; description?: string }>;
  multiple: boolean;
  allowCustom: boolean;
  secret: boolean;
}): InputRequestField {
  // An engine's blank header is no label at all, so it is left out rather
  // than drawn as an empty slot.
  const base = {
    name: question.id,
    ...(question.header?.trim() ? { header: question.header } : {}),
    title: question.prompt,
    required: true,
  };
  if (question.options.length === 0)
    return {
      ...base,
      kind: 'string',
      ...(question.secret ? { secret: true } : {}),
    };
  const options = question.options.map((option) => ({
    value: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
  const extensions = {
    ...(question.allowCustom ? { allowCustom: true } : {}),
    ...(question.secret ? { secret: true } : {}),
  };
  return question.multiple
    ? { ...base, kind: 'multi-choice', options, minItems: 1, ...extensions }
    : { ...base, kind: 'choice', options, ...extensions };
}

/** Engine display names for a legacy event, which named only the provider. */
const LEGACY_REQUESTERS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * The input request a `request.opened` event carries: its `inputRequest`
 * form, or — for an event stored before #3390 — its legacy `questionnaire`,
 * adapted. An approval is not read here (see {@link approvalDecisionBody}).
 */
export function inputRequestFromRequestEvent(
  event:
    | {
        provider?: string;
        title?: string;
        payload?: Record<string, unknown>;
      }
    | undefined,
): InputRequestForm | null {
  const payload = own(event?.payload);
  if (!payload || !event) return null;
  if (payload.inputRequest !== undefined)
    return readInputRequestForm(payload.inputRequest);
  if (payload.mcpElicitation !== undefined) {
    const legacyForm = own(payload.mcpElicitation);
    if (
      !legacyForm ||
      !onlyKeys(legacyForm, ['serverId', 'message', 'fields']) ||
      typeof legacyForm.serverId !== 'string'
    )
      return null;
    return readInputRequestForm({
      schema: INPUT_REQUEST_SCHEMA,
      source: `mcp:${legacyForm.serverId}`,
      requester: legacyForm.serverId,
      message: legacyForm.message,
      body: { kind: 'form', fields: legacyForm.fields },
    });
  }
  const legacy = readLegacyHarnessQuestions(payload.questionnaire);
  if (!legacy) return null;
  const provider = event.provider ?? 'agent';
  return readInputRequestForm({
    schema: INPUT_REQUEST_SCHEMA,
    source: `harness:${provider}`,
    requester: LEGACY_REQUESTERS[provider] ?? provider,
    message:
      typeof event.title === 'string' && event.title.trim()
        ? event.title
        : 'The agent has questions for you',
    body: { kind: 'form', fields: legacy.map(harnessQuestionField) },
  });
}

/**
 * The deprecated `answers` (`HarnessQuestionAnswers`) a pre-#3390 client
 * sends, as form content. Translation only: whatever does not translate is
 * passed through as-is, so {@link validateInputRequestContent} refuses it
 * with its ordinary reason. A blank custom answer reads as none, as before.
 */
export function harnessAnswersToInputContent(
  form: InputRequestForm,
  answers: unknown,
): unknown {
  const map = own(answers);
  if (!map) return answers;
  const content = dictionary<unknown>();
  for (const [name, raw] of Object.entries(map)) {
    const field = form.body.fields.find((item) => item.name === name);
    const answer = own(raw);
    const optionIds = ownArray(answer?.optionIds);
    if (
      !field ||
      !answer ||
      !optionIds ||
      !onlyKeys(answer, ['optionIds', 'custom']) ||
      (answer.custom !== undefined && typeof answer.custom !== 'string')
    ) {
      content[name] = raw;
      continue;
    }
    const secret =
      (field.kind === 'string' ||
        field.kind === 'choice' ||
        field.kind === 'multi-choice') &&
      field.secret === true;
    const custom =
      typeof answer.custom === 'string' &&
      (secret ? answer.custom.length > 0 : answer.custom.trim().length > 0)
        ? answer.custom
        : undefined;
    const ids = optionIds;
    if (field.kind === 'string')
      content[name] = ids.length > 0 ? ids : (custom ?? '');
    else if (field.kind === 'multi-choice')
      content[name] = [...ids, ...(custom !== undefined ? [{ custom }] : [])];
    else {
      const items = [...ids, ...(custom !== undefined ? [{ custom }] : [])];
      content[name] = items.length === 1 ? items[0] : items;
    }
  }
  return content;
}

// --- Validation ----------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function validDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatProblem(
  format: InputRequestStringFormat,
  value: string,
): string | null {
  switch (format) {
    case 'email':
      return EMAIL.test(value) ? null : 'must be an email address';
    case 'uri':
      try {
        new URL(value);
        return null;
      } catch {
        return 'must be a URI';
      }
    case 'date':
      return validDate(value) ? null : 'must be a date (YYYY-MM-DD)';
    case 'date-time':
      return DATE_TIME.test(value) && Number.isFinite(Date.parse(value))
        ? null
        : 'must be a date and time (ISO 8601 with a time zone)';
  }
}

/** The name a person sees for a field, in errors and in the renderer. */
export function inputRequestFieldLabel(field: InputRequestField): string {
  return field.title?.trim() || field.name;
}

function isCustomAnswer(value: unknown): value is InputRequestCustomAnswer {
  const answer = own(value);
  return (
    !!answer && onlyKeys(answer, ['custom']) && Object.hasOwn(answer, 'custom')
  );
}

function blank(value: string, secret: boolean): boolean {
  return secret ? value.length === 0 : value.trim() === '';
}

/** A field's problem, or null. Never coerces. */
function fieldProblem(field: InputRequestField, value: unknown): string | null {
  const name = inputRequestFieldLabel(field);
  switch (field.kind) {
    case 'string': {
      if (typeof value !== 'string') return `${name} must be text.`;
      if (field.required && blank(value, field.secret === true))
        return `${name} is required.`;
      if (value.length > INPUT_REQUEST_MAX_TEXT_CHARS)
        return `${name} is longer than ${INPUT_REQUEST_MAX_TEXT_CHARS} characters.`;
      if (field.minLength !== undefined && value.length < field.minLength)
        return `${name} needs at least ${field.minLength} characters.`;
      if (field.maxLength !== undefined && value.length > field.maxLength)
        return `${name} allows at most ${field.maxLength} characters.`;
      const problem = field.format ? formatProblem(field.format, value) : null;
      return problem ? `${name} ${problem}.` : null;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `${name} must be a number.`;
      if (field.kind === 'integer' && !Number.isInteger(value))
        return `${name} must be a whole number.`;
      if (field.minimum !== undefined && value < field.minimum)
        return `${name} must be at least ${field.minimum}.`;
      if (field.maximum !== undefined && value > field.maximum)
        return `${name} must be at most ${field.maximum}.`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${name} must be yes or no.`;
    case 'choice':
      return choiceProblem(field, value, name);
    case 'multi-choice': {
      if (!Array.isArray(value))
        return `${name} must use only the offered choices, once each.`;
      let customs = 0;
      for (const item of value) {
        if (isCustomAnswer(item)) {
          const problem = customProblem(field, item, name);
          if (problem) return problem;
          customs += 1;
        } else if (
          typeof item !== 'string' ||
          !field.options.some((option) => option.value === item)
        )
          return `${name} must use only the offered choices, once each.`;
      }
      const values = value.filter((item) => typeof item === 'string');
      if (new Set(values).size !== values.length || customs > 1)
        return `${name} must use only the offered choices, once each.`;
      if (field.required && value.length === 0) return `${name} is required.`;
      if (field.minItems !== undefined && value.length < field.minItems)
        return field.minItems === 1
          ? `${name}: choose at least one.`
          : `${name} needs at least ${field.minItems} choices.`;
      if (field.maxItems !== undefined && value.length > field.maxItems)
        return `${name} allows at most ${field.maxItems} choices.`;
      return null;
    }
  }
}

function customProblem(
  field: Extract<InputRequestField, { kind: 'choice' | 'multi-choice' }>,
  answer: InputRequestCustomAnswer,
  name: string,
): string | null {
  if (!field.allowCustom) return `${name} must be one of the offered choices.`;
  if (typeof answer.custom !== 'string') return `${name} must be text.`;
  if (blank(answer.custom, field.secret === true))
    return `${name}: write your answer, or choose an option.`;
  if (answer.custom.length > INPUT_REQUEST_MAX_TEXT_CHARS)
    return `${name} is longer than ${INPUT_REQUEST_MAX_TEXT_CHARS} characters.`;
  return null;
}

function choiceProblem(
  field: Extract<InputRequestField, { kind: 'choice' }>,
  value: unknown,
  name: string,
): string | null {
  if (isCustomAnswer(value)) return customProblem(field, value, name);
  if (
    typeof value !== 'string' ||
    !field.options.some((option) => option.value === value)
  )
    return `${name} must be one of the offered choices.`;
  return null;
}

/**
 * Every problem with `value` as content for `form`: one per field, keyed by
 * field name, plus a form-level problem (an unknown field, or content that is
 * not a set of fields). Empty when the content is valid.
 */
export function inputRequestContentProblems(
  form: InputRequestForm,
  input: unknown,
): { fields: Record<string, string>; form?: string } {
  return problemsOf(form, admitContent(input));
}

/**
 * One read of untrusted content, detached from it: a null-prototype
 * dictionary of each own key's value, read once. Arrays are copied element by
 * element and a custom answer becomes a fresh `{ custom }`, so a getter that
 * answers differently on a second read never reaches anything validated here
 * or sent on. A value that is not plain data (a class instance, another
 * prototype) becomes `null`, which every field refuses. Null when the
 * content is not a set of fields at all.
 */
function admitContent(input: unknown): Record<string, unknown> | null {
  const value = own(input);
  if (!value) return null;
  const content = dictionary<unknown>();
  for (const key of Object.keys(value)) content[key] = admitValue(value[key]);
  return content;
}

function admitValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = ownArray(value);
    return items ? items.map(admitValue) : null;
  }
  const record = own(value);
  if (!record) return null;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'custom')
    return { custom: record.custom };
  return record;
}

function problemsOf(
  form: InputRequestForm,
  value: Record<string, unknown> | null,
): { fields: Record<string, string>; form?: string } {
  if (!value)
    return {
      fields: dictionary<string>(),
      form: 'The answer must be a set of fields.',
    };
  const unknown = Object.keys(value).find(
    (key) => !form.body.fields.some((field) => field.name === key),
  );
  const fields = dictionary<string>();
  for (const field of form.body.fields) {
    const has =
      Object.hasOwn(value, field.name) && value[field.name] !== undefined;
    if (!has) {
      if (field.required)
        fields[field.name] = `${inputRequestFieldLabel(field)} is required.`;
      continue;
    }
    const problem = fieldProblem(field, value[field.name]);
    if (problem) fields[field.name] = problem;
  }
  return {
    fields,
    ...(unknown !== undefined
      ? { form: `The form has no field named ${unknown}.` }
      : {}),
  };
}

/**
 * Validate accepted content against the form that was opened. Throws the
 * first problem, worded for the person; when it is valid, returns a
 * detached, null-prototype snapshot of exactly the content it checked. Never
 * coerces or truncates.
 */
export function validateInputRequestContent(
  form: InputRequestForm,
  value: unknown,
): InputRequestContent {
  // Validate and return the same detached snapshot, never the caller's
  // object: what was checked is exactly what is sent on.
  const content = admitContent(value);
  const problems = problemsOf(form, content);
  if (problems.form) throw new Error(problems.form);
  const first = form.body.fields.find((field) =>
    Object.hasOwn(problems.fields, field.name),
  );
  if (first) throw new Error(problems.fields[first.name]);
  return content as InputRequestContent;
}

/** Read a response carried through storage or a reply, or null. Shape only. */
export function readInputRequestResponse(
  input: unknown,
): InputRequestResponse | null {
  const value = own(input);
  if (!value) return null;
  if (value.action === 'decline' || value.action === 'cancel')
    return Object.keys(value).length === 1 ? { action: value.action } : null;
  if (
    value.action === 'accept' &&
    own(value.content) &&
    onlyKeys(value, ['action', 'content'])
  )
    return {
      action: 'accept',
      content: value.content as InputRequestContent,
    };
  return null;
}

/**
 * A valid answer as the text an engine's question tool takes back: the
 * chosen options' labels, then any custom answer.
 */
export function inputRequestAnswerTexts(
  field: InputRequestField,
  value: InputRequestValue | undefined,
): string[] {
  if (value === undefined) return [];
  const one = (item: string | InputRequestCustomAnswer): string =>
    typeof item === 'string'
      ? field.kind === 'choice' || field.kind === 'multi-choice'
        ? (field.options.find((option) => option.value === item)?.label ?? item)
        : item
      : item.custom;
  if (Array.isArray(value)) return value.map(one);
  if (typeof value === 'string' || isCustomAnswer(value)) return [one(value)];
  return [String(value)];
}

// --- Decisions -----------------------------------------------------------

/**
 * #3390: the decision body for a tool approval, derived from the approval
 * request by Station — never read from a payload. `sessionGrantLabel` is
 * what a session answer would grant for this request
 * (`toolRequestGrantLabel`), or undefined where none is offered. The optional
 * server label is supplied only after the adapter authenticated a Station browser call.
 */
export function approvalDecisionBody(
  sessionGrantLabel: string | undefined,
  serverGrantLabel?: string,
): InputRequestDecisionBody {
  return {
    kind: 'decision',
    options: [
      { id: 'allow-once', label: 'Allow Once', effect: 'allow', scope: 'once' },
      ...(sessionGrantLabel
        ? [
            {
              id: 'allow-session',
              label: sessionGrantLabel,
              effect: 'allow' as const,
              scope: 'session' as const,
            },
          ]
        : []),
      ...(serverGrantLabel
        ? [
            {
              id: 'allow-server-session',
              label: serverGrantLabel,
              effect: 'allow' as const,
              scope: 'session' as const,
              sessionGrantScope: 'server' as const,
            },
          ]
        : []),
      { id: 'deny', label: 'Deny', effect: 'deny', scope: 'once' },
    ],
  };
}

/**
 * The respond decision an option sends. The approval's authority path reads
 * this effect plus the separate `sessionGrantScope` on the option, so every
 * surface forwards both the decision and its authorized scope.
 */
export function decisionOptionResponse(
  option: InputRequestDecisionOption,
): 'accept' | 'acceptForSession' | 'decline' {
  if (option.effect === 'deny') return 'decline';
  return option.scope === 'session' ? 'acceptForSession' : 'accept';
}

// --- History -------------------------------------------------------------

/** The outcome a `request.resolved` status records for a request kind. */
export function inputRequestOutcome(
  kind: InputRequestBody['kind'],
  status: ApprovalStatus,
): InputRequestOutcome {
  switch (status) {
    case 'approved':
      return kind === 'form' ? 'accepted' : 'allowed';
    case 'denied':
      return kind === 'form' ? 'declined' : 'denied';
    case 'expired':
      return 'expired';
    default:
      return 'cancelled';
  }
}
