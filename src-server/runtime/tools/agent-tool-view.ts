import type { ITool } from '../types.js';

export function addAgentTools(base: ITool[], additions: ITool[]): ITool[] {
  const tools = new Map(base.map((tool) => [tool.name, tool]));
  for (const tool of additions)
    if (!tools.has(tool.name)) tools.set(tool.name, tool);
  return [...tools.values()];
}
