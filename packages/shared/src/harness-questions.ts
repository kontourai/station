import type {
  HarnessQuestion,
  HarnessQuestionAnswers,
  HarnessQuestionnaire,
} from '@kontourai/station-contracts/harness-questions';
import type {
  InputRequestForm,
  InputRequestValue,
} from '@kontourai/station-contracts/input-request';
import { INPUT_REQUEST_SCHEMA } from '@kontourai/station-contracts/input-request';
import {
  harnessAnswersToInputContent,
  harnessQuestionField,
  inputRequestAnswerTexts,
  readLegacyHarnessQuestions,
  validateInputRequestContent,
} from './input-request.js';

/**
 * @deprecated since 0.9.0 — harness questions are `station.input-request/v1`
 * forms (#3390); use `@kontourai/station-shared/input-request`. These
 * adapters keep the pre-#3390 public API working for one release and are
 * removed in 0.10.0. None of them validates on its own: answers go through
 * `validateInputRequestContent`, the one validator.
 */

function questionnaireForm(
  questionnaire: HarnessQuestionnaire,
): InputRequestForm {
  return {
    schema: INPUT_REQUEST_SCHEMA,
    source: 'harness:agent',
    requester: 'Agent',
    message: '',
    body: {
      kind: 'form',
      fields: questionnaire.questions.map(harnessQuestionField),
    },
  };
}

/**
 * @deprecated since 0.9.0; removed in 0.10.0. Use
 * `inputRequestFromRequestEvent`, which also reads this stored shape.
 */
export function readHarnessQuestionnaire(
  value: unknown,
): HarnessQuestionnaire | null {
  const questions = readLegacyHarnessQuestions(value);
  return questions ? { questions } : null;
}

/**
 * @deprecated since 0.9.0; removed in 0.10.0. Use
 * `validateInputRequestContent` with `content`.
 */
export function validateHarnessQuestionAnswers(
  questionnaire: HarnessQuestionnaire,
  value: unknown,
): HarnessQuestionAnswers {
  const form = questionnaireForm(questionnaire);
  validateInputRequestContent(form, harnessAnswersToInputContent(form, value));
  // Valid: return the canonical answers (a blank custom answer dropped).
  const answers = value as HarnessQuestionAnswers;
  return Object.fromEntries(
    questionnaire.questions.map((question) => {
      const answer = answers[question.id];
      const custom =
        typeof answer.custom === 'string' &&
        (question.secret
          ? answer.custom.length > 0
          : answer.custom.trim().length > 0)
          ? answer.custom
          : undefined;
      return [
        question.id,
        {
          optionIds: [...answer.optionIds],
          ...(custom !== undefined ? { custom } : {}),
        },
      ];
    }),
  );
}

/** @deprecated since 0.9.0; removed in 0.10.0. Use `inputRequestAnswerTexts`. */
export function harnessAnswerTexts(
  question: HarnessQuestion,
  answers: HarnessQuestionAnswers,
): string[] {
  const field = harnessQuestionField(question);
  const content = harnessAnswersToInputContent(
    questionnaireForm({ questions: [question] }),
    {
      [question.id]: answers[question.id],
    },
  ) as Record<string, InputRequestValue>;
  return inputRequestAnswerTexts(field, content[question.id]);
}

/**
 * @deprecated since 0.9.0; removed in 0.10.0. A harness form in the pre-#3390
 * questionnaire shape, for a surface whose own published protocol still
 * speaks it (the skill-experience rich view). Null for a form that shape
 * cannot express. The question `header` is not part of the form; it reads
 * as empty.
 */
export function harnessQuestionnaireFromInputRequest(
  form: InputRequestForm,
): HarnessQuestionnaire | null {
  const questions: HarnessQuestion[] = [];
  for (const field of form.body.fields) {
    if (field.kind === 'string') {
      if (
        field.format !== undefined ||
        field.minLength !== undefined ||
        field.maxLength !== undefined ||
        field.default !== undefined
      )
        return null;
      questions.push({
        id: field.name,
        header: '',
        prompt: field.title ?? field.name,
        options: [],
        multiple: false,
        allowCustom: true,
        secret: field.secret === true,
      });
      continue;
    }
    if (field.kind !== 'choice' && field.kind !== 'multi-choice') return null;
    questions.push({
      id: field.name,
      header: '',
      prompt: field.title ?? field.name,
      options: field.options.map((option) => ({
        id: option.value,
        label: option.label,
        description: option.description ?? '',
      })),
      multiple: field.kind === 'multi-choice',
      allowCustom: field.allowCustom === true,
      secret: field.secret === true,
    });
  }
  return questions.length > 0 ? { questions } : null;
}
