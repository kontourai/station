import { describe, expect, test } from 'vitest';
import { resolveHistoricalForkExecution } from '../components/chat-dock/forkSourceExecution';

describe('historical fork execution identity', () => {
  test('uses the exact source Session provider instance/options despite duplicate live providers', () => {
    const sessions = [
      {
        threadId: 'historical-session',
        provider: 'station-agent',
        modelLaunchPlan: {
          kind: 'station-resolved',
          modelConnectionId: 'bedrock-west',
          modelId: 'duplicate-model',
          evidence: 'catalog-accepted',
        },
        effectiveModelOptions: { effort: 'high', temperature: 0.2 },
      },
      {
        threadId: 'current-session',
        provider: 'station-agent',
        modelLaunchPlan: {
          kind: 'station-resolved',
          modelConnectionId: 'bedrock-east',
          modelId: 'duplicate-model',
          evidence: 'catalog-accepted',
        },
        effectiveModelOptions: { effort: 'low' },
      },
    ] as never;

    expect(
      resolveHistoricalForkExecution('historical-session', sessions),
    ).toEqual({
      providerType: 'station-agent',
      providerId: 'bedrock-west',
      providerOptions: { effort: 'high', temperature: 0.2 },
    });
  });

  test('missing legacy Session omits provider instance/options instead of using a current Agent binding', () => {
    expect(resolveHistoricalForkExecution('missing', [])).toEqual({});
  });
});
