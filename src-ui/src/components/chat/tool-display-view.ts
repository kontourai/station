const MAX_PURPOSE_CHARS = 240;

/** Normalize known compatibility aliases once at the display boundary. */
export function toolPurposeView(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const raw = row.purpose ?? row.toolPurpose;
  if (typeof raw !== 'string') return undefined;
  const purpose = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PURPOSE_CHARS);
  return purpose || undefined;
}
