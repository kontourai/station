/**
 * station#3047 — `claimInstanceEntry` / `replaceInstance` /
 * `removeOwnedInstance`: the ownership-checked write primitives.
 *
 * The defect class these pin: `upsertInstance` MERGES partials, so a writer
 * publishing over a foreign entry inherited every field its partial omitted
 * — a service install over a CLI entry produced a `type: 'service'` record
 * carrying the CLI process's live pid/birth, which Desktop's home-ownership
 * decision read as a live service (#3047). The claim primitive replaces
 * exactly and runs its guards inside the mutation lock (the TOCTOU accepted
 * in #2904's review).
 */
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  claimInstanceEntry,
  entryOwnedByLiveProcess,
  readInstanceRegistry,
  removeOwnedInstance,
  replaceInstance,
  updateOwnedInstance,
  upsertInstance,
} from '../instance-registry.js';

const DEAD_PID = 2 ** 31 - 1;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-claim-3047-'));
});

describe('claimInstanceEntry (station#3047)', () => {
  test('writes the exact entry into an empty registry', () => {
    const result = claimInstanceEntry(
      'dev',
      { port: 3299, uiPort: 5299, type: 'service' },
      { home },
    );
    expect(result).toEqual({ written: true });
    expect(readInstanceRegistry(home).instances.dev).toEqual({
      port: 3299,
      uiPort: 5299,
      type: 'service',
    });
  });

  test('REPLACES a dead foreign entry — inherits nothing (the chimera pin)', () => {
    // The #3047 mechanism: the old upsert-merge kept pid/birth/checkout from
    // the CLI entry it wrote over. The claim must leave none of them.
    upsertInstance(
      'dev',
      {
        port: 4000,
        type: 'worktree',
        pid: DEAD_PID,
        birth: 'stale-birth',
        checkout: '/some/checkout',
        status: 'running',
      },
      home,
    );

    const result = claimInstanceEntry(
      'dev',
      { port: 3299, type: 'service' },
      { home },
    );

    expect(result).toEqual({ written: true });
    const entry = readInstanceRegistry(home).instances.dev;
    expect(entry).toEqual({ port: 3299, type: 'service' });
    expect(entry.pid).toBeUndefined();
    expect(entry.birth).toBeUndefined();
  });

  test('refuses a LIVE foreign owner and leaves the registry untouched', () => {
    upsertInstance(
      'dev',
      { port: 4000, type: 'worktree', pid: process.pid },
      home,
    );

    const result = claimInstanceEntry(
      'dev',
      { port: 3299, type: 'service' },
      { home },
    );

    expect(result).toMatchObject({ written: false, reason: 'live-owner' });
    expect(readInstanceRegistry(home).instances.dev.port).toBe(4000);
  });

  test('a live pid whose recorded birth proves reuse is NOT an owner', () => {
    // process.pid is alive, but the recorded fingerprint belongs to a dead
    // predecessor — the pid was reissued. The entry must be displaceable.
    upsertInstance(
      'dev',
      {
        port: 4000,
        type: 'worktree',
        pid: process.pid,
        birth: 'not-this-process-birth',
      },
      home,
    );

    expect(
      claimInstanceEntry('dev', { port: 3299, type: 'service' }, { home }),
    ).toEqual({ written: true });
    expect(readInstanceRegistry(home).instances.dev.type).toBe('service');
  });

  test('the holder may refresh its own entry (selfPid exemption)', () => {
    upsertInstance(
      'dev',
      { port: 3299, type: 'worktree', pid: process.pid },
      home,
    );

    const result = claimInstanceEntry(
      'dev',
      { port: 3299, uiPort: 5299, type: 'worktree', pid: process.pid },
      { home },
    );
    expect(result).toEqual({ written: true });
    expect(readInstanceRegistry(home).instances.dev.uiPort).toBe(5299);
  });

  test('a protected type refuses even when dead', () => {
    // A service entry is durable origin-policy authority (#1983): it has no
    // pid by design, and its being "dead" is its normal state — a caller
    // listing it as protected must never displace it.
    upsertInstance('dev', { port: 4000, type: 'service' }, home);

    const result = claimInstanceEntry(
      'dev',
      { port: 3299, type: 'worktree', pid: process.pid },
      { home, protectedTypes: ['service', 'sidecar'] },
    );

    expect(result).toMatchObject({ written: false, reason: 'protected-type' });
    expect(readInstanceRegistry(home).instances.dev.type).toBe('service');
  });

  test('rejects an entry without a valid port and type', () => {
    expect(() =>
      claimInstanceEntry(
        'dev',
        { type: 'service' } as unknown as Parameters<
          typeof claimInstanceEntry
        >[1],
        { home },
      ),
    ).toThrow('requires a numeric port and a valid type');
  });
});

