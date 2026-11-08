#!/usr/bin/env node
/**
 * A free, scripted model for development: an Ollama-compatible HTTP server
 * whose "models" are scripted scenarios. Add it to an isolated dev Station as
 * an Ollama connection and every turn streams through Station's real Ollama
 * adapter, orchestration, persistence, SSE and UI, with no model bill and a
 * deterministic reply.
 *
 * It reuses the existing Ollama engine instead of adding a dev engine, so no
 * production code knows it exists. It listens on loopback only and never
 * calls out. Usage and connection setup: docs/guides/development.md
 * ("Free scripted turns").
 *
 *   node scripts/dev-scripted-model.mjs [--port=4417] [--delay-ms=25]
 */
import { createServer } from 'node:http';
import { invokedDirectly } from './lib/module-entry.mjs';

const SHOWCASE = [
  '## Scripted showcase\n\n',
  'This reply is **scripted**: no model ran and nothing was billed. ',
  'It streams in small pieces so you can watch the transcript grow.\n\n',
  '- A bullet with `inline code`\n',
  '- A bullet with a [link](https://example.com)\n',
  '- A third bullet, for rhythm\n\n',
  '| Column | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n\n',
  '```ts\nexport function greet(name: string): string {\n  return "hello " + name;\n}\n```\n\n',
  '> A closing quote, then the turn completes normally.\n',
].join('');

function longReply() {
  const paragraphs = [];
  for (let index = 1; index <= 60; index += 1) {
    paragraphs.push(
      `### Section ${index}\n\nParagraph ${index} of a long scripted reply, for scrolling, follow-bottom and virtualization checks.\n`,
    );
  }
  return paragraphs.join('\n');
}

/** Split text into word-sized pieces so streaming is visible. */
export function chunkText(text) {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

/**
 * Each scenario is a model name the server lists. `steps(prompt)` returns
 * the streamed parts: `{ text }`, then exactly one terminal part,
 * `{ finish: 'stop' | 'length' }` or `{ error: message }`.
 */
export const SCRIPTED_MODEL_SCENARIOS = Object.freeze({
  'scripted-showcase': {
    description: 'Markdown: heading, list, table, code block, quote.',
    steps: () => [
      ...chunkText(SHOWCASE).map((text) => ({ text })),
      { finish: 'stop' },
    ],
  },
  'scripted-echo': {
    description: 'Repeats the latest user message.',
    steps: (prompt) => [
      ...chunkText(`You said: ${prompt || '(nothing)'}`).map((text) => ({
        text,
      })),
      { finish: 'stop' },
    ],
  },
  'scripted-long': {
    description: 'A long reply for scroll and virtualization checks.',
    steps: () => [
      ...chunkText(longReply()).map((text) => ({ text })),
      { finish: 'stop' },
    ],
  },
  'scripted-truncated': {
    description: 'Stops at the token ceiling (finish reason "length").',
    steps: () => [
      ...chunkText('This reply runs out of room before it can').map((text) => ({
        text,
      })),
      { finish: 'length' },
    ],
  },
  'scripted-error': {
    description: 'Streams a little text, then fails mid-stream.',
    steps: () => [
      ...chunkText('Starting a reply that will fail').map((text) => ({ text })),
      { error: 'Scripted mid-stream failure' },
    ],
  },
});

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('');
    }
  }
  return '';
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

const sleep = (ms) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

async function streamCompletion(response, model, steps, delayMs) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  let closed = false;
  response.on('close', () => {
    closed = true;
  });
  const write = (payload) =>
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  let completionTokens = 0;
  for (const step of steps) {
    if (closed) return;
    if (step.text !== undefined) {
      completionTokens += 1;
      write({
        model,
        choices: [
          { index: 0, delta: { content: step.text }, finish_reason: null },
        ],
      });
      await sleep(delayMs);
      continue;
    }
    if (step.error !== undefined) {
      write({ error: { message: step.error, type: 'scripted_error' } });
      response.end();
      return;
    }
    write({
      model,
      choices: [{ index: 0, delta: {}, finish_reason: step.finish }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: completionTokens,
        total_tokens: completionTokens + 1,
      },
    });
    response.end('data: [DONE]\n\n');
    return;
  }
}

/**
 * Start the server. `port: 0` picks a free port. Resolves with the bound
 * origin and a `close()` that also drops open streams.
 */
export function startScriptedModelServer({
  port = 0,
  host = '127.0.0.1',
  delayMs = 25,
  scenarios = SCRIPTED_MODEL_SCENARIOS,
} = {}) {
  const names = Object.keys(scenarios);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://scripted.invalid');
    if (request.method === 'GET' && url.pathname === '/api/version') {
      sendJson(response, 200, { version: '0.0.0-scripted' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tags') {
      sendJson(response, 200, {
        models: names.map((name) => ({
          name,
          model: name,
          details: { family: 'scripted' },
        })),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: names.map((id) => ({
          id,
          object: 'model',
          owned_by: 'scripted',
        })),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/show') {
      const body = await readJson(request);
      const scenario = scenarios[body?.model ?? body?.name];
      if (!scenario) {
        sendJson(response, 404, { error: 'model not found' });
        return;
      }
      // Completion only: no tools are offered, so a scripted turn never
      // asks Station to run anything.
      sendJson(response, 200, {
        capabilities: ['completion'],
        details: { family: 'scripted' },
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readJson(request);
      const model = typeof body?.model === 'string' ? body.model : '';
      const scenario = scenarios[model];
      if (!scenario) {
        sendJson(response, 404, {
          error: {
            message: `Unknown scripted model "${model}". Known: ${names.join(', ')}`,
          },
        });
        return;
      }
      const steps = scenario.steps(latestUserText(body));
      if (body?.stream === true) {
        await streamCompletion(response, model, steps, delayMs);
        return;
      }
      const failure = steps.find((step) => step.error !== undefined);
      if (failure) {
        sendJson(response, 500, { error: { message: failure.error } });
        return;
      }
      const finish =
        steps.find((step) => step.finish !== undefined)?.finish ?? 'stop';
      sendJson(response, 200, {
        id: 'scripted-completion',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: steps.map((step) => step.text ?? '').join(''),
            },
            finish_reason: finish,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return;
    }
    sendJson(response, 404, {
      error: `Unhandled scripted model path ${url.pathname}`,
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Scripted model server did not bind a TCP port'));
        return;
      }
      resolve({
        server,
        origin: `http://${host}:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.closeAllConnections?.();
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function parseArgs(argv) {
  const options = { port: 4417, delayMs: 25 };
  for (const arg of argv) {
    const [key, value] = arg.split('=');
    if (key === '--port') options.port = Number(value);
    else if (key === '--delay-ms') options.delayMs = Number(value);
    else if (key === '--help' || key === '-h') options.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  for (const [name, value] of [
    ['--port', options.port],
    ['--delay-ms', options.delayMs],
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
  if (options.port === 3141 || options.port === 3000) {
    throw new Error(
      `Port ${options.port} belongs to the operator; choose another`,
    );
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: node scripts/dev-scripted-model.mjs [--port=4417] [--delay-ms=25]',
    );
    return;
  }
  const { origin, close } = await startScriptedModelServer(options);
  console.log(`Scripted model server: ${origin}`);
  console.log(
    'Add it to an isolated dev Station as an Ollama connection with this base URL.',
  );
  console.log('Models (pick one in the composer):');
  for (const [name, scenario] of Object.entries(SCRIPTED_MODEL_SCENARIOS)) {
    console.log(`  ${name.padEnd(20)} ${scenario.description}`);
  }
  const stop = () => {
    void close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (invokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
