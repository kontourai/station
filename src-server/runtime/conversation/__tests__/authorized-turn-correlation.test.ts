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
});
