import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireFileMutationLock,
  appendLifecycleEvent,
  classifyLifecycleExit,
  type LifecycleIdentity,
  readLifecycleEvents,
  resolveProcessBirthFingerprint,
  type StopIntent,
} from '../lifecycle-events.js';
import {
  lookupProcessBirthFingerprint,
  probeExactProcessIdentity,
} from '../process-identity.mjs';

const identity: LifecycleIdentity = {
  instanceId: 'phone',
  sha: 'a'.repeat(40),
  bootId: '11111111-1111-4111-8111-111111111111',
  pid: 1234,
};

const PROCESS_INTEGRATION_TEST_TIMEOUT_MS = 15_000;
const CHILD_READY_TIMEOUT_MS = 5_000;
const CHILD_CLEANUP_TIMEOUT_MS = 1_000;

function currentProcessBirthFingerprint(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-journal-birth-'));
  const lock = join(root, 'probe.lock');
  const release = acquireFileMutationLock(lock);
  try {
    return JSON.parse(readFileSync(lock, 'utf8')).birth;
  } finally {
    release();
    rmSync(root, { force: true, recursive: true });
  }
}

describe('lifecycle event journal', () => {
  it.each([
    ['promotion', 'expected_promotion'],
    ['operator_stop', 'operator_stop'],
    ['recovery', 'expected_recovery_stop'],
    ['rollback', 'expected_rollback'],
  ] as Array<[StopIntent, string]>)(
    'classifies %s intent with the exact boot identity',
    (intent, classification) => {
      const operationId = '22222222-2222-4222-8222-222222222222';
      const events = [
        {
          ...identity,
          version: 1 as const,
          type: 'stop_intent' as const,
          intent,
          operationId,
          expiresAt: '2026-07-10T12:00:30.000Z',
          timestamp: '2026-07-10T12:00:00.000Z',
        },
        {
          ...identity,
          version: 1 as const,
          type: 'stop_result' as const,
          operationId,
          result: 'completed' as const,
          timestamp: '2026-07-10T12:00:02.000Z',
        },
        {
          ...identity,
          version: 1 as const,
          type: 'shutdown_observed' as const,
          reason: 'SIGTERM' as const,
          sender: 'unknown' as const,
          timestamp: '2026-07-10T12:00:01.000Z',
        },
      ];
      expect(classifyLifecycleExit(events, identity)).toMatchObject({
        classification,
        intent,
        sender: 'unknown',
      });
    },
  );

  it.each(['failed', 'expired', 'orphan'] as const)(
    'does not let a %s stop intent misclassify a later signal',
    (shape) => {
      const operationId = '22222222-2222-4222-8222-222222222222';
      const events: any[] = [
        {
          ...identity,
          version: 1,
          type: 'stop_intent',
          intent: 'recovery',
          operationId,
          expiresAt:
            shape === 'expired'
              ? '2026-07-10T11:59:59.000Z'
              : '2026-07-10T12:00:30.000Z',
          timestamp: '2026-07-10T12:00:00.000Z',
        },
        {
          ...identity,
          version: 1,
          type: 'shutdown_observed',
          reason: 'SIGTERM',
          timestamp: '2026-07-10T12:00:01.000Z',
        },
      ];
      if (shape !== 'orphan') {
        events.push({
          ...identity,
          version: 1,
          type: 'stop_result',
          operationId,
          result: shape === 'failed' ? 'failed' : 'completed',
          timestamp: '2026-07-10T12:00:02.000Z',
        });
      }
      expect(classifyLifecycleExit(events, identity).classification).toBe(
        'unexpected_signal',
      );
    },
  );

  it('distinguishes unexpected signal, crash, and unobserved crash', () => {
    const at = '2026-07-10T12:00:00.000Z';
    expect(
      classifyLifecycleExit(
        [
          {
            ...identity,
            version: 1,
            type: 'shutdown_observed',
            reason: 'SIGTERM',
            sender: 'unknown',
            timestamp: at,
          },
        ],
        identity,
      ).classification,
    ).toBe('unexpected_signal');
    expect(
      classifyLifecycleExit(
        [
          {
            ...identity,
            version: 1,
            type: 'process_exit',
            exitCode: 1,
            signal: null,
            sender: 'unknown',
            timestamp: at,
          },
        ],
        identity,
      ).classification,
    ).toBe('crash');
    expect(classifyLifecycleExit([], identity).classification).toBe(
      'crash_unobserved',
    );
  });

  it('appends privately and rotates atomically without losing prior evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-'));
    const file = join(root, 'events.jsonl');
    appendLifecycleEvent(
      file,
      { ...identity, type: 'started', timestamp: '2026-07-10T12:00:00.000Z' },
      { maxBytes: 200 },
    );
    appendLifecycleEvent(
      file,
      {
        ...identity,
        type: 'process_exit',
        exitCode: 1,
        signal: null,
        sender: 'unknown',
        timestamp: '2026-07-10T12:00:01.000Z',
      },
      { maxBytes: 200 },
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${file}.previous`, 'utf8')).toContain(
      '"type":"started"',
    );
    expect(readLifecycleEvents(file)).toHaveLength(2);
  });

  it('rejects a symlink journal', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-link-'));
    const target = join(root, 'target');
    const link = join(root, 'events.jsonl');
    writeFileSync(target, '');
    chmodSync(target, 0o600);
    symlinkSync(target, link);
    expect(() =>
      appendLifecycleEvent(link, {
        ...identity,
        type: 'started',
        timestamp: '2026-07-10T12:00:00.000Z',
      }),
    ).toThrow();
  });

  it(
    'serializes concurrent process writers and reads both retained generations',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-journal-concurrent-'));
      const file = join(root, 'events.jsonl');
      const tsx = resolve(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        'node_modules',
        'tsx',
        'dist',
        'cli.mjs',
      );
      const modulePath = resolve(
        import.meta.dirname,
        '..',
        'lifecycle-events.ts',
      );
      const source = `import {appendLifecycleEvent} from ${JSON.stringify(modulePath)}; for(let i=0;i<10;i++) appendLifecycleEvent(process.env.FILE,{instanceId:'phone',sha:'${'a'.repeat(40)}',bootId:process.env.BOOT,pid:Number(process.env.PID),type:'started',timestamp:new Date(Date.now()+i).toISOString()},{maxBytes:4000});`;
      const children = [1, 2].map((index) =>
        spawn(process.execPath, [tsx, '-e', source], {
          env: {
            ...process.env,
            FILE: file,
            BOOT: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
            PID: String(5000 + index),
          },
        }),
      );
      const exits = await Promise.all(
        children.map(
          (child) =>
            new Promise<number | null>((resolveExit) =>
              child.once('exit', resolveExit),
            ),
        ),
      );
      expect(exits).toEqual([0, 0]);
      const events = readLifecycleEvents(file, 100);
      expect(new Set(events.map((event) => event.eventId)).size).toBe(
        events.length,
      );
      expect(events).toHaveLength(20);
    },
    PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it('reclaims a lock whose PID birth fingerprint no longer matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-reused-pid-'));
    const file = join(root, 'events.jsonl');
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        pid: process.pid,
        birth: 'not-this-process',
        token: 'old',
      }),
      { mode: 0o600 },
    );
    expect(() =>
      appendLifecycleEvent(
        file,
        { ...identity, type: 'started', timestamp: new Date().toISOString() },
        { lockTimeoutMs: 50 },
      ),
    ).not.toThrow();
  });

  it('does not reclaim a lock held by the same live PID birth', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-live-pid-'));
    const file = join(root, 'events.jsonl');
    const release = acquireFileMutationLock(`${file}.lock`);
    try {
      expect(() =>
        appendLifecycleEvent(
          file,
          { ...identity, type: 'started', timestamp: new Date().toISOString() },
          { lockTimeoutMs: 25 },
        ),
      ).toThrow('held by a live process');
    } finally {
      release();
    }
  });

  it.runIf(process.platform === 'linux')(
    'derives lock ownership from procfs when ps is unavailable',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-journal-procfs-'));
      const file = join(root, 'events.jsonl');
      const originalPath = process.env.PATH;
      process.env.PATH = '/path-without-ps';
      try {
        expect(() =>
          appendLifecycleEvent(file, {
            ...identity,
            type: 'started',
            timestamp: new Date().toISOString(),
          }),
        ).not.toThrow();
      } finally {
        process.env.PATH = originalPath;
      }
    },
  );

  it('publishes no lock artifact when process birth identity is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-no-birth-'));
    const file = join(root, 'events.jsonl');
    expect(() =>
      appendLifecycleEvent(
        file,
        { ...identity, type: 'started', timestamp: new Date().toISOString() },
        { lockOptions: { birthFingerprint: () => null } },
      ),
    ).toThrow('birth fingerprint is required');
    expect(readdirSync(root)).toEqual([]);
  });

  it('never moves replacement B when stale A changes after inspection', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-replacement-'));
    const file = join(root, 'events.jsonl');
    const lock = `${file}.lock`;
    const birth = currentProcessBirthFingerprint();
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, birth: 'stale', token: 'A' }),
      {
        mode: 0o600,
      },
    );
    expect(() =>
      appendLifecycleEvent(
        file,
        { ...identity, type: 'started', timestamp: new Date().toISOString() },
        {
          lockTimeoutMs: 25,
          lockOptions: {
            hooks: {
              afterStaleInspect: () => {
                rmSync(lock);
                writeFileSync(
                  lock,
                  JSON.stringify({ pid: process.pid, birth, token: 'B' }),
                  {
                    mode: 0o600,
                  },
                );
              },
            },
          },
        },
      ),
    ).toThrow('held by a live process');
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('B');
    expect(existsSync(`${lock}.guard`)).toBe(false);
  });

  it('blocks a publisher while the fixed guard protects stale A', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-guard-'));
    const lock = join(root, 'events.lock');
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, birth: 'stale', token: 'A' }),
      {
        mode: 0o600,
      },
    );
    let blocked = false;
    const release = acquireFileMutationLock(lock, {
      timeoutMs: 50,
      hooks: {
        afterGuardAcquired: () => {
          expect(existsSync(`${lock}.guard`)).toBe(true);
          expect(() => acquireFileMutationLock(lock, { timeoutMs: 0 })).toThrow(
            'guard is held',
          );
          blocked = true;
        },
      },
    });
    expect(blocked).toBe(true);
    release();
  });

  it('recovers after real guard-owner and reclamation-claimant child crashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-orphan-guard-'));
    const file = join(root, 'events.jsonl');
    const lock = `${file}.lock`;
    const tsx = resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    );
    const modulePath = resolve(
      import.meta.dirname,
      '..',
      'lifecycle-events.ts',
    );
    const runChild = async (
      hook: 'afterGuardAcquired' | 'afterClaimPublished',
    ) => {
      const source = `import {acquireFileMutationLock} from ${JSON.stringify(modulePath)}; acquireFileMutationLock(process.env.LOCK,{timeoutMs:500,claimLeaseMs:60,hooks:{${hook}:()=>process.exit(17)}});`;
      const child = spawn(process.execPath, [tsx, '-e', source], {
        env: { ...process.env, LOCK: lock },
      });
      return await new Promise<number | null>((resolveExit) =>
        child.once('exit', resolveExit),
      );
    };

    writeFileSync(
      lock,
      JSON.stringify({ pid: 999_999, birth: 'dead', token: 'A' }),
      {
        mode: 0o600,
      },
    );
    expect(await runChild('afterGuardAcquired')).toBe(17);
    expect(existsSync(`${lock}.guard`)).toBe(true);

    expect(await runChild('afterClaimPublished')).toBe(17);
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    appendLifecycleEvent(
      file,
      { ...identity, type: 'started', timestamp: new Date().toISOString() },
      { lockTimeoutMs: 1_000 },
    );
    expect(readLifecycleEvents(file)).toHaveLength(1);
    expect(existsSync(`${lock}.guard`)).toBe(false);
  });

  it('never expires or preempts a live elected claimant by wall clock alone', {
    timeout: PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-live-claim-'));
    const lock = join(root, 'events.lock');
    const ready = join(root, 'ready');
    const resume = join(root, 'resume');
    const tsx = resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    );
    const modulePath = resolve(
      import.meta.dirname,
      '..',
      'lifecycle-events.ts',
    );
    writeFileSync(
      lock,
      JSON.stringify({ pid: 999_999, birth: 'dead', token: 'A' }),
      {
        mode: 0o600,
      },
    );
    const guardOwner = spawnSync(
      process.execPath,
      [
        tsx,
        '-e',
        `import {acquireFileMutationLock} from ${JSON.stringify(modulePath)}; acquireFileMutationLock(process.env.LOCK,{hooks:{afterGuardAcquired:()=>process.exit(17)}});`,
      ],
      {
        env: { ...process.env, LOCK: lock },
        encoding: 'utf8',
        timeout: CHILD_READY_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    const guardDiagnostic = [guardOwner.error?.message, guardOwner.stderr]
      .filter(Boolean)
      .join('\n');
    expect(guardOwner.status, guardDiagnostic).toBe(17);

    const source = `import {existsSync,writeFileSync} from 'node:fs'; import {acquireFileMutationLock} from ${JSON.stringify(modulePath)}; const release=acquireFileMutationLock(process.env.LOCK,{claimLeaseMs:60,electionMs:5,hooks:{afterElectionWon:()=>{writeFileSync(process.env.READY,''); while(!existsSync(process.env.RESUME)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}}); release();`;
    const elected = spawn(process.execPath, [tsx, '-e', source], {
      env: { ...process.env, LOCK: lock, READY: ready, RESUME: resume },
    });
    const electedExit = new Promise<number | null>((resolveExit) => {
      elected.once('exit', resolveExit);
      elected.once('error', () => resolveExit(null));
    });
    try {
      const readyDeadline = Date.now() + CHILD_READY_TIMEOUT_MS;
      while (!existsSync(ready) && Date.now() < readyDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(existsSync(ready)).toBe(true);
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
      expect(() => acquireFileMutationLock(lock, { timeoutMs: 40 })).toThrow();
      expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('A');
      writeFileSync(resume, 'resume');
      expect(await electedExit).toBe(0);
      expect(existsSync(`${lock}.guard`)).toBe(false);
    } finally {
      if (!existsSync(resume)) writeFileSync(resume, 'resume');
      if (elected.exitCode === null) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const exited = await Promise.race([
          electedExit.then(() => true),
          new Promise<false>((resolveTimeout) => {
            cleanupTimer = setTimeout(
              () => resolveTimeout(false),
              CHILD_CLEANUP_TIMEOUT_MS,
            );
          }),
        ]);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        if (!exited && elected.exitCode === null) {
          elected.kill('SIGKILL');
          await electedExit;
        }
      }
    }
  });

  it('removes only an orphan guard when canonical replacement B is live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-journal-orphan-b-'));
    const file = join(root, 'events.jsonl');
    const lock = `${file}.lock`;
    const tsx = resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    );
    const modulePath = resolve(
      import.meta.dirname,
      '..',
      'lifecycle-events.ts',
    );
    writeFileSync(
      lock,
      JSON.stringify({ pid: 999_999, birth: 'dead', token: 'A' }),
      {
        mode: 0o600,
      },
    );
    const source = `import {acquireFileMutationLock} from ${JSON.stringify(modulePath)}; acquireFileMutationLock(process.env.LOCK,{hooks:{afterGuardAcquired:()=>process.exit(17)}});`;
    const child = spawn(process.execPath, [tsx, '-e', source], {
      env: { ...process.env, LOCK: lock },
    });
    await new Promise((resolveExit) => child.once('exit', resolveExit));
    const birth = currentProcessBirthFingerprint();
    rmSync(lock);
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, birth, token: 'B' }),
      {
        mode: 0o600,
      },
    );
    expect(() => acquireFileMutationLock(lock, { timeoutMs: 50 })).toThrow(
      'held by a live process',
    );
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('B');
    expect(existsSync(`${lock}.guard`)).toBe(false);
  });
});

describe('resolveProcessBirthFingerprint (#1057 load resilience)', () => {
  it('retries a spuriously failed lookup for a live process', () => {
    const lookup = vi
      .fn<(pid: number) => string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('birth-x');
    const alive = vi.fn(() => true);
    expect(resolveProcessBirthFingerprint(1234, { lookup, alive })).toBe(
      'birth-x',
    );
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('a dead process short-circuits to null without retries (stale-lock reclaim semantics)', () => {
    const lookup = vi.fn(() => null);
    const alive = vi.fn(() => false);
    expect(resolveProcessBirthFingerprint(1234, { lookup, alive })).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a live process with persistently failing lookups exhausts attempts and returns null', () => {
    const lookup = vi.fn(() => null);
    const alive = vi.fn(() => true);
    expect(
      resolveProcessBirthFingerprint(1234, { lookup, alive, attempts: 3 }),
    ).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});

describe('resolveProcessBirthFingerprint default wiring', () => {
  it('resolves a real fingerprint for the current process', () => {
    const birth = resolveProcessBirthFingerprint(process.pid);
    expect(birth).toBeTruthy();
    expect(typeof birth).toBe('string');
  });
});

describe('exact Windows process identity', () => {
  it('preserves the shared Windows CIM fingerprint as a round-trip UTC ISO value', () => {
    const legacyIso = '2025-08-03T00:00:00.0000000Z';
    const exec = vi.fn(() => `${legacyIso}\n`);
    expect(lookupProcessBirthFingerprint(42, { platform: 'win32', exec })).toBe(
      legacyIso,
    );
    expect(exec).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-Command',
        expect.stringContaining(
          "ToString('o', [cultureinfo]::InvariantCulture)",
        ),
      ]),
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('treats a live PID with unavailable round-trip UTC CIM CreationDate as unavailable, never dead', () => {
    expect(
      probeExactProcessIdentity(42, {
        platform: 'win32',
        alive: () => 'alive',
        lookup: () => null,
      }),
    ).toEqual({ state: 'unavailable' });
  });

  it('retains a live legacy ISO lock identity and rejects a recycled PID', () => {
    const legacyIso = '2025-08-03T00:00:00.0000000Z';
    const oldOwner = probeExactProcessIdentity(42, {
      platform: 'win32',
      alive: () => 'alive',
      lookup: () => legacyIso,
    });
    const matchingOwner = probeExactProcessIdentity(42, {
      platform: 'win32',
      alive: () => 'alive',
      lookup: () => legacyIso,
    });
    const recycled = probeExactProcessIdentity(42, {
      platform: 'win32',
      alive: () => 'alive',
      lookup: () => '2025-08-03T00:00:00.0000010Z',
    });
    expect(oldOwner).toMatchObject({ state: 'exact', identity: { pid: 42 } });
    expect(matchingOwner).toEqual(oldOwner);
    expect(recycled).toMatchObject({ state: 'exact', identity: { pid: 42 } });
    expect(oldOwner).not.toEqual(recycled);
  });
});
