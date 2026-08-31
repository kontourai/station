import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type {
  AgentConnectionView,
  ConnectionConfig,
} from '@kontourai/station-contracts/tool';
import { afterEach, describe, expect, test } from 'vitest';
import { deriveConnectionReadinessEvidence } from '../connection-readiness-evidence.js';
import {
  ConnectionSmokeEvidenceStoreValidationError,
  deriveConnectionSmokeFreshUntil,
  FileConnectionSmokeEvidenceStore,
  type StoredConnectionSmokeResult,
} from '../connection-smoke-evidence-store.js';

function connection(
  overrides: Partial<AgentConnectionView> = {},
): AgentConnectionView {
  return {
    id: engineConnectionId('codex'),
    kind: 'agent',
    type: 'codex',
    name: 'Codex',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: { provider: 'codex' },
    status: 'ready',
    prerequisites: [],
    runtimeCatalog: {
      source: 'live',
      fetchedAt: '2026-07-13T20:00:00.000Z',
      models: [{ id: 'gpt-5.4', name: 'GPT-5.4', originalId: 'gpt-5.4' }],
      builtInModels: [],
    },
    ...overrides,
    setup: overrides.setup ?? {
      state: 'ready',
      detected: true,
      configured: false,
    },
  };
}

function modelConnection(): ConnectionConfig {
  return {
    id: 'anthropic-1',
    kind: 'model',
    type: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    capabilities: ['llm'],
    // No modelOptions: an invalid key is exactly the case where the catalogue
    // never loads, so `baseLevel` stays at the prerequisite guess.
    config: {},
    status: 'ready',
    prerequisites: [
      {
        id: 'anthropic-api-key',
        name: 'Anthropic API key',
        description: 'A key is saved.',
        status: 'installed',
        category: 'required',
      },
    ],
  };
}

