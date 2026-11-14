export const REPORT_INPUT_TOOL_NAME = 'station_request_input';

/** Fresh wire definition; callers cannot mutate the host's accepted schema. */
export function reportInputToolDefinition() {
  return {
    name: REPORT_INPUT_TOOL_NAME,
    description: 'Ask the operator for report clarification.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string' as const, minLength: 1, maxLength: 512 },
      },
      required: ['question'],
      additionalProperties: false,
    },
  };
}

export function readReportInputQuestion(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid report input request.');
  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    keys[0] !== 'question' ||
    !('question' in value) ||
    typeof value.question !== 'string' ||
    !value.question.trim() ||
    value.question.length > 512 ||
    Buffer.byteLength(value.question) > 2048
  )
    throw new Error('Invalid report input request.');
  return value.question;
}
