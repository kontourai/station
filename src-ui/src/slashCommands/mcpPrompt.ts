import type { AgentMcpPrompt } from '@kontourai/station-contracts/mcp-prompts';
import { runAgentMcpPrompt } from '@kontourai/station-sdk';
import { assignSkillVariableArgs } from '../utils/skill-commands';

/**
 * #3284: run an MCP server prompt typed as `/<server>:<prompt>`. Loaded on
 * first use, so the entry bundle carries only the menu lookup. Arguments use
 * the same `name=value` / positional parser as skill variables; the server
 * reads the prompt and its text becomes the turn. A missing required argument
 * or a refused read sends nothing and says why.
 */
export async function runMcpPromptCommand(
  agentSlug: string,
  prompt: AgentMcpPrompt,
  args: string[],
): Promise<{ text: string } | { refusal: string }> {
  const assignment = assignSkillVariableArgs(
    prompt.arguments.map((argument) => ({ name: argument.name })),
    args,
  );
  if (!assignment.ok)
    return {
      refusal: `/${prompt.command}: ${assignment.error} — nothing was sent`,
    };
  const provided = Object.fromEntries(
    Object.entries(assignment.provided).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim() !== '',
    ),
  );
  const missing = prompt.arguments
    .filter((argument) => argument.required && !(argument.name in provided))
    .map((argument) => `<${argument.name}>`);
  if (missing.length)
    return {
      refusal: `/${prompt.command} needs a value for ${missing.join(', ')} — nothing was sent`,
    };
  try {
    const run = await runAgentMcpPrompt(agentSlug, {
      serverId: prompt.serverId,
      name: prompt.name,
      arguments: provided,
    });
    return { text: run.text };
  } catch (error) {
    return {
      refusal: `Could not run /${prompt.command}: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}
