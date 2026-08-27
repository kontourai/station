/**
 * KnownEnvironmentRegistry unit tests — pure Node, no DOM, no React.
 * AC1 (station#1096): the same station reached via two endpoints resolves
 * to one KnownEnvironment after both attach the same environmentId.
 */
import { describe, expect, it } from 'vitest';
import {
  addEndpoint,
  attachEnvironmentDescriptor,
  createKnownEnvironment,
  KnownEnvironmentRegistry,
  mergeKnownEnvironments,
} from '../core/knownEnvironmentRegistry';
import type { StorageAdapter } from '../core/types';

function memoryAdapter(): StorageAdapter {
  const store: Record<string, string> = {};
  return {
    get: (k) => store[k] ?? null,
    set: (k, v) => {
      store[k] = v;
    },
    remove: (k) => {
      delete store[k];
    },
  };
}

function makeRegistry() {
  return new KnownEnvironmentRegistry({ storage: memoryAdapter() });
}

describe('KnownEnvironmentRegistry — CRUD', () => {
  it('starts empty', () => {
    expect(makeRegistry().getAll()).toHaveLength(0);
  });

  it('add() persists and returns the new environment', () => {
    const registry = makeRegistry();
    const created = registry.add({
      label: 'Box B',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
    });
    expect(created.label).toBe('Box B');
    expect(created.endpoints).toHaveLength(1);
    expect(created.endpoints[0].httpBaseUrl).toBe(
      'https://box-b.tailnet.ts.net',
    );
    expect(created.environmentId).toBeUndefined();
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get(created.id)?.id).toBe(created.id);
  });

  it('remove() drops the entry', () => {
    const registry = makeRegistry();
    const created = registry.add({
      label: 'Box B',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
    });
    registry.remove(created.id);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('notifies subscribers on write', () => {
    const registry = makeRegistry();
    let notified = 0;
    const unsubscribe = registry.subscribe(() => {
      notified += 1;
    });
    registry.add({
      label: 'Box B',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
    });
    expect(notified).toBe(1);
    unsubscribe();
    registry.add({
      label: 'Box C',
      httpBaseUrl: 'https://box-c.tailnet.ts.net',
      source: 'manual',
    });
    expect(notified).toBe(1);
  });

  it('corrupt storage reads back as empty rather than throwing', () => {
    const storage = memoryAdapter();
    storage.set('station-known-environments', '{not json');
    const registry = new KnownEnvironmentRegistry({ storage });
    expect(registry.getAll()).toHaveLength(0);
  });
});

describe('KnownEnvironmentRegistry — identity merge (AC1)', () => {
  it('two manual entries pointing at the same environmentId merge into one, keeping both endpoints', () => {
    const registry = makeRegistry();
    const first = registry.add({
      label: 'Box B — LAN',
      httpBaseUrl: 'http://192.168.1.20:3141',
      source: 'manual',
    });
    const second = registry.add({
      label: 'Box B — Tailnet',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
    });
    expect(registry.getAll()).toHaveLength(2);

    registry.attachEnvironmentDescriptor(first.id, 'environment-box-b');
    const merged = registry.attachEnvironmentDescriptor(
      second.id,
      'environment-box-b',
    );

    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].environmentId).toBe('environment-box-b');
    // The stable (first-attached) entry's identity and label win.
    expect(all[0].id).toBe(first.id);
    expect(all[0].label).toBe('Box B — LAN');
    const urls = all[0].endpoints
      .map((endpoint) => endpoint.httpBaseUrl)
      .sort();
    expect(urls).toEqual([
      'http://192.168.1.20:3141',
      'https://box-b.tailnet.ts.net',
    ]);
    expect(merged?.id).toBe(first.id);
  });

  it('attaching a fresh environmentId to a single entry does not merge anything', () => {
    const registry = makeRegistry();
    const only = registry.add({
      label: 'Box B',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
    });
    const updated = registry.attachEnvironmentDescriptor(
      only.id,
      'environment-box-b',
    );
    expect(updated?.environmentId).toBe('environment-box-b');
    expect(registry.getAll()).toHaveLength(1);
  });

  it('attachEnvironmentDescriptor on an unknown id is a no-op', () => {
    const registry = makeRegistry();
    expect(registry.attachEnvironmentDescriptor('missing', 'env-x')).toBeNull();
  });

  it('a third entry attaching to an already-merged environmentId folds in (1 env, 3 endpoints)', () => {
    // Verifier probe, station#1096 fix round 1: prove the merge doesn't
    // special-case "exactly two" — a third independently-added endpoint for
    // the same station must fold into the SAME stable entry, not create a
    // second merged pair.
    const registry = makeRegistry();
    const first = registry.add({
      label: 'Box B — LAN',
      httpBaseUrl: 'http://192.168.1.20:3141',
      source: 'manual',
    });
    const second = registry.add({
      label: 'Box B — Tailnet',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
    });
    const third = registry.add({
      label: 'Box B — LAN alt NIC',
      httpBaseUrl: 'http://10.0.0.5:3141',
      source: 'manual',
    });

    registry.attachEnvironmentDescriptor(first.id, 'environment-box-b');
    registry.attachEnvironmentDescriptor(second.id, 'environment-box-b');
    const afterThird = registry.attachEnvironmentDescriptor(
      third.id,
      'environment-box-b',
    );

    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
    const urls = all[0].endpoints
      .map((endpoint) => endpoint.httpBaseUrl)
      .sort();
    expect(urls).toEqual([
      'http://10.0.0.5:3141',
      'http://192.168.1.20:3141',
      'https://box-b.tailnet.ts.net',
    ]);
    expect(afterThird?.id).toBe(first.id);
  });

  it('re-attaching a DIFFERENT environmentId to an already-identified entry updates in place — no orphan or duplicate', () => {
    // Verifier probe, station#1096 fix round 1: a corrected/re-typed
    // environmentId must overwrite the existing entry's identity, not spawn
    // a second entry or strand the old identity as an orphan.
    const registry = makeRegistry();
    const entry = registry.add({
      label: 'Box B',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
    });
    registry.attachEnvironmentDescriptor(entry.id, 'environment-old');
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get(entry.id)?.environmentId).toBe('environment-old');

    const updated = registry.attachEnvironmentDescriptor(
      entry.id,
      'environment-new',
    );

    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(entry.id);
    expect(all[0].environmentId).toBe('environment-new');
    expect(updated?.environmentId).toBe('environment-new');
    // No stranded entry anywhere in the registry still carrying the old id.
    expect(
      registry
        .getAll()
        .some((item) => item.environmentId === 'environment-old'),
    ).toBe(false);
  });

  it('endpoint dedup: the same httpBaseUrl is never added twice', () => {
    const environment = createKnownEnvironment({
      label: 'Box B',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
      now: 1000,
    });
    const withDuplicate = addEndpoint(
      environment,
      environment.endpoints[0],
      2000,
    );
    expect(withDuplicate.endpoints).toHaveLength(1);
    // No-op dedup leaves updatedAt untouched.
    expect(withDuplicate.updatedAt).toBe(1000);
  });
});