describe('connection readiness evidence', () => {
  // RT-06 — `status: 'ready'` on a model connection means "a non-empty string
  // is saved in the key box". A knowingly-invalid key reported Ready and the
  // explicit test that refuted it was discarded.
  test('a refused check outranks the prerequisite guess and carries the reason', () => {
    const evidence = deriveConnectionReadinessEvidence(
      modelConnection(),
      null,
      new Date('2026-08-20T10:00:00.000Z'),
      {
        status: 'failed',
        checkedAt: '2026-08-20T09:59:00.000Z',
        reason: '401 invalid x-api-key',
      },
    );

    expect(evidence.level).toBe('discovered');
    expect(evidence.summary).toBe('401 invalid x-api-key');
    expect(evidence.action).toContain('test it again');
    expect(evidence.check).toEqual({
      status: 'failed',
      checkedAt: '2026-08-20T09:59:00.000Z',
      reason: '401 invalid x-api-key',
    });
  });

  // Delta review H1 — reachable, no usable catalogue. Neither a refusal nor
  // Ready: an OpenAI-compatible server with chat and no /models lives here.
  test('a catalog-unavailable check is not a refusal and cannot reach catalog-ready', () => {
    const evidence = deriveConnectionReadinessEvidence(
      modelConnection(),
      null,
      new Date('2026-08-20T10:00:00.000Z'),
      {
        status: 'catalog-unavailable',
        checkedAt: '2026-08-20T09:59:00.000Z',
        reason: 'Model catalog request failed with HTTP 404.',
        source: 'catalog-discovery',
      },
    );

    expect(evidence.level).toBe('prerequisite-ready');
    expect(evidence.summary).toBe(
      'Model catalog request failed with HTTP 404.',
    );
    expect(evidence.action).toContain('Test Connection');
  });

  test('configured selectors cannot lift a catalog-unavailable connection to catalog-ready', () => {
    // `baseLevel` reads modelOptions, which a configured-selector fallback can
    // populate — the operator's own text, not a provider response.
    const evidence = deriveConnectionReadinessEvidence(
      {
        ...modelConnection(),
        config: { modelOptions: [{ id: 'a', name: 'A' }] },
      },
      null,
      new Date('2026-08-20T10:00:00.000Z'),
      { status: 'catalog-unavailable', source: 'catalog-discovery' },
    );

    expect(evidence.level).toBe('prerequisite-ready');
  });

  test('an unasked model connection stays below catalog-ready', () => {
    const evidence = deriveConnectionReadinessEvidence(
      modelConnection(),
      null,
      new Date('2026-08-20T10:00:00.000Z'),
      { status: 'not-checked' },
    );

    expect(evidence.level).toBe('prerequisite-ready');
    expect(evidence.check).toEqual({ status: 'not-checked' });
  });

  test('a passed check is a live provider response, so it reaches catalog-ready', () => {
    const evidence = deriveConnectionReadinessEvidence(
      modelConnection(),
      null,
      new Date('2026-08-20T10:00:00.000Z'),
      { status: 'passed', checkedAt: '2026-08-20T09:59:00.000Z' },
    );

    expect(evidence.level).toBe('catalog-ready');
  });

  test('keeps live catalog evidence distinct from an untested chat', () => {
    const evidence = deriveConnectionReadinessEvidence(
      connection(),
      null,
      new Date('2026-07-13T20:01:00.000Z'),
    );

    expect(evidence).toMatchObject({
      level: 'catalog-ready',
      freshness: 'fresh',
      smoke: { status: 'not-tested', freshness: 'unknown', turnLimit: 1 },
    });
  });

  test('promotes only fresh successful smoke and downgrades stale proof', () => {
    const receipt = {
      evidenceVersion: 2 as const,
      connectionId: 'codex',
      configurationFingerprint: 'fingerprint',
      status: 'passed' as const,
      testedAt: '2026-07-13T20:00:00.000Z',
      freshUntil: '2026-07-14T20:00:00.000Z',
      provider: 'codex',
      durationMs: 1200,
      turnLimit: 1 as const,
    };

    expect(
      deriveConnectionReadinessEvidence(
        connection(),
        receipt,
        new Date('2026-07-14T19:59:00.000Z'),
      ).level,
    ).toBe('smoke-passed');
    expect(
      deriveConnectionReadinessEvidence(
        connection(),
        receipt,
        new Date('2026-07-14T20:01:00.000Z'),
      ),
    ).toMatchObject({
      level: 'catalog-ready',
      smoke: { status: 'passed', freshness: 'stale' },
    });
  });

  // Delta2 review H3 — smoke receipts stay fresh for 24 hours, so
  // unconditional precedence let a smoke that passed at 09:00 keep rendering
  // Ready through a genuine 401 observed at 10:00, while system status was
  // already gating the same connection.
  describe('smoke versus check precedence is decided by time, not by rank', () => {
    const passedSmoke = {
      evidenceVersion: 2 as const,
      connectionId: 'anthropic-1',
      configurationFingerprint: 'fingerprint',
      status: 'passed' as const,
      testedAt: '2026-07-14T09:00:00.000Z',
      freshUntil: '2026-07-15T09:00:00.000Z',
      provider: 'anthropic',
      durationMs: 1200,
      turnLimit: 1 as const,
    };

    test('a refusal observed AFTER the smoke wins', () => {
      const evidence = deriveConnectionReadinessEvidence(
        modelConnection(),
        passedSmoke,
        new Date('2026-07-14T10:05:00.000Z'),
        {
          status: 'failed',
          checkedAt: '2026-07-14T10:00:00.000Z',
          reason: '401 invalid x-api-key',
          source: 'catalog-discovery',
        },
      );

      expect(evidence.level).toBe('discovered');
      expect(evidence.summary).toBe('401 invalid x-api-key');
    });

    test('a refusal observed BEFORE the smoke does not', () => {
      const evidence = deriveConnectionReadinessEvidence(
        modelConnection(),
        passedSmoke,
        new Date('2026-07-14T10:05:00.000Z'),
        {
          status: 'failed',
          checkedAt: '2026-07-14T08:00:00.000Z',
          reason: '401 invalid x-api-key',
          source: 'catalog-discovery',
        },
      );

      expect(evidence.level).toBe('smoke-passed');
      // …and it is not captioned with the refusal it just outranked.
      expect(evidence.summary).not.toContain('401');
    });

    test('a newer catalog-unavailable never outranks a passed smoke', () => {
      // Reachable-with-no-catalogue is not a fault; a complete chat turn
      // remains the stronger evidence however recent the catalogue answer is.
      expect(
        deriveConnectionReadinessEvidence(
          modelConnection(),
          passedSmoke,
          new Date('2026-07-14T10:05:00.000Z'),
          {
            status: 'catalog-unavailable',
            checkedAt: '2026-07-14T10:00:00.000Z',
            source: 'catalog-discovery',
          },
        ).level,
      ).toBe('smoke-passed');
    });

    test('a newer unreachable inside its grace window does not outrank the smoke', () => {
      expect(
        deriveConnectionReadinessEvidence(
          modelConnection(),
          passedSmoke,
          new Date('2026-07-14T10:05:00.000Z'),
          {
            status: 'unreachable',
            retrying: true,
            checkedAt: '2026-07-14T10:00:00.000Z',
            reason: 'fetch failed',
            source: 'catalog-discovery',
          },
        ).level,
      ).toBe('smoke-passed');
    });

    test('a newer unreachable past its grace window does', () => {
      const evidence = deriveConnectionReadinessEvidence(
        modelConnection(),
        passedSmoke,
        new Date('2026-07-14T10:05:00.000Z'),
        {
          status: 'unreachable',
          checkedAt: '2026-07-14T10:00:00.000Z',
          reason: 'fetch failed',
          source: 'catalog-discovery',
        },
      );

      expect(evidence.level).toBe('discovered');
      expect(evidence.summary).toBe('fetch failed');
    });
  });

  test('reports a fresh failed smoke without hiding independently proven catalog evidence', () => {
    const evidence = deriveConnectionReadinessEvidence(
      connection(),
      {
        evidenceVersion: 2,
        connectionId: 'codex',
        configurationFingerprint: 'fingerprint',
        status: 'failed',
        testedAt: '2026-07-13T20:00:00.000Z',
        freshUntil: '2026-07-14T20:00:00.000Z',
        provider: 'codex',
        durationMs: 5000,
        reasonCode: 'timeout',
        reason: 'The smoke timed out.',
        action: 'Check the runtime.',
        turnLimit: 1,
      },
      new Date('2026-07-13T20:01:00.000Z'),
    );

    expect(evidence).toMatchObject({
      level: 'catalog-ready',
      summary: 'The smoke timed out.',
      action: 'Check the runtime.',
      smoke: { status: 'failed', reasonCode: 'timeout' },
    });
  });

  test('does not call built-in catalogs catalog-ready', () => {
    const evidence = deriveConnectionReadinessEvidence(
      connection({
        runtimeCatalog: {
          source: 'built-in',
          fetchedAt: null,
          models: [],
          builtInModels: [
            { id: 'built-in', name: 'Built-in', originalId: 'built-in' },
          ],
        },
      }),
      null,
    );

    expect(evidence.level).toBe('prerequisite-ready');
  });
});

