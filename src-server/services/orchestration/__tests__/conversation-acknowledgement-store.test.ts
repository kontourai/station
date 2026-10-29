import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { JsonFileStore } from '../../infra/json-store.js';
import {
  conversationAcknowledgementKey,
  FileConversationAcknowledgementStore,
  ownerDevicePredicate,
  PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY,
} from '../conversation-acknowledgement-store.js';

/** Paired devices as the pairing service records them. */
const device = (
  id: string,
  over: Partial<PairedDevice> = {},
): PairedDevice => ({
  id,
  name: id,
  scope: 'orchestration:read orchestration:operate',
  kind: 'device',
  createdAt: 0,
  revokedAt: null,
  activityTracking: 'tracked-since-issued',
  lastSeenFrom: null,
  usageCount: 0,
  lastActiveDay: null,
  revocation:
    over.revokedAt != null
      ? { state: 'unobserved-before-revocation-provenance' }
      : { state: 'not-revoked' },
  ...over,
});
const DEVICES: PairedDevice[] = [
  device('owner-phone'),
  device('account-phone', {
    principalBinding: {
      kind: 'account',
      issuer: 'https://accounts.example',
      subject: 'person-2',
      displayName: 'Person Two',
    } as PairedDevice['principalBinding'],
  }),
  device('revoked-phone', { revokedAt: 1 }),
  // Tied to a tailnet person: theirs, not the owner's.
  device('tailnet-phone', {
    principalBinding: {
      provider: 'tailscale-serve',
      subject: 'housemate@example.com',
      approvedAt: 0,
      approvalId: 'approval-1',
      approvedBy: 'owner',
    },
  }),
];
const isOwnerDevice = ownerDevicePredicate(() => DEVICES);

const makeTempDir = trackTempDirs();

