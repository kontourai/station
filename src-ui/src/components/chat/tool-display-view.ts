import {
  displayText,
  truncateDisplay,
} from '@kontourai/station-shared/display-text';

const MAX_PURPOSE_CHARS = 240;

/** Normalize known compatibility aliases once at the display boundary. */
export function toolPurposeView(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const raw = row.purpose ?? row.toolPurpose;
  if (typeof raw !== 'string') return undefined;
  // Shown as "Why: …" on the row and in the approval toast: model text, so
  // it gets the label's `displayText` (no bidi controls, controls become
  // spaces), cut by code point.
  const purpose = truncateDisplay(displayText(raw), MAX_PURPOSE_CHARS);
  return purpose || undefined;
}

export function toolDisplayView(value: unknown) {
  const row = (value && typeof value === 'object' ? value : {}) as Record<
    string,
    any
  >;
  const purpose = toolPurposeView(row);
  const rawArgs = row.args ?? row.input;
  const args =
    purpose && rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (({ __station_tool_purpose: _purpose, ...clean }) => clean)(rawArgs)
      : rawArgs;
  return {
    toolName:
      row.toolName ||
      row.name ||
      (typeof row.type === 'string' ? row.type.replace(/^tool-/, '') : ''),
    args,
    result: row.result ?? row.output,
    error: row.error ?? row.errorText,
    purpose,
  };
}

/**
 * A station-control refusal, recognised by the exact envelope the server
 * writes (`stationControlRefusalBody` in `src-server/tools/
 * station-control-policy.ts`: `{ success: false, code, error }`, sent as
 * pretty-printed JSON text by `jsonToolResult`). The whole value is parsed;
 * text that merely contains such JSON is not a refusal.
 */
export function stationControlRefusal(
  value: unknown,
): { code: string; message: string } | undefined {
  let body: unknown = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{')) return undefined;
    try {
      body = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (
    record.success !== false ||
    typeof record.code !== 'string' ||
    typeof record.error !== 'string' ||
    !record.error.trim()
  ) {
    return undefined;
  }
  return { code: record.code, message: record.error.trim() };
}
