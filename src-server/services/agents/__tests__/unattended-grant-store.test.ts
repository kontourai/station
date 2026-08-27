import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { unattendedGrantOperations } from '../../../telemetry/metrics.js';
import {
  corruptFile,
  danglingSymlink,
  interleaveOnceOnLockAcquire,
  reservedKeyShapes,
  truncatePrimaryKeepPrevious,
} from '../../infra/__tests__/helpers/store-faults.js';
import {
  principalKey,
  UnattendedGrantStore,
  UnattendedGrantStoreUnavailableError,
  UnattendedGrantValidationError,
  unattendedGrantStorePath,
} from '../unattended-grant-store.js';

let onLockAcquire: ((lock: string) => void) | undefined;
vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLockAsync: async (
        lock: string,
        options?: Parameters<typeof actual.acquireFileMutationLockAsync>[1],
      ) => {
        const release = await actual.acquireFileMutationLockAsync(lock, {
          ...options,
          birthFingerprint: () => 'unattended-grant-store-test',
        });
        onLockAcquire?.(lock);
        return release;
      },
    };
  },
);

describe('UnattendedGrantStore', () => {
  let homeDir: string;
  let filePath: string;
  let store: UnattendedGrantStore;
  let ticks: Date[];

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'station-unattended-grants-'));
    filePath = unattendedGrantStorePath(homeDir);
    ticks = [
      new Date('2026-08-09T12:00:00.000Z'),
      new Date('2026-08-09T12:01:00.000Z'),
      new Date('2026-08-09T12:02:00.000Z'),
    ];
    store = new UnattendedGrantStore(homeDir, () => ticks.shift()!);
  });

  afterEach(() => {
    onLockAcquire = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('grant authorizes, revoke denies, and retains the revocation receipt', async () => {
    const principal = principalKey({
      kind: 'voice',
      agentSlug: 'operator',
      sessionId: 'one',
    });
    await store.grantTool(principal, 'calendar.create', 'brian');
    expect(store.isGranted(principal, 'calendar.create')).toBe(true);

    await store.revokeGrant(principal, 'calendar.create');
    expect(store.isGranted(principal, 'calendar.create')).toBe(false);
    expect(store.listGrants()).toEqual([
      {
        principalKey: principal,
        toolName: 'calendar.create',
        grantedBy: 'brian',
        grantedAt: '2026-08-09T12:00:00.000Z',
        revokedAt: '2026-08-09T12:01:00.000Z',
      },
    ]);
  });

  test('a throwing telemetry counter cannot fail an already-committed grant/revoke (#2037)', async () => {
    // The metric is recorded AFTER the durable mutation. If it could throw
    // past the return, the caller would observe a non-2xx while the grant is
    // live — the fail-closed-mutation violation the re-review caught.
    const spy = vi
      .spyOn(unattendedGrantOperations, 'add')
      .mockImplementation(() => {
        throw new Error('otel exporter exploded');
      });
    try {
      const principal = principalKey({
        kind: 'voice',
        agentSlug: 'operator',
        sessionId: 'one',
      });
      // grantTool must still RETURN the receipt, and the grant must persist.
      const receipt = await store.grantTool(
        principal,
        'calendar.create',
        'brian',
      );
      expect(receipt.toolName).toBe('calendar.create');
      expect(store.isGranted(principal, 'calendar.create')).toBe(true);
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
        [JSON.stringify([principal, 'calendar.create'])]: {
          grantedBy: 'brian',
        },
      });
      // revokeGrant must likewise not throw and must persist the revocation.
      await expect(
        store.revokeGrant(principal, 'calendar.create'),
      ).resolves.toBeUndefined();
      expect(store.isGranted(principal, 'calendar.create')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('voice principal key is stable across session ids and isolates agents', async () => {
    const first = principalKey({
      kind: 'voice',
      agentSlug: 'alpha',
      sessionId: 'a',
    });
    const second = principalKey({
      kind: 'voice',
      agentSlug: 'alpha',
      sessionId: 'b',
    });
    const other = principalKey({
      kind: 'voice',
      agentSlug: 'beta',
      sessionId: 'a',
    });
    expect(first).toBe(second);
    expect(first).not.toBe(other);

    await store.grantTool(first, 'calendar.create', 'brian');
    expect(store.isGranted(second, 'calendar.create')).toBe(true);
    expect(store.isGranted(other, 'calendar.create')).toBe(false);
  });

  test('principal keys include their unattended-principal kind', async () => {
    const voice = principalKey({
      kind: 'voice',
      agentSlug: 'x',
      sessionId: 'session',
    });
    const scheduledJob = principalKey({ kind: 'scheduled-job', jobId: 'x' });
    const delegatedChild = principalKey({
      kind: 'delegated-child',
      originAgentSlug: 'x',
    });
    expect(new Set([voice, scheduledJob, delegatedChild])).toHaveLength(3);

    await store.grantTool(voice, 'reports.send', 'brian');
    expect(store.isGranted(scheduledJob, 'reports.send')).toBe(false);
    expect(store.isGranted(delegatedChild, 'reports.send')).toBe(false);
  });

  test('grant is isolated to its exact tool', async () => {
    const principal = principalKey({ kind: 'scheduled-job', jobId: 'daily' });
    await store.grantTool(principal, 'reports.send', 'brian');
    expect(store.isGranted(principal, 'reports.delete')).toBe(false);
  });

  test('re-grant after revocation restores authorization with a fresh receipt', async () => {
    const principal = principalKey({ kind: 'scheduled-job', jobId: 'daily' });
    await store.grantTool(principal, 'reports.send', 'brian');
    await store.revokeGrant(principal, 'reports.send');
    expect(store.isGranted(principal, 'reports.send')).toBe(false);
    expect(store.listGrants()[0]?.revokedAt).toBe('2026-08-09T12:01:00.000Z');

    await store.grantTool(principal, 'reports.send', 'brian');
    expect(store.isGranted(principal, 'reports.send')).toBe(true);
    expect(store.listGrants()).toEqual([
      {
        principalKey: principal,
        toolName: 'reports.send',
        grantedBy: 'brian',
        grantedAt: '2026-08-09T12:02:00.000Z',
      },
    ]);
  });

  test('rejects blank mutation inputs without changing an existing store', async () => {
    const principal = principalKey({ kind: 'scheduled-job', jobId: 'daily' });
    await store.grantTool(principal, 'reports.send', 'brian');
    const before = readFileSync(filePath, 'utf-8');

    for (const [invalidPrincipal, invalidToolName, invalidGrantedBy] of [
      [principal, '', 'brian'],
      [principal, 'reports.delete', ' '],
      ['', 'reports.delete', 'brian'],
    ]) {
      await expect(
        store.grantTool(invalidPrincipal, invalidToolName, invalidGrantedBy),
      ).rejects.toThrow(UnattendedGrantValidationError);
      expect(readFileSync(filePath, 'utf-8')).toBe(before);
    }
    await expect(store.revokeGrant(' ', 'reports.send')).rejects.toThrow(
      UnattendedGrantValidationError,
    );
    await expect(store.revokeGrant(principal, ' ')).rejects.toThrow(
      UnattendedGrantValidationError,
    );
    expect(readFileSync(filePath, 'utf-8')).toBe(before);

    expect(store.isGranted(principal, 'reports.send')).toBe(true);
  });

  test('v1 receipt has only exact principal/tool consent and revocation fields', async () => {
    const principal = principalKey({
      kind: 'scheduled-job',
      jobId: 'daily-report',
    });
    await store.grantTool(principal, 'reports.send', 'brian');
    expect(store.listGrants()[0]).toEqual({
      principalKey: principal,
      toolName: 'reports.send',
      grantedBy: 'brian',
      grantedAt: '2026-08-09T12:00:00.000Z',
    });
    expect(Object.keys(store.listGrants()[0])).not.toEqual(
      expect.arrayContaining([
        'expiresAt',
        'capability',
        'arguments',
        'tenantId',
      ]),
    );
  });

  test('forbidden grant scope fields on disk fail closed', async () => {
    const principal = principalKey({ kind: 'scheduled-job', jobId: 'daily' });
    const toolName = 'reports.send';
    // Create the directory using the real store, then replace its contents
    // with a receipt from a newer/unsupported scope contract.
    await store.grantTool(principal, toolName, 'brian');
    writeFileSync(
      filePath,
      JSON.stringify({
        [JSON.stringify([principal, toolName])]: {
          principalKey: principal,
          toolName,
          grantedBy: 'brian',
          grantedAt: '2026-08-09T12:00:00.000Z',
          expiresAt: '2026-08-10T12:00:00.000Z',
        },
      }),
    );

    expect(() => store.isGranted(principal, toolName)).toThrow(
      UnattendedGrantStoreUnavailableError,
    );
  });

  test('corrupt primary fails closed for read, grant, and revoke without overwrite', async () => {
    const principal = principalKey({ kind: 'scheduled-job', jobId: 'keeper' });
    await store.grantTool(principal, 'reports.send', 'brian');
    corruptFile(filePath);

    expect(() => store.isGranted(principal, 'reports.send')).toThrow(
      UnattendedGrantStoreUnavailableError,
    );
    await expect(
      store.grantTool(principal, 'reports.delete', 'brian'),
    ).rejects.toThrow(UnattendedGrantStoreUnavailableError);
    await expect(store.revokeGrant(principal, 'reports.send')).rejects.toThrow(
      UnattendedGrantStoreUnavailableError,
    );
    expect(readFileSync(filePath, 'utf-8')).toBe('not json');
  });

  test('torn primary with .previous is unavailable, never restored or rewritten', async () => {
    const principal = principalKey({ kind: 'scheduled-job', jobId: 'daily' });
    await store.grantTool(principal, 'reports.send', 'brian');
    await store.grantTool(principal, 'reports.archive', 'brian');
    const { truncated } = truncatePrimaryKeepPrevious(filePath);

    expect(() => store.isGranted(principal, 'reports.send')).toThrow(
      UnattendedGrantStoreUnavailableError,
    );
    await expect(
      store.grantTool(principal, 'reports.delete', 'brian'),
    ).rejects.toThrow(UnattendedGrantStoreUnavailableError);
    expect(readFileSync(filePath, 'utf-8')).toBe(truncated);
    expect(
      readdirSync(join(homeDir, 'security')).filter((name) =>
        name.includes('quarantine'),
      ),
    ).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'dangling symlink fails closed rather than reading empty',
    async () => {
      // Ensure the containing directory exists without creating the primary.
      await store.grantTool(
        principalKey({ kind: 'scheduled-job', jobId: 'setup' }),
        'reports.send',
        'brian',
      );
      rmSync(filePath);
      danglingSymlink(filePath);
      expect(() => store.isGranted('any', 'tool')).toThrow(
        UnattendedGrantStoreUnavailableError,
      );
    },
  );

  test.each(reservedKeyShapes())(
    'hostile store shape $label fails closed',
    async ({ content }) => {
      // Create the containing directory and valid primary through the real store.
      await store.grantTool(
        principalKey({ kind: 'scheduled-job', jobId: 'setup' }),
        'reports.send',
        'brian',
      );
      writeFileSync(filePath, content);
      expect(() => store.listGrants()).toThrow(
        UnattendedGrantStoreUnavailableError,
      );
    },
  );

  test('serialized concurrent interleave preserves both grants', async () => {
    const first = principalKey({ kind: 'scheduled-job', jobId: 'first' });
    const second = principalKey({ kind: 'scheduled-job', jobId: 'second' });
    await store.grantTool(first, 'reports.send', 'brian');
    const injected = interleaveOnceOnLockAcquire(
      (hook) => {
        onLockAcquire = hook;
      },
      () => {
        const current = JSON.parse(readFileSync(filePath, 'utf-8'));
        const key = JSON.stringify([second, 'reports.archive']);
        current[key] = {
          principalKey: second,
          toolName: 'reports.archive',
          grantedBy: 'other',
          grantedAt: '2026-08-09T12:02:00.000Z',
        };
        writeFileSync(filePath, JSON.stringify(current, null, 2));
      },
    );
    await store.grantTool(first, 'reports.delete', 'brian');
    expect(injected()).toBe(true);
    expect(store.isGranted(second, 'reports.archive')).toBe(true);
    expect(store.isGranted(first, 'reports.delete')).toBe(true);
  });
  test('grantTool rejects an undefined or empty grantor without bricking the store', async () => {
    const principal = principalKey({ kind: 'scheduled-job', jobId: 'j1' });
    const file = readFileSync;
    await store.grantTool(principal, 'reports.send', 'brian');
    const before = file(unattendedGrantStorePath(homeDir), 'utf-8');
    await expect(
      // runtime callers can defeat the string type
      (
        store.grantTool as unknown as (
          p: string,
          t: string,
          g?: string,
        ) => Promise<void>
      )(principal, 'reports.delete', undefined),
    ).rejects.toThrow(UnattendedGrantValidationError);
    await expect(
      store.grantTool(principal, 'reports.delete', '   '),
    ).rejects.toThrow(UnattendedGrantValidationError);
    // store untouched and still readable
    expect(file(unattendedGrantStorePath(homeDir), 'utf-8')).toBe(before);
    expect(store.isGranted(principal, 'reports.send')).toBe(true);
  });
});
