/**
 * @deprecated since 0.9.0 — the pre-#3390 harness question shape. Harness
 * questions are now `station.input-request/v1` form requests
 * (`@kontourai/station-contracts/input-request`). These types remain for one
 * release so stored `questionnaire` payloads and `answers` callers keep
 * working, and are removed in 0.10.0.
 */
export interface HarnessQuestionnaire {
  questions: HarnessQuestion[];
}

/** @deprecated since 0.9.0; removed in 0.10.0. Use `InputRequestField`. */
export interface HarnessQuestion {
  id: string;
  header: string;
  prompt: string;
  options: Array<{ id: string; label: string; description: string }>;
  multiple: boolean;
  allowCustom: boolean;
  secret: boolean;
}

/**
 * @deprecated since 0.9.0; removed in 0.10.0. Use `InputRequestContent`
 * (`respondToRequest`'s `content`).
 */
export type HarnessQuestionAnswers = Record<
  string,
  {
    optionIds: string[];
    custom?: string;
  }
>;
