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
 *
 * Field names are the engine's own question identity (Claude's question
 * index, Codex's question id) and option values are option indexes, so the
 * answer maps back without trusting any label to be unique.
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
  engine: 'claude' | 'codex',
  requester: string,
  questions: HarnessQuestionInput[],
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
    message: HARNESS_QUESTION_MESSAGE,
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
