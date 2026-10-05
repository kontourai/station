import type {
  InputRequestContent,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import { INPUT_REQUEST_SCHEMA } from '@kontourai/station-contracts/input-request';
import {
  harnessQuestionField,
  inputRequestAnswerTexts,
  readInputRequestForm,
} from '@kontourai/station-shared/input-request';

/**
 * #3390: the harness edge of `station.input-request/v1`. Each engine's
 * question tool maps into a `form` here, and a validated answer maps back
 * into the text that tool takes. What each source can express:
 *
 * | Source | Fields | Custom answer | Secret |
 * | --- | --- | --- | --- |
 * | Claude `AskUserQuestion` | ≤4 choice / multi-choice | always | no |
 * | Codex `request_user_input` | choice, or free text with no options | `isOther` | `isSecret` |
 *
 * Field names are the engine's own question identity (Claude's question
 * index, Codex's question id) and option values are option indexes, so the
 * answer maps back without trusting any label to be unique.
 */

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const HARNESS_QUESTION_MESSAGE = 'The agent has questions for you';

function harnessForm(
  engine: 'claude' | 'codex',
  requester: string,
  questions: unknown[],
): InputRequestForm | null {
  if (questions.length < 1 || questions.length > 16) return null;
  const fields = [];
  for (const question of questions) {
    if (!record(question)) return null;
    const options = question.options;
    if (
      typeof question.id !== 'string' ||
      !question.id ||
      typeof question.prompt !== 'string' ||
      !question.prompt.trim() ||
      !Array.isArray(options) ||
      options.length > 32 ||
      options.some(
        (option) =>
          !record(option) ||
          typeof option.label !== 'string' ||
          !option.label.trim() ||
          (option.description !== undefined &&
            typeof option.description !== 'string'),
      ) ||
      (options.length === 0 && question.allowCustom !== true)
    )
      return null;
    fields.push(
      harnessQuestionField({
        id: question.id,
        prompt: question.prompt,
        options: options.map((option, index) => ({
          id: String(index),
          label: (option as { label: string }).label,
          description: (option as { description?: string }).description,
        })),
        multiple: question.multiple === true,
        allowCustom: question.allowCustom === true,
        secret: question.secret === true,
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
  if (
    !record(input) ||
    !Array.isArray(input.questions) ||
    input.questions.length > 4
  )
    return null;
  const prompts = new Set<unknown>();
  for (const question of input.questions) {
    if (!record(question) || prompts.has(question.question)) return null;
    prompts.add(question.question);
  }
  return harnessForm(
    'claude',
    'Claude',
    input.questions.map((question, index) => ({
      id: String(index),
      prompt: question.question,
      options: question.options,
      multiple: question.multiSelect === true,
      allowCustom: true,
      secret: false,
    })),
  );
}

/**
 * Claude takes each answer back keyed by its question text, as one string.
 * `content` must already be valid for `form`.
 */
export function claudeAnswers(
  input: { questions: Array<{ question: string }> },
  form: InputRequestForm,
  content: InputRequestContent,
): Record<string, string> {
  return Object.fromEntries(
    form.body.fields.map((field) => [
      input.questions[Number(field.name)].question,
      inputRequestAnswerTexts(field, content[field.name]).join(', '),
    ]),
  );
}

/** Codex `item/tool/requestUserInput` params → form. */
export function codexInputRequest(params: unknown): InputRequestForm | null {
  if (!record(params) || !Array.isArray(params.questions)) return null;
  const questions: unknown[] = [];
  for (const question of params.questions) {
    if (
      !record(question) ||
      (question.options !== null && !Array.isArray(question.options))
    )
      return null;
    questions.push({
      id: question.id,
      prompt: question.question,
      options: Array.isArray(question.options) ? question.options : [],
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
