/** Recorded UI metadata is a presentation signal, never resource-read authority. */
export function mcpAppResultResourceUri(result: unknown): string | undefined {
  if (
    !isRecord(result) ||
    !Array.isArray(result.content) ||
    (result.isError !== undefined && result.isError !== false)
  )
    return undefined;
  const meta = result._meta;
  if (!isRecord(meta) || !isRecord(meta.ui)) return undefined;
  const uri = meta.ui.resourceUri;
  return typeof uri === 'string' &&
    uri.length <= 2048 &&
    /^ui:\/\/[^\s]+$/.test(uri)
    ? uri
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
