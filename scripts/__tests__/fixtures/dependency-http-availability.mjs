import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { deflateSync, gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const [mode, caller] = process.argv.slice(2);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function body() {
  const fromCaller =
    caller === 'a2a-express'
      ? createRequire(require.resolve('@a2a-js/sdk'))
      : require;
  const fromExpress = createRequire(fromCaller.resolve('express'));
  const parser = fromExpress('body-parser');
  const middleware = parser.raw({ type: 'application/octet-stream' });
  const first = Buffer.concat([
    deflateSync(Buffer.from('valid body')),
    Buffer.from([0]),
  ]);
  const trailing = Buffer.alloc(1024);
  const gzipBody = Buffer.concat([
    gzipSync(Buffer.from('valid body')),
    Buffer.from([0]),
    Buffer.alloc(100 * 1024, 0x58),
  ]);
  const expectedHash = createHash('sha256')
    .update(first)
    .update(trailing)
    .digest('hex');
  let client;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.end('healthy');
      return;
    }
    const hash = createHash('sha256');
    req.pipe(hash);
    middleware(req, res, (error) => {
      if (error) {
        res.statusCode = error.status || 500;
        res.end(error.type);
        return;
      }
      assert.equal(req.body.toString(), 'valid body');
      if (req.url === '/split') {
        hash.once('finish', () => {
          res.setHeader('x-body-sha256', hash.digest('hex'));
          res.end('accepted');
        });
        client.end(trailing);
      } else {
        res.end('accepted');
      }
    });
  });
  const origin = await listen(server);
  try {
    const accepted = await new Promise((resolve, reject) => {
      client = http.request(`${origin}/split`, {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/octet-stream',
          'content-encoding': 'deflate',
          'content-length': first.length + trailing.length,
        },
      });
      client.on('error', reject);
      client.on('response', (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          assert.equal(response.headers['x-body-sha256'], expectedHash);
          resolve(response.statusCode === 200 && text === 'accepted');
        });
      });
      client.write(first);
    });
    assert.equal(accepted, true);
    await new Promise((resolve, reject) => {
      client = http.request(
        `${origin}/gzip`,
        {
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/octet-stream',
            'content-encoding': 'gzip',
            'content-length': gzipBody.length,
          },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('error', reject);
          response.on('end', () => {
            assert.equal(response.statusCode, 200);
            assert.equal(text, 'accepted');
            resolve();
          });
        },
      );
      client.on('error', reject);
      client.end(gzipBody);
    });
    const healthy = await fetch(`${origin}/health`);
    assert.equal(await healthy.text(), 'healthy');
    return { accepted, healthy: true };
  } finally {
    client?.destroy();
    await close(server);
  }
}

async function fetchResponse() {
  const fromCaller = createRequire(
    require.resolve(caller === 'jsdom' ? 'jsdom' : '@ai-sdk/provider-utils'),
  );
  const { Agent, fetch } = fromCaller('undici');
  const dispatcher = new Agent();
  const server = http.createServer((req, res) => {
    if (req.url === '/bad') {
      res.writeHead(200, {
        'content-encoding': Array(6).fill('gzip').join(', '),
        'content-length': '100',
        connection: 'close',
      });
      res.end();
    } else {
      res.end('healthy');
    }
  });
  const origin = await listen(server);
  try {
    await assert.rejects(fetch(`${origin}/bad`, { dispatcher }), (error) => {
      assert.match(error.cause.message, /too many content-encodings/);
      return true;
    });
    const healthy = await fetch(`${origin}/health`, { dispatcher });
    assert.equal(await healthy.text(), 'healthy');
    return { rejected: true, healthy: true };
  } finally {
    await dispatcher.close();
    await close(server);
  }
}

async function eventSource() {
  const fromCaller = createRequire(
    require.resolve(caller === 'jsdom' ? 'jsdom' : '@ai-sdk/provider-utils'),
  );
  const { Agent, EventSource } = fromCaller('undici');
  const dispatcher = new Agent({
    eventSource: { maxEventSize: mode === 'sse-fields' ? 256 * 1024 : 64 },
  });
  const payload =
    mode === 'sse-fields'
      ? `${'data:\n'.repeat(2049)}\n`
      : `data: ${'a'.repeat(80)}`;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    if (req.url === '/good') res.end('data: healthy\n\n');
    else {
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync(Buffer.from(payload)));
    }
  });
  const origin = await listen(server);
  async function firstEvent(path) {
    const source = new EventSource(`${origin}${path}`, { dispatcher });
    try {
      return await new Promise((resolve) => {
        source.addEventListener('message', (event) =>
          resolve({ type: 'message', data: event.data }),
        );
        source.addEventListener('error', () =>
          resolve({ type: 'error', readyState: source.readyState }),
        );
      });
    } finally {
      source.close();
    }
  }
  try {
    assert.deepEqual(await firstEvent('/good'), {
      type: 'message',
      data: 'healthy',
    });
    const denied = await firstEvent('/bad');
    assert.equal(denied.type, 'error');
    assert.equal(denied.readyState, EventSource.CLOSED);
    return { denied: true, healthy: true };
  } finally {
    await dispatcher.close();
    await close(server);
  }
}

const result =
  mode === 'body'
    ? await body()
    : mode === 'fetch'
      ? await fetchResponse()
      : await eventSource();
console.log(JSON.stringify({ mode, caller, ...result }));