describe('replaceInstance', () => {
  test('writes exactly, dropping fields the previous entry had', () => {
    upsertInstance(
      'dev',
      { port: 4000, type: 'worktree', pid: DEAD_PID, birth: 'x' },
      home,
    );
    replaceInstance('dev', { port: 4000, type: 'worktree' }, home);
    expect(readInstanceRegistry(home).instances.dev).toEqual({
      port: 4000,
      type: 'worktree',
    });
  });
});

describe('removeOwnedInstance', () => {
  test('removes an own-typed entry with a matching pid', () => {
    upsertInstance(
      'dev',
      { port: 3299, type: 'worktree', pid: process.pid },
      home,
    );
    expect(
      removeOwnedInstance('dev', {
        home,
        pid: process.pid,
        ownTypes: ['inline', 'worktree'],
      }),
    ).toBe(true);
    expect(readInstanceRegistry(home).instances.dev).toBeUndefined();
  });

  test('keeps a foreign-typed entry even on pid match', () => {
    upsertInstance(
      'dev',
      { port: 3299, type: 'service', pid: process.pid },
      home,
    );
    expect(
      removeOwnedInstance('dev', {
        home,
        pid: process.pid,
        ownTypes: ['inline', 'worktree'],
      }),
    ).toBe(false);
    expect(readInstanceRegistry(home).instances.dev).toBeDefined();
  });

  test('keeps an entry recorded under a different pid', () => {
    upsertInstance(
      'dev',
      { port: 3299, type: 'worktree', pid: process.pid },
      home,
    );
    expect(
      removeOwnedInstance('dev', {
        home,
        pid: process.pid + 1,
        ownTypes: ['inline', 'worktree'],
      }),
    ).toBe(false);
    expect(readInstanceRegistry(home).instances.dev).toBeDefined();
  });

  test('an entry with no recorded pid is removable by an owner-typed caller', () => {
    upsertInstance('dev', { port: 3299, type: 'worktree' }, home);
    expect(
      removeOwnedInstance('dev', {
        home,
        pid: process.pid,
        ownTypes: ['inline', 'worktree'],
      }),
    ).toBe(true);
    expect(readInstanceRegistry(home).instances.dev).toBeUndefined();
  });

  test('absent id is a no-op returning false', () => {
    expect(
      removeOwnedInstance('missing', {
        home,
        pid: process.pid,
        ownTypes: ['inline', 'worktree'],
      }),
    ).toBe(false);
  });

  test('a no-op never creates or rewrites the registry file (#3047 review MED-1)', () => {
    // A bare `station stop` in a home that never had a registry must not
    // CREATE instances.json (an unestablished home stays unestablished),
    // and a refusal must not touch the file's inode/mtime (phantom writes
    // are the station#1588 watcher-loop class).
    expect(
      removeOwnedInstance('missing', {
        home,
        pid: process.pid,
        ownTypes: ['inline', 'worktree'],
      }),
    ).toBe(false);
    expect(existsSync(join(home, 'instances.json'))).toBe(false);

    upsertInstance(
      'dev',
      { port: 4000, type: 'worktree', pid: process.pid },
      home,
    );
    const before = statSync(join(home, 'instances.json'));
    expect(
      claimInstanceEntry('dev', { port: 3299, type: 'service' }, { home }),
    ).toMatchObject({ written: false });
    expect(
      removeOwnedInstance('dev', {
        home,
        pid: process.pid,
        ownTypes: ['service'],
      }),
    ).toBe(false);
    const after = statSync(join(home, 'instances.json'));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe('entryOwnedByLiveProcess', () => {
  test('live pid without birth is owned; dead pid is not; selfPid is exempt', () => {
    expect(entryOwnedByLiveProcess({ port: 1, type: 'worktree' })).toBe(false);
    expect(
      entryOwnedByLiveProcess({ port: 1, type: 'worktree', pid: DEAD_PID }),
    ).toBe(false);
    expect(
      entryOwnedByLiveProcess({ port: 1, type: 'worktree', pid: process.pid }),
    ).toBe(true);
    expect(
      entryOwnedByLiveProcess(
        { port: 1, type: 'worktree', pid: process.pid },
        process.pid,
      ),
    ).toBe(false);
  });
});

describe('claimInstanceEntry adoptTypes (station#3064)', () => {
  test('a live entry of an adopted type does not block the claim', () => {
    // `service install` reconfiguring its own live unit: the supervisor now
    // publishes a real pid, and the backend install protocol stops and
    // replaces that generation itself. Without adoptTypes the #3047
    // live-owner guard would refuse every reinstall of a running service.
    upsertInstance(
      'dev',
      { port: 4000, type: 'service', pid: process.pid },
      home,
    );

    const result = claimInstanceEntry(
      'dev',
      { port: 3299, type: 'service', env: { ALLOWED_ORIGINS: '' } },
      { home, adoptTypes: ['service'] },
    );

    expect(result).toEqual({ written: true });
    expect(readInstanceRegistry(home).instances.dev.port).toBe(3299);
  });

  test('a live entry of a NON-adopted type still refuses', () => {
    upsertInstance(
      'dev',
      { port: 4000, type: 'worktree', pid: process.pid },
      home,
    );

    expect(
      claimInstanceEntry(
        'dev',
        { port: 3299, type: 'service' },
        { home, adoptTypes: ['service'] },
      ),
    ).toMatchObject({ written: false, reason: 'live-owner' });
    expect(readInstanceRegistry(home).instances.dev.type).toBe('worktree');
  });

  test('protectedTypes wins over adoptTypes', () => {
    upsertInstance('dev', { port: 4000, type: 'service' }, home);

    expect(
      claimInstanceEntry(
        'dev',
        { port: 3299, type: 'worktree' },
        { home, protectedTypes: ['service'], adoptTypes: ['service'] },
      ),
    ).toMatchObject({ written: false, reason: 'protected-type' });
  });
});

describe('updateOwnedInstance (station#3064)', () => {
  test('patches an owned entry and preserves the fields it does not touch', () => {
    upsertInstance(
      'dev',
      {
        port: 3242,
        type: 'service',
        env: { ALLOWED_ORIGINS: 'https://paired.example' },
      },
      home,
    );

    expect(
      updateOwnedInstance(
        'dev',
        { home, ownTypes: ['service'] },
        (existing) => ({
          ...existing,
          pid: process.pid,
          status: 'running',
        }),
      ),
    ).toBe(true);

    const entry = readInstanceRegistry(home).instances.dev;
    expect(entry.pid).toBe(process.pid);
    expect(entry.env).toEqual({ ALLOWED_ORIGINS: 'https://paired.example' });
  });

  test('refuses a foreign-typed entry', () => {
    upsertInstance('dev', { port: 4000, type: 'worktree' }, home);
    expect(
      updateOwnedInstance(
        'dev',
        { home, ownTypes: ['service'] },
        (existing) => ({
          ...existing,
          pid: process.pid,
        }),
      ),
    ).toBe(false);
    expect(readInstanceRegistry(home).instances.dev.pid).toBeUndefined();
  });

  test('never mints an absent entry', () => {
    expect(
      updateOwnedInstance(
        'dev',
        { home, ownTypes: ['service'] },
        (existing) => ({
          ...existing,
          pid: process.pid,
        }),
      ),
    ).toBe(false);
    expect(readInstanceRegistry(home).instances.dev).toBeUndefined();
  });

  test('a null updater result leaves the registry untouched', () => {
    upsertInstance('dev', { port: 3242, type: 'service' }, home);
    const before = statSync(join(home, 'instances.json'));
    expect(
      updateOwnedInstance('dev', { home, ownTypes: ['service'] }, () => null),
    ).toBe(false);
    expect(statSync(join(home, 'instances.json')).ino).toBe(before.ino);
  });

  test('the defensive copy is DEEP — a nested env mutation cannot leak', () => {
    // The discriminating case for structuredClone: a shallow spread shares
    // `env` by reference, so this mutation would reach the object the caller
    // reads back. Top-level mutation (the test below) passes either way.
    upsertInstance(
      'dev',
      {
        port: 3242,
        type: 'service',
        env: { ALLOWED_ORIGINS: 'https://a.example' },
      },
      home,
    );
    updateOwnedInstance('dev', { home, ownTypes: ['service'] }, (existing) => {
      (existing.env as Record<string, string>).ALLOWED_ORIGINS =
        'https://evil.example';
      return null;
    });
    expect(readInstanceRegistry(home).instances.dev.env).toEqual({
      ALLOWED_ORIGINS: 'https://a.example',
    });
  });

  test('the updater receives a defensive copy — mutating it cannot leak', () => {
    // station#1606: handing out the live object diverges cache from disk.
    upsertInstance('dev', { port: 3242, type: 'service' }, home);
    updateOwnedInstance('dev', { home, ownTypes: ['service'] }, (existing) => {
      (existing as { port: number }).port = 9999;
      return null;
    });
    expect(readInstanceRegistry(home).instances.dev.port).toBe(3242);
  });
});
