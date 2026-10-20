import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  claudeExitDetailWithStderr,
  createClaudeEngineProcess,
} from '../adapters/claude-code-spawn.js';
import {
  claudeCanUseToolFrame,
  FAKE_CLAUDE_COMMAND,
  FakeClaudeChild,
  fakeClaudeSpawn,
} from './claude-engine-process-test-utils.js';

function start(env: Record<string, string | undefined> = { A: '1' }) {
  const engine = createClaudeEngineProcess(fakeClaudeSpawn());
  const signal = new AbortController().signal;
  const spawned = engine.spawn({
    command: FAKE_CLAUDE_COMMAND,
    args: ['--output-format', 'stream-json'],
    cwd: '/work',
    env,
    signal,
  });
  const child = FakeClaudeChild.newest!;
  return { engine, spawned, child, signal };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createClaudeEngineProcess', () => {
  test('retirement waits for confirmed exit and fences later spawns', async () => {
    vi.useFakeTimers();
    const { engine, child } = start();
    child.kill = vi.fn(() => true);
    let retired = false;
    const retirement = engine.terminate().then(() => {
      retired = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(retired).toBe(false);
    child.exit(0);
    await vi.advanceTimersByTimeAsync(100);
    await retirement;
    expect(retired).toBe(true);
    expect(() =>
      engine.spawn({
        command: FAKE_CLAUDE_COMMAND,
        args: [],
        cwd: '/work',
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow('has retired');
  });

  test('unconfirmed retirement is a failure rather than permission to resume elsewhere', async () => {
    vi.useFakeTimers();
    const { engine, child } = start();
    child.kill = vi.fn(() => true);
    const outcome = engine.terminate().then(
      () => null,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await outcome).toBeInstanceOf(Error);
  });
  test("spawns as the SDK's default spawn does: piped stdio, the forwarded signal, the given env, no shell, windowsHide", () => {
    const env = { PATH: '/bin', TMPDIR: '/tmp/station' };
    const { child, signal } = start(env);
    expect(child.spawnArgs.command).toBe(FAKE_CLAUDE_COMMAND);
    expect(child.spawnArgs.args).toEqual(['--output-format', 'stream-json']);
    expect(child.spawnArgs.options).toEqual({
      cwd: '/work',
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      env,
      windowsHide: true,
    });
  });

  test('the SDK reads the same stdout bytes, after each ask on them was recorded', async () => {
    const { engine, spawned, child } = start();
    const frame = claudeCanUseToolFrame('req-1', {
      tool_name: 'Bash',
      input: { command: 'git status' },
      decision_reason: 'This command requires approval',
      decision_reason_type: 'other',
    });
    const stream = Buffer.from(`{"type":"system","note":"日本語"}\n${frame}`);
    const read = readAll(spawned.stdout);
    child.stdout.write(stream.subarray(0, 21));
    child.stdout.write(stream.subarray(21));
    child.stdout.end();
    expect((await read).equals(stream)).toBe(true);
    expect(engine.asks.take('req-1')).toEqual({ decisionReasonType: 'other' });
    expect(spawned.stdin).toBe(child.stdin);
  });

  test('a stream far larger than the pipe buffers reaches the SDK whole through the tap', async () => {
    const { spawned, child } = start();
    // The SDK must read the tap's output: left unread, the tap would fill
    // and stall the engine's stdout.
    expect(spawned.stdout).not.toBe(child.stdout);
    const line = Buffer.from(
      `${JSON.stringify({ type: 'assistant', text: 'é'.repeat(2000) })}\n`,
    );
    const lines = 512;
    const read = readAll(spawned.stdout);
    for (let index = 0; index < lines; index += 1) child.stdout.write(line);
    child.stdout.end();
    const received = await read;
    expect(received.length).toBe(line.length * lines);
    expect(received.subarray(-line.length).equals(line)).toBe(true);
  });

  test("stdin stays the child's own and receives the host's writes unchanged, while an initialize request arms the replay", async () => {
    const { engine, spawned, child } = start();
    expect(spawned.stdin).toBe(child.stdin);
    const written: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => written.push(chunk));
    const initialize = `${JSON.stringify({
      request_id: 'init-1',
      type: 'control_request',
      request: { subtype: 'initialize' },
    })}\n`;
    const user = `${JSON.stringify({ type: 'user', text: 'héllo 🙂' })}\n`;
    expect(spawned.stdin.write(initialize)).toBe(true);
    const flushed = new Promise<void>((resolve) =>
      spawned.stdin.write(user, 'utf8', () => resolve()),
    );
    await flushed;
    await vi.waitFor(() =>
      expect(Buffer.concat(written).toString('utf8')).toBe(initialize + user),
    );

    const replay = JSON.parse(
      claudeCanUseToolFrame('req-replay', {
        tool_name: 'Bash',
        input: { command: 'git push' },
        decision_reason_type: 'rule',
      }),
    );
    const read = readAll(spawned.stdout);
    child.stdout.end(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'init-1',
          response: {},
          pending_permission_requests: [replay],
        },
      })}\n`,
    );
    await read;
    expect(engine.asks.take('req-replay')).toEqual({
      decisionReasonType: 'rule',
    });
  });

  test('an stdout error reaches the reader', async () => {
    const { spawned, child } = start();
    const read = readAll(spawned.stdout);
    child.stdout.emit('error', new Error('EPIPE on stdout'));
    await expect(read).rejects.toThrow('EPIPE on stdout');
  });

  test('exit reaches listeners only after stderr has closed, with the stderr tail complete', async () => {
    const { engine, spawned, child } = start();
    const exits: Array<[number | null, NodeJS.Signals | null]> = [];
    spawned.on('exit', (code, signal) => exits.push([code, signal]));
    child.stderr.write('error: not logged in\n');
    child.exit(1);
    expect(exits).toEqual([]);
    child.stderr.write('run the login command\n');
    child.closeStderr();
    await vi.waitFor(() => expect(exits).toEqual([[1, null]]));
    expect(engine.stderrTail()).toBe(
      'error: not logged in\nrun the login command',
    );
    expect(spawned.exitCode).toBe(1);
  });

  test('exit is delivered 200 ms after the process exit when stderr stays open, once', async () => {
    vi.useFakeTimers();
    const { spawned, child } = start();
    const onExit = vi.fn();
    spawned.on('exit', onExit);
    child.exit(null, 'SIGKILL');
    vi.advanceTimersByTime(199);
    expect(onExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExit).toHaveBeenCalledExactlyOnceWith(null, 'SIGKILL');
    // The late close delivers nothing further.
    child.closeStderr();
    await vi.advanceTimersByTimeAsync(10);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test('once and off follow the delayed exit; error listeners are direct', async () => {
    const { spawned, child } = start();
    const removed = vi.fn();
    const once = vi.fn();
    const onError = vi.fn();
    spawned.on('exit', removed);
    spawned.off('exit', removed);
    spawned.once('exit', once);
    spawned.on('error', onError);
    const failure = new Error('spawn ENOENT');
    child.emit('error', failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    child.closeStderr();
    await vi.waitFor(() => expect(child.stderr.destroyed).toBe(true));
    child.exit(0);
    await vi.waitFor(() => expect(once).toHaveBeenCalledTimes(1));
    expect(removed).not.toHaveBeenCalled();
  });

  test("kill and the process state are the child's own", () => {
    const { spawned, child } = start();
    expect(spawned.killed).toBe(false);
    expect(spawned.exitCode).toBeNull();
    expect(spawned.kill('SIGTERM')).toBe(true);
    expect(child.killed).toBe(true);
    expect(spawned.killed).toBe(true);
    expect(spawned.signalCode).toBe('SIGTERM');
  });

  test('the stderr tail is bounded, keeps the end, and is passed through redaction', async () => {
    const { engine, child } = start();
    const fakeCredential = ['sk', 'ant', 'api03', 'a'.repeat(40)].join('-');
    child.stderr.write(`${'x'.repeat(9000)}\n`);
    child.stderr.write(`ANTHROPIC_API_KEY=${fakeCredential}\nfinal line\n`);
    child.closeStderr();
    await vi.waitFor(() => expect(child.stderr.destroyed).toBe(true));
    const tail = engine.stderrTail();
    expect(tail.length).toBeLessThanOrEqual(2048);
    expect(tail.endsWith('final line')).toBe(true);
    expect(tail).not.toContain(fakeCredential);
  });
});

describe('claudeExitDetailWithStderr', () => {
  test("appends the tail to the SDK's exit errors the way the SDK words it", () => {
    expect(
      claudeExitDetailWithStderr(
        'Claude Code process exited with code 1',
        'error: not logged in',
      ),
    ).toBe(
      'Claude Code process exited with code 1. stderr: error: not logged in',
    );
    expect(
      claudeExitDetailWithStderr(
        'Claude Code process terminated by signal SIGKILL',
        'oom',
      ),
    ).toBe('Claude Code process terminated by signal SIGKILL. stderr: oom');
  });

  test('leaves other errors, and an exit with no stderr, unchanged', () => {
    expect(
      claudeExitDetailWithStderr('Claude Code process exited with code 1', ''),
    ).toBe('Claude Code process exited with code 1');
    expect(claudeExitDetailWithStderr('Request timed out', 'noise')).toBe(
      'Request timed out',
    );
    expect(
      claudeExitDetailWithStderr(
        'Claude Code process exited with code 1. stderr: already',
        'again',
      ),
    ).toBe('Claude Code process exited with code 1. stderr: already');
  });
});
