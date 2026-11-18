/**
 * station#2802 — `station checkpoints` against a REAL fixture repository and
 * a real `git`, driven through the command's own default runner.
 *
 * Why the default runner and not an injected fake: the defect this file
 * exists to prevent lived entirely in `defaultRunner`. `status` measures
 * reclaimable disk with `git cat-file --batch-check`, which reads object
 * names from stdin and does not exit until stdin closes. The first
 * implementation passed an `input` option to `execFile`, which — unlike
 * `execFileSync` — has no such option, so it was silently ignored and the
 * command hung forever. Every unit test that injects a runner passes while
 * the shipped command never returns, which is exactly how that reached a
 * review. So: real git, real runner, and a deadline.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { runCheckpointsCommand } from '../commands/checkpoints.js';
import {
  getProfileCredentialStore,
  setProfileCredentialStore,
} from '../commands/profile-credentials.js';
import { upsertProfile } from '../commands/profile-store.js';
import { readBody } from './helpers/http-test-helpers.js';

const scratch: string[] = [];
const makeTempDir = trackTempDirs();

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
  });
}

/** A station home with one captured checkpoint whose object really exists. */
function fixture(): { home: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'station-cp-cli-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'base');

  // A checkpoint commit reachable only from the hidden pseudo-ref, exactly
  // as the store writes it.
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
  const commit = execFileSync(
    'git',
    ['commit-tree', tree, '-p', head, '-m', 'station checkpoint'],
    { cwd: repo, encoding: 'utf-8', windowsHide: true },
  ).trim();
  git(
    repo,
    'update-ref',
    '--create-reflog',
    'STATION_CHECKPOINTS/thread-1/cp-1',
    commit,
  );

  const home = join(root, 'home');
  mkdirSync(join(home, 'turn-checkpoints'), { recursive: true });
  writeFileSync(
    join(home, 'turn-checkpoints', 'thread-1.json'),
    // Shape taken from what the store actually writes (version + keyed
    // `turns` object), not from what the record type suggests — an index
    // whose shape the real writer never produces would make this test
    // green against a command that cannot read production data.
    JSON.stringify({
      version: 1,
      threadId: 'thread-1',
      turns: {
        'turn-1': {
          threadId: 'thread-1',
          turnId: 'turn-1',
          baseline: {
            status: 'captured',
            checkpointId: 'cp-1',
            commitSha: commit,
            treeSha: tree,
            repoRoot: repo,
            capturedAt: new Date(0).toISOString(),
          },
          updatedAt: new Date(0).toISOString(),
        },
      },
    }),
  );
  return { home, repo };
}

