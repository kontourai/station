/**
 * The `dynamicTools` a Codex `thread/start` carries for Station's bound
 * channel (`createCodexBoundToolServer`): browser and device tools, and with
 * the station-control catalog when that travels there too (#2376 slice 2).
 * Each tool is a function the model sees with its name, description and
 * listed input schema. Codex persists them with the thread and keeps them on
 * `thread/resume` and `thread/fork`, which take none. `agent-context-budget.test.ts`
 * measures this exact shape.
 */
export function codexDynamicTools(
  tools: readonly {
    name: string;
    description?: string;
    inputSchema: unknown;
  }[],
) {
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: tool.inputSchema,
  }));
}
