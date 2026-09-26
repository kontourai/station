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
  test("owner: the operator and the personal family's devices", () => {
    const tailnetBinding = {
      provider: 'tailscale-serve',
      subject: 'owner@example.com',
      approvedAt: 1,
      approvalId: '22222222-2222-4222-8222-222222222222',
      approvedBy: 'human:local:operator',
    } as PairedDevice['principalBinding'];
    const accountBinding = {
      kind: 'account',
      issuer: 'https://id.example.test',
      subject: 'account-1',
      displayName: 'Account',
      approvedAt: 1,
      approvalId: '22222222-2222-4222-8222-222222222222',
      approvedBy: 'human:local:operator',
    } as PairedDevice['principalBinding'];
    const { resolver: subject } = resolver({
      listDevices: () => [
        ...DEVICES,
        // The owner's phone paired over the tailnet: reads as the tailnet
        // person, and is a personal-family member (#1958).
        device({ id: 'tailnet-phone', principalBinding: tailnetBinding }),
        // Bound to a deployment account: limited to that account.
        device({ id: 'account-laptop', principalBinding: accountBinding }),
      ],
    });
    const result = subject.resolve(envelope({ kind: 'owner' }));
    expect([...result.deviceSurfaces].sort()).toEqual([
      // unbound, read scope
      'device:other-person',
      'device:reader',
      'device:tailnet-phone',
    ]);
    // A delegated Station, a no-read-scope device, a revoked one and an
    // account-bound one never receive owner notifications.
    for (const excluded of [
      'device:delegation',
      'device:no-read-scope',
      'device:revoked',
      'device:account-laptop',
    ])
      expect(result.deviceSurfaces.has(excluded as never)).toBe(false);
    expect(result.includesOperator).toBe(true);
    // The owner for focus: the operator and unbound devices. The tailnet
    // phone is its own person (it could be a housemate).
    expect([...(result.ownerPrincipals ?? [])].sort()).toEqual([
      OPERATOR,
      'principal:other-person',
      'principal:reader',
    ]);
  });

  test('an owner notification that names a session reaches only surfaces that can read it', () => {
    const { resolver: subject } = resolver({
      canPrincipalReadSession: (sessionId, principalId) =>
        sessionId === 'secret-session' && principalId === 'principal:reader',
    });
    const result = subject.resolve(envelope({ kind: 'owner' }), {
      sessionId: 'secret-session',
    });
    expect([...result.deviceSurfaces]).toEqual(['device:reader']);
    // The operator cannot read it either, so no local surface.
    expect(result.includesOperator).toBe(false);
  });

  test('a session-readers notification must also pass the session the record names', () => {
    const { resolver: subject } = resolver({
      canPrincipalReadSession: (sessionId, principalId) =>
        principalId === 'principal:reader' ||
        (principalId === 'principal:other-person' && sessionId === 'session-1'),
    });
    const result = subject.resolve(
      envelope({ kind: 'session-readers', sessionId: 'session-1' }),
      { sessionId: 'other-session' },
    );
    expect([...result.deviceSurfaces]).toEqual(['device:reader']);
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