describe('station checkpoints (real git, default runner)', () => {
  it('status completes and reports the reclaimable checkpoint', async () => {
    const { home } = fixture();
    const lines: string[] = [];

    // The deadline IS the assertion. A hung `cat-file` fails here rather
    // than stalling the suite until vitest's own timeout, which reports as
    // an unrelated slow test rather than as this defect.
    await expect(
      Promise.race([
        runCheckpointsCommand(['status'], {
          env: { ...process.env, STATION_HOME: home },
          stdout: (line) => lines.push(line),
          stderr: (line) => lines.push(line),
        }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error('station checkpoints status did not return')),
            15_000,
          ),
        ),
      ]),
    ).resolves.not.toThrow();

    const output = lines.join('\n');
    expect(output).toContain('thread-1');
    expect(output).toMatch(/checkpoint\(s\)/);
  }, 30_000);

  it('refuses a --thread value that escapes the home directory', async () => {
    const { home } = fixture();
    const errors: string[] = [];
    await runCheckpointsCommand(['prune', '--thread=../../escape'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: () => {},
      stderr: (line) => errors.push(line),
    });
    expect(errors.join('\n')).toMatch(/invalid --thread/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  }, 30_000);

  it('lists recorded restores for one thread, and fails closed when the restore audit is corrupt', async () => {
    const { home } = fixture();
    const lines: string[] = [];
    await runCheckpointsCommand(['history', '--thread=thread-1'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    // No audit file yet: nothing was recorded, which is not a failure.
    expect(lines).toEqual(['thread thread-1: no checkpoint restores recorded']);

    // The document `CheckpointRestoreService` writes: `{ version, events }`
    // with one full restore event per confirmed restore.
    const restoreEvent = (id: string, threadId: string) => {
      const previewId = `00000000-0000-4000-8000-00000000000${id.slice(-1)}`;
      return {
        id,
        threadId,
        turnId: 'turn-1',
        phase: 'settle',
        checkpointId: 'cp-1',
        commitSha: 'b'.repeat(40),
        treeSha: 'c'.repeat(40),
        repoRoot: join(home, '..', 'repo'),
        restoredAt: '2026-08-16T00:00:00.000Z',
        previewId,
        previousTreeSha: 'a'.repeat(40),
        recoveryRef: `refs/station/restore-recovery/${previewId}`,
      };
    };
    const own = restoreEvent('restore-1', 'thread-1');
    writeFileSync(
      join(home, 'checkpoint-restores.json'),
      JSON.stringify(
        { version: 1, events: [own, restoreEvent('restore-2', 'thread-2')] },
        null,
        2,
      ),
    );
    lines.length = 0;
    await runCheckpointsCommand(['history', '--thread=thread-1'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: (line) => lines.push(line),
      stderr: () => {},
    });
    expect(lines).toEqual([JSON.stringify(own)]);

    writeFileSync(join(home, 'checkpoint-restores.json'), '{corrupt');
    const errors: string[] = [];
    lines.length = 0;
    await runCheckpointsCommand(['history', '--thread=thread-1'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: (line) => lines.push(line),
      stderr: (line) => errors.push(line),
    });
    expect(errors.join('\n')).toMatch(
      /station checkpoints history: audit unavailable/,
    );
    expect(lines).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('exposes durable retention outcomes for inspection', async () => {
    const { home } = fixture();
    writeFileSync(
      join(home, 'checkpoint-retention.json'),
      JSON.stringify({
        version: 1,
        events: [
          {
            id: 'retention-1',
            threadId: 'thread-1',
            status: 'deferred',
            removed: 0,
            detail: 'repository unreachable',
            recordedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      }),
    );
    const lines: string[] = [];
    await runCheckpointsCommand(['retention', '--thread=thread-1'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: (line) => lines.push(line),
      stderr: () => {},
    });
    expect(lines.join('\n')).toContain('repository unreachable');
    expect(lines.join('\n')).toContain('deferred');
  });

  it('fails closed when the retention audit is corrupt', async () => {
    const { home } = fixture();
    writeFileSync(join(home, 'checkpoint-retention.json'), '{corrupt');
    const errors: string[] = [];
    await runCheckpointsCommand(['retention', '--thread=thread-1'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: () => {},
      stderr: (line) => errors.push(line),
    });
    expect(errors.join('\n')).toMatch(/audit unavailable/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it.each([
    ['missing schema', {}],
    ['wrong version', { version: 2, events: [] }],
    ['unknown document key', { version: 1, events: [], extra: true }],
    [
      'non-string status',
      {
        version: 1,
        events: [
          {
            id: 'retention-1',
            threadId: 'thread-1',
            status: ['no_op'],
            removed: 0,
            recordedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      },
    ],
    [
      'invalid event',
      {
        version: 1,
        events: [
          {
            id: 'retention-1',
            threadId: 'thread-1',
            status: 'reclaimed',
            removed: -1,
            recordedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      },
    ],
    [
      'empty event id',
      {
        version: 1,
        events: [
          {
            id: '',
            threadId: 'thread-1',
            status: 'no_op',
            removed: 0,
            recordedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      },
    ],
    [
      'noncanonical timestamp',
      {
        version: 1,
        events: [
          {
            id: 'retention-1',
            threadId: 'thread-1',
            status: 'no_op',
            removed: 0,
            recordedAt: '2026-08-16',
          },
        ],
      },
    ],
    [
      'unknown event key',
      {
        version: 1,
        events: [
          {
            id: 'retention-1',
            threadId: 'thread-1',
            status: 'no_op',
            removed: 0,
            recordedAt: '2026-08-16T00:00:00.000Z',
            unexpected: true,
          },
        ],
      },
    ],
    [
      'unbounded detail',
      {
        version: 1,
        events: [
          {
            id: 'retention-1',
            threadId: 'thread-1',
            status: 'failed',
            removed: 0,
            recordedAt: '2026-08-16T00:00:00.000Z',
            detail: 'x'.repeat(2_049),
          },
        ],
      },
    ],
  ])(
    'fails closed for semantic retention audit corruption: %s',
    async (_name, audit) => {
      const { home } = fixture();
      writeFileSync(
        join(home, 'checkpoint-retention.json'),
        JSON.stringify(audit),
      );
      const errors: string[] = [];
      await runCheckpointsCommand(['retention', '--thread=thread-1'], {
        env: { ...process.env, STATION_HOME: home },
        stdout: () => {},
        stderr: (line) => errors.push(line),
      });
      expect(errors.join('\n')).toMatch(/invalid retention audit schema/);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    },
  );

  it('discovers and prunes refs after the active index evicts a thread', async () => {
    const { home, repo } = fixture();
    mkdirSync(join(home, 'turn-checkpoints-evicted'), { recursive: true });
    renameSync(
      join(home, 'turn-checkpoints', 'thread-1.json'),
      join(home, 'turn-checkpoints-evicted', 'thread-1.json'),
    );
    const lines: string[] = [];
    await runCheckpointsCommand(['status'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: (line) => lines.push(line),
      stderr: () => {},
    });
    expect(lines.join('\n')).toContain('thread-1');
    await runCheckpointsCommand(['prune', '--thread=thread-1'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: () => {},
      stderr: () => {},
    });
    expect(
      existsSync(join(repo, '.git', 'STATION_CHECKPOINTS', 'thread-1', 'cp-1')),
    ).toBe(false);
    expect(
      existsSync(join(home, 'turn-checkpoints-evicted', 'thread-1.json')),
    ).toBe(false);
  });

  it('preserves a valid archived generation when the reactivated active index is corrupt', async () => {
    const { home } = fixture();
    const active = join(home, 'turn-checkpoints', 'thread-1.json');
    const archiveDir = join(home, 'turn-checkpoints-evicted');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, 'thread-1.1.generation.json'),
      readFileSync(active, 'utf-8'),
    );
    writeFileSync(active, '{corrupt');

    const lines: string[] = [];
    await runCheckpointsCommand(['status'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: (line) => lines.push(line),
      stderr: () => {},
    });
    expect(lines.join('\n')).toContain('thread-1');
    expect(lines.join('\n')).toMatch(/1 checkpoint\(s\)/);
  });

  it('keeps discovery when one repo in a multi-repo prune is unreachable', async () => {
    const { home, repo } = fixture();
    const active = join(home, 'turn-checkpoints', 'thread-1.json');
    const index = JSON.parse(readFileSync(active, 'utf-8')) as {
      turns: Record<string, unknown>;
    };
    index.turns['turn-missing'] = {
      threadId: 'thread-1',
      turnId: 'turn-missing',
      settle: {
        status: 'captured',
        checkpointId: 'cp-missing',
        commitSha: 'sha',
        treeSha: 'tree',
        repoRoot: join(home, 'missing-repo'),
        capturedAt: new Date(1).toISOString(),
      },
      updatedAt: new Date(1).toISOString(),
    };
    writeFileSync(active, JSON.stringify(index));

    const errors: string[] = [];
    await runCheckpointsCommand(['prune', '--thread=thread-1'], {
      env: { ...process.env, STATION_HOME: home },
      stdout: () => {},
      stderr: (line) => errors.push(line),
    });
    expect(errors.join('\n')).toMatch(/repository unreachable/);
    expect(existsSync(active)).toBe(true);
    expect(
      existsSync(join(repo, '.git', 'STATION_CHECKPOINTS', 'thread-1', 'cp-1')),
    ).toBe(false);
  });
});

it('previews and confirms only the reviewed checkpoint on the authenticated saved Station', async () => {
  const home = makeTempDir('station-cp-target-');
  const credential = 'isolated-checkpoint-bearer';
  let previewId = randomUUID();
  const currentTreeSha = 'a'.repeat(40);
  const preview = {
    currentTreeSha,
    threadId: 'thread-1',
    turnId: 'turn-1',
    phase: 'baseline',
    checkpointId: 'cp-1',
    repoRoot: home,
    targetTreeSha: 'b'.repeat(40),
    paths: [{ path: 'src/example.ts', status: 'M' }],
    pathsTruncated: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const requests: Array<{ path: string; body: unknown }> = [];
  let mode:
    | 'success'
    | 'preview-refused'
    | 'stale'
    | 'lost'
    | 'redirect'
    | 'silent' = 'success';
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${credential}`) {
      res.writeHead(401).end();
      return;
    }
    const path = req.url ?? '';
    const body = await readBody(req);
    requests.push({ path, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (
      req.method !== 'POST' ||
      !path.startsWith(
        '/api/orchestration/sessions/thread-1/checkpoints/turn-1/',
      )
    ) {
      send(404, { success: false });
    } else if (path.endsWith('/restore-preview')) {
      if (mode === 'preview-refused') {
        send(409, {
          success: false,
          error: 'No preview available',
          reason: 'checkpoint_pruned',
        });
      } else {
        send(200, { success: true, data: { ...preview, previewId } });
      }
    } else if (mode === 'stale') {
      send(409, {
        success: false,
        error: 'Workspace changed',
        reason: 'workspace_changed',
      });
    } else if (mode === 'lost') {
      req.socket.destroy();
    } else if (mode === 'redirect') {
      res.writeHead(307, { Location: '/unselected-checkpoint' }).end();
    } else if (mode !== 'silent') {
      send(200, {
        success: true,
        data: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          previewId,
          previousTreeSha: currentTreeSha,
          restored: true,
        },
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const previousCredentialStore = getProfileCredentialStore();
  const previousExitCode = process.exitCode;
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    vi.stubEnv('STATION_HOME', home);
    vi.stubEnv('STATION_ROOT', home);
    vi.stubEnv('STATION_TARGET', undefined);
    vi.stubEnv('STATION_API_CREDENTIAL', undefined);
    setProfileCredentialStore({
      get: (ref) => (ref.id === 'checkpoint-test' ? credential : undefined),
      set: () => {},
      delete: () => {},
      status: () => 'available',
    });
    upsertProfile({
      name: 'checkpoint-test',
      endpoint: apiBase,
      credentialRef: { kind: 'station-bearer', id: 'checkpoint-test' },
      makeDefault: true,
    });
    expect(
      (
        await fetch(
          `${apiBase}/api/orchestration/sessions/thread-1/checkpoints/turn-1/restore-preview`,
          {
            method: 'POST',
          },
        )
      ).status,
    ).toBe(401);

    const { runCli } = await import('../cli.js');
    const args = [
      'checkpoints',
      'restore',
      '--thread=thread-1',
      '--turn=turn-1',
    ];
    const reviewArgs = [
      ...args,
      '--station=checkpoint-test',
      '--phase=baseline',
    ];
    const confirmArgs = () => [
      ...args,
      `--api-base=${apiBase}/`,
      `--credential=${credential}`,
      '--confirm',
      `--preview-id=${previewId}`,
      `--expected-current-tree-sha=${currentTreeSha}`,
    ];

    await runCli([...args, '--confirm']);
    expect(requests).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    mode = 'preview-refused';
    await runCli(reviewArgs);
    expect(requests).toHaveLength(1);
    expect(stderr.mock.calls.flat().join('\n')).toContain('checkpoint_pruned');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    mode = 'success';
    await runCli(reviewArgs);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      path: '/api/orchestration/sessions/thread-1/checkpoints/turn-1/restore-preview',
      body: { phase: 'baseline' },
    });
    expect(stdout.mock.calls.flat().join('\n')).toContain('src/example.ts');
    expect(stdout.mock.calls.flat().join('\n')).toContain(apiBase);
    expect(stdout.mock.calls.flat().join('\n')).toContain(
      `--preview-id=${previewId}`,
    );

    const expectedConfirmation = () => ({
      path: '/api/orchestration/sessions/thread-1/checkpoints/turn-1/restore',
      body: {
        confirmed: true,
        previewId,
        expectedCurrentTreeSha: currentTreeSha,
      },
    });
    await runCli(confirmArgs());
    expect(stdout.mock.calls.flat().join('\n')).toContain(
      'Restored thread thread-1',
    );
    expect(requests[2]).toEqual(expectedConfirmation());

    for (const refusal of ['stale', 'lost', 'redirect', 'silent'] as const) {
      previewId = randomUUID();
      await runCli(reviewArgs);
      expect(stdout.mock.calls.flat().join('\n')).toContain(
        `--preview-id=${previewId}`,
      );
      stdout.mockClear();
      stderr.mockClear();
      const before = requests.length;
      mode = refusal;
      if (refusal === 'silent') vi.stubEnv('STATION_REQUEST_TIMEOUT_MS', '500');
      await runCli(confirmArgs());
      expect(process.exitCode).toBe(1);
      expect(requests.slice(before)).toEqual([expectedConfirmation()]);
      const error = stderr.mock.calls.flat().join('\n');
      expect(error).toContain('Inspect the workspace');
      if (refusal === 'stale') expect(error).toContain('workspace_changed');
      if (refusal === 'silent') expect(error).toMatch(/deadline|timed out/i);
      expect(stdout.mock.calls.flat().join('\n')).not.toContain(
        'Restored thread',
      );
      process.exitCode = 0;
      mode = 'success';
    }
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    vi.unstubAllEnvs();
    setProfileCredentialStore(previousCredentialStore);
    process.exitCode = previousExitCode;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
