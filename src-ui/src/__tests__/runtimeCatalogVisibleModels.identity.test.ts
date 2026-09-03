import { describe, expect, test } from 'vitest';
import { runtimeCatalogVisibleModels } from '../utils/execution';

// #1208 review: `config.modelOptions` is the fallback New Chat reads, and its
// projection rebuilt each option from scratch -- dropping the server-decided
// identity and the alias resolution, so grouping depended on which entry
// point the user came through.
describe('runtimeCatalogVisibleModels identity passthrough', () => {
  const connection = (modelOptions: unknown) =>
    ({
      id: 'c1',
      kind: 'model',
      type: 'anthropic',
      name: 'c1',
      enabled: true,
      capabilities: [],
      config: { modelOptions },
      status: 'ready',
      prerequisites: [],
    }) as never;

  test('carries a well-formed identity and resolvedModel through', () => {
    const [model] = runtimeCatalogVisibleModels(
      connection([
        {
          id: 'default',
          name: 'Default',
          resolvedModel: 'claude-sonnet-4-5',
          canonicalModelIdentity: {
            canonicalId: 'anthropic:claude-sonnet-4-5',
            verifiedAgainst: 'reviewed',
          },
        },
      ]),
    );
    expect(model?.resolvedModel).toBe('claude-sonnet-4-5');
    expect(model?.canonicalModelIdentity?.canonicalId).toBe(
      'anthropic:claude-sonnet-4-5',
    );
  });

  test('drops a malformed identity rather than trusting its shape', () => {
    const [model] = runtimeCatalogVisibleModels(
      connection([
        { id: 'x', name: 'X', canonicalModelIdentity: 'anthropic:x' },
      ]),
    );
    expect(model?.canonicalModelIdentity).toBeUndefined();
  });
});
