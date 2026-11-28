import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireFileMutationLock,
  appendLifecycleEvent,
  classifyLifecycleExit,
  DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES,
  type LifecycleIdentity,
  readLifecycleEvents,
  type StopIntent,
} from '../lifecycle-events.js';
import {
  lookupProcessBirthFingerprint,
  probeExactProcessIdentity,
} from '../process-identity.mjs';
import { openWindowsPrivateFile } from '../windows-file-security.js';
import {
  assertWindowsPathsTrusted,
  encodePowerShellCommand,
  hardenWindowsPathsTrusted,
  runWindowsTrustCommand,
  windowsSystemUtilityPath,
} from '../windows-path-trust.js';

const identity: LifecycleIdentity = {
  instanceId: 'phone',
  sha: 'a'.repeat(40),
  bootId: '11111111-1111-4111-8111-111111111111',
  pid: 1234,
};

const PROCESS_INTEGRATION_TEST_TIMEOUT_MS = 15_000;
const CHILD_READY_TIMEOUT_MS = 5_000;
const CHILD_CLEANUP_TIMEOUT_MS = 1_000;

function createJournalRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  hardenWindowsPathsTrusted(runWindowsTrustCommand, [
    { path: root, kind: 'directory' },
  ]);
  return root;
}

function allowUnrelatedJournalAccess(file: string): void {
  if (process.platform !== 'win32') {
    chmodSync(file, 0o666);
    return;
  }
  const path = Buffer.from(file).toString('base64');
  const command = encodePowerShellCommand(
    `$ErrorActionPreference='Stop'; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path}')); $acl=[IO.File]::GetAccessControl($file); $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl($file,$acl)`,
  );
  const result = runWindowsTrustCommand(
    windowsSystemUtilityPath('powershell'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', command],
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

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

  it.each(['supervisor_drain', 'supervisor_disconnect'] as const)(
    'classifies a %s shutdown as itself, not a crash',
    (reason) => {
      const events = [
        {
          ...identity,
          version: 1 as const,
          type: 'shutdown_observed' as const,
          reason,
          sender: 'unknown' as const,
          timestamp: '2026-07-10T12:00:01.000Z',
        },
        {
          ...identity,
          version: 1 as const,
          type: 'process_exit' as const,
          exitCode: 0,
          signal: null,
          sender: 'unknown' as const,
          timestamp: '2026-07-10T12:00:02.000Z',
        },
      ];
      expect(classifyLifecycleExit(events, identity).classification).toBe(
        reason,
      );
    },
  );

  it('classifies a non-zero exit after a supervisor drain as a crash', () => {
    const events = [
      {
        ...identity,
        version: 1 as const,
        type: 'shutdown_observed' as const,
        reason: 'supervisor_drain' as const,
        sender: 'unknown' as const,
        timestamp: '2026-07-10T12:00:01.000Z',
      },
      {
        ...identity,
        version: 1 as const,
        type: 'process_exit' as const,
        exitCode: 1,
        signal: null,
        sender: 'unknown' as const,
        timestamp: '2026-07-10T12:00:02.000Z',
      },
    ];
    expect(classifyLifecycleExit(events, identity).classification).toBe(
      'crash',
    );
  });

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
    const root = createJournalRoot('station-journal-');
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
    if (process.platform === 'win32') {
      assertWindowsPathsTrusted(runWindowsTrustCommand, [
        { kind: 'file', path: file },
        { kind: 'file', path: `${file}.previous` },
      ]);
    } else {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(`${file}.previous`, 'utf8')).toContain(
      '"type":"started"',
    );
    expect(readLifecycleEvents(file)).toHaveLength(2);
  });

  it.runIf(process.platform === 'win32')(
    'migrates an inherited owner-only journal without losing existing bytes',
    () => {
      const root = createJournalRoot('station-journal-inherited-');
      const file = join(root, 'events.jsonl');
      const event = {
        ...identity,
        version: 1 as const,
        type: 'started' as const,
        timestamp: '2026-07-10T12:00:00.000Z',
      };
      const original = `${JSON.stringify(event)}\n`;
      try {
        writeFileSync(file, original, { mode: 0o600 });
        const encodedPath = Buffer.from(file).toString('base64');
        const inspect = () => {
          const result = runWindowsTrustCommand(
            windowsSystemUtilityPath('powershell'),
            [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              encodePowerShellCommand(
                `$ErrorActionPreference='Stop'; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $acl=[IO.File]::GetAccessControl($file); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Fixture is not owner-only FullControl' }; @{ protected=$acl.AreAccessRulesProtected; inherited=$rules[0].IsInherited } | ConvertTo-Json -Compress`,
              ),
            ],
          );
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
          return JSON.parse(result.stdout ?? '');
        };
        expect(inspect()).toEqual({ protected: false, inherited: true });
        expect(readLifecycleEvents(file)).toEqual([event]);
        expect(readFileSync(file, 'utf8')).toBe(original);
        expect(inspect()).toEqual({ protected: true, inherited: false });
        appendLifecycleEvent(file, { ...event, type: 'process_exit' });
        expect(readFileSync(file, 'utf8').startsWith(original)).toBe(true);
        expect(readLifecycleEvents(file)).toHaveLength(2);
        allowUnrelatedJournalAccess(file);
        const beforeRefusal = readFileSync(file, 'utf8');
        expect(() => readLifecycleEvents(file)).toThrow(/private file/);
        expect(() => appendLifecycleEvent(file, event)).toThrow(/private file/);
        expect(readFileSync(file, 'utf8')).toBe(beforeRefusal);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['current', 'retained'] as const)(
    'refuses unrelated-principal access to the %s journal without rewriting it',
    (generation) => {
      const root = createJournalRoot('station-journal-acl-');
      const file = join(root, 'events.jsonl');
      try {
        const event = {
          ...identity,
          type: 'started' as const,
          timestamp: '2026-07-10T12:00:00.000Z',
        };
        appendLifecycleEvent(file, event, { maxBytes: 200 });
        appendLifecycleEvent(file, event, { maxBytes: 200 });
        const target = generation === 'current' ? file : `${file}.previous`;
        allowUnrelatedJournalAccess(target);
        const before = readFileSync(target, 'utf8');
        expect(() => readLifecycleEvents(file)).toThrow(/private/);
        if (process.platform === 'win32') {
          expect(() =>
            appendLifecycleEvent(file, event, { maxBytes: 200 }),
          ).toThrow(/private file/);
        }
        expect(readFileSync(target, 'utf8')).toBe(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32').each(['read', 'append'] as const)(
    'holds the %s journal generation against pathname replacement',
    (operation) => {
      const root = mkdtempSync(join(tmpdir(), 'station-journal-binding-'));
      const file = join(root, 'events.jsonl');
      const unrelated = join(root, 'unrelated');
      let descriptor: ReturnType<typeof openWindowsPrivateFile> | undefined;
      try {
        appendLifecycleEvent(file, {
          ...identity,
          type: 'started',
          timestamp: '2026-07-10T12:00:00.000Z',
        });
        writeFileSync(unrelated, 'unrelated control');
        descriptor = openWindowsPrivateFile(file, operation);
        expect(() => renameSync(file, join(root, 'moved'))).toThrow();
        expect(() => renameSync(root, `${root}-moved`)).toThrow();
        expect(() => renameSync(unrelated, file)).toThrow();
        expect(readFileSync(unrelated, 'utf8')).toBe('unrelated control');
        descriptor.close();
        descriptor = undefined;
        renameSync(root, `${root}-moved`);
        renameSync(`${root}-moved`, root);
      } finally {
        descriptor?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'rechecks the DACL on a retained handle without relying on file metadata',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-journal-acl-change-'));
      const file = join(root, 'events.jsonl');
      let journal: ReturnType<typeof openWindowsPrivateFile> | undefined;
      try {
        appendLifecycleEvent(file, {
          ...identity,
          type: 'started',
          timestamp: '2026-07-10T12:00:00.000Z',
        });
        journal = openWindowsPrivateFile(file, 'read');
        expect(
          journal.read(DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES).length,
        ).toBeGreaterThan(0);
        const before = statSync(file);
        allowUnrelatedJournalAccess(file);
        const after = statSync(file);
        expect([after.size, after.mtimeMs]).toEqual([
          before.size,
          before.mtimeMs,
        ]);
        expect(() =>
          journal?.read(DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES),
        ).toThrow(/private file/);
      } finally {
        journal?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32').each(
    Array.from({ length: 16 }, (_, index) => index + 1),
  )(
    'renames a retained UTF-16 filename with %i suffix code units without extra bytes',
    (suffixLength) => {
      const root = createJournalRoot('station-journal-rename-');
      try {
        const file = join(root, `events-${'x'.repeat(suffixLength)}`);
        const target = `${file}.previous`;
        const journal = openWindowsPrivateFile(file, 'create');
        try {
          journal.write(Buffer.from('retained evidence'));
          journal.rename(target);
          expect(readFileSync(target, 'utf8')).toBe('retained evidence');
          expect(existsSync(file)).toBe(false);
        } finally {
          journal.close();
        }
        expect(readdirSync(root)).toEqual([
          `events-${'x'.repeat(suffixLength)}.previous`,
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'retires only its unpublished rotation file when the retained generation is held open',
    () => {
      const root = createJournalRoot('station-journal-rotation-refusal-');
      const file = join(root, 'events.jsonl');
      let retained: ReturnType<typeof openWindowsPrivateFile> | undefined;
      try {
        const event = {
          ...identity,
          type: 'started' as const,
          timestamp: '2026-07-10T12:00:00.000Z',
        };
        appendLifecycleEvent(file, event, { maxBytes: 200 });
        appendLifecycleEvent(file, event, { maxBytes: 200 });
        const current = readFileSync(file, 'utf8');
        retained = openWindowsPrivateFile(`${file}.previous`, 'read');
        const previous = retained.read(DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES);
        expect(() =>
          appendLifecycleEvent(file, event, { maxBytes: 200 }),
        ).toThrow(/rename failed/);
        expect(retained.read(DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES)).toEqual(
          previous,
        );
        expect(readFileSync(file, 'utf8')).toBe(current);
        expect(
          readdirSync(root).filter((name) =>
            name.startsWith('.lifecycle-journal-'),
          ),
        ).toEqual([]);
        retained.close();
        retained = undefined;
        appendLifecycleEvent(file, event, { maxBytes: 200 });
        expect(readLifecycleEvents(file)).toHaveLength(2);
      } finally {
        retained?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves both generations when an unrelated SID can replace directory entries',
    () => {
      const root = createJournalRoot('station-journal-directory-refusal-');
      const file = join(root, 'events.jsonl');
      try {
        const event = {
          ...identity,
          type: 'started' as const,
          timestamp: '2026-07-10T12:00:00.000Z',
        };
        appendLifecycleEvent(file, event, { maxBytes: 200 });
        appendLifecycleEvent(file, event, { maxBytes: 200 });
        const current = readFileSync(file, 'utf8');
        const previous = readFileSync(`${file}.previous`, 'utf8');
        allowUnrelatedJournalAccess(root);
        expect(() =>
          appendLifecycleEvent(file, event, { maxBytes: 200 }),
        ).toThrow(/unrelated SID/);
        expect(readFileSync(file, 'utf8')).toBe(current);
        expect(readFileSync(`${file}.previous`, 'utf8')).toBe(previous);
        expect(
          readdirSync(root).filter((name) =>
            name.startsWith('.lifecycle-journal-'),
          ),
        ).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'retains full-size journals and accepts configured thresholds and oversized records',
    () => {
      const root = createJournalRoot('station-journal-capacity-');
      const file = join(root, 'events.jsonl');
      try {
        const event = appendLifecycleEvent(file, {
          ...identity,
          type: 'started',
          timestamp: '2026-07-10T12:00:00.000Z',
        });
        const line = `${JSON.stringify(event)}\n`;
        const count = Math.floor(
          DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES / Buffer.byteLength(line),
        );
        const records = Array.from({ length: count }, () => ({
          ...event,
          eventId: randomUUID(),
        }));
        const content = records
          .map((record) => `${JSON.stringify(record)}\n`)
          .join('');
        writeFileSync(file, content);
        const appended = appendLifecycleEvent(file, {
          ...identity,
          type: 'process_exit',
          exitCode: 0,
          timestamp: '2026-07-10T12:00:01.000Z',
        });
        expect(statSync(`${file}.previous`).size).toBe(
          Buffer.byteLength(line) * count,
        );
        expect(readFileSync(`${file}.previous`, 'utf8')).toBe(content);
        expect(readLifecycleEvents(file, records.length + 1)).toEqual([
          ...records,
          appended,
        ]);
        writeFileSync(file, content);
        const configured = appendLifecycleEvent(
          file,
          {
            ...identity,
            type: 'process_exit',
            exitCode: 0,
            timestamp: '2026-07-10T12:00:02.000Z',
          },
          { maxBytes: DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES * 2 },
        );
        expect(statSync(file).size).toBeGreaterThan(
          DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES,
        );
        expect(readLifecycleEvents(file, records.length + 1)).toEqual([
          ...records,
          configured,
        ]);
        const oversized = appendLifecycleEvent(file, {
          ...identity,
          type: 'process_exit',
          signal: 'x'.repeat(DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES),
          timestamp: '2026-07-10T12:00:03.000Z',
        });
        expect(readLifecycleEvents(file, 1)).toEqual([oversized]);
        appendLifecycleEvent(file, event);
        expect(readLifecycleEvents(file, 2)).toEqual([oversized, event]);
        const retained = openWindowsPrivateFile(`${file}.previous`, 'read');
        try {
          expect(() =>
            retained.read(DEFAULT_LIFECYCLE_JOURNAL_MAX_BYTES),
          ).toThrow(/exceeds its read bound/);
        } finally {
          retained.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
      const deadline =
        Date.now() +
        PROCESS_INTEGRATION_TEST_TIMEOUT_MS -
        CHILD_CLEANUP_TIMEOUT_MS;
      const root = createJournalRoot('station-journal-concurrent-');
      const file = join(root, 'events.jsonl');
      const modulePath = resolve(
        import.meta.dirname,
        '..',
        'lifecycle-events.ts',
      );
      const source = `import {appendLifecycleEvent} from ${JSON.stringify(pathToFileURL(modulePath).href)}; for(let index=0;index<4;index++) appendLifecycleEvent(process.env.FILE,{instanceId:'phone',sha:'${'a'.repeat(40)}',bootId:process.env.BOOT,pid:Number(process.env.PID),type:'started',timestamp:new Date(Date.now()+index).toISOString()},{maxBytes:1200});`;
      const children = [1, 2].map((index) =>
        spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', source],
          {
            env: {
              ...process.env,
              FILE: file,
              BOOT: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
              PID: String(5000 + index),
            },
          },
        ),
      );
      const diagnostics = [`journal=${file}\n`, `journal=${file}\n`];
      children.forEach((child, index) => {
        child.stderr.on('data', (chunk) => {
          diagnostics[index] += String(chunk);
        });
      });
      const exits = Promise.all(
        children.map(
          (child) =>
            new Promise<number | null>((resolveExit, rejectExit) => {
              child.once('exit', resolveExit);
              child.once('error', rejectExit);
            }),
        ),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            exits,
            new Promise<never>((_, rejectTimeout) => {
              timer = setTimeout(
                () =>
                  rejectTimeout(
                    new Error(
                      `Journal writers did not settle: ${diagnostics.join('\n')}`,
                    ),
                  ),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]),
          diagnostics.join('\n'),
        ).toEqual([0, 0]);
        const events = readLifecycleEvents(file, 100);
        expect(new Set(events.map((event) => event.eventId)).size).toBe(
          events.length,
        );
        expect(events).toHaveLength(8);
        for (const index of [1, 2]) {
          expect(
            events.filter((event) => event.pid === 5000 + index),
          ).toHaveLength(4);
        }
        expect(
          readFileSync(`${file}.previous`, 'utf8').trim().split('\n'),
        ).toHaveLength(4);
        expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4);
      } finally {
        clearTimeout(timer);
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
        }
        try {
          await Promise.race([
            exits,
            new Promise<never>((_, rejectCleanup) => {
              timer = setTimeout(
                () =>
                  rejectCleanup(new Error('Journal writers did not retire')),
                CHILD_CLEANUP_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          rmSync(root, { recursive: true, force: true });
        }
      }
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
    ).toThrow(
      /birth fingerprint is required for lock ownership: injected birth fingerprint returned no start time for pid \d+/,
    );
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

describe('exact Windows process identity', () => {
  it('preserves the shared Windows CIM fingerprint as a round-trip UTC ISO value', () => {
    const legacyIso = '2025-08-03T00:00:00.0000000Z';
    const exec = vi.fn(() => `${legacyIso}\n`);
    expect(
      lookupProcessBirthFingerprint(42, {
        platform: 'win32',
        exec,
        env: { SystemRoot: 'C:\\Windows' },
      }),
    ).toBe(legacyIso);
    expect(exec).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expect.arrayContaining([
        '-Command',
        expect.stringContaining(
          "ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', [System.Globalization.CultureInfo]::InvariantCulture)",
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