describe('attachEnvironmentDescriptor (pure function)', () => {
  it('merges endpoints across two entries sharing a new environmentId', () => {
    const stable = createKnownEnvironment({
      label: 'Stable',
      httpBaseUrl: 'http://192.168.1.20:3141',
      source: 'manual',
      environmentId: 'environment-box-b',
      now: 1000,
    });
    const candidate = createKnownEnvironment({
      label: 'Candidate',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      source: 'manual',
      now: 2000,
    });
    const merged = attachEnvironmentDescriptor(
      [stable, candidate],
      'environment-box-b',
      candidate.id,
      3000,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(stable.id);
    expect(merged[0].endpoints).toHaveLength(2);
  });
});

describe('mergeKnownEnvironments (read-time fold)', () => {
  it('appends an environment with no environmentId as a distinct entry', () => {
    const existing = [
      createKnownEnvironment({
        label: 'A',
        httpBaseUrl: 'https://a.example.test',
        source: 'manual',
      }),
    ];
    const incoming = createKnownEnvironment({
      label: 'B',
      httpBaseUrl: 'https://b.example.test',
      source: 'ssh',
    });
    const result = mergeKnownEnvironments(existing, incoming);
    expect(result).toHaveLength(2);
  });

  it('folds an incoming environment into an existing one sharing environmentId', () => {
    const existing = [
      createKnownEnvironment({
        label: 'Paired Box B',
        httpBaseUrl: 'https://box-b.tailnet.ts.net',
        source: 'paired',
        environmentId: 'environment-box-b',
      }),
    ];
    const incoming = createKnownEnvironment({
      label: 'SSH Box B',
      httpBaseUrl: 'http://127.0.0.1:41123',
      source: 'ssh',
      kind: 'ssh-forward',
      environmentId: 'environment-box-b',
    });
    const result = mergeKnownEnvironments(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('paired');
    expect(result[0].endpoints).toHaveLength(2);
  });
});
