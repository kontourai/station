export const STATION_TOOL_PURPOSE_KEY = '__station_tool_purpose';
const MAX_PURPOSE_CHARS = 240;
const COMPOSED = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if'];
const purposeByCallId = new Map<string, string>();

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function toolSchemaWithPurpose(schema: unknown): unknown {
  if (!record(schema) || schema.type !== 'object') return schema;
  if (COMPOSED.some((key) => key in schema)) return schema;
  if (
    !record(schema.properties) ||
    STATION_TOOL_PURPOSE_KEY in schema.properties
  )
    return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [STATION_TOOL_PURPOSE_KEY]: {
        type: 'string',
        maxLength: MAX_PURPOSE_CHARS,
        description: 'Briefly state why this tool call is needed.',
      },
    },
  };
}

export function extractToolPurpose(input: unknown): {
  input: unknown;
  purpose?: string;
} {
  if (!record(input) || !(STATION_TOOL_PURPOSE_KEY in input)) return { input };
  const { [STATION_TOOL_PURPOSE_KEY]: raw, ...clean } = input;
  const purpose =
    typeof raw === 'string'
      ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PURPOSE_CHARS)
      : '';
  return { input: clean, ...(purpose ? { purpose } : {}) };
}

export function rememberToolPurpose(callId: string, purpose?: string): void {
  if (!callId || !purpose) return;
  if (purposeByCallId.size >= 1_000)
    purposeByCallId.delete(purposeByCallId.keys().next().value!);
  purposeByCallId.set(callId, purpose);
}

export function takeToolPurpose(callId: string): string | undefined {
  const purpose = purposeByCallId.get(callId);
  purposeByCallId.delete(callId);
  return purpose;
}

export function toolPurposeForCall(callId: string): string | undefined {
  return purposeByCallId.get(callId);
}
