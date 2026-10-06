import type {
  HarnessQuestion,
  HarnessQuestionAnswers,
  HarnessQuestionnaire,
} from '@kontourai/station-contracts/harness-questions';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read the data-only descriptor shared by the harness and human answer card. */
export function readHarnessQuestionnaire(
  value: unknown,
): HarnessQuestionnaire | null {
  if (
    !record(value) ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > 16
  )
    return null;
  const questions: HarnessQuestion[] = [];
  for (const question of value.questions) {
    if (
      !record(question) ||
      typeof question.id !== 'string' ||
      !question.id ||
      question.id.length > 256 ||
      typeof question.header !== 'string' ||
      typeof question.prompt !== 'string' ||
      !question.prompt.trim() ||
      typeof question.multiple !== 'boolean' ||
      typeof question.allowCustom !== 'boolean' ||
      typeof question.secret !== 'boolean' ||
      !Array.isArray(question.options) ||
      question.options.length > 32
    )
      return null;
    const options: HarnessQuestion['options'] = [];
    for (const option of question.options) {
      if (
        !record(option) ||
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
  return { questions };
}

/** Refuse malformed or incomplete answers before consuming a pending request. */
export function validateHarnessQuestionAnswers(
  questionnaire: HarnessQuestionnaire,
  value: unknown,
): HarnessQuestionAnswers {
  if (
    !record(value) ||
    Object.keys(value).length !== questionnaire.questions.length
  )
    throw new Error('Answer every question before sending.');
  const entries: Array<[string, HarnessQuestionAnswers[string]]> = [];
  for (const question of questionnaire.questions) {
    const answer = value[question.id];
    if (
      !record(answer) ||
      Object.keys(answer).some(
        (key) => key !== 'optionIds' && key !== 'custom',
      ) ||
      !Array.isArray(answer.optionIds) ||
      answer.optionIds.some(
        (id) =>
          typeof id !== 'string' ||
          !question.options.some((option) => option.id === id),
      ) ||
      new Set(answer.optionIds).size !== answer.optionIds.length ||
      (answer.custom !== undefined && typeof answer.custom !== 'string')
    )
      throw new Error('The answer does not match the current question.');
    const custom = typeof answer.custom === 'string' ? answer.custom : '';
    const hasCustom = question.secret
      ? custom.length > 0
      : custom.trim().length > 0;
    if ((hasCustom && !question.allowCustom) || custom.length > 12000)
      throw new Error('This question does not accept that custom answer.');
    const count = answer.optionIds.length + (hasCustom ? 1 : 0);
    if (count < 1 || (!question.multiple && count !== 1))
      throw new Error(
        question.multiple
          ? 'Choose at least one answer.'
          : 'Choose one answer.',
      );
    entries.push([
      question.id,
      {
        optionIds: answer.optionIds.map((id) => String(id)),
        ...(hasCustom ? { custom } : {}),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

export function harnessAnswerTexts(
  question: HarnessQuestion,
  answers: HarnessQuestionAnswers,
): string[] {
  const answer = answers[question.id];
  return [
    ...question.options
      .filter((option) => answer.optionIds.includes(option.id))
      .map((option) => option.label),
    ...(answer.custom ? [answer.custom] : []),
  ];
}
