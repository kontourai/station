import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, test } from 'vitest';

const panel = { uri: 'ui://station-sessions/panel' };
const credential = 'synthetic-station-read-credential';

test('stdio tool and panel distinguish an authenticated snapshot from failure', async () => {
  let response;
  const requests = [];
  const api = createServer((request, reply) => {
    requests.push([request.url, request.headers.authorization]);
    if (response) {
      reply.writeHead(response.status, { 'content-type': 'application/json' });
      reply.end(response.body);
    }
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    env: {
      STATION_API_BASE: `http://127.0.0.1:${address.port}`,
      STATION_API_CREDENTIAL: credential,
    },
  });
  const client = new Client({ name: 'sessions-test', version: '1' });
  try {
    await client.connect(transport);
    const read = async () => {
      const tool = await client.callTool({
        name: 'sessions_panel',
        arguments: {},
      });
      const { contents } = await client.readResource(panel);
      expect(contents[0].mimeType).toBe('text/html;profile=mcp-app');
      expect(JSON.stringify([tool, contents])).not.toContain(credential);
      return [tool, contents[0].text];
    };

    response = {
      status: 200,
      body: JSON.stringify({
        success: true,
        data: [{ threadId: '<session>', provider: 'codex', status: 'ready' }],
      }),
    };
    const [listed, nonempty] = await read();
    expect(listed.structuredContent).toEqual({ count: 1 });
    expect(nonempty).toContain('&lt;session&gt;');
    expect(nonempty).not.toContain('<session>');

    response.body = JSON.stringify({ success: true, data: [] });
    const [empty, html] = await read();
    expect(empty.structuredContent).toEqual({ count: 0 });
    expect(html).toContain('No sessions in this snapshot.');

    for (const [reply, message] of [
      [{ status: 401, body: credential }, 'refused this session read'],
      [{ status: 404, body: credential }, 'session list is unavailable'],
      [
        { status: 200, body: JSON.stringify({ success: true, data: [{}] }) },
        'incomplete or invalid',
      ],
      [
        {
          status: 200,
          body: JSON.stringify({ success: true, partial: true, data: [] }),
        },
        'incomplete or invalid',
      ],
      [{ status: 200, body: '<not-json>' }, 'session list is unavailable'],
      [null, 'session read timed out'],
    ]) {
      response = reply;
      const [failure, failedPanel] = await read();
      expect(failure).toMatchObject({ isError: true });
      expect(failure.structuredContent).toBeUndefined();
      expect(failure.content[0].text).toContain(message);
      expect(failedPanel).toContain(message);
      expect(failedPanel).not.toContain('No sessions in this snapshot.');
      expect(failedPanel).not.toContain('(0)');
    }
    expect(requests).toHaveLength(16);
    expect(new Set(requests.map(JSON.stringify))).toEqual(
      new Set([
        JSON.stringify([
          '/api/orchestration/sessions/read-model?limit=200',
          `Bearer ${credential}`,
        ]),
      ]),
    );
  } finally {
    await client.close();
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  }
}, 20_000);
