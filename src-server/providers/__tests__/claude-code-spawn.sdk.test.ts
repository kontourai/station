import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';
import {
  claudeExitDetailWithStderr,
  createClaudeEngineProcess,
} from '../adapters/claude-code-spawn.js';

/**
 * #2932: the contract between Station's engine spawn and the REAL Agent SDK
 * the lockfile resolves. Nothing is mocked: the SDK launches a small Node
 * script standing in for the CLI (`fixtures/fake-claude-cli.mjs`), once
 * through its own default spawn and once through Station's.
 *
 * If an SDK upgrade breaks any of this, permission asks would read as
 * missing and every Claude ask would prompt; this test says so first.
 */
const fakeCli = fileURLToPath(
  new URL('./fixtures/fake-claude-cli.mjs', import.meta.url),
);

async function run(spawner: 'sdk' | 'station') {
  const engine = createClaudeEngineProcess();
  const calls: Array<{
    requestId: unknown;
    optionKeys: string[];
    recorded: unknown;
  }> = [];
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  async function* prompt() {
    yield {
      type: 'user' as const,
      session_id: '',
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'go' }],
      },
      parent_tool_use_id: null,
    };
    // Keep stdin open until the engine has exited.
    await finished;
  }
  const messages: unknown[] = [];
  let error = '';
  try {
    for await (const message of query({
      prompt: prompt(),
      options: {
        pathToClaudeCodeExecutable: fakeCli,
        env: { ...process.env },
        ...(spawner === 'station'
          ? { spawnClaudeCodeProcess: engine.spawn }
          : {}),
        canUseTool: async (_toolName, input, options) => {
          calls.push({
            requestId: options.requestId,
            optionKeys: Object.keys(options).sort(),
            recorded: engine.asks.take(options.requestId),
          });
          return { behavior: 'allow', updatedInput: input };
        },
      },
    }))
      messages.push(message);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    finish();
  }
  return { engine, calls, messages, error };
}

describe('Station engine spawn against the real Agent SDK', () => {
  test('the SDK still withholds the structured reason, and hands canUseTool the frame request id the tap recorded under', async () => {
    const { engine, calls, messages } = await run('station');

    // The replayed ask and the live ask, each already recorded when the
    // SDK called back.
    expect(calls.map((call) => [call.requestId, call.recorded])).toEqual([
      ['req-replay', { decisionReasonType: 'rule' }],
      [
        'req-live',
        { decisionReasonType: 'safetyCheck', classifierApprovable: false },
      ],
    ]);
    expect(engine.asks.size).toBe(0);
    // The SDK read the stream through the tap unchanged.
    expect(messages).toContainEqual(
      expect.objectContaining({ note: 'héllo — 日本語 🙂' }),
    );
    // Why the tap exists: the SDK forwards none of these. When this fails
    // the SDK has started to, and the tap can be retired for its field.
    for (const call of calls) {
      expect(call.optionKeys).not.toContain('decisionReasonType');
      expect(call.optionKeys).not.toContain('classifierApprovable');
      expect(call.optionKeys).not.toContain('requiresUserInteraction');
    }
  }, 30_000);

  test("an engine exit reads the same as under the SDK's own spawn once Station adds its stderr tail", async () => {
    const sdk = await run('sdk');
    const station = await run('station');

    expect(sdk.error).toBe(
      'Claude Code process exited with code 3. stderr: fake engine: failing on purpose',
    );
    // The SDK folds no stderr into the error for a custom spawner.
    expect(station.error).toBe('Claude Code process exited with code 3');
    expect(station.engine.stderrTail()).toBe('fake engine: failing on purpose');
    expect(
      claudeExitDetailWithStderr(station.error, station.engine.stderrTail()),
    ).toBe(sdk.error);
    // Both spawns drive the same two asks.
    expect(sdk.calls.map((call) => call.requestId)).toEqual(
      station.calls.map((call) => call.requestId),
    );
  }, 30_000);
});
