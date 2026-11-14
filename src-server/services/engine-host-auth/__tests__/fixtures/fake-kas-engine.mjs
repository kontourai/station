#!/usr/bin/env node
// A fake Kiro agent service: on `initialize` it first asks the client for an
// access token (`_kiro/auth/getAccessToken`, as KAS does under
// `--auth=acp-callback`) and only then answers, putting what the client said
// in the result's `_meta.fakeKas` so the test reads it from the handshake.
// It also records its own argv there, to prove which launch ran.
import { createInterface } from 'node:readline';

const pending = new Map();
let nextId = 1000;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
    return;
  }
  if (message.method === 'initialize') {
    const id = nextId++;
    pending.set(id, (reply) =>
      send({
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: 'fake-kas', version: '0.0.0' },
          _meta: {
            fakeKas: {
              argv: process.argv.slice(2),
              ...(reply.error
                ? {
                    error: {
                      code: reply.error.code,
                      message: reply.error.message,
                    },
                  }
                : { result: reply.result }),
            },
          },
        },
      }),
    );
    send({ id, method: '_kiro/auth/getAccessToken', params: {} });
    return;
  }
  if (message.id !== undefined && message.method !== undefined)
    send({
      id: message.id,
      error: { code: -32601, message: 'Method not found' },
    });
});
