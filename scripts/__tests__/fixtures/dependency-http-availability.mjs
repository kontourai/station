import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

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
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.end('healthy');
      return;
    }
    middleware(req, res, (error) => {
      if (error) {
        res.statusCode = error.status || 500;
        res.end(error.type);
        return;
      }
      assert.equal(req.body.toString(), 'valid body');
      res.end('accepted');
    });
  });
  const origin = await listen(server);
  try {
    const accepted = await new Promise((resolve, reject) => {
      const request = http.request(origin, {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/octet-stream',
          'content-encoding': 'deflate',
          'transfer-encoding': 'chunked',
        },
      });
      request.on('error', reject);
      request.on('response', (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve(response.statusCode === 200 && text === 'accepted'),
        );
        request.end('trailing bytes');
      });
      request.write(deflateSync(Buffer.from('valid body')));
    });
    assert.equal(accepted, true);
    const healthy = await fetch(`${origin}/health`);
    assert.equal(await healthy.text(), 'healthy');
    return { accepted, healthy: true };
  } finally {
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

const result = mode === 'body' ? await body() : await fetchResponse();
console.log(JSON.stringify({ mode, caller, ...result }));
