import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import type { NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import { describe, expect, test, vi } from 'vitest';
import { createPairingAudienceResolver } from '../audience-resolver.js';

const OPERATOR = 'human:local:operator';

const device = (overrides: Partial<PairedDevice> = {}): PairedDevice =>
  ({
    id: 'device-1',
    name: 'Pixel',
    scope: 'orchestration:read orchestration:operate',
    kind: 'device',
    createdAt: 1,
    revokedAt: null,
    ...overrides,
  }) as PairedDevice;

const envelope = (
  audience: NotificationEnvelopeV1['audience'],
): NotificationEnvelopeV1 => ({
  v: 1,
  source: { kind: 'agent', sessionId: 'session-1', assurance: 'bound' },
  audience,
  urgency: 'attention',
  interrupt: 'default',
});

const DEVICES = [
  device({ id: 'reader' }),
  // Paired and active, but its own credential cannot read sessions.
  device({ id: 'no-read-scope', scope: 'orchestration:operate' }),
  // Reads sessions, but not this one (another person's device).
  device({ id: 'other-person' }),
  device({ id: 'revoked', revokedAt: 5 }),
  device({ id: 'delegation', kind: 'delegation' }),
];

function resolver(
  overrides: {
    canPrincipalReadSession?: (
      sessionId: string,
      principalId: string,
    ) => boolean;
    listDevices?: () => PairedDevice[];
  } = {},
) {
  const logger = { warn: vi.fn() };
  const canPrincipalReadSession = vi.fn(
    overrides.canPrincipalReadSession ??
      ((sessionId: string, principalId: string) =>
        sessionId === 'session-1' && principalId !== 'principal:other-person'),
  );
  return {
    logger,
    canPrincipalReadSession,
    resolver: createPairingAudienceResolver({
      listDevices: overrides.listDevices ?? (() => DEVICES),
      devicePrincipalId: (candidate) => `principal:${candidate.id}`,
      operatorPrincipalId: OPERATOR,
      canPrincipalReadSession,
      logger,
    }),
  };
}

describe('createPairingAudienceResolver', () => {
  test('owner: the operator and every active paired device (Web Push parity)', () => {
    const { resolver: subject } = resolver();
    const result = subject.resolve(envelope({ kind: 'owner' }));
    expect([...result.deviceSurfaces].sort()).toEqual([
      'device:delegation',
      'device:no-read-scope',
      'device:other-person',
      'device:reader',
    ]);
    expect(result.includesOperator).toBe(true);
  });

  test('session-readers: only devices whose own credential can read that session', () => {
    const { resolver: subject, canPrincipalReadSession } = resolver();
    const result = subject.resolve(
      envelope({ kind: 'session-readers', sessionId: 'session-1' }),
    );
    expect([...result.deviceSurfaces]).toEqual(['device:reader']);
    expect(result.includesOperator).toBe(true);
    // The read-scope/kind/revocation checks run before any session read.
    const asked = canPrincipalReadSession.mock.calls.map(
      ([, principal]) => principal,
    );
    expect(asked).not.toContain('principal:no-read-scope');
    expect(asked).not.toContain('principal:revoked');
    expect(asked).not.toContain('principal:delegation');
  });

  test('session-readers: the operator is out when the operator cannot read it', () => {
    const { resolver: subject } = resolver({
      canPrincipalReadSession: (_sessionId, principalId) =>
        principalId === 'principal:reader',
    });
    const result = subject.resolve(
      envelope({ kind: 'session-readers', sessionId: 'session-1' }),
    );
    expect([...result.deviceSurfaces]).toEqual(['device:reader']);
    expect(result.includesOperator).toBe(false);
  });

  test('a read check that throws leaves that surface out', () => {
    const { resolver: subject, logger } = resolver({
      canPrincipalReadSession: () => {
        throw new Error('read model unavailable');
      },
    });
    const result = subject.resolve(
      envelope({ kind: 'session-readers', sessionId: 'session-1' }),
    );
    expect(result.deviceSurfaces.size).toBe(0);
    expect(result.includesOperator).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('principal audiences resolve to no surface and say so once', () => {
    const { resolver: subject, logger } = resolver();
    for (let i = 0; i < 3; i += 1) {
      const result = subject.resolve(
        envelope({ kind: 'principal', principalId: 'human:x:y' }),
      );
      expect(result.deviceSurfaces.size).toBe(0);
      expect(result.includesOperator).toBe(false);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
