export const STATION_TOOL_PURPOSE_KEY = '__station_tool_purpose';
const MAX_PURPOSE_CHARS = 240;
const COMPOSED = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if'];
const purposesByScope = new WeakMap<object, Map<string, string>>();
const registeredCleanup = new WeakSet<object>();

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

const scopeOf = (explicit?: object) =>
  explicit ?? currentNativeForegroundRelay();

export function rememberToolPurpose(
  callId: string,
  purpose?: string,
  explicitScope?: object,
): void {
  const scope = scopeOf(explicitScope);
  if (!scope || !callId || !purpose) return;
  let purposes = purposesByScope.get(scope);
  if (!purposes) {
    purposes = new Map();
    purposesByScope.set(scope, purposes);
  }
  if (purposes.size >= 1_000) purposes.delete(purposes.keys().next().value!);
  purposes.set(callId, purpose);
  if (!registeredCleanup.has(scope) && 'onClose' in scope) {
    registeredCleanup.add(scope);
    (scope as { onClose(cleanup: () => void): void }).onClose(() =>
      purposesByScope.delete(scope),
    );
  }
}

export function takeToolPurpose(
  callId: string,
  explicitScope?: object,
): string | undefined {
  const scope = scopeOf(explicitScope);
  const purposes = scope ? purposesByScope.get(scope) : undefined;
  const purpose = purposes?.get(callId);
  purposes?.delete(callId);
  return purpose;
}

export function toolPurposeForCall(
  callId: string,
  explicitScope?: object,
): string | undefined {
  const scope = scopeOf(explicitScope);
  return scope ? purposesByScope.get(scope)?.get(callId) : undefined;
}

import { currentNativeForegroundRelay } from '../conversation/native-foreground-invocation.js';
