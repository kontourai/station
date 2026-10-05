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
