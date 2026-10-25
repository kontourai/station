// A credential-free ACP engine fixture. Station supplies its real session-bound
// MCP transport; replies go through the registered tool and internal HTTP route.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';

const git = promisify(execFile);
const sessions = new Map();
let rpcId = 0;
async function call(server, method, params, session) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(
        server.headers.map(({ name, value }) => [name, value]),
      ),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(session.id ? { 'mcp-session-id': session.id } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!response.ok)
    throw new Error(`Review fixture MCP returned ${response.status}`);
  session.id = response.headers.get('mcp-session-id') ?? session.id;
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  const result = JSON.parse(data ?? text);
  if (result.error)
    throw new Error(`Review fixture MCP error: ${result.error.message}`);
  return result.result;
}

const app = acp
  .agent({ name: 'review-journey' })
  .onRequest('initialize', () => ({
    protocolVersion: 1,
    agentInfo: { name: 'review-journey', version: '1' },
    agentCapabilities: { mcpCapabilities: { http: true } },
    authMethods: [],
  }))
  .onRequest('session/new', ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      cwd: params.cwd,
      server: params.mcpServers.find(
        (server) => server.name === 'station-control',
      ),
      transport: {},
    });
    return { sessionId };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('Review fixture session missing');
    const text = params.prompt
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const key = text.match(/Delivery key for these threads: ("[^"\n]+")/);
    const threads = [...text.matchAll(/^Thread ("[^"\n]+")/gm)];
    if (key) {
      if (!session.server || threads.length === 0)
        throw new Error(
          'Review fixture did not receive its MCP transport or threads',
        );
      if (!session.initialized) {
        await call(
          session.server,
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'review-journey', version: '1' },
          },
          session.transport,
        );
        session.initialized = true;
      }
      const commit = (
        await git('git', ['rev-parse', 'HEAD'], {
          cwd: session.cwd,
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 4096,
        })
      ).stdout.trim();
      for (const thread of threads) {
        const reply = await call(
          session.server,
          'tools/call',
          {
            name: 'task_thread_reply',
            arguments: {
              threadId: JSON.parse(thread[1]),
              deliveryKey: JSON.parse(key[1]),
              body: 'Reviewed the plan change through the session-bound tool.',
              evidence: { commit },
              operationId: randomUUID(),
            },
          },
          session.transport,
        );
        const body = JSON.parse(
          reply.content.find((part) => part.type === 'text').text,
        );
        if (reply.isError || body.success !== true)
          throw new Error(
            `Review fixture reply refused: ${JSON.stringify(body)}`,
          );
      }
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: key ? 'Review reply recorded.' : 'Ready for Task review.',
        },
      },
    });
    return { stopReason: 'end_turn' };
  });
app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);
process.stdin.on('end', () => process.exit(0));
