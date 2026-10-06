import type {
  HarnessQuestionAnswers,
  HarnessQuestionnaire,
} from '@kontourai/station-contracts/harness-questions';
import { createStore, del, get, keys, set } from 'idb-keyval';

const store = createStore('station-harness-question-drafts', 'answers');

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function admittedDraft(
  questionnaire: HarnessQuestionnaire,
  value: unknown,
): HarnessQuestionAnswers {
  if (!record(value)) return {};
  const entries: Array<[string, HarnessQuestionAnswers[string]]> = [];
  for (const question of questionnaire.questions) {
    if (question.secret || !(question.id in value)) continue;
    const answer = value[question.id];
    if (!record(answer) || !Array.isArray(answer.optionIds)) continue;
    const optionIds = answer.optionIds.filter(
      (id: unknown): id is string =>
        typeof id === 'string' &&
        question.options.some((option) => option.id === id),
    );
    const custom =
      question.allowCustom && typeof answer.custom === 'string'
        ? answer.custom.slice(0, 12000)
        : undefined;
    entries.push([
      question.id,
      {
        optionIds: [...new Set(optionIds)].slice(0, question.multiple ? 32 : 1),
        ...(custom !== undefined ? { custom } : {}),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

export async function readHarnessQuestionDraft(
  key: string,
  questionnaire: HarnessQuestionnaire,
): Promise<HarnessQuestionAnswers> {
  try {
    return admittedDraft(
      questionnaire,
      (await get<{ answers?: unknown }>(key, store))?.answers,
    );
  } catch {
    return {};
  }
}

export async function saveHarnessQuestionDraft(
  key: string,
  questionnaire: HarnessQuestionnaire,
  answers: HarnessQuestionAnswers,
): Promise<boolean> {
  try {
    await set(
      key,
      { answers: admittedDraft(questionnaire, answers), updatedAt: Date.now() },
      store,
    );
    const all = await keys<string>(store);
    if (all.length > 32) {
      const records = await Promise.all(
        all.map(async (key) => ({
          key,
          value: await get<{ updatedAt?: number }>(key, store),
        })),
      );
      for (const record of records
        .sort((a, b) => (b.value?.updatedAt ?? 0) - (a.value?.updatedAt ?? 0))
        .slice(32))
        await del(record.key, store);
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearHarnessQuestionDraft(key: string): Promise<void> {
  try {
    await del(key, store);
  } catch {
    /* Keep the current answers usable when device storage is unavailable. */
  }
}
