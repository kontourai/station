import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../../infra/process-utils.js';
import {
  type NativeModelChannelRequest,
  NativeModelStdioChannel,
} from '../native-model-stdio-channel.js';
import {
  NATIVE_MODEL_CHANNEL_LIMITS,
  type NativeModelRequest,
} from '../native-model-stdio-protocol.js';

const temporary = trackTempDirs({ lifetime: 'file' });
async function fixture(
  request: (
    input: NativeModelRequest,
    signal: AbortSignal,
  ) => NativeModelChannelRequest,
  retirement: Promise<void> = Promise.resolve(),
) {
  const home = temporary('native-model-stdio-');
  const registry = join(home, 'registry');
  mkdirSync(registry, { mode: 0o700 });
  const handle = spawnOwnedChild(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve(import.meta.dirname, '../native-model-stdio-worker.ts'),
    ],
    {
      registryDir: registry,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
    },
  );
  const { stdin, stdout, stderr } = handle.proc;
  if (!stdin || !stdout || !stderr)
    throw new Error('Owned worker pipes unavailable');
  let diagnostic = '';
  stderr.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString();
    if (Buffer.byteLength(diagnostic) > 64 * 1024)
      void terminateProcessTree(handle.proc);
  });
  const closed = new Promise<void>((resolve, reject) => {
    handle.proc.once('close', () => resolve());
    handle.proc.once('error', reject);
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping)
      stopping = (async () => {
        stdin.end();
        await terminateProcessTree(handle.proc, {
          graceMs: 1_000,
          killConfirmMs: 1_000,
        });
        await closed;
        handle.release();
      })();
    return stopping;
  };
  const channel = new NativeModelStdioChannel(
    {
      input: stdin,
      output: stdout,
      settled: closed,
      stop: async () => {
        await retirement;
        await stop();
      },
    },
    request,
  );
  onTestFinished(async () => {
    await stop();
    await closed;
    expect(channel.inspect().pending).toBe(0);
    expect(readdirSync(registry)).toEqual([]);
  });
  const ready = await channel.ready;
  return {
    channel,
    url: `http://127.0.0.1:${ready.port}`,
    stop,
    closed,
    diagnostic: () => diagnostic,
  };
}

const delivery = async (write: () => void) => write();

