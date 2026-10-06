/** A harness request whose answer returns to the suspended tool call. */
export interface HarnessQuestionnaire {
  questions: HarnessQuestion[];
}

export interface HarnessQuestion {
  id: string;
  header: string;
  prompt: string;
  options: Array<{ id: string; label: string; description: string }>;
  multiple: boolean;
  allowCustom: boolean;
  secret: boolean;
}

export type HarnessQuestionAnswers = Record<
  string,
  {
    optionIds: string[];
    custom?: string;
  }
>;
