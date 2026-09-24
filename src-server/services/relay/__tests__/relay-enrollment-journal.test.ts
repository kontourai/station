import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import {
  openRelayEnrollmentJournal,
  RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS,
  RelayEnrollmentCapacityError,
  type RelayEnrollmentJournal,
  type RelayEnrollmentPatch,
  type RelayEnrollmentRecord,
  type RelayEnrollmentState,
} from '../relay-enrollment-journal.js';

describe('RelayEnrollmentJournal', () => {
  const directories: string[] = [];
  afterEach(() =>
    directories
      .splice(0)
      .forEach((path) => rmSync(path, { recursive: true, force: true })),
  );

  function setup(options: Record<string, unknown> = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'station-relay-enrollment-'));
    directories.push(directory);
    const dbPath = join(directory, 'relay-enrollment.sqlite');
    const journal = openRelayEnrollmentJournal({
      dbPath,
      stationId: 'station-test-1',
      ...options,
    } as Parameters<typeof openRelayEnrollmentJournal>[0]);
    return { directory, dbPath, journal };
  }

  type ChallengeInput = Pick<
    RelayEnrollmentRecord,
    | 'enrollmentId'
    | 'stationId'
    | 'clientOrigin'
    | 'keyThumbprint'
    | 'publicKey'
    | 'nonce'
    | 'expiresAt'
  >;
  function challenge(
    enrollmentId = 'enrollment-high-entropy-001',
    overrides: Partial<RelayEnrollmentRecord> = {},
  ): ChallengeInput {
    return {
      enrollmentId: makeId(enrollmentId),
      stationId: 'station-test-1',
      clientOrigin: 'https://client.example',
      keyThumbprint: 'T'.repeat(43),
      publicKey: {
        kty: 'EC',
        crv: 'P-256',
        x: 'A'.repeat(43),
        y: 'B'.repeat(43),
      },
      nonce: 'fresh-nonce-001-xxxxxxxxxxxxxxxxxxxx',
      expiresAt: Date.now() + 20_000,
      ...overrides,
    } as ChallengeInput;
  }
  function makeId(label: string) {
    return `${label}-${'x'.repeat(Math.max(0, 32 - label.length - 1))}`;
  }

  function transitionProviderPending(
    journal: RelayEnrollmentJournal,
    enrollmentId: string,
    patch: RelayEnrollmentPatch,
  ) {
    journal.transition({
      enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-creating',
      patch: {
        issuer:
          typeof patch.issuer === 'string'
            ? patch.issuer
            : 'https://issuer.example',
        loginJti: 'L'.repeat(22),
      },
    });
    return journal.transition({
      enrollmentId,
      expectedStates: ['provider-creating'],
      nextState: 'provider-pending',
      patch,
    });
  }

  test('allows one matching compare-and-swap across independent SQLite connections', async () => {
    const first = setup();
    const second = openRelayEnrollmentJournal({
      dbPath: first.dbPath,
      stationId: 'station-test-1',
    });
    try {
      first.journal.reserveChallenge(challenge());
      const results = await Promise.all([
        Promise.resolve().then(() =>
          transitionProviderPending(
            first.journal,
            makeId('enrollment-high-entropy-001'),
            {
              providerSessionId: 'session-a',
              issuer: 'https://issuer.example',
              subject: 'account-a',
            },
          ),
        ),
        Promise.resolve().then(() =>
          transitionProviderPending(
            second,
            makeId('enrollment-high-entropy-001'),
            {
              providerSessionId: 'session-a',
              issuer: 'https://issuer.example',
              subject: 'account-a',
            },
          ),
        ),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        first.journal.get(makeId('enrollment-high-entropy-001'))?.state,
      ).toBe('provider-pending');
    } finally {
      second.close();
      first.journal.close();
    }
  });

  test('binds a database to the exact Station and refuses immutable or unknown fields', () => {
    const { dbPath, journal } = setup();
    journal.close();
    expect(() =>
      openRelayEnrollmentJournal({ dbPath, stationId: 'station-other' }),
    ).toThrow(/different Station identity/);
    const reopened = openRelayEnrollmentJournal({
      dbPath,
      stationId: 'station-test-1',
    });
    try {
      reopened.reserveChallenge(challenge());
      expect(() =>
        transitionProviderPending(
          reopened,
          makeId('enrollment-high-entropy-001'),
          { stationId: 'station-other' } as never,
        ),
      ).toThrow(/immutable/);
      expect(() =>
        transitionProviderPending(
          reopened,
          makeId('enrollment-high-entropy-001'),
          { deviceCredential: 'raw-secret' } as never,
        ),
      ).toThrow(/immutable/);
      expect(reopened.get(makeId('enrollment-high-entropy-001'))?.state).toBe(
        'provider-creating',
      );
    } finally {
      reopened.close();
    }
  });

  test('refuses malformed, oversized and credential-shaped records before persistence', () => {
    const { journal } = setup();
    try {
      expect(() =>
        journal.reserveChallenge(
          challenge('oversized', { offerProof: 'x'.repeat(9000) } as never),
        ),
      ).toThrow(/non-binding fields/);
      expect(() =>
        journal.reserveChallenge({
          ...challenge('extra'),
          rawDeviceCredential: 'never-store',
        } as never),
      ).toThrow(/non-binding fields/);
      expect(() =>
        journal.reserveChallenge(
          challenge('invalid', { expiresAt: Number.NaN }),
        ),
      ).toThrow(/timestamps/);
      expect(journal.listUnfinished()).toEqual([]);
    } finally {
      journal.close();
    }
  });

  test('requires durable Device and ACK receipts before committing, and validates the public JWK closure', () => {
    const { journal } = setup();
    try {
      expect(() =>
        journal.reserveChallenge(
          challenge('bad-key', {
            publicKey: {
              kty: 'EC',
              crv: 'P-256',
              x: 'short',
              y: 'B'.repeat(43),
            },
          }),
        ),
      ).toThrow(/P-256 public key/);
      journal.reserveChallenge(challenge('missing-device'));
      const id = makeId('missing-device');
      transitionProviderPending(journal, id, {
        providerSessionId: 'session-id',
        issuer: 'https://issuer.example',
        subject: 'subject-id',
      });
      journal.transition({
        enrollmentId: id,
        expectedStates: ['provider-pending'],
        nextState: 'pairing-requested',
        patch: {
          offerId: 'offer-id',
          requestId: 'request-id',
          offerProof: 'private-proof',
        },
      });
      journal.transition({
        enrollmentId: id,
        expectedStates: ['pairing-requested'],
        nextState: 'approved',
        patch: {
          approvalId: 'approval-id',
          approvalPrincipalId: 'approver-id',
          issuedScope: ['app:read'],
        },
      });
      expect(() =>
        journal.transition({
          enrollmentId: id,
          expectedStates: ['approved'],
          nextState: 'device-pending',
        }),
      ).toThrow(/requires deviceId/);
      expect(journal.get(id)?.state).toBe('approved');
      journal.transition({
        enrollmentId: id,
        expectedStates: ['approved'],
        nextState: 'device-pending',
        patch: { deviceId: 'device-id' },
      });
      journal.transition({
        enrollmentId: id,
        expectedStates: ['device-pending'],
        nextState: 'continuation-pending',
        patch: { authorityKey: 'authority-key' },
      });
      journal.transition({
        enrollmentId: id,
        expectedStates: ['continuation-pending'],
        nextState: 'awaiting-ack',
        patch: {
          activationNonce: 'activation-nonce-001',
          bundleDigest: 'bundle-digest-001',
          ackJti: 'accepted-ack-jti',
        },
      });
      journal.transition({
        enrollmentId: id,
        expectedStates: ['awaiting-ack'],
        nextState: 'activating',
      });
      expect(() =>
        journal.transition({
          enrollmentId: id,
          expectedStates: ['activating'],
          nextState: 'committed',
        }),
      ).toThrow(/requires receiptDigest/);
      expect(journal.get(id)).toMatchObject({ state: 'activating' });
    } finally {
      journal.close();
    }
  });

  test('rejects every state transition that omits that state’s required recovery references', () => {
    const cases: Array<{
      next: RelayEnrollmentState;
      prior: RelayEnrollmentState[];
    }> = [
      { next: 'provider-creating', prior: [] },
      { next: 'provider-pending', prior: ['provider-creating'] },
      {
        next: 'pairing-requested',
        prior: ['provider-creating', 'provider-pending'],
      },
      {
        next: 'approved',
        prior: ['provider-creating', 'provider-pending', 'pairing-requested'],
      },
      {
        next: 'device-pending',
        prior: [
          'provider-creating',
          'provider-pending',
          'pairing-requested',
          'approved',
        ],
      },
      {
        next: 'continuation-pending',
        prior: [
          'provider-creating',
          'provider-pending',
          'pairing-requested',
          'approved',
          'device-pending',
        ],
      },
      {
        next: 'awaiting-ack',
        prior: [
          'provider-creating',
          'provider-pending',
          'pairing-requested',
          'approved',
          'device-pending',
          'continuation-pending',
        ],
      },
      {
        next: 'activating',
        prior: [
          'provider-creating',
          'provider-pending',
          'pairing-requested',
          'approved',
          'device-pending',
          'continuation-pending',
          'awaiting-ack',
        ],
      },
    ];
    const { journal } = setup();
    try {
      for (const [index, item] of cases.entries()) {
        const label = `state-closure-${index}`;
        const id = makeId(label);
        journal.reserveChallenge(challenge(label));
        let state: RelayEnrollmentState = 'challenge';
        const validPatches: Record<string, Record<string, unknown>> = {
          'provider-creating': {
            issuer: 'https://issuer.example',
            loginJti: `login-${index}-abcdefghijkl`,
          },
          'provider-pending': {
            providerSessionId: `session-${index}`,
            issuer: 'https://issuer.example',
            subject: `subject-${index}`,
          },
          'pairing-requested': {
            offerId: `offer-${index}`,
            requestId: `request-${index}`,
            offerProof: 'private-proof',
          },
          approved: {
            approvalId: `approval-${index}`,
            approvalPrincipalId: `principal-${index}`,
            issuedScope: ['app:read'],
          },
          'device-pending': { deviceId: `device-${index}` },
          'continuation-pending': { authorityKey: `authority-${index}` },
          'awaiting-ack': {
            activationNonce: `activation-${index}`,
            bundleDigest: `bundle-${index}`,
          },
          activating: { ackJti: `ack-${index}` },
        };
        for (const next of item.prior) {
          journal.transition({
            enrollmentId: id,
            expectedStates: [state],
            nextState: next,
            patch: validPatches[next] as never,
          });
          state = next;
        }
        expect(() =>
          journal.transition({
            enrollmentId: id,
            expectedStates: [state],
            nextState: item.next,
            patch: {},
          }),
        ).toThrow(
          new RegExp(
            `requires ${item.next === 'provider-creating' ? 'issuer' : item.next === 'provider-pending' ? 'providerSessionId' : item.next === 'pairing-requested' ? 'offerId' : item.next === 'approved' ? 'approvalId' : item.next === 'device-pending' ? 'deviceId' : item.next === 'continuation-pending' ? 'authorityKey' : item.next === 'awaiting-ack' ? 'activationNonce' : 'ackJti'}`,
          ),
        );
        expect(journal.get(id)?.state).toBe(state);
        journal.transition({
          enrollmentId: id,
          expectedStates: [state],
          nextState: 'cleaning',
        });
        journal.markCleanupComplete(id);
      }
    } finally {
      journal.close();
    }
  });

  test('reopens incomplete and committed records with the ACK receipt, then retains a hash-only cleanup tombstone', () => {
    const first = setup();
    try {
      first.journal.reserveChallenge(challenge());
      transitionProviderPending(
        first.journal,
        makeId('enrollment-high-entropy-001'),
        {
          providerSessionId: 'provider-session-ref',
          issuer: 'https://issuer.example',
          subject: 'provider-subject',
        },
      );
      first.journal.transition({
        enrollmentId: makeId('enrollment-high-entropy-001'),
        expectedStates: ['provider-pending'],
        nextState: 'pairing-requested',
        patch: {
          offerId: 'offer-id',
          requestId: 'request-id',
          offerProof: 'private-proof',
        },
      });
      first.journal.transition({
        enrollmentId: makeId('enrollment-high-entropy-001'),
        expectedStates: ['pairing-requested'],
        nextState: 'approved',
        patch: {
          approvalId: 'approval-id',
          approvalPrincipalId: 'approver-id',
          issuedScope: ['app:read'],
        },
      });
      first.journal.transition({
        enrollmentId: makeId('enrollment-high-entropy-001'),
        expectedStates: ['approved'],
        nextState: 'device-pending',
        patch: { deviceId: 'device-server-owned' },
      });
      expect(() =>
        first.journal.transition({
          enrollmentId: makeId('enrollment-high-entropy-001'),
          expectedStates: ['device-pending'],
          nextState: 'continuation-pending',
          patch: { deviceId: 'attacker-selected-device' },
        }),
      ).toThrow(/immutable once set/);
      first.journal.transition({
        enrollmentId: makeId('enrollment-high-entropy-001'),
        expectedStates: ['device-pending'],
        nextState: 'continuation-pending',
        patch: { authorityKey: 'app-key-ref' },
      });
      first.journal.transition({
        enrollmentId: makeId('enrollment-high-entropy-001'),
        expectedStates: ['continuation-pending'],
        nextState: 'awaiting-ack',
        patch: {
          bundleDigest: 'bundle-sha256',
          activationNonce: 'activation-nonce-001',
          ackJti: 'ack-jti',
        },
      });
      first.journal.transition({
        enrollmentId: makeId('enrollment-high-entropy-001'),
        expectedStates: ['awaiting-ack'],
        nextState: 'activating',
      });
      expect(first.journal.listUnfinished().map((row) => row.state)).toEqual([
        'activating',
      ]);
      first.journal.close();
      const reopened = openRelayEnrollmentJournal({
        dbPath: first.dbPath,
        stationId: 'station-test-1',
      });
      reopened.transition({
        enrollmentId: makeId('enrollment-high-entropy-001'),
        expectedStates: ['activating'],
        nextState: 'committed',
        patch: { receiptDigest: 'receipt-sha256' },
      });
      expect(() =>
        reopened.transition({
          enrollmentId: makeId('enrollment-high-entropy-001'),
          expectedStates: ['committed'],
          nextState: 'challenge',
        }),
      ).toThrow(/Invalid relay enrollment state transition/);
      expect(reopened.listUnfinished()).toEqual([]);
      expect(reopened.listCommittedReceipts()[0]).toMatchObject({
        state: 'committed',
        ackJti: 'ack-jti',
        receiptDigest: 'receipt-sha256',
      });
      reopened.reserveChallenge(challenge('cleanup-attempt'));
      transitionProviderPending(reopened, makeId('cleanup-attempt'), {
        providerSessionId: 'cleanup-provider-session',
        issuer: 'https://issuer.example',
        subject: 'subject-id',
      });
      expect(() =>
        reopened.transition({
          enrollmentId: makeId('cleanup-attempt'),
          expectedStates: ['provider-pending'],
          nextState: 'failed',
        }),
      ).toThrow(/Invalid relay enrollment state transition/);
      expect(reopened.get(makeId('cleanup-attempt'))).toMatchObject({
        state: 'provider-pending',
        providerSessionId: 'cleanup-provider-session',
      });
      reopened.transition({
        enrollmentId: makeId('cleanup-attempt'),
        expectedStates: ['provider-pending'],
        nextState: 'cleaning',
      });
      reopened.close();
    } finally {
      /* reopen below performs the terminal cleanup to exercise tombstone behavior */
    }
    const last = openRelayEnrollmentJournal({
      dbPath: first.dbPath,
      stationId: 'station-test-1',
    });
    try {
      const tombstone = last.markCleanupComplete(makeId('cleanup-attempt'));
      expect(tombstone).not.toHaveProperty('enrollmentId');
      expect(last.get(makeId('cleanup-attempt'))).toMatchObject({
        state: 'failed',
        terminalReason: 'failed',
      });
      expect(last.get(makeId('cleanup-attempt'))).not.toHaveProperty(
        'providerSessionId',
      );
      expect(last.markCleanupComplete(makeId('cleanup-attempt'))).toEqual(
        tombstone,
      );
    } finally {
      last.close();
    }
  });

  test('applies exact expiry, protects committed ACK replay windows, and enforces capacity without a partial row', () => {
    let now = 100;
    const { journal } = setup({
      now: () => now,
      maxActiveAttempts: 1,
      maxTombstones: 2,
    });
    try {
      journal.reserveChallenge(challenge('first', { expiresAt: 200 }));
      expect(() => journal.reserveChallenge(challenge('second'))).toThrow(
        RelayEnrollmentCapacityError,
      );
      expect(journal.get(makeId('second'))).toBeUndefined();
      transitionProviderPending(journal, makeId('first'), {
        providerSessionId: 'session-first',
        issuer: 'https://issuer.example',
        subject: 'subject-first',
      });
      journal.transition({
        enrollmentId: makeId('first'),
        expectedStates: ['provider-pending'],
        nextState: 'pairing-requested',
        patch: {
          offerId: 'offer-first',
          requestId: 'request-first',
          offerProof: 'proof-first',
        },
      });
      journal.transition({
        enrollmentId: makeId('first'),
        expectedStates: ['pairing-requested'],
        nextState: 'approved',
        patch: {
          approvalId: 'approval-first',
          approvalPrincipalId: 'principal-first',
          issuedScope: ['app:read'],
        },
      });
      journal.transition({
        enrollmentId: makeId('first'),
        expectedStates: ['approved'],
        nextState: 'device-pending',
        patch: { deviceId: 'device-first' },
      });
      journal.transition({
        enrollmentId: makeId('first'),
        expectedStates: ['device-pending'],
        nextState: 'continuation-pending',
        patch: { authorityKey: 'authority-first' },
      });
      journal.transition({
        enrollmentId: makeId('first'),
        expectedStates: ['continuation-pending'],
        nextState: 'awaiting-ack',
        patch: {
          activationNonce: 'activation-first',
          bundleDigest: 'bundle-first',
          ackJti: 'ack-first',
        },
      });
      journal.transition({
        enrollmentId: makeId('first'),
        expectedStates: ['awaiting-ack'],
        nextState: 'activating',
      });
      journal.transition({
        enrollmentId: makeId('first'),
        expectedStates: ['activating'],
        nextState: 'committed',
        patch: { receiptDigest: 'digest' },
      });
      const committed = journal.get(makeId('first'));
      expect(committed).toMatchObject({
        state: 'committed',
        publicKey: { kty: 'EC', crv: 'P-256' },
        deviceId: 'device-first',
        activationNonce: 'activation-first',
        bundleDigest: 'bundle-first',
        ackJti: 'ack-first',
        receiptDigest: 'digest',
      });
      expect(committed).not.toHaveProperty('providerSessionId');
      expect(committed).not.toHaveProperty('authorityKey');
      expect(
        journal.pruneExpiredTombstones(
          100 + RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS - 1,
        ),
      ).toBe(0);
      expect(journal.get(makeId('first'))?.state).toBe('committed');
      expect(
        journal.pruneExpiredTombstones(
          100 + RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS,
        ),
      ).toBe(1);
      expect(journal.get(makeId('first'))).toBeUndefined();
      now = 300;
      journal.reserveChallenge(challenge('third', { expiresAt: 301 }));
      expect(() =>
        journal.reserveChallenge(challenge('exact-expiry', { expiresAt: 300 })),
      ).toThrow(/expire in the future/);
      expect(journal.get(makeId('exact-expiry'))).toBeUndefined();
      journal.transition({
        enrollmentId: makeId('third'),
        expectedStates: ['challenge'],
        nextState: 'cleaning',
      });
      journal.markCleanupComplete(makeId('third'), 'expired');
      expect(
        journal.pruneExpiredTombstones(
          300 + RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS - 1,
        ),
      ).toBe(0);
      expect(
        journal.pruneExpiredTombstones(
          300 + RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS,
        ),
      ).toBe(1);
    } finally {
      journal.close();
    }
  });

  test('expired challenge-only attempts release admission capacity without operator polling', () => {
    let now = 100;
    let failReserve = false;
    const { journal } = setup({
      now: () => now,
      maxActiveAttempts: 1,
      faultInjector: (operation: string) => {
        if (operation === 'reserve' && failReserve)
          throw new Error('injected reservation failure');
      },
    });
    try {
      journal.reserveChallenge(challenge('abandoned', { expiresAt: 200 }));
      expect(() =>
        journal.reserveChallenge(challenge('early', { expiresAt: 300 })),
      ).toThrow(RelayEnrollmentCapacityError);

      now = 200;
      failReserve = true;
      expect(() =>
        journal.reserveChallenge(challenge('replacement', { expiresAt: 300 })),
      ).toThrow('injected reservation failure');
      expect(journal.get(makeId('abandoned'))?.state).toBe('challenge');
      failReserve = false;
      journal.reserveChallenge(challenge('replacement', { expiresAt: 300 }));
      expect(journal.get(makeId('abandoned'))).toBeUndefined();
      expect(journal.get(makeId('replacement'))?.state).toBe('challenge');

      transitionProviderPending(journal, makeId('replacement'), {
        providerSessionId: 'provider-session',
        issuer: 'https://issuer.example',
        subject: 'account-subject',
      });
      now = 300;
      expect(() =>
        journal.reserveChallenge(
          challenge('not-yet-cleaned', { expiresAt: 400 }),
        ),
      ).toThrow(RelayEnrollmentCapacityError);
      expect(journal.get(makeId('replacement'))?.state).toBe(
        'provider-pending',
      );
    } finally {
      journal.close();
    }
  });

  test('allows cleanup but refuses forward CAS at the exact expiry boundary', () => {
    let now = 100;
    const { journal } = setup({ now: () => now });
    try {
      const id = makeId('transition-expiry');
      journal.reserveChallenge(
        challenge('transition-expiry', { expiresAt: 200 }),
      );
      now = 200;
      expect(() =>
        transitionProviderPending(journal, id, {
          providerSessionId: 'session',
          issuer: 'https://issuer.example',
          subject: 'subject',
        }),
      ).toThrow(/Expired relay enrollment/);
      expect(journal.get(id)?.state).toBe('challenge');
      journal.transition({
        enrollmentId: id,
        expectedStates: ['challenge'],
        nextState: 'cleaning',
      });
      expect(journal.markCleanupComplete(id, 'expired')).toMatchObject({
        state: 'expired',
      });
    } finally {
      journal.close();
    }
  });

  test('rolls back reservation and state transition when persistence fails', () => {
    let fail: 'reserve' | 'transition' | 'cleanup' | undefined;
    const { journal } = setup({
      faultInjector: (operation: string) => {
        if (operation === fail) throw new Error('injected persistence failure');
      },
    });
    try {
      fail = 'reserve';
      expect(() => journal.reserveChallenge(challenge())).toThrow(
        /injected persistence/,
      );
      expect(
        journal.get(makeId('enrollment-high-entropy-001')),
      ).toBeUndefined();
      fail = undefined;
      journal.reserveChallenge(challenge());
      fail = 'transition';
      expect(() =>
        transitionProviderPending(
          journal,
          makeId('enrollment-high-entropy-001'),
          {
            providerSessionId: 'session',
            issuer: 'https://issuer.example',
            subject: 'subject',
          },
        ),
      ).toThrow(/injected persistence/);
      expect(journal.get(makeId('enrollment-high-entropy-001'))?.state).toBe(
        'challenge',
      );
      fail = undefined;
      journal.transition({
        enrollmentId: makeId('enrollment-high-entropy-001'),
        expectedStates: ['challenge'],
        nextState: 'cleaning',
      });
      fail = 'cleanup';
      expect(() =>
        journal.markCleanupComplete(makeId('enrollment-high-entropy-001')),
      ).toThrow(/injected persistence/);
      expect(journal.get(makeId('enrollment-high-entropy-001'))).toMatchObject({
        state: 'cleaning',
      });
      fail = undefined;
      expect(
        journal.markCleanupComplete(makeId('enrollment-high-entropy-001')),
      ).toMatchObject({ state: 'failed' });
    } finally {
      journal.close();
    }
  });

  test('fails closed when a persisted record is corrupted', () => {
    const { dbPath, journal } = setup();
    journal.reserveChallenge(challenge());
    transitionProviderPending(journal, makeId('enrollment-high-entropy-001'), {
      providerSessionId: 'session-tamper',
      issuer: 'https://issuer.example',
      subject: 'subject-tamper',
    });
    journal.transition({
      enrollmentId: makeId('enrollment-high-entropy-001'),
      expectedStates: ['provider-pending'],
      nextState: 'pairing-requested',
      patch: {
        offerId: 'offer-tamper',
        requestId: 'request-tamper',
        offerProof: 'proof-tamper',
      },
    });
    journal.transition({
      enrollmentId: makeId('enrollment-high-entropy-001'),
      expectedStates: ['pairing-requested'],
      nextState: 'approved',
      patch: {
        approvalId: 'approval-tamper',
        approvalPrincipalId: 'principal-tamper',
        issuedScope: ['app:read'],
      },
    });
    journal.transition({
      enrollmentId: makeId('enrollment-high-entropy-001'),
      expectedStates: ['approved'],
      nextState: 'device-pending',
      patch: { deviceId: 'device-tamper' },
    });
    journal.close();
    const monitor = openRelayEnrollmentJournal({
      dbPath,
      stationId: 'station-test-1',
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE relay_enrollment_journal SET state=?').run('committed');
    raw.close();
    expect(() => monitor.listUnfinished()).toThrow(/inconsistent/);
    monitor.close();
    expect(() =>
      openRelayEnrollmentJournal({ dbPath, stationId: 'station-test-1' }),
    ).toThrow(/inconsistent/);
  });

  test('refuses reopened in-progress records missing cumulative recovery references', () => {
    const { dbPath, journal } = setup();
    const id = makeId('missing-device-ref');
    journal.reserveChallenge(challenge('missing-device-ref'));
    transitionProviderPending(journal, id, {
      providerSessionId: 'provider-session',
      issuer: 'https://issuer.example',
      subject: 'provider-subject',
    });
    journal.transition({
      enrollmentId: id,
      expectedStates: ['provider-pending'],
      nextState: 'pairing-requested',
      patch: {
        offerId: 'offer-id',
        requestId: 'request-id',
        offerProof: 'proof',
      },
    });
    journal.transition({
      enrollmentId: id,
      expectedStates: ['pairing-requested'],
      nextState: 'approved',
      patch: {
        approvalId: 'approval-id',
        approvalPrincipalId: 'principal-id',
        issuedScope: ['app:read'],
      },
    });
    journal.transition({
      enrollmentId: id,
      expectedStates: ['approved'],
      nextState: 'device-pending',
      patch: { deviceId: 'device-id' },
    });
    journal.transition({
      enrollmentId: id,
      expectedStates: ['device-pending'],
      nextState: 'continuation-pending',
      patch: { authorityKey: 'authority-key' },
    });
    journal.close();
    const raw = new DatabaseSync(dbPath);
    const row = raw
      .prepare('SELECT record_json FROM relay_enrollment_journal')
      .get() as { record_json: string };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    delete record.deviceId;
    raw
      .prepare('UPDATE relay_enrollment_journal SET record_json=?')
      .run(JSON.stringify(record));
    raw.close();
    expect(() =>
      openRelayEnrollmentJournal({ dbPath, stationId: 'station-test-1' }),
    ).toThrow(/continuation-pending state requires deviceId/);
  });

  test('refuses missing Station metadata and incompatible existing schema without repairing either', () => {
    const { dbPath, journal } = setup();
    journal.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare('DELETE FROM relay_enrollment_meta').run();
    raw.close();
    expect(() =>
      openRelayEnrollmentJournal({ dbPath, stationId: 'station-test-1' }),
    ).toThrow(/missing Station identity metadata/);
    const inspect = new DatabaseSync(dbPath);
    expect(
      inspect
        .prepare('SELECT count(*) AS count FROM relay_enrollment_meta')
        .get(),
    ).toEqual({ count: 0 });
    inspect.exec('DROP TABLE relay_enrollment_meta');
    inspect.close();
    expect(() =>
      openRelayEnrollmentJournal({ dbPath, stationId: 'station-test-1' }),
    ).toThrow(/schema is incompatible/);
    const finalInspect = new DatabaseSync(dbPath);
    expect(
      finalInspect
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='relay_enrollment_meta'",
        )
        .get(),
    ).toEqual({ count: 0 });
    finalInspect.close();
  });

  test('reopen rejects a cleaning record whose saved source state lost its Device reference', () => {
    const { dbPath, journal } = setup();
    const id = makeId('cleaning-device-ref');
    journal.reserveChallenge(challenge('cleaning-device-ref'));
    transitionProviderPending(journal, id, {
      providerSessionId: 'provider-session',
      issuer: 'https://issuer.example',
      subject: 'provider-subject',
    });
    journal.transition({
      enrollmentId: id,
      expectedStates: ['provider-pending'],
      nextState: 'pairing-requested',
      patch: {
        offerId: 'offer-id',
        requestId: 'request-id',
        offerProof: 'proof',
      },
    });
    journal.transition({
      enrollmentId: id,
      expectedStates: ['pairing-requested'],
      nextState: 'approved',
      patch: {
        approvalId: 'approval-id',
        approvalPrincipalId: 'principal-id',
        issuedScope: ['app:read'],
      },
    });
    journal.transition({
      enrollmentId: id,
      expectedStates: ['approved'],
      nextState: 'device-pending',
      patch: { deviceId: 'device-id' },
    });
    journal.transition({
      enrollmentId: id,
      expectedStates: ['device-pending'],
      nextState: 'cleaning',
    });
    journal.close();
    const raw = new DatabaseSync(dbPath);
    const row = raw
      .prepare('SELECT record_json FROM relay_enrollment_journal')
      .get() as { record_json: string };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    delete record.deviceId;
    raw
      .prepare('UPDATE relay_enrollment_journal SET record_json=?')
      .run(JSON.stringify(record));
    raw.close();
    expect(() =>
      openRelayEnrollmentJournal({ dbPath, stationId: 'station-test-1' }),
    ).toThrow(
      /Cleaning relay enrollment from device-pending is missing deviceId/,
    );
  });

  test('refuses new challenges when the retained receipt capacity is full, without a partial row', () => {
    let now = 1_000;
    const { journal } = setup({ now: () => now, maxTombstones: 1 });
    try {
      journal.reserveChallenge(challenge('first-cleanup'));
      journal.transition({
        enrollmentId: makeId('first-cleanup'),
        expectedStates: ['challenge'],
        nextState: 'cleaning',
        patch: { providerSessionId: 'session-to-revoke' },
      });
      journal.markCleanupComplete(makeId('first-cleanup'));
      expect(() =>
        journal.reserveChallenge(challenge('second-cleanup')),
      ).toThrow(RelayEnrollmentCapacityError);
      expect(journal.get(makeId('second-cleanup'))).toBeUndefined();
      now += RELAY_ENROLLMENT_ACK_REPLAY_WINDOW_MS;
      journal.reserveChallenge(challenge('second-cleanup'));
      journal.transition({
        enrollmentId: makeId('second-cleanup'),
        expectedStates: ['challenge'],
        nextState: 'cleaning',
        patch: { providerSessionId: 'second-session-to-revoke' },
      });
      expect(
        journal.markCleanupComplete(makeId('second-cleanup')),
      ).toMatchObject({ state: 'failed' });
      expect(journal.get(makeId('first-cleanup'))).toBeUndefined();
    } finally {
      journal.close();
    }
  });
});
