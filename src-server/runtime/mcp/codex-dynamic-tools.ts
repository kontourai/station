/**
 * The `dynamicTools` a Codex `thread/start` carries for Station's bound
 * browser and device channel (`createCodexBoundToolServer`): each tool as a
 * function the model sees with its name, description and listed input
 * schema. `agent-context-budget.test.ts` measures this exact shape.
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
