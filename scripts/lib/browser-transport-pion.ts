import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { localLabEnvironment } from './local-collaboration-process.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './owned-process.mjs';

function readBounded(path: string): unknown {
  assert(
    statSync(path).size <= 128 * 1024,
    'Pion fixture response exceeds bound',
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function startPionFixture(input: {
  executable: string;
  directory: string;
  certificate: string;
  key: string;
  offer: { type: string; sdp: string };
  turnPort: number;
  username: string;
  password: string;
}) {
  assert(
    existsSync(input.executable),
    'Build the Pion fixture before running --peer=pion',
  );
  mkdirSync(input.directory, { mode: 0o700 });
  writeFileSync(
    join(input.directory, 'config.json'),
    JSON.stringify({
      Offer: input.offer,
      Certificate: input.certificate,
      Key: input.key,
      URL: `turn:127.0.0.1:${input.turnPort}?transport=tcp`,
      Username: input.username,
      Password: input.password,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const execution = executeOwnedCommand(
    input.executable,
    [input.directory],
    spawn,
    'Pion lab peer',
    {
      cwd: input.directory,
      env: localLabEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const capture = captureOwnedProcessOutput(execution, { maxBytes: 64 * 1024 });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const result = await terminateSuiteExecution(execution, {
        waitForSuiteSettlement,
        terminationGraceMs: 2000,
        terminationForceMs: 3000,
      });
      assert(result.settled, 'Pion process tree did not settle');
      assert.deepEqual(result.errors, []);
      const output = capture.finish();
      assert(
        !output.truncated && !output.invalidUtf8,
        'Pion process output contract failed',
      );
      assert(
        !existsSync(join(input.directory, 'failure.json')),
        'Pion fixture reported a lifecycle failure',
      );
    })());
  const readMessages = () => {
    const path = join(input.directory, 'messages.json');
    if (!existsSync(path))
      return { messages: [] as string[], local: '', remote: '' };
    const value = readBounded(path) as {
      messages: unknown;
      local: unknown;
      remote: unknown;
    };
    assert(
      Array.isArray(value.messages) &&
        value.messages.length <= 8 &&
        value.messages.every((message) => typeof message === 'string'),
    );
    assert(typeof value.local === 'string' && typeof value.remote === 'string');
    return {
      messages: value.messages as string[],
      local: value.local,
      remote: value.remote,
    };
  };
  try {
    const deadline = Date.now() + 25000;
    const answerPath = join(input.directory, 'answer.json');
    while (!existsSync(answerPath)) {
      assert(
        !existsSync(join(input.directory, 'failure.json')),
        'Pion fixture failed before answer',
      );
      assert(execution.isAlive(), 'Pion fixture exited before answer');
      assert(Date.now() < deadline, 'Pion answer exceeded liveness bound');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const answer = readBounded(answerPath) as { type: unknown; sdp: unknown };
    assert(answer.type === 'answer' && typeof answer.sdp === 'string');
    const version = readBounded(join(input.directory, 'version.json')) as {
      pion: unknown;
      go: unknown;
    };
    assert(version.pion === 'v4.2.20' && typeof version.go === 'string');
    return {
      provenance: {
        pionWebrtc: version.pion,
        goVersion: version.go,
        executableSha256: createHash('sha256')
          .update(readFileSync(input.executable))
          .digest('hex'),
      },
      answer: { type: 'answer' as const, sdp: answer.sdp },
      peer: {
        close,
        getSelectedCandidatePair() {
          const value = readMessages();
          return {
            local: { type: value.local },
            remote: { type: value.remote },
          };
        },
      },
      readMessages: () => readMessages().messages,
      diagnostics: () => {
        const path = join(input.directory, 'state.json');
        return existsSync(path) ? readBounded(path) : null;
      },
    };
  } catch (error) {
    const errors = [error];
    try {
      await close();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    throw new AggregateError(errors, 'Pion fixture startup failed');
  }
}