describe('FileConversationAcknowledgementStore', () => {
  test('treats an absent store as an honest empty state and writes the first acknowledgement', () => {
    const dataDir = makeTempDir('station-conversation-empty-');
    const store = new FileConversationAcknowledgementStore(dataDir);

    expect(
      store.getMany('casey', ['thread-1']).get('thread-1'),
    ).toBeUndefined();
    store.acknowledge({
      userId: 'casey',
      conversationId: 'thread-1',
      updatedAt: '2026-08-02T20:00:00.000Z',
    });

    expect(store.getMany('casey', ['thread-1']).get('thread-1')).toBe(
      '2026-08-02T20:00:00.000Z',
    );
  });

  test('persists a user-scoped rendered conversation version across instances', () => {
    const dataDir = makeTempDir('station-conversation-read-');
    const first = new FileConversationAcknowledgementStore(dataDir);

    first.acknowledge({
      userId: 'casey',
      conversationId: 'thread-1',
      updatedAt: '2026-08-02T20:00:00.000Z',
    });

    const restarted = new FileConversationAcknowledgementStore(dataDir);
    expect(restarted.getMany('casey', ['thread-1']).get('thread-1')).toBe(
      '2026-08-02T20:00:00.000Z',
    );
    expect(
      restarted.getMany('other-user', ['thread-1']).get('thread-1'),
    ).toBeUndefined();
  });

  test('batches one snapshot, scopes it to the user, and sees external writes on the next read', () => {
    const dir = makeTempDir('station-ack-batch-');
    const path = join(dir, 'conversation-acknowledgements.json');
    const ids = Array.from({ length: 100 }, (_, i) => `thread-${i}`);
    const write = (version: string) =>
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          acknowledgements: {
            casey: Object.fromEntries(ids.map((id) => [id, version])),
            other: { private: version },
          },
        }),
      );
    write('2026-09-05T00:00:00Z');
    const store = new FileConversationAcknowledgementStore(dir);
    const read = vi.spyOn(JsonFileStore.prototype, 'read');
    try {
      const snapshot = store.getMany('casey', [...ids, 'private', 'missing']);
      expect(snapshot.size).toBe(100);
      expect(snapshot.get('private')).toBeUndefined();
      expect(snapshot.get('missing')).toBeUndefined();
      expect(read).toHaveBeenCalledTimes(1);
      write('2026-09-05T01:00:00Z');
      expect(store.getMany('casey', ids).get(ids[0])).toBe(
        '2026-09-05T01:00:00Z',
      );
      expect(snapshot.get(ids[0])).toBe('2026-09-05T00:00:00Z');
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a readable-corrupt store without overwriting its original bytes', () => {
    const dataDir = makeTempDir('station-conversation-corrupt-');
    const storePath = join(dataDir, 'conversation-acknowledgements.json');
    const corruptBytes = '{"version":1,"acknowledgements":';
    writeFileSync(storePath, corruptBytes, 'utf8');
    const store = new FileConversationAcknowledgementStore(dataDir);

    expect(() => store.getMany('casey', ['thread-1']).get('thread-1')).toThrow(
      'JSON store is corrupt',
    );
    expect(() =>
      store.acknowledge({
        userId: 'casey',
        conversationId: 'thread-1',
        updatedAt: '2026-08-02T20:00:00.000Z',
      }),
    ).toThrow('JSON store is corrupt');
    expect(readFileSync(storePath, 'utf8')).toBe(corruptBytes);
  });

  test('migrates a version 1 file: the owner’s writers fold into the owner key, newest version wins, another person keeps theirs', () => {
    const dir = makeTempDir('station-ack-migrate-');
    const path = join(dir, 'conversation-acknowledgements.json');
    try {
      // The exact shape the version 1 writers left on a real personal
      // Station: the inventory POST under the OS account name, the
      // attention projection under a device principal.
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          acknowledgements: {
            brian: {
              'thread-a': '2026-10-28T04:41:06.065Z',
              'thread-b': '2026-10-01T00:00:00.000Z',
            },
            'human:device:owner-phone': {
              'thread-b': '2026-10-24T16:40:28.567Z',
              'session-failed:thread-c': '2026-10-20T00:00:00.000Z',
            },
            'tenant:alpha': { 'thread-t': '2026-10-02T00:00:00.000Z' },
            'human:tailscale-serve:housemate@example.com': {
              'thread-a': '2026-10-29T00:00:00.000Z',
            },
            'service:scheduler': { 'thread-s': '2026-10-03T00:00:00.000Z' },
          },
        }),
      );
      const store = new FileConversationAcknowledgementStore(
        dir,
        isOwnerDevice,
      );
      const owner = store.getMany(PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY, [
        'thread-a',
        'thread-b',
        'session-failed:thread-c',
        'thread-t',
        'thread-s',
      ]);
      expect(Object.fromEntries(owner)).toEqual({
        'thread-a': '2026-10-28T04:41:06.065Z',
        'thread-b': '2026-10-24T16:40:28.567Z',
        'session-failed:thread-c': '2026-10-20T00:00:00.000Z',
      });
      expect(store.getMany('tenant:alpha', ['thread-t']).get('thread-t')).toBe(
        '2026-10-02T00:00:00.000Z',
      );
      expect(store.getMany('brian', ['thread-a']).size).toBe(0);
      // Another person's view stays theirs: it did not move the owner's.
      expect(
        store
          .getMany('human:tailscale-serve:housemate@example.com', ['thread-a'])
          .get('thread-a'),
      ).toBe('2026-10-29T00:00:00.000Z');

      store.acknowledge({
        userId: PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY,
        conversationId: 'thread-d',
        updatedAt: '2026-10-28T05:00:00.000Z',
      });
      const written = JSON.parse(readFileSync(path, 'utf8'));
      expect(written.version).toBe(2);
      expect(Object.keys(written.acknowledgements).sort()).toEqual([
        'human:tailscale-serve:housemate@example.com',
        PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY,
        'tenant:alpha',
      ]);
      expect(
        written.acknowledgements[PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY][
          'thread-b'
        ],
      ).toBe('2026-10-24T16:40:28.567Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never moves a version backwards when a second device acknowledges an older render', () => {
    const dir = makeTempDir('station-ack-monotonic-');
    try {
      const store = new FileConversationAcknowledgementStore(dir);
      const ack = (updatedAt: string) =>
        store.acknowledge({
          userId: PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY,
          conversationId: 'thread-1',
          updatedAt,
        });
      ack('2026-10-28T05:00:00.000Z');
      ack('2026-10-28T04:00:00.000Z');
      expect(
        store
          .getMany(PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY, ['thread-1'])
          .get('thread-1'),
      ).toBe('2026-10-28T05:00:00.000Z');
      // Compared as times, not text: 06:30+02:00 is 04:30Z, older than 05:00Z.
      ack('2026-10-28T06:30:00.000+02:00');
      expect(
        store
          .getMany(PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY, ['thread-1'])
          .get('thread-1'),
      ).toBe('2026-10-28T05:00:00.000Z');
      ack('2026-10-28T06:00:00.000Z');
      expect(
        store
          .getMany(PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY, ['thread-1'])
          .get('thread-1'),
      ).toBe('2026-10-28T06:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FileConversationAcknowledgementStore eviction', () => {
  test('past the bound, a version that does not parse goes first, then the oldest', () => {
    const dir = makeTempDir('station-ack-evict-');
    try {
      const acknowledgements: Record<string, string> = {};
      for (let index = 0; index < 1_998; index++)
        acknowledgements[`thread-${index}`] = new Date(
          Date.UTC(2026, 0, 1) + index * 1000,
        ).toISOString();
      // Last in file order, so order alone would not evict them first.
      acknowledgements.oldest = '2020-01-01T00:00:00.000Z';
      acknowledgements['not-a-time'] = 'garbage';
      writeFileSync(
        join(dir, 'conversation-acknowledgements.json'),
        JSON.stringify({
          version: 2,
          acknowledgements: {
            [PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY]: acknowledgements,
          },
        }),
      );
      const store = new FileConversationAcknowledgementStore(dir);
      const ack = (conversationId: string) =>
        store.acknowledge({
          userId: PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY,
          conversationId,
          updatedAt: '2026-10-28T00:00:00.000Z',
        });
      const kept = (ids: string[]) => [
        ...store.getMany(PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY, ids).keys(),
      ];
      ack('new-1');
      expect(kept(['not-a-time', 'oldest', 'new-1'])).toEqual([
        'oldest',
        'new-1',
      ]);
      ack('new-2');
      expect(kept(['oldest', 'thread-0', 'new-2'])).toEqual([
        'thread-0',
        'new-2',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('conversationAcknowledgementKey', () => {
  test('maps the owner’s principals on a personal Station to the one owner key', () => {
    for (const principal of [
      'human:local:operator',
      'human:device:owner-phone',
      // The OS account name an older composition passes.
      'brian',
    ]) {
      expect(
        conversationAcknowledgementKey(
          sessionReadAuthorityFromRequest(principal, undefined, undefined),
          isOwnerDevice,
        ),
      ).toBe(PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY);
    }
  });

  test('decides a device principal from its record, not its id', () => {
    for (const principal of [
      // Bound to another person's account, reading as its device identity.
      'human:device:account-phone',
      'human:device:revoked-phone',
      'human:device:tailnet-phone',
      'human:device:unknown-phone',
    ]) {
      expect(
        conversationAcknowledgementKey(
          sessionReadAuthorityFromRequest(principal, undefined, undefined),
          isOwnerDevice,
        ),
      ).toBe(principal);
    }
    // With no device records to read, no device is taken for the owner.
    expect(
      conversationAcknowledgementKey(
        sessionReadAuthorityFromRequest(
          'human:device:owner-phone',
          undefined,
          undefined,
        ),
      ),
    ).toBe('human:device:owner-phone');
  });

  test('keys every other person on a personal Station by their own identity', () => {
    for (const principal of [
      'human:tailscale-serve:housemate@example.com',
      'human:oidc:https%3A%2F%2Fissuer.example:person-2',
    ]) {
      expect(
        conversationAcknowledgementKey(
          sessionReadAuthorityFromRequest(principal, undefined, undefined),
        ),
      ).toBe(principal);
    }
  });

  test('gives non-person principals no key', () => {
    for (const principal of ['service:scheduler', 'agent:reviewer']) {
      expect(
        conversationAcknowledgementKey(
          sessionReadAuthorityFromRequest(principal, undefined, undefined),
        ),
      ).toBeUndefined();
    }
  });

  test('keys a hosted request by its tenant, and a tenantless hosted request by nothing', () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
    });
    expect(
      conversationAcknowledgementKey(
        sessionReadAuthorityFromRequest(
          'human:device:one',
          { tenantId: registry.tenants[0].id },
          registry,
        ),
      ),
    ).toBe('tenant:alpha');
    expect(
      conversationAcknowledgementKey(
        sessionReadAuthorityFromRequest(
          'human:device:one',
          undefined,
          registry,
        ),
      ),
    ).toBeUndefined();
  });
});
