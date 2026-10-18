import { describe, expect, it } from 'vitest';
import {
  checkOutputs,
  checkServedConnection,
  checkServedModel,
  renderMatrix,
} from '../lib/engine-matrix.mjs';

const connection = {
  id: 'test-engine',
  enabled: true,
  type: 'test',
  config: { provider: 'fake' },
};
describe('engine matrix verdicts', () => {
  it.each([
    ['claude-sonnet-4-5', 'claude-sonnet-4-5', 'pass'],
    ['claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5-20250929', 'pass'],
    ['anthropic/claude-3-7-sonnet-20250219-v1:0', 'claude-3-7-sonnet', 'pass'],
    ['gpt-4.1', 'openai/gpt-4.1-2025-04-14', 'pass'],
    ['claude-sonnet-4-5', 'openai/claude-sonnet-4-5', 'fail'],
    ['anthropic/claude-sonnet-4-5', 'google/claude-sonnet-4-5', 'fail'],
    ['gpt-4.1', 'anthropic/gpt-4.1', 'fail'],
    ['claude-sonnet-4-5', 'openrouter/anthropic/claude-sonnet-4-5', 'pass'],
    ['claude-sonnet-4-5', 'openrouter/openai/claude-sonnet-4-5', 'fail'],
    ['claude-sonnet-4-5', 'claude-sonnet-4-5@20250929', 'pass'],
    [
      'claude-sonnet-4-5',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'pass',
    ],
    ['claude-sonnet-4-5', 'us.anthropic.claude-opus-4-5-20250929-v1:0', 'fail'],
    ['claude-sonnet-4-5', 'claude-sonnet-4-5-mini@20250929', 'fail'],
    [
      'claude-sonnet-4-5@20250929',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'pass',
    ],
    [
      'claude-sonnet-4-5',
      'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'pass',
    ],
    [
      'claude-sonnet-4-5',
      'au.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'pass',
    ],
    [
      'claude-sonnet-4-5',
      'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'pass',
    ],
    ['llama3-70b-instruct', 'us.meta.llama3-70b-instruct', 'pass'],
    ['amazon/nova-pro', 'au.amazon.nova-pro', 'pass'],
    ['meta/llama3-70b-instruct', 'us.mistral.llama3-70b-instruct', 'fail'],
    ['claude-sonnet-4-5', 'jp.meta.claude-sonnet-4-5', 'fail'],
    ['claude-sonnet-4-5', 'zz.anthropic.claude-sonnet-4-5', 'fail'],
    ['openai/codex-mini-latest', 'openai/codex-mini-latest', 'pass'],
    ['codex-mini-latest', 'openai/codex-mini-latest', 'pass'],
    ['mistral/pixtral-large', 'mistral/pixtral-large', 'pass'],
    ['pixtral-large', 'mistral/pixtral-large', 'pass'],
    ['mistral/future-family-1', 'jp.mistral.future-family-1-20260101', 'pass'],
    ['mistral/future-family-1', 'openai/future-family-1', 'fail'],
    ['mistral/future-family-1', 'us.meta.future-family-1', 'fail'],
    ['future-family-1', 'mistral/future-family-1', 'unverified'],
    ['cohere/command-r', 'us.cohere.command-r', 'pass'],
    ['acme/future-model', 'jp.acme.future-model-20260101', 'pass'],
    ['acme/future-model', 'us.other.future-model', 'fail'],
    ['llama3.1-70b', 'us.llama3.1-70b', 'fail'],
    ['qwen3.5-coder', '5-coder', 'fail'],
    ['grok-4.1', '1', 'fail'],
    ['glm-4.6', 'glm-4/6', 'fail'],
    ['kimi-k2.5', 'kimi-k2/5', 'fail'],
    ['qwen3.5-coder', 'us.qwen3.5-coder', 'fail'],
    ['qwen3.5-coder', 'qwen3/5-coder', 'fail'],
    ['deepseek-v3.1', 'deepseek/deepseek-v3.1', 'pass'],
    ['grok-4.1', 'x-ai/grok-4.1', 'pass'],
    ['kimi-k2.5', 'moonshot/kimi-k2.5', 'pass'],
    ['nova-pro', 'us.amazon.nova-pro-v1:0', 'pass'],
    ['nova-pro', 'us.amazon.nova-lite-v1:0', 'fail'],
    ['nova-pro', 'us.meta.nova-pro-v1:0', 'fail'],
    ['deepseek-v3.1', 'openai/deepseek-v3.1', 'fail'],
    ['grok-4.1', 'openai/grok-4.1', 'fail'],
    ['kimi-k2.5', 'openai/kimi-k2.5', 'fail'],
    ['gpt-4.1', 'gpt-4.1-mini', 'fail'],
    ['gpt-4.1-mini', 'gpt-4.1', 'fail'],
    ['gpt-4.1', 'gpt-4.2', 'fail'],
    ['claude-sonnet-4-5', 'claude-opus-4-5', 'fail'],
    ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'fail'],
    ['gpt-4.1', 'gpt-4.1-v2', 'fail'],
    ['gpt-4.1', 'gpt-4.1-latest', 'fail'],
    ['gpt-4.1', 'untrusted/gpt-4.1', 'fail'],
    ['gpt-4.1-2025-04-14', 'gpt-4.1-2025-05-14', 'fail'],
    ['gpt-4.1', null, 'unverified'],
    [
      'anthropic.claude-3-7-sonnet-20250219-v1:0',
      'anthropic.claude-3-7-sonnet-20250219-v2:0',
      'fail',
    ],
  ])(
    'compares requested %s to reported %s: %s',
    (requested, reported, verdict) => {
      expect(checkServedModel(requested, reported)).toBe(verdict);
    },
  );

  it('resolves the observed engine through an unambiguous enabled connection', () => {
    expect(checkServedConnection('test-engine', 'fake', [connection])).toBe(
      'pass',
    );
    expect(checkServedConnection('test-engine', 'other', [connection])).toBe(
      'fail',
    );
    expect(checkServedConnection('test-engine', null, [connection])).toBe(
      'unverified',
    );
    expect(
      checkServedConnection('test-engine', 'fake', [
        connection,
        { ...connection, id: 'other' },
      ]),
    ).toBe('fail');
  });

  it.each([
    [['a', 'b'], ['b', 'a'], 'pass'],
    [['a'], ['a', 'a'], 'fail'],
    [['a', 'a'], ['a'], 'fail'],
    [['a'], ['b'], 'fail'],
    [[], [], 'pass'],
    [[], null, 'unverified'],
    [null, [], 'unverified'],
    [['a'], 'a', 'fail'],
  ])(
    'compares complete output multisets %j and %j',
    (stored, rendered, expected) => {
      expect(checkOutputs(stored, rendered)).toBe(expected);
    },
  );

  it('renders dated rows, served identities and escaped failures without implying live evidence', () => {
    expect(
      renderMatrix({
        generatedAt: '2026-10-18T12:00:00.000Z',
        evidence: 'stub-api; no providers',
        rows: [
          {
            engine: 'fake',
            connectionId: 'test-engine',
            model: 'model-1',
            scenario: 'first',
            status: 'fail',
            turns: [{ servedBy: 'other', reportedModel: 'model-2' }],
            failure: 'wrong | model\nagain',
          },
        ],
      }),
    ).toBe(
      [
        '# Engine verification matrix — 2026-10-18',
        '',
        'Generated: 2026-10-18T12:00:00.000Z. Evidence: stub-api; no providers.',
        'A missing model or rendered-output observation is unverified. This report does not alter the catalog.',
        '',
        '| Engine | Connection | Requested model | Scenario | Verdict | Engine-inferred connection | Served as | Failure |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| fake | test-engine | model-1 | first | fail | other | model-2 | wrong \\| model again |',
        '',
      ].join('\n'),
    );
  });
});
