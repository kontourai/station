/**
 * What an Agent's authored `tools.mcpLoading` tells Claude Code, as its
 * `ENABLE_TOOL_SEARCH`. Omitted, Station sets nothing, so Claude Code's own
 * setting and default decide (the documented "Harness default").
 */
export function claudeToolSearchEnv(
  loading: 'on-demand' | 'always' | undefined,
): 'true' | 'false' | undefined {
  if (loading === undefined) return undefined;
  return loading === 'always' ? 'false' : 'true';
}

/**
 * Whether Station itself turns Claude's tool search on, the only case in
 * which Station's instructions may say its tools load on demand. Under the
 * harness default Station cannot know: Claude Code decides per model,
 * endpoint and listing size, and names deferred tools itself when it
 * defers them.
 */
export function stationEnablesClaudeToolSearch(
  loading: 'on-demand' | 'always' | undefined,
): boolean {
  return claudeToolSearchEnv(loading) === 'true';
}
