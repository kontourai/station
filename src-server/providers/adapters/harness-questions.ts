import type {
  InputRequestContent,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import { INPUT_REQUEST_SCHEMA } from '@kontourai/station-contracts/input-request';
import {
  harnessQuestionField,
  inputRequestAnswerTexts,
  ownArray,
  ownRecord,
  readInputRequestForm,
} from '@kontourai/station-shared/input-request';

/**
 * #3390: the harness edge of `station.input-request/v1`. Each engine's
 * question tool maps into a `form` here, and a validated answer maps back
 * into the text that tool takes. What each source can express:
 *
 * | Source | Fields | Header | Custom answer | Secret |
 * | --- | --- | --- | --- | --- |
 * | Claude `AskUserQuestion` | ≤4 choice / multi-choice | `header` | always | no |
 * | Codex `request_user_input` | choice, or free text with no options | `header` | `isOther` | `isSecret` |
 * | Cursor `cursor/ask_question` | choice / multi-choice | no | no | no |
 *
 * Field names are the engine's own question identity (Claude's question
 * index, Codex's and Cursor's question id) and option values are option
 * indexes, so the answer maps back without trusting any label to be unique.
 * Cursor's request can come from any engine that speaks it, so its form
 * names the sending connection as requester, never Cursor.
 *
 * Every engine record is snapshotted by its own keys at this ingress, at
 * every level (`ownRecord` / `ownArray`): an inherited `isSecret`, option or
 * question is never read, and an object with another prototype is refused.
 */

/** One question, already read from an engine record by its own keys. */
interface HarnessQuestionInput {
  id: unknown;
  header: unknown;
  prompt: unknown;
  options: unknown[];
  multiple: boolean;
  allowCustom: boolean;
  secret: boolean;
}

const HARNESS_QUESTION_MESSAGE = 'The agent has questions for you';

function harnessForm(
  engine: 'claude' | 'codex' | 'cursor',
  requester: string,
  questions: HarnessQuestionInput[],
  message: string = HARNESS_QUESTION_MESSAGE,
): InputRequestForm | null {
  if (questions.length < 1 || questions.length > 16) return null;
  const fields = [];
  for (const question of questions) {
    const { options } = question;
    if (
      typeof question.id !== 'string' ||
      !question.id ||
      typeof question.prompt !== 'string' ||
      !question.prompt.trim() ||
      options.length > 32 ||
      (options.length === 0 && !question.allowCustom)
    )
      return null;
    const admitted: Array<{ id: string; label: string; description?: string }> =
      [];
    for (const [index, entry] of options.entries()) {
      const option = ownRecord(entry);
      if (
        !option ||
        typeof option.label !== 'string' ||
        !option.label.trim() ||
        (option.description !== undefined &&
          typeof option.description !== 'string')
      )
        return null;
      admitted.push({
        id: String(index),
        label: option.label,
        ...(typeof option.description === 'string'
          ? { description: option.description }
          : {}),
      });
    }
    fields.push(
      harnessQuestionField({
        id: question.id,
        ...(typeof question.header === 'string'
          ? { header: question.header }
          : {}),
        prompt: question.prompt,
        options: admitted,
        multiple: question.multiple,
        allowCustom: question.allowCustom,
        secret: question.secret,
      }),
    );
  }
  return readInputRequestForm({
    schema: INPUT_REQUEST_SCHEMA,
    source: `harness:${engine}`,
    requester,
    message,
    body: { kind: 'form', fields },
  });
}

/** Claude `AskUserQuestion` input → form. Null when Station cannot render it. */
export function claudeInputRequest(input: unknown): InputRequestForm | null {
  const raw = ownRecord(input);
  const list = ownArray(raw?.questions);
  if (!list || list.length > 4) return null;
  const prompts = new Set<unknown>();
  const questions: HarnessQuestionInput[] = [];
  for (const [index, entry] of list.entries()) {
    const question = ownRecord(entry);
    const options = ownArray(question?.options);
    if (!question || !options || prompts.has(question.question)) return null;
    prompts.add(question.question);
    questions.push({
      id: String(index),
      header: question.header,
      prompt: question.question,
      options,
      multiple: question.multiSelect === true,
      allowCustom: true,
      secret: false,
    });
  }
  return harnessForm('claude', 'Claude', questions);
}

/**
 * Claude takes each answer back keyed by its question text, as one string.
 * The text is the admitted question's own (the form field's `title`), never
 * re-read from the engine's input. `content` must already be valid for
 * `form`.
 */
export function claudeAnswers(
  form: InputRequestForm,
  content: InputRequestContent,
): Record<string, string> {
  return Object.fromEntries(
    form.body.fields.map((field) => [
      field.title ?? field.name,
      inputRequestAnswerTexts(field, content[field.name]).join(', '),
    ]),
  );
}

/** Codex `item/tool/requestUserInput` params → form. */
export function codexInputRequest(params: unknown): InputRequestForm | null {
  const list = ownArray(ownRecord(params)?.questions);
  if (!list) return null;
  const questions: HarnessQuestionInput[] = [];
  for (const entry of list) {
    const question = ownRecord(entry);
    if (!question) return null;
    const options = question.options === null ? [] : ownArray(question.options);
    if (!options) return null;
    questions.push({
      id: question.id,
      header: question.header,
      prompt: question.question,
      options,
      multiple: false,
      allowCustom: question.options === null || question.isOther === true,
      secret: question.isSecret === true,
    });
  }
  return harnessForm('codex', 'Codex', questions);
}

/** Codex takes each answer back as a list of texts, keyed by question id. */
export function codexAnswers(
  form: InputRequestForm,
  content: InputRequestContent,
): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    form.body.fields.map((field) => [
      field.name,
      { answers: inputRequestAnswerTexts(field, content[field.name]) },
    ]),
  );
}

