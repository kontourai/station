import { describe, expect, test } from 'vitest';
import {
  AUTHORED_ARTIFACT_MAX_CHARS,
  authoredArtifactBudgetMessage,
} from '../../../src-shared/authored-artifact-limits.js';

const { buildAgentPayload } = await import('../station-control-agent-tools.js');

describe('station-control agent tools', () => {
  test('maps systemPrompt and mcpServers into the agent route shape', () => {
    expect(
      buildAgentPayload({
        name: 'Smoke Writer',
        slug: 'smoke-writer',
        model: 'llama3.2:latest',
        systemPrompt: 'Reply with exactly: SMOKE_WRITER_OK',
        skills: ['review'],
        mcpServers: ['station-control'],
      }),
    ).toEqual({
      name: 'Smoke Writer',
      slug: 'smoke-writer',
      model: 'llama3.2:latest',
      prompt: 'Reply with exactly: SMOKE_WRITER_OK',
      skills: ['review'],
      tools: { mcpServers: ['station-control'] },
    });
  });

  test('create and update tool schemas declare the system-prompt budget themselves', async () => {
    const { registerAgentTools } = await import(
      '../station-control-agent-tools.js'
    );
    const shapes = new Map<
      string,
      Record<string, { safeParse(value: unknown): unknown }>
    >();
    registerAgentTools({
      tool: (
        name: string,
        _description: string,
        shape: Record<string, { safeParse(value: unknown): unknown }>,
      ) => {
        shapes.set(name, shape);
      },
    } as any);

    for (const name of ['create_agent', 'update_agent']) {
      const result = shapes
        .get(name)
        ?.systemPrompt.safeParse(
          'x'.repeat(AUTHORED_ARTIFACT_MAX_CHARS + 1),
        ) as {
        success: boolean;
        error?: { issues: Array<{ message: string }> };
      };
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        authoredArtifactBudgetMessage('Agent system prompt'),
      );
    }
  });
});
