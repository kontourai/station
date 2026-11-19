/**
 * Loopback stand-in for the Anthropic Messages endpoint. The Claude engine is
 * pointed here through `ANTHROPIC_BASE_URL`, so a turn costs no model spend:
 * every request is recorded as received and `/v1/messages` gets a minimal
 * canned reply ("ok"). Anything else is recorded and answered 404, so an
 * unexpected call is visible in the record instead of silently succeeding.
 */
import { createServer } from 'node:http';

/** The canned assistant text; callers assert a completed turn against it. */
export const STUB_REPLY_TEXT = 'ok';

/** Bodies above this are refused (413) and recorded as refused, not parsed. */
export const STUB_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Header names whose values could carry a credential are dropped on record. */
const SECRET_HEADER = /auth|key|cookie|token/i;

function cannedMessage(model) {
  return {
    id: 'msg_station_weight_stub',
    type: 'message',
    role: 'assistant',
    model: typeof model === 'string' ? model : 'stub',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function writeStream(response, model, reply) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const event = (name, data) =>
    response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event('message_start', {
    type: 'message_start',
    message: cannedMessage(model),
  });
  event('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: reply },
  });
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  event('message_stop', { type: 'message_stop' });
  response.end();
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * @typedef {{ sequence: number, receivedAt: number, method: string, path: string, query: string, headers: Record<string, string>, bodyBytes: number, body: unknown, refused?: string }} StubRequest
 * @param {{host?: string, turns?: ReadonlyArray<{prompt: string, reply: string}>}} [options]
 * @returns {Promise<{ url: string, requests: StubRequest[], close: () => Promise<void> }>}
 */
export async function startStubAnthropic({
  host = '127.0.0.1',
  turns = [],
} = {}) {
  /** @type {StubRequest[]} */
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    let bytes = 0;
    let refused = false;
    request.on('data', (chunk) => {
      if (refused) return;
      bytes += chunk.length;
      if (bytes > STUB_MAX_BODY_BYTES) {
        refused = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://stub.invalid');
      const headers = Object.fromEntries(
        Object.entries(request.headers)
          .filter(([name]) => !SECRET_HEADER.test(name))
          .map(([name, value]) => [name, String(value)]),
      );
      const text = refused ? '' : Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      const record = {
        sequence: requests.length + 1,
        receivedAt: Date.now(),
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        headers,
        bodyBytes: bytes,
        body,
        ...(refused ? { refused: 'body-too-large' } : {}),
      };
      requests.push(record);
      if (refused) return json(response, 413, { type: 'error' });
      if (record.method === 'POST' && url.pathname === '/v1/messages') {
        const model = body?.model;
        const content = body?.messages?.findLast(
          (message) => message.role === 'user',
        )?.content;
        const texts =
          typeof content === 'string'
            ? [content]
            : Array.isArray(content)
              ? content
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
              : [];
        const matches = turns.filter((turn) =>
          texts.some((text) => text.trimEnd().endsWith(turn.prompt)),
        );
        if (matches.length > 1)
          return json(response, 400, {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'ambiguous diagnostic prompt',
            },
          });
        const reply = matches[0]?.reply ?? STUB_REPLY_TEXT;
        record.reply = reply;
        if (body?.stream === true) return writeStream(response, model, reply);
        return json(response, 200, {
          ...cannedMessage(model),
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
        });
      }
      if (
        record.method === 'POST' &&
        url.pathname === '/v1/messages/count_tokens'
      )
        return json(response, 200, { input_tokens: 1 });
      return json(response, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'station-weight stub' },
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('stub endpoint did not bind a TCP port');
  return {
    url: `http://${host}:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