test('real worker authenticates its scope and streams both native provider paths without sending the scoped key to the host request owner', async () => {
  const body = '{"input":"native 😺\u2028separator\u2029tail"}';
  const responseBytes = Buffer.from('data: native 😺\u2028reply\u2029\n\n');
  const seen: NativeModelRequest[] = [];
  const f = await fixture((input) => {
    seen.push(input);
    return {
      response: Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(responseBytes.subarray(0, 15));
              controller.enqueue(responseBytes.subarray(15));
              controller.close();
            },
          }),
          {
            headers: {
              'content-type': 'text/event-stream',
              'x-codex-turn-state': 'opaque-state',
              authorization: 'never-forward',
            },
          },
        ),
      ),
      settled: Promise.resolve(),
      invokeDelivery: delivery,
    };
  });
  expect(
    (
      await fetch(`${f.url}/v1/messages`, {
        method: 'POST',
        body,
        headers: { authorization: 'Bearer wrong-token' },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${f.url}/private`, {
        headers: { authorization: `Bearer ${f.channel.token}` },
      })
    ).status,
  ).toBe(404);
  expect(seen).toEqual([]);
  for (const path of ['/v1/messages?beta=true', '/v1/responses']) {
    const response = await fetch(`${f.url}${path}`, {
      method: 'POST',
      body,
      headers: {
        authorization: `Bearer ${f.channel.token}`,
        'content-type': 'application/json',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codex-turn-state')).toBe('opaque-state');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(responseBytes);
  }
  expect(seen.map((input) => input.path)).toEqual([
    '/v1/messages?beta=true',
    '/v1/responses',
  ]);
  expect(seen.every((input) => input.body.equals(Buffer.from(body)))).toBe(
    true,
  );
  expect(
    seen
      .flatMap((input) => input.headers)
      .some(([name]) => ['authorization', 'x-api-key'].includes(name)),
  ).toBe(false);
  expect(JSON.stringify(seen)).not.toContain(f.channel.token);
  await f.channel.close();
  expect(f.channel.inspect()).toMatchObject({
    workerSettled: true,
    pending: 0,
  });
});

test('oversized native request is refused before host admission and does not poison a later valid request', async () => {
  const owner = vi.fn(() => ({
    response: Promise.resolve(new Response('valid')),
    settled: Promise.resolve(),
    invokeDelivery: delivery,
  }));
  const f = await fixture(owner);
  const headers = { authorization: `Bearer ${f.channel.token}` };
  const invalid = await fetch(`${f.url}/v1/messages`, {
    method: 'POST',
    headers,
    body: Buffer.alloc(NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes + 1, 97),
  });
  expect(invalid.status).toBe(502);
  expect(owner).not.toHaveBeenCalled();
  const valid = await fetch(`${f.url}/v1/messages`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(await valid.text()).toBe('valid');
  expect(owner).toHaveBeenCalledTimes(1);
  await f.channel.close();
});

test('each actual response write re-enters the captured host delivery port and revocation withholds private bytes', async () => {
  let writes = 0;
  const retired = new Error('captured delivery authority revoked');
  const f = await fixture(() => ({
    response: Promise.resolve(new Response('PRIVATE_NATIVE_RESPONSE')),
    settled: Promise.resolve(),
    invokeDelivery: async (write) => {
      if (++writes > 1) throw retired;
      write();
    },
  }));
  await expect(
    fetch(`${f.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${f.channel.token}` },
      body: '{}',
    }).then((response) => response.text()),
  ).rejects.toThrow();
  await expect(f.channel.settled).rejects.toBe(retired);
  expect(writes).toBe(2);
  expect(f.channel.inspect()).toMatchObject({
    workerSettled: true,
    pending: 0,
    failure: retired,
  });
});

test('native disconnect aborts the host request but keeps a nonsettled owner visible after worker retirement', async () => {
  let entered!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  const f = await fixture((_input, signal) => {
    entered(signal);
    return {
      response: pending.then(() => new Response('late private response')),
      settled: pending,
      invokeDelivery: delivery,
    };
  });
  try {
    const abort = new AbortController();
    const fetching = fetch(`${f.url}/v1/responses`, {
      method: 'POST',
      signal: abort.signal,
      headers: { authorization: `Bearer ${f.channel.token}` },
      body: '{}',
    });
    void fetching.catch(() => {});
    const signal = await started;
    const cancelled = new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    abort.abort();
    await expect(fetching).rejects.toThrow();
    await cancelled;
    await expect(f.channel.close()).rejects.toThrow(
      'native_model_channel_unsettled',
    );
    expect(f.channel.inspect()).toMatchObject({
      workerSettled: true,
      pending: 1,
    });
    release();
    await expect(f.channel.settled).rejects.toThrow();
    expect(f.channel.inspect().pending).toBe(0);
  } finally {
    release();
    await f.channel.settled.catch(() => {});
  }
});

test('complete provider bytes do not release a still-pending host terminal/accounting owner', async () => {
  let release!: () => void;
  const terminal = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  const f = await fixture(() => ({
    response: Promise.resolve(new Response('complete provider bytes')),
    settled: terminal,
    invokeDelivery: delivery,
  }));
  try {
    const response = await fetch(`${f.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${f.channel.token}` },
      body: '{}',
    });
    expect(await response.text()).toBe('complete provider bytes');
    expect(f.channel.inspect().pending).toBe(1);
    await expect(f.channel.close()).rejects.toThrow(
      'native_model_channel_unsettled',
    );
    expect(f.channel.inspect()).toMatchObject({
      workerSettled: true,
      pending: 1,
    });
    release();
    await f.channel.settled;
    expect(f.channel.inspect().pending).toBe(0);
  } finally {
    release();
    await f.channel.settled.catch(() => {});
  }
});

test('unexpected worker loss cancels the host request before slow worker retirement settles', async () => {
  let releaseRetirement!: () => void;
  const retirement = new Promise<void>((resolve) => {
    releaseRetirement = resolve;
  });
  let entered!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    entered = resolve;
  });
  let releaseResponse!: () => void;
  const pending = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const f = await fixture((_input, signal) => {
    entered(signal);
    return {
      response: pending.then(() => new Response('late')),
      settled: pending,
      invokeDelivery: delivery,
    };
  }, retirement);
  const fetching = fetch(`${f.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.channel.token}` },
    body: '{}',
  });
  void fetching.catch(() => {});
  try {
    const signal = await started;
    await f.stop();
    await expect(fetching).rejects.toThrow();
    await vi.waitFor(() => expect(signal.aborted).toBe(true), {
      timeout: 1000,
    });
    expect(f.channel.inspect()).toMatchObject({
      admissionClosed: true,
      pending: 1,
    });
  } finally {
    releaseRetirement();
    releaseResponse();
    await f.channel.settled.catch(() => {});
  }
});