describe('file connection smoke evidence store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function receipt(overrides: Record<string, unknown> = {}) {
    return {
      evidenceVersion: 2 as const,
      connectionId: 'claude',
      configurationFingerprint: 'a'.repeat(64),
      status: 'passed' as const,
      testedAt: '2026-07-13T20:00:00.000Z',
      freshUntil: '2026-07-14T20:00:00.000Z',
      provider: 'claude',
      model: 'claude-sonnet',
      durationMs: 900,
      turnLimit: 1 as const,
      ...overrides,
    };
  }

  function storePath(dir: string): string {
    return join(dir, 'connection-smoke.json');
  }

  function document(results: unknown[] = [receipt()]) {
    return { evidenceVersion: 3 as const, results };
  }

  test('derives the one exact bounded freshness window from a canonical observation', () => {
    expect(deriveConnectionSmokeFreshUntil('2026-07-13T20:00:00.000Z')).toBe(
      '2026-07-14T20:00:00.000Z',
    );
    expect(() =>
      deriveConnectionSmokeFreshUntil('2026-07-13T20:00:00Z'),
    ).toThrow(ConnectionSmokeEvidenceStoreValidationError);
  });

  test('persists only redacted receipt metadata across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const storedReceipt = receipt();

    await new FileConnectionSmokeEvidenceStore(dir).record(storedReceipt);

    expect(new FileConnectionSmokeEvidenceStore(dir).get('claude')).toEqual(
      storedReceipt,
    );
  });

  test('treats ENOENT as the only empty state and writes a durable receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const store = new FileConnectionSmokeEvidenceStore(dir);

    expect(store.get('claude')).toBeNull();
    await store.record(receipt());
    await store.record(receipt({ durationMs: 901 }));

    expect(existsSync(storePath(dir))).toBe(true);
    expect(existsSync(`${storePath(dir)}.previous`)).toBe(true);
    expect(new FileConnectionSmokeEvidenceStore(dir).get('claude')).toEqual(
      receipt({ durationMs: 901 }),
    );
  });

  test('rejects corrupt or ill-shaped persisted evidence without changing its bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const invalid = JSON.stringify(
      document([{ ...receipt(), unexpected: true }]),
    );
    writeFileSync(storePath(dir), invalid);
    const store = new FileConnectionSmokeEvidenceStore(dir);

    expect(() => store.get('claude')).toThrow(
      ConnectionSmokeEvidenceStoreValidationError,
    );
    await expect(store.record(receipt())).rejects.toThrow(
      ConnectionSmokeEvidenceStoreValidationError,
    );
    expect(readFileSync(storePath(dir), 'utf8')).toBe(invalid);
    expect(existsSync(`${storePath(dir)}.mutation`)).toBe(false);
  });

  test.each([
    [
      'unknown document key',
      (value: Record<string, unknown>) => ({ ...value, extra: true }),
    ],
    [
      'noncanonical connection identity',
      (value: Record<string, unknown>) => ({
        ...value,
        results: [receipt({ connectionId: 'CLAUDE-RUNTIME' })],
      }),
    ],
    [
      'noncanonical fingerprint',
      (value: Record<string, unknown>) => ({
        ...value,
        results: [receipt({ configurationFingerprint: 'fingerprint' })],
      }),
    ],
    [
      'noncanonical timestamp',
      (value: Record<string, unknown>) => ({
        ...value,
        results: [receipt({ testedAt: '2026-07-13T20:00:00Z' })],
      }),
    ],
    [
      'arbitrary freshness window',
      (value: Record<string, unknown>) => ({
        ...value,
        results: [receipt({ freshUntil: '2026-07-13T21:00:00.000Z' })],
      }),
    ],
    [
      'non-terminal status',
      (value: Record<string, unknown>) => ({
        ...value,
        results: [receipt({ status: 'not-tested' })],
      }),
    ],
    [
      'failure missing its actionable outcome',
      (value: Record<string, unknown>) => ({
        ...value,
        results: [
          receipt({
            status: 'failed',
            reasonCode: 'timeout',
            reason: 'The smoke timed out.',
          }),
        ],
      }),
    ],
    [
      'passed result carrying failure fields',
      (value: Record<string, unknown>) => ({
        ...value,
        results: [receipt({ reasonCode: 'timeout' })],
      }),
    ],
  ])(
    'rejects %s without defaulting or writing it back',
    async (_label, mutate) => {
      const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
      dirs.push(dir);
      const persisted = JSON.stringify(mutate(document()));
      writeFileSync(storePath(dir), persisted);
      const store = new FileConnectionSmokeEvidenceStore(dir);

      expect(() => store.get('claude')).toThrow(
        ConnectionSmokeEvidenceStoreValidationError,
      );
      await expect(store.record(receipt())).rejects.toThrow(
        ConnectionSmokeEvidenceStoreValidationError,
      );
      expect(readFileSync(storePath(dir), 'utf8')).toBe(persisted);
    },
  );

  test('rejects an ambiguous raw document with duplicate connection receipt identities', () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const persisted = JSON.stringify(
      document([receipt(), receipt({ durationMs: 901 })]),
    );
    writeFileSync(storePath(dir), persisted);

    expect(() =>
      new FileConnectionSmokeEvidenceStore(dir).get('claude'),
    ).toThrow(ConnectionSmokeEvidenceStoreValidationError);
    expect(readFileSync(storePath(dir), 'utf8')).toBe(persisted);
  });

  test('rejects the superseded keyed document instead of migrating or rewriting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const persisted = JSON.stringify({
      evidenceVersion: 2,
      results: { claude: receipt() },
    });
    writeFileSync(storePath(dir), persisted);
    const store = new FileConnectionSmokeEvidenceStore(dir);

    expect(() => store.get('claude')).toThrow(
      ConnectionSmokeEvidenceStoreValidationError,
    );
    await expect(store.record(receipt())).rejects.toThrow(
      ConnectionSmokeEvidenceStoreValidationError,
    );
    expect(readFileSync(storePath(dir), 'utf8')).toBe(persisted);
  });

  test('rejects coercible or non-JSON runtime inputs before they can publish an unreadable receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const store = new FileConnectionSmokeEvidenceStore(dir);

    await expect(
      store.record(
        receipt({
          configurationFingerprint: ['a'.repeat(64)],
        }) as StoredConnectionSmokeResult,
      ),
    ).rejects.toThrow(ConnectionSmokeEvidenceStoreValidationError);
    await expect(
      store.record(
        receipt({ durationMs: Number.NaN }) as StoredConnectionSmokeResult,
      ),
    ).rejects.toThrow(ConnectionSmokeEvidenceStoreValidationError);
    await expect(
      store.record(
        receipt({ provider: BigInt(1) }) as StoredConnectionSmokeResult,
      ),
    ).rejects.toThrow(ConnectionSmokeEvidenceStoreValidationError);
    const serializationChangingReceipt = Object.defineProperty(
      receipt(),
      'toJSON',
      {
        enumerable: false,
        value: () => null,
      },
    );
    await expect(
      store.record(serializationChangingReceipt as StoredConnectionSmokeResult),
    ).rejects.toThrow(ConnectionSmokeEvidenceStoreValidationError);
    expect(existsSync(storePath(dir))).toBe(false);
  });

  test('re-reads under the mutation lock so distinct records survive a stale writer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const second = new FileConnectionSmokeEvidenceStore(dir);
    let lockCalls = 0;
    const first = new FileConnectionSmokeEvidenceStore(dir, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 1)
          await second.record(
            receipt({
              connectionId: 'codex',
              configurationFingerprint: 'b'.repeat(64),
              provider: 'codex',
            }),
          );
        return () => {};
      },
    });

    await first.record(receipt());

    const reopened = new FileConnectionSmokeEvidenceStore(dir);
    expect(lockCalls).toBe(1);
    expect(reopened.get('claude')).toEqual(receipt());
    expect(reopened.get('codex')).toEqual(
      receipt({
        connectionId: 'codex',
        configurationFingerprint: 'b'.repeat(64),
        provider: 'codex',
      }),
    );
  });

  test('persists a complete failed outcome with its exact reason contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const failed = receipt({
      status: 'failed',
      reasonCode: 'timeout',
      reason: 'The smoke timed out.',
      action: 'Check the runtime, then run the smoke again.',
    });

    await new FileConnectionSmokeEvidenceStore(dir).record(failed);

    expect(new FileConnectionSmokeEvidenceStore(dir).get('claude')).toEqual(
      failed,
    );
  });

  test('replaces exactly the same connection key after a concurrent record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const second = new FileConnectionSmokeEvidenceStore(dir);
    let started = false;
    const first = new FileConnectionSmokeEvidenceStore(dir, {
      acquireMutationLock: async () => {
        if (!started) {
          started = true;
          await second.record(receipt({ durationMs: 1 }));
        }
        return () => {};
      },
    });

    await first.record(receipt({ durationMs: 2 }));

    expect(new FileConnectionSmokeEvidenceStore(dir).get('claude')).toEqual(
      receipt({ durationMs: 2 }),
    );
  });

  test('fails before publication when the mutation lock or durable write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connection-smoke-'));
    dirs.push(dir);
    const unavailable = new FileConnectionSmokeEvidenceStore(dir, {
      acquireMutationLock: () => {
        throw new Error('connection smoke lock unavailable');
      },
    });
    await expect(unavailable.record(receipt())).rejects.toThrow(
      'connection smoke lock unavailable',
    );
    expect(existsSync(storePath(dir))).toBe(false);

    const failing = new FileConnectionSmokeEvidenceStore(dir, {
      storeFactory: () => ({
        read: () => ({ evidenceVersion: 3 as const, results: [] }),
        write: () => {
          throw new Error('connection smoke durable write failed');
        },
      }),
    });
    await expect(failing.record(receipt())).rejects.toThrow(
      'connection smoke durable write failed',
    );
    expect(existsSync(`${storePath(dir)}.mutation`)).toBe(false);
    expect(existsSync(storePath(dir))).toBe(false);
  });
});
