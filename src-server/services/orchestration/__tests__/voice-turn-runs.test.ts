import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';
import { RunService } from '../run-service.js';

const stores: EventStore[] = [];
const directories: string[] = [];

function createStore(): EventStore {
  const directory = mkdtempSync(join(tmpdir(), 'voice-turn-runs-'));
  directories.push(directory);
  const store = new EventStore(join(directory, 'events.sqlite'));
  stores.push(store);
  return store;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  if (child.exitCode === null) await once(child, 'exit');
}

async function spawnObservedVoiceOwner(path: string): Promise<ChildProcess> {
  const eventStorePath = new URL('../event-store.ts', import.meta.url).pathname;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { EventStore } from ${JSON.stringify(eventStorePath)};
       const store = new EventStore(process.argv[1]);
       const started = store.voiceTurnRunAuthority().observeStart({ voiceSessionId: 'voice-a', providerSessionId: 'nova-a', providerPromptId: 'prompt-a', providerTurnId: 'completion-a', providerId: 'nova-s2s', now: '2026-08-14T00:00:00.000Z' });
       if (started.kind !== 'started') process.exit(2);
       process.stdout.write(JSON.stringify({ runId: started.handle.runId }) + '\\n');
       setInterval(() => {}, 1_000);`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  await once(child.stdout!, 'data');
  return child;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('VoiceTurnRuns', () => {
  test('upgrades the legacy tuple table before an EventStore observes a reused provider completion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-turn-legacy-'));
    directories.push(directory);
    const path = join(directory, 'events.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE voice_turn_runs (
      run_id TEXT PRIMARY KEY, voice_session_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
      provider_prompt_id TEXT, source_id TEXT, state TEXT NOT NULL,
      owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_birth TEXT,
      owner_identity_kind TEXT NOT NULL, started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, completed_at TEXT, failure_message TEXT,
      UNIQUE(voice_session_id, provider_turn_id)
    );
    INSERT INTO voice_turn_runs
      (run_id, voice_session_id, provider_session_id, provider_turn_id, provider_prompt_id,
       source_id, state, owner_id, owner_pid, owner_identity_kind, started_at, updated_at)
    VALUES
      ('voice:legacy-active', 'voice-legacy', 'provider-legacy', 'completion-legacy', NULL,
       'station-voice', 'running', 'dead-owner', 99999999, 'unverified',
       '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z');`);
    legacy.close();
    const store = new EventStore(path);
    stores.push(store);
    const first = store.voiceTurnRunAuthority().observeStart({
      voiceSessionId: 'voice-a',
      providerSessionId: 'provider-a',
      providerPromptId: 'prompt-a',
      providerTurnId: 'completion-a',
      providerId: 'nova-s2s',
      now: '2026-08-14T00:00:00.000Z',
    });
    const second = store.voiceTurnRunAuthority().observeStart({
      voiceSessionId: 'voice-a',
      providerSessionId: 'provider-b',
      providerPromptId: 'prompt-b',
      providerTurnId: 'completion-a',
      providerId: 'nova-s2s',
      now: '2026-08-14T00:00:01.000Z',
    });
    expect(first.kind).toBe('started');
    expect(second.kind).toBe('started');
    expect(
      store.voiceTurnRunReader().read('voice:legacy-active'),
    ).toMatchObject({
      kind: 'available',
      run: { status: 'failed', failureKind: 'unknown' },
    });
  });
  test('uses the exact provider completion identity, deduplicates start, and projects one canonical voice run', async () => {
    const store = createStore();
    const runs = store.voiceTurnRunAuthority();
    const first = runs.observeStart({
      voiceSessionId: 'voice-session-a',
      providerSessionId: 'nova-session-a',
      providerTurnId: 'completion-a',
      providerId: 'nova-s2s',
      providerPromptId: 'prompt-a',
      sourceId: 'station-voice',
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(first.kind).toBe('started');
    if (first.kind !== 'started') throw new Error('expected voice owner');
    expect(
      runs.observeStart({
        voiceSessionId: 'voice-session-a',
        providerSessionId: 'nova-session-a',
        providerTurnId: 'completion-a',
        providerId: 'nova-s2s',
        providerPromptId: 'prompt-a',
        now: '2026-08-14T00:00:01.000Z',
      }),
    ).toEqual({ kind: 'duplicate' });

    expect(
      first.handle.complete({
        now: '2026-08-14T00:00:02.000Z',
        stopReason: 'END_TURN',
      }),
    ).toEqual({ kind: 'applied' });

    const reader = store.voiceTurnRunReader();
    const projected = reader.read(first.handle.runId);
    expect(projected).toMatchObject({
      kind: 'available',
      run: {
        runId: first.handle.runId,
        providerId: 'nova-s2s',
        source: 'voice',
        sourceId: 'station-voice',
        status: 'completed',
        retryEligible: false,
      },
    });
    expect(JSON.stringify(projected)).not.toContain('completion-a');

    const service = new RunService(
      { listAgentRuns: async () => [], readAgentRun: async () => null } as any,
      {
        listRunSummaries: async () => [],
        readRunSummary: async () => null,
      } as any,
      store.nativeInvocationRunReader(),
      store.voiceTurnRunReader(),
    );
    await expect(
      service.readRun(first.handle.runId, {
        mode: 'personal',
        userId: 'brian',
      } as any),
    ).resolves.toMatchObject({ runId: first.handle.runId, source: 'voice' });
  });

  test('keeps invoke and voice source reads isolated from the other store failure', async () => {
    const invokeRun = {
      runId: 'invoke:a',
      providerId: 'invoke-provider',
      source: 'invoke' as const,
      status: 'completed' as const,
      startedAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:01.000Z',
      completedAt: '2026-08-14T00:00:01.000Z',
      retryEligible: false,
      attempt: 1,
    };
    const voiceRun = {
      ...invokeRun,
      runId: 'voice:a',
      providerId: 'voice-provider',
      source: 'voice' as const,
    };
    const authority = { mode: 'personal', userId: 'brian' } as any;
    const orchestration = {
      listAgentRuns: async () => [],
      readAgentRun: async () => null,
    } as any;
    const scheduler = {
      listRunSummaries: async () => [],
      readRunSummary: async () => null,
    } as any;
    const invokeService = new RunService(
      orchestration,
      scheduler,
      {
        list: () => ({ kind: 'available' as const, runs: [invokeRun] }),
        read: () => ({ kind: 'available' as const, run: invokeRun }),
      },
      {
        list: () => ({ kind: 'unavailable' as const }),
        read: () => ({ kind: 'unavailable' as const }),
      },
    );
    await expect(
      invokeService.listRuns(authority, { source: 'invoke' }),
    ).resolves.toEqual([invokeRun]);
    const voiceService = new RunService(
      orchestration,
      scheduler,
      {
        list: () => ({ kind: 'unavailable' as const }),
        read: () => ({ kind: 'unavailable' as const }),
      },
      {
        list: () => ({ kind: 'available' as const, runs: [voiceRun] }),
        read: () => ({ kind: 'available' as const, run: voiceRun }),
      },
    );
    await expect(
      voiceService.listRuns(authority, { source: 'voice' }),
    ).resolves.toEqual([voiceRun]);
  });

  test('fails closed for unmatched terminal events and makes documented non-END_TURN ends indeterminate', () => {
    const store = createStore();
    const runs = store.voiceTurnRunAuthority();
    expect('indeterminateSession' in runs).toBe(false);
    const started = runs.observeStart({
      voiceSessionId: 'voice-session-a',
      providerSessionId: 'nova-session-a',
      providerTurnId: 'completion-a',
      providerId: 'nova-s2s',
      providerPromptId: 'prompt-a',
      now: '2026-08-14T00:00:01.000Z',
    });
    if (started.kind !== 'started') throw new Error('expected owner');
    expect(
      started.handle.complete({
        now: '2026-08-14T00:00:02.000Z',
        stopReason: 'INTERRUPTED',
      }),
    ).toEqual({ kind: 'applied' });
    expect(store.voiceTurnRunReader().read(started.handle.runId)).toMatchObject(
      {
        kind: 'available',
        run: { status: 'failed', failureKind: 'unknown', retryEligible: false },
      },
    );
  });

  test('reads back an exact terminal after the SQLite write boundary throws', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-turn-postwrite-'));
    directories.push(directory);
    const path = join(directory, 'events.sqlite');
    const store = new EventStore(
      path,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error('post-write boundary unavailable');
      },
    );
    stores.push(store);
    const started = store.voiceTurnRunAuthority().observeStart({
      voiceSessionId: 'voice-postwrite',
      providerSessionId: 'nova-postwrite',
      providerTurnId: 'completion-postwrite',
      providerPromptId: 'prompt-postwrite',
      providerId: 'nova-s2s',
      now: '2026-08-14T00:00:00.000Z',
    });
    if (started.kind !== 'started') throw new Error('expected owner');
    expect(
      started.handle.complete({
        now: '2026-08-14T00:00:01.000Z',
        stopReason: 'END_TURN',
      }),
    ).toEqual({ kind: 'applied' });
    expect(store.voiceTurnRunReader().read(started.handle.runId)).toMatchObject(
      {
        kind: 'available',
        run: { status: 'completed' },
      },
    );
  });

  test('retains every active voice boundary and only the newest 1000 terminals', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-turn-retention-'));
    directories.push(directory);
    const path = join(directory, 'events.sqlite');
    const store = new EventStore(path);
    stores.push(store);
    const seed = new DatabaseSync(path);
    seed.exec('BEGIN IMMEDIATE');
    const insert = seed.prepare(`INSERT INTO voice_turn_runs
      (run_id, voice_session_id, provider_session_id, provider_turn_id, provider_prompt_id, provider_id,
       state, owner_id, owner_pid, owner_identity_kind, started_at, updated_at, completed_at, terminal_sequence)
      VALUES (?, ?, ?, ?, 'prompt', 'nova-s2s', 'completed', 'seed', ?, 'unverified', ?, ?, ?, ?)`);
    for (let index = 0; index < 1001; index += 1) {
      const timestamp = new Date(
        Date.UTC(2026, 0, 1, 0, 0, index),
      ).toISOString();
      insert.run(
        `voice:terminal-${index}`,
        `voice-terminal-${index}`,
        'nova-terminal',
        `completion-${index}`,
        process.pid,
        timestamp,
        timestamp,
        timestamp,
        index + 1,
      );
    }
    seed.exec('COMMIT');
    seed.close();

    const terminalized = store.voiceTurnRunAuthority().observeStart({
      voiceSessionId: 'voice-new-terminal',
      providerSessionId: 'nova-new-terminal',
      providerTurnId: 'completion-new-terminal',
      providerPromptId: 'prompt-new-terminal',
      providerId: 'nova-s2s',
      now: '2026-08-14T00:00:00.000Z',
    });
    if (terminalized.kind !== 'started') throw new Error('expected owner');
    expect(
      terminalized.handle.complete({
        now: '2026-08-14T00:00:01.000Z',
        stopReason: 'END_TURN',
      }),
    ).toEqual({ kind: 'applied' });
    const active = store.voiceTurnRunAuthority().observeStart({
      voiceSessionId: 'voice-active',
      providerSessionId: 'nova-active',
      providerTurnId: 'completion-active',
      providerPromptId: 'prompt-active',
      providerId: 'nova-s2s',
      now: '2026-08-14T00:00:02.000Z',
    });
    expect(active.kind).toBe('started');

    const listed = store.voiceTurnRunReader().list();
    expect(listed.kind).toBe('available');
    if (listed.kind !== 'available') throw new Error('expected projection');
    expect(listed.runs.filter((run) => run.status === 'running')).toHaveLength(
      1,
    );
    expect(listed.runs.filter((run) => run.status !== 'running')).toHaveLength(
      1000,
    );
    expect(listed.runs.some((run) => run.runId === 'voice:terminal-0')).toBe(
      false,
    );
    const proof = new DatabaseSync(path, { readOnly: true });
    const count = proof
      .prepare(
        "SELECT COUNT(*) AS count FROM voice_turn_runs WHERE state != 'running'",
      )
      .get() as { count: number };
    proof.close();
    expect(count.count).toBe(1000);
  });

  test('reconciles an observed provider completion as indeterminate after a same-process restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-turn-restart-'));
    directories.push(directory);
    const path = join(directory, 'events.sqlite');
    const first = new EventStore(path);
    const started = first.voiceTurnRunAuthority().observeStart({
      voiceSessionId: 'voice-session-a',
      providerSessionId: 'nova-session-a',
      providerTurnId: 'completion-a',
      providerId: 'nova-s2s',
      providerPromptId: 'prompt-a',
      now: '2026-08-14T00:00:00.000Z',
    });
    if (started.kind !== 'started') throw new Error('expected owner');
    first.close();
    const second = new EventStore(path);
    stores.push(second);
    expect(
      second.voiceTurnRunReader().read(started.handle.runId),
    ).toMatchObject({
      kind: 'available',
      run: { status: 'failed', failureKind: 'unknown', retryEligible: false },
    });
  });

  test('does not steal a live observed turn and marks exactly that turn indeterminate after its owner dies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-turn-process-'));
    directories.push(directory);
    const path = join(directory, 'events.sqlite');
    const initial = new EventStore(path);
    initial.close();
    const child = await spawnObservedVoiceOwner(path);
    try {
      const live = new EventStore(path);
      expect(live.voiceTurnRunReader().list()).toMatchObject({
        kind: 'available',
        runs: [expect.objectContaining({ source: 'voice', status: 'running' })],
      });
      live.close();
    } finally {
      await stopChild(child);
    }
    const recovered = new EventStore(path);
    stores.push(recovered);
    expect(recovered.voiceTurnRunReader().list()).toMatchObject({
      kind: 'available',
      runs: [
        expect.objectContaining({
          source: 'voice',
          status: 'failed',
          failureKind: 'unknown',
          retryEligible: false,
        }),
      ],
    });
  });
});
