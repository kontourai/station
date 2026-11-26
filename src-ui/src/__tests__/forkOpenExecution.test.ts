import { describe, expect, test } from 'vitest';
import { forkOpenExecution } from '../components/chat-dock/forkSourceExecution';

const source = {
  agentSlug: 'codex',
  model: 'gpt-6',
  modelSource: 'runtime' as const,
  defaultModel: 'gpt-6',
  defaultModelSource: 'runtime' as const,
  providerOptions: { effort: 'high' },
  providerId: 'openai',
  providerType: 'openai',
};

describe('forkOpenExecution', () => {
  test('the same Agent on the source model keeps its provider and options', () => {
    const open = forkOpenExecution(source, 'codex', { modelOverride: 'gpt-6' });
    expect(open).toMatchObject({
      model: 'gpt-6',
      providerId: 'openai',
      providerOptions: { effort: 'high' },
    });
  });

  test('another model on the same Agent does not borrow the source model provider or options', () => {
    const open = forkOpenExecution(source, 'codex', { modelOverride: 'gpt-5' });
    expect(open.model).toBe('gpt-5');
    expect(open.providerId).toBeUndefined();
    expect(open.providerType).toBeUndefined();
    expect(open.providerOptions).toBeUndefined();
  });

  test('another model with its own provider uses that provider', () => {
    const open = forkOpenExecution(source, 'codex', {
      modelOverride: 'gpt-5',
      providerId: 'azure',
    });
    expect(open.providerId).toBe('azure');
  });

  test('another Agent inherits nothing from the source turn', () => {
    const open = forkOpenExecution(source, 'claude');
    expect(open).toEqual({
      model: undefined,
      requestedModel: undefined,
      modelSource: undefined,
      defaultModel: undefined,
      defaultModelSource: undefined,
      providerOptions: undefined,
      requestedProviderOptions: undefined,
      providerId: undefined,
      providerType: undefined,
    });
  });
});
