/** A cheap candidate filter; only a server tool definition can identify an App. */
export function isSuccessfulMcpResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return false;
  const value = result as Record<string, unknown>;
  return (
    Array.isArray(value.content) &&
    (value.isError === undefined || value.isError === false)
  );
}
