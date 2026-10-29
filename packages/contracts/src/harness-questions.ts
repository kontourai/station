/**
 * @deprecated since 0.9.0 — the pre-#3390 harness question shape. Harness
 * questions are now `station.input-request/v1` form requests
 * (`@kontourai/station-contracts/input-request`). These types remain for stored
 * `questionnaire` payloads and legacy `answers` callers. Use the input-request
 * types for new callers.
 */
export interface HarnessQuestionnaire {
  questions: HarnessQuestion[];
}

/** @deprecated since 0.9.0; retained for compatibility. Use `InputRequestField`. */
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
 * @deprecated since 0.9.0; retained for compatibility. Use `InputRequestContent`
 * (`respondToRequest`'s `content`).
 */
export type HarnessQuestionAnswers = Record<
  string,
  {
    optionIds: string[];
    custom?: string;
  }
>;
