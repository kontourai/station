import { createServer as createHttpServer, type Server } from 'node:http';

export interface OllamaFixture {
  server: Server;
  origin: string;
  model: string;
}

export function startOllamaFixture(
  model: string,
  onChat: (body: unknown) => void = () => undefined,
  reply = 'Fixture response',
): Promise<OllamaFixture> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (request.method === 'GET' && url.pathname === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: model }] }));
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/v1/chat/completions'
      ) {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = raw ? JSON.parse(raw) : null;
          onChat(body);
          if (
            body &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            (body as { stream?: unknown }).stream !== true
          ) {
            response.writeHead(200, {
              'content-type': 'application/json',
              connection: 'close',
            });
            response.end(
              JSON.stringify({
                id: 'fixture-completion',
                object: 'chat.completion',
                created: 0,
                model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: reply },
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }),
            );
            return;
          }
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'close',
          });
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: 'stop' }] })}\n\n`,
          );
          response.end('data: [DONE]\n\n');
        });
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `Unhandled fixture path ${url}` }));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to start Ollama fixture'));
        return;
      }
      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}`,
        model,
      });
    });
  });
}

export async function closeFixtureServer(server: Server | null) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
