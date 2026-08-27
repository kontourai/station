import { createAiSdkDispatchModel } from '@kontourai/dispatch/ai-sdk';
import { describe, expect, it } from 'vitest';
import {
  createAuthorizedTurnCorrelation,
  currentAuthorizedTurnCorrelation,
  issueAuthorizedTurnCorrelationHandoff,
  parseAuthorizedTurnCorrelation,
  readAuthorizedTurnCorrelationHandoff,
  runWithAuthorizedTurnCorrelation,
} from '../authorized-turn-correlation.js';

const TURN_A = Object.freeze({
  accountId: 'account-a',
  sessionId: 'session-a',
  turnId: 'turn-a',
  correlationId: 'correlation-a',
});

describe('authorized turn correlation', () => {
  it('hands an exact identity envelope to every retry of the internal relay', () => {
    const handoff = issueAuthorizedTurnCorrelationHandoff(TURN_A);
    expect(readAuthorizedTurnCorrelationHandoff(handoff)).toEqual(TURN_A);
    expect(readAuthorizedTurnCorrelationHandoff(handoff)).toEqual(TURN_A);
  });

  it('rejects partial, widened, and oversized relay values', () => {
    expect(
      parseAuthorizedTurnCorrelation({ ...TURN_A, prompt: 'do not keep' }),
    ).toBeUndefined();
    expect(
      parseAuthorizedTurnCorrelation({ accountId: 'account-a' }),
    ).toBeUndefined();
    expect(
      parseAuthorizedTurnCorrelation({
        ...TURN_A,
        correlationId: 'x'.repeat(513),
      }),
    ).toBeUndefined();
    expect(
      readAuthorizedTurnCorrelationHandoff('not-a-real-handoff'),
    ).toBeUndefined();
  });

  it('keeps concurrent request scopes isolated across asynchronous work', async () => {
    const TURN_B = Object.freeze({
      accountId: 'account-b',
      sessionId: 'session-b',
      turnId: 'turn-b',
      correlationId: 'correlation-b',
    });
    const observed = await Promise.all([
      runWithAuthorizedTurnCorrelation(TURN_A, async () => {
        await Promise.resolve();
        return currentAuthorizedTurnCorrelation();
      }),
      runWithAuthorizedTurnCorrelation(TURN_B, async () => {
        await Promise.resolve();
        return currentAuthorizedTurnCorrelation();
      }),
    ]);

    expect(observed).toEqual([TURN_A, TURN_B]);
    expect(currentAuthorizedTurnCorrelation()).toBeUndefined();
  });

  it('separates hosted tenants with the same user text while replaying one tenant idempotently', () => {
    const first = createAuthorizedTurnCorrelation({
      accountId: 'same-user',
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientTurnId: 'client-turn-a',
    });
    const redelivery = createAuthorizedTurnCorrelation({
      accountId: 'same-user',
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientTurnId: 'client-turn-a',
    });
    const otherTenant = createAuthorizedTurnCorrelation({
      accountId: 'same-user',
      tenantId: 'tenant-b',
      sessionId: 'session-a',
      clientTurnId: 'client-turn-a',
    });

    expect(redelivery).toEqual(first);
    expect(otherTenant.accountId).not.toBe(first.accountId);
    expect(otherTenant.turnId).not.toBe(first.turnId);
    expect(otherTenant.correlationId).not.toBe(first.correlationId);
  });

  it('routes a correlation-qualified candidate through its unchanged runtime id', async () => {
    const doGenerate = async () => ({
      content: [{ type: 'text' as const, text: 'resolved' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    });
    const model = createAiSdkDispatchModel({
      id: 'fleet-correlation-fixture',
      capabilities: {
        structuredTools: true,
        streaming: false,
        abort: true,
        usage: true,
      },
      models: {
        // The registry key stays an installed runtime identity, while only
        // the per-invocation candidate id is qualified.
        'fleet-runtime-0': {
          specificationVersion: 'v3',
          provider: 'fixture',
          modelId: 'fixture-model',
          supportedUrls: {},
          doGenerate,
          async doStream() {
            throw new Error('not used');
          },
        },
      },
      plan: {
        schemaVersion: 1,
        role: 'station-agent',
        candidates: [
          {
            id: 'fleet-candidate-0:turn:correlation-a',
            runtimeId: 'fleet-runtime-0',
          },
        ],
        budget: { maxAttempts: 1 },
      },
    });

    const generated = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }],
    });
    expect(generated.content).toEqual([{ type: 'text', text: 'resolved' }]);
  });

  it('contains no request content channel', () => {
    expect(Object.keys(TURN_A).sort()).toEqual([
      'accountId',
      'correlationId',
      'sessionId',
      'turnId',
    ]);
    expect(JSON.stringify(TURN_A)).not.toContain('prompt');
  });
});
