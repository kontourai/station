import type { HarnessQuestionnaire } from '@kontourai/station-contracts/harness-questions';
import { readHarnessQuestionnaire } from '@kontourai/station-shared/harness-questions';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function claudeQuestionnaire(
  input: unknown,
): HarnessQuestionnaire | null {
  if (
    !record(input) ||
    !Array.isArray(input.questions) ||
    input.questions.length > 4
  )
    return null;
  const prompts = new Set<string>();
  const questions = input.questions.map((question, index) => {
    if (
      !record(question) ||
      typeof question.question !== 'string' ||
      prompts.has(question.question) ||
      !Array.isArray(question.options)
    )
      return null;
    prompts.add(question.question);
    return {
      id: String(index),
      header: question.header,
      prompt: question.question,
      options: question.options.map((option, i) =>
        record(option)
          ? {
              id: String(i),
              label: option.label,
              description: option.description,
            }
          : null,
      ),
      multiple: question.multiSelect === true,
      allowCustom: true,
      secret: false,
    };
  });
  return readHarnessQuestionnaire({ questions });
}

export function codexQuestionnaire(
  input: unknown,
): HarnessQuestionnaire | null {
  if (!record(input) || !Array.isArray(input.questions)) return null;
  return readHarnessQuestionnaire({
    questions: input.questions.map((question) => {
      if (
        !record(question) ||
        (question.options !== null && !Array.isArray(question.options))
      )
        return null;
      return {
        id: question.id,
        header: question.header,
        prompt: question.question,
        options: Array.isArray(question.options)
          ? question.options.map((option, i) =>
              record(option)
                ? {
                    id: String(i),
                    label: option.label,
                    description: option.description,
                  }
                : null,
            )
          : [],
        multiple: false,
        allowCustom: question.options === null || question.isOther === true,
        secret: question.isSecret === true,
      };
    }),
  });
}
