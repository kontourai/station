import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

const compatibilityUrl = new URL('../node-http-compat.mjs', import.meta.url)
  .href;

function probe(options: {
  entry?: 'cli';
  enabled?: boolean;
  platform?: string;
  undiciVersion?: string;
  code?: string;
  syscall?: string;
  reset?: boolean;
}) {
  return spawnSync(
    process.execPath,
    [
      ...(options.entry === 'cli' ? ['--import', 'tsx'] : []),
      '--input-type=module',
      '--eval',
      `
      import { channel } from 'node:diagnostics_channel';
      import { createServer } from 'node:http';
      import { Socket } from 'node:net';
      import { installNodeHttpCompatibility } from ${JSON.stringify(compatibilityUrl)};
      const options = ${JSON.stringify(options)};
      const injected = function () {
        throw Object.assign(new Error('injected socket option failure'), {
          code: options.code ?? 'EINVAL',
          syscall: options.syscall ?? 'setTypeOfService',
        });
      };
      Socket.prototype.setTypeOfService = injected;
      const connected = channel('undici:client:connected');
      if (options.entry === 'cli') {
        const { runCli } = await import(${JSON.stringify(new URL('../../../cli/src/cli.ts', import.meta.url).href)});
        await runCli(['--version']);
      } else if (options.enabled !== false) {
        const target = { platform: options.platform ?? 'darwin', undiciVersion: options.undiciVersion ?? '7.29.0' };
        installNodeHttpCompatibility(target);
        installNodeHttpCompatibility(target);
      }
      // Exercise the socket boundary even on older Node 24 builds whose
      // bundled client predates ToS. The socket and POST are real.
      const sample = new Socket();
      connected.publish({ socket: sample });
      const guarded = sample.setTypeOfService;
      connected.publish({ socket: sample });
      const repeatedConnectionSafe = sample.setTypeOfService === guarded;
      sample.destroy();
      connected.subscribe(({ socket }) => socket.setTypeOfService(0));
      const requests = [];
      const server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => body += chunk);
        request.on('end', () => {
          requests.push({ method: request.method, body });
          if (options.reset) { request.socket.destroy(); return; }
          response.end('received');
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        let result;
        try {
          const response = await fetch('http://127.0.0.1:' + server.address().port, { method: 'POST', body: 'one write' });
          result = { status: response.status, body: await response.text() };
        } catch (error) {
          if (!options.reset) throw error;
          result = { networkRejected: true };
        }
        console.log(JSON.stringify({ ...result, requests, repeatedConnectionSafe,
          prototypeUnchanged: Socket.prototype.setTypeOfService === injected,
          uncaughtHandlers: process.listenerCount('uncaughtException') }));
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      `,
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
}

test('the unguarded socket fault crashes instead of becoming a fetch rejection', () => {
  const result = probe({ enabled: false });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('EINVAL');
  expect(result.stderr).toContain('setTypeOfService');
});

test('optional ToS failure preserves one real POST without changing global sockets', () => {
  const result = probe({});
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 200,
    body: 'received',
    requests: [{ method: 'POST', body: 'one write' }],
    repeatedConnectionSafe: true,
    prototypeUnchanged: true,
    uncaughtHandlers: 0,
  });
});

test.each([
  { code: 'EACCES', syscall: 'setTypeOfService' },
  { code: 'EINVAL', syscall: 'write' },
])('does not suppress a different failure: %j', (failure) => {
  const result = probe(failure);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(failure.code);
  expect(result.stderr).toContain(failure.syscall);
});

test.each([{ platform: 'linux' }, { undiciVersion: '8.8.0' }])(
  'leaves unaffected runtimes alone: %j',
  (runtime) => {
    const result = probe(runtime);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('setTypeOfService');
  },
);

test('ordinary network failures still reject', () => {
  const result = probe({ reset: true });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    networkRejected: true,
    prototypeUnchanged: true,
    uncaughtHandlers: 0,
  });
});

test.skipIf(
  process.platform !== 'darwin' || !process.versions.undici?.startsWith('7.'),
)('the real CLI entry installs compatibility before commands use fetch', () => {
  const result = probe({ entry: 'cli' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({
    status: 200,
    body: 'received',
    requests: [{ method: 'POST', body: 'one write' }],
    prototypeUnchanged: true,
    uncaughtHandlers: 0,
  });
});
