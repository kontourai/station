import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  acquireBoundedJournalLock,
  acquireLock,
} from '../../station-dogfood-reconcile.mjs';
import { fixtureRoot, NOW } from './fixture.js';

const PROCESS_INTEGRATION_TEST_TIMEOUT_MS = 15_000;
const CHILD_READY_TIMEOUT_MS = 5_000;
const CHILD_CLEANUP_TIMEOUT_MS = 1_000;

export function registerLocking() {
  describe('station dogfood reconcile', () => {
    it('reclaims a stale PID-reused lock but refuses a matching live birth identity', () => {
      const root = fixtureRoot();
      const lock = path.join(root, 'reconcile.lock');
      writeFileSync(
        lock,
        JSON.stringify({ pid: 42, birth: 'old-birth', token: 'old' }),
        { mode: 0o600 },
      );
      const stale = new Date(NOW - 120_000);
      utimesSync(lock, stale, stale);
      const release = acquireLock(lock, {
        now: NOW,
        maxAgeMs: 60_000,
        processAlive: () => true,
        processBirth: () => 'new-birth',
      });
      release();

      writeFileSync(
        lock,
        JSON.stringify({ pid: 42, birth: 'same-birth', token: 'live' }),
        { mode: 0o600 },
      );
      utimesSync(lock, stale, stale);
      expect(() =>
        acquireLock(lock, {
          now: NOW,
          maxAgeMs: 60_000,
          processAlive: () => true,
          processBirth: () => 'same-birth',
        }),
      ).toThrow('owned by live PID 42');
    });

    it('leaves a live replacement lock untouched when pathname ownership changes after baseline', () => {
      const root = fixtureRoot();
      const lock = path.join(root, 'reconcile.lock');
      writeFileSync(
        lock,
        JSON.stringify({ pid: 999_999, birth: 'dead', token: 'A' }),
        { mode: 0o600 },
      );
      const stale = new Date(NOW - 120_000);
      utimesSync(lock, stale, stale);

      expect(() =>
        acquireLock(lock, {
          now: NOW,
          maxAgeMs: 60_000,
          processAlive: (pid) => pid === process.pid,
          processBirth: (pid) => (pid === process.pid ? 'live-birth' : null),
          afterBaseline: () => {
            rmSync(lock);
            writeFileSync(
              lock,
              JSON.stringify({
                pid: process.pid,
                birth: 'live-birth',
                token: 'B',
              }),
              { mode: 0o600 },
            );
          },
        }),
      ).toThrow('lock ownership changed while inspecting');
      expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('B');
    });

    it('rejects a live lock and safely recovers a stale lock', () => {
      const root = fixtureRoot();
      const lock = path.join(root, 'reconcile.lock');
      const release = acquireLock(lock, { now: NOW, maxAgeMs: 60_000 });
      const current = new Date(NOW);
      utimesSync(lock, current, current);
      expect(() =>
        acquireLock(lock, {
          now: NOW + 1_000,
          maxAgeMs: 60_000,
          processAlive: () => false,
        }),
      ).toThrow('another dogfood reconcile holds');
      release();

      writeFileSync(lock, '{}\n');
      const old = new Date(NOW - 120_000);
      utimesSync(lock, old, old);
      const releaseRecovered = acquireLock(lock, {
        now: NOW,
        maxAgeMs: 60_000,
      });
      releaseRecovered();
    });

    it('does not steal an old lock from a live owner PID', () => {
      const root = fixtureRoot();
      const lock = path.join(root, 'reconcile.lock');
      writeFileSync(lock, `${JSON.stringify({ pid: 1234 })}\n`);
      const old = new Date(NOW - 120_000);
      utimesSync(lock, old, old);

      expect(() =>
        acquireLock(lock, {
          now: NOW,
          maxAgeMs: 60_000,
          processAlive: (pid: number) => pid === 1234,
        }),
      ).toThrow('owned by live PID 1234');
    });

    it('uses PID birth identity when reclaiming the lifecycle journal lock', () => {
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      writeFileSync(
        `${journal}.lock`,
        JSON.stringify({
          pid: process.pid,
          birth: 'reused-pid',
          token: 'old',
        }),
        { mode: 0o600 },
      );
      const release = acquireBoundedJournalLock(journal, 50);
      release();
      expect(existsSync(`${journal}.lock`)).toBe(false);
    });

    it('does not reclaim the lifecycle journal lock from the same live PID birth', () => {
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      const birth = execFileSync(
        'ps',
        ['-o', 'lstart=', '-p', String(process.pid)],
        {
          encoding: 'utf8',
          // Same pin as production journalProcessBirth (#3049): on a
          // non-UTC host an unpinned expected birth only matched through
          // the temporary migration lens, leaving the primary pinned
          // comparison untested (review MED-1).
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        },
      ).trim();
      writeFileSync(
        `${journal}.lock`,
        JSON.stringify({ pid: process.pid, birth, token: 'live' }),
        { mode: 0o600 },
      );
      expect(() => acquireBoundedJournalLock(journal, 25)).toThrow(
        'held by a live process',
      );
    });

    it('does not reclaim a lock whose birth a pre-pin build recorded (#3049 migration)', () => {
      // A birth captured through the RECORDER's env — exactly what a
      // pre-#3049 build wrote. On a non-UTC host this mismatches the
      // pinned probe for the same live process; only the legacy migration
      // lens keeps the live holder's lock from being reclaimed. On a UTC/C
      // host this collapses into the pinned-match case and discriminates
      // nothing — the pinned sibling test above stays the primary pin.
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      const prePinBirth = execFileSync(
        'ps',
        ['-o', 'lstart=', '-p', String(process.pid)],
        { encoding: 'utf8' },
      ).trim();
      writeFileSync(
        `${journal}.lock`,
        JSON.stringify({ pid: process.pid, birth: prePinBirth, token: 'old' }),
        { mode: 0o600 },
      );
      expect(() => acquireBoundedJournalLock(journal, 25)).toThrow(
        'held by a live process',
      );
    });

    it('publishes no reconciler journal lock when birth identity is unavailable', () => {
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      expect(() =>
        acquireBoundedJournalLock(journal, 25, {
          birthFingerprint: () => null,
        }),
      ).toThrow('birth fingerprint is required');
      expect(readdirSync(root)).toEqual([]);
    });

    it('preserves replacement B when reconciler stale A changes after inspection', () => {
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      const lock = `${journal}.lock`;
      const birth = execFileSync(
        'ps',
        ['-o', 'lstart=', '-p', String(process.pid)],
        {
          encoding: 'utf8',
          // Same pin as production journalProcessBirth (#3049): on a
          // non-UTC host an unpinned expected birth only matched through
          // the temporary migration lens, leaving the primary pinned
          // comparison untested (review MED-1).
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        },
      ).trim();
      writeFileSync(
        lock,
        JSON.stringify({ pid: process.pid, birth: 'stale', token: 'A' }),
        {
          mode: 0o600,
        },
      );
      expect(() =>
        acquireBoundedJournalLock(journal, 25, {
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
        }),
      ).toThrow('held by a live process');
      expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('B');
      expect(existsSync(`${lock}.guard`)).toBe(false);
    });

    it('blocks reconciler publication while the fixed guard protects stale A', () => {
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      const lock = `${journal}.lock`;
      writeFileSync(
        lock,
        JSON.stringify({ pid: process.pid, birth: 'stale', token: 'A' }),
        {
          mode: 0o600,
        },
      );
      let blocked = false;
      const release = acquireBoundedJournalLock(journal, 50, {
        afterGuardAcquired: () => {
          expect(existsSync(`${lock}.guard`)).toBe(true);
          expect(() => acquireBoundedJournalLock(journal, 0)).toThrow(
            'guard is held',
          );
          blocked = true;
        },
      });
      expect(blocked).toBe(true);
      release();
    });

    it('recovers reconciler locking after real guard and claim child crashes', async () => {
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      const lock = `${journal}.lock`;
      const modulePath = path.resolve(
        import.meta.dirname,
        '../../station-dogfood-reconcile.mjs',
      );
      const runChild = async (
        hook: 'afterGuardAcquired' | 'afterClaimPublished',
      ) => {
        const source = `import {acquireBoundedJournalLock} from ${JSON.stringify(modulePath)}; acquireBoundedJournalLock(process.env.JOURNAL,500,{claimLeaseMs:60,${hook}:()=>process.exit(19)});`;
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', source],
          {
            env: { ...process.env, JOURNAL: journal },
          },
        );
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
      expect(await runChild('afterGuardAcquired')).toBe(19);
      expect(existsSync(`${lock}.guard`)).toBe(true);
      expect(await runChild('afterClaimPublished')).toBe(19);
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
      const release = acquireBoundedJournalLock(journal, 1_000);
      release();
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(`${lock}.guard`)).toBe(false);
    });

    it('does not preempt a live elected reconciler claimant after lease expiry', {
      timeout: PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
    }, async () => {
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      const lock = `${journal}.lock`;
      const ready = path.join(root, 'ready');
      const resume = path.join(root, 'resume');
      const modulePath = path.resolve(
        import.meta.dirname,
        '../../station-dogfood-reconcile.mjs',
      );
      writeFileSync(
        lock,
        JSON.stringify({ pid: 999_999, birth: 'dead', token: 'A' }),
        {
          mode: 0o600,
        },
      );
      const guardSource = `import {acquireBoundedJournalLock} from ${JSON.stringify(modulePath)}; acquireBoundedJournalLock(process.env.JOURNAL,500,{afterGuardAcquired:()=>process.exit(19)});`;
      const guardOwner = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', guardSource],
        {
          env: { ...process.env, JOURNAL: journal },
          encoding: 'utf8',
          timeout: CHILD_READY_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
      const guardDiagnostic = [guardOwner.error?.message, guardOwner.stderr]
        .filter(Boolean)
        .join('\n');
      expect(guardOwner.status, guardDiagnostic).toBe(19);

      const source = `import {existsSync,writeFileSync} from 'node:fs'; import {acquireBoundedJournalLock} from ${JSON.stringify(modulePath)}; const release=acquireBoundedJournalLock(process.env.JOURNAL,1000,{claimLeaseMs:60,electionMs:5,afterElectionWon:()=>{writeFileSync(process.env.READY,''); while(!existsSync(process.env.RESUME)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}); release();`;
      const elected = spawn(
        process.execPath,
        ['--input-type=module', '-e', source],
        {
          env: {
            ...process.env,
            JOURNAL: journal,
            READY: ready,
            RESUME: resume,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let electedStderr = '';
      elected.stderr?.setEncoding('utf8');
      elected.stderr?.on('data', (chunk) => {
        electedStderr += chunk;
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
        expect(existsSync(ready), electedStderr).toBe(true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 80));
        expect(() => acquireBoundedJournalLock(journal, 40)).toThrow();
        expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('A');
        writeFileSync(resume, 'resume');
        expect(await electedExit, electedStderr).toBe(0);
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

    it('preserves live reconciler replacement B while reclaiming its orphan guard', async () => {
      const root = fixtureRoot();
      const journal = path.join(root, 'lifecycle.jsonl');
      const lock = `${journal}.lock`;
      const modulePath = path.resolve(
        import.meta.dirname,
        '../../station-dogfood-reconcile.mjs',
      );
      writeFileSync(
        lock,
        JSON.stringify({ pid: 999_999, birth: 'dead', token: 'A' }),
        {
          mode: 0o600,
        },
      );
      const source = `import {acquireBoundedJournalLock} from ${JSON.stringify(modulePath)}; acquireBoundedJournalLock(process.env.JOURNAL,500,{afterGuardAcquired:()=>process.exit(19)});`;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', source],
        {
          env: { ...process.env, JOURNAL: journal },
        },
      );
      await new Promise((resolveExit) => child.once('exit', resolveExit));
      const birth = execFileSync(
        'ps',
        ['-o', 'lstart=', '-p', String(process.pid)],
        {
          encoding: 'utf8',
          // Same pin as production journalProcessBirth (#3049): on a
          // non-UTC host an unpinned expected birth only matched through
          // the temporary migration lens, leaving the primary pinned
          // comparison untested (review MED-1).
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        },
      ).trim();
      rmSync(lock);
      writeFileSync(
        lock,
        JSON.stringify({ pid: process.pid, birth, token: 'B' }),
        {
          mode: 0o600,
        },
      );
      expect(() => acquireBoundedJournalLock(journal, 50)).toThrow(
        'held by a live process',
      );
      expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('B');
      expect(existsSync(`${lock}.guard`)).toBe(false);
    });

    it('does not let an old owner release a reclaimed lock', () => {
      const root = fixtureRoot();
      const lock = path.join(root, 'reconcile.lock');
      const releaseOld = acquireLock(lock, { now: NOW, maxAgeMs: 60_000 });
      const old = new Date(NOW - 120_000);
      utimesSync(lock, old, old);
      const releaseNew = acquireLock(lock, {
        now: NOW,
        maxAgeMs: 60_000,
        processAlive: () => false,
      });

      releaseOld();
      expect(() =>
        acquireLock(lock, {
          now: NOW + 1_000,
          maxAgeMs: 60_000,
          processAlive: () => true,
        }),
      ).toThrow(/owned by live PID|another dogfood reconcile holds/);
      releaseNew();
    });
  });
}