/**
 * Cursor `cursor/ask_question` params → form (cursor.com/docs/cli/acp). Its
 * answer can only name option ids, so a question with no options, or with an
 * option id that is blank or repeated, is refused: it could not be answered
 * back unambiguously. `requester` is the sending connection's display name.
 */
export function cursorInputRequest(
  params: unknown,
  requester: string,
): InputRequestForm | null {
  const raw = ownRecord(params);
  const list = ownArray(raw?.questions);
  if (!raw || !list) return null;
  if (raw.title !== undefined && typeof raw.title !== 'string') return null;
  const questions: HarnessQuestionInput[] = [];
  for (const entry of list) {
    const question = ownRecord(entry);
    const options = ownArray(question?.options);
    if (
      !question ||
      !options ||
      options.length === 0 ||
      (question.allowMultiple !== undefined &&
        typeof question.allowMultiple !== 'boolean')
    )
      return null;
    const ids = new Set<string>();
    for (const option of options) {
      const id = ownRecord(option)?.id;
      if (typeof id !== 'string' || !id.trim() || ids.has(id)) return null;
      ids.add(id);
    }
    questions.push({
      id: question.id,
      header: undefined,
      prompt: question.prompt,
      options,
      multiple: question.allowMultiple === true,
      allowCustom: false,
      secret: false,
    });
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  return harnessForm('cursor', requester, questions, title || undefined);
}

/**
 * Cursor takes each answer back as the chosen options' own ids, keyed by
 * question id. Field option values are option indexes (see `harnessForm`),
 * mapped back through the engine's option list that `form` was built from.
 */
export function cursorAnswers(
  form: InputRequestForm,
  params: unknown,
  content: InputRequestContent,
): Array<{ questionId: string; selectedOptionIds: string[] }> {
  const list = ownArray(ownRecord(params)?.questions) ?? [];
  return form.body.fields.map((field) => {
    const question = list
      .map((entry) => ownRecord(entry))
      .find((entry) => entry?.id === field.name);
    const options = ownArray(question?.options) ?? [];
    const value = content[field.name];
    const chosen = Array.isArray(value) ? value : [value];
    const selectedOptionIds = chosen.map((item) => {
      const id =
        typeof item === 'string' ? ownRecord(options[Number(item)])?.id : null;
      // Unreachable for content validated against `form`; refused, not dropped.
      if (typeof id !== 'string')
        throw new Error('This answer does not match the question.');
      return id;
    });
    return { questionId: field.name, selectedOptionIds };
  });
}
