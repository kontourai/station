/**
 * #2377 slice D: feedback analysis acts for no person, so it runs with no
 * tools at all — not the default agent with station-control tools it could
 * only be refused.
 */
import { expect, test, vi } from 'vitest';
import { createFeedbackAnalyzer } from '../feedback-analysis-agent.js';

test('feedback analysis runs a utility agent on the default model with no tools', async () => {
  const generateText = vi.fn().mockResolvedValue({ text: 'summary' });
  const createTempAgent = vi.fn().mockResolvedValue({ generateText });
  const createModel = vi.fn().mockResolvedValue('default-model');
  const analyze = createFeedbackAnalyzer({
    framework: { createTempAgent } as never,
    resolveSpec: () => ({ name: 'Station', prompt: 'p', model: 'm' }) as never,
    createModel,
  });

  expect(await analyze('analyze this')).toBe('summary');
  expect(createModel).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Station' }),
  );
  const [options] = createTempAgent.mock.calls[0]!;
  expect(options).toMatchObject({ purpose: 'utility', model: 'default-model' });
  // Exactly no tools: an empty list, never the default agent's set.
  expect(options.tools).toEqual([]);
  expect(generateText).toHaveBeenCalledWith('analyze this');
});

test('with no agent spec there is nothing to analyze with', async () => {
  const analyze = createFeedbackAnalyzer({
    framework: { createTempAgent: vi.fn() } as never,
    resolveSpec: () => undefined,
    createModel: vi.fn(),
  });
  await expect(analyze('x')).rejects.toThrow('No agents available');
});
