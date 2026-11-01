/**
 * A core generation for the supervised-terminal journey, bundled by
 * `supervisor-terminal.real.test.ts`. It is the production terminal stack
 * (`SupervisorLink`, `createTerminalShellHost`, `TerminalSessions`) behind a
 * tiny loopback API instead of Station's authenticated routes, so the journey
 * exercises the real supervisor and workload host without a whole server.
 *
 * Environment: JOURNEY_HOME, JOURNEY_ROOT, JOURNEY_SHELL, JOURNEY_PORT.
 *
 *   GET  /state                       generation, pid, whether workloads were granted
 *   POST /open                        opens a shell; { terminalId, pid }
 *   POST /write?id=<id>               writes the request body to the shell
 *   GET  /read?id=<id>&from=<seq>     { pid, status, records }
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { SUPERVISOR_ENV } from '@kontourai/station-supervisor/protocol';
import { NodePtyAdapter } from '../../../../adapters/node-pty-adapter.js';
import {
  allowHomeAccess,
  installListenerLink,
  parkUnderSupervisor,
  supervisorWorkloadChannel,
} from '../../../../runtime/bootstrap/supervisor-link.js';
import { createTerminalShellHost } from '../../supervisor-shell-host.js';
import { TerminalSessions } from '../../terminal-sessions.js';

const link = await parkUnderSupervisor();
if (!link) throw new Error('the journey core must run under the supervisor');
installListenerLink(link);
allowHomeAccess();

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const scope = { projectId: 'journey', bindingKey: 'project' };
const channel = supervisorWorkloadChannel();
const sessions = new TerminalSessions<string>(
  env('JOURNEY_HOME'),
  createTerminalShellHost(
    channel,
    new NodePtyAdapter(),
    () => env('JOURNEY_SHELL'),
  ),
  { authorize: () => true, resolveRoot: async () => env('JOURNEY_ROOT') },
);

async function body(req: http.IncomingMessage): Promise<string> {
  let text = '';
  req.setEncoding('utf8');
  for await (const chunk of req) text += chunk;
  return text;
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://journey');
    const id = url.searchParams.get('id') ?? '';
    let result: unknown;
    if (url.pathname === '/state') {
      result = {
        generation: Number(process.env[SUPERVISOR_ENV.generation]),
        pid: process.pid,
        workloads: channel !== null,
      };
    } else if (url.pathname === '/open') {
      const opened = await sessions.open('journey', scope, {
        cols: 80,
        rows: 24,
      });
      result = { terminalId: opened.terminalId, pid: opened.pid };
    } else if (url.pathname === '/write') {
      await sessions.write('journey', scope, id, await body(req));
      result = {};
    } else if (url.pathname === '/read') {
      const read = await sessions.read(
        'journey',
        scope,
        id,
        Number(url.searchParams.get('from') ?? 0),
      );
      result = {
        pid: read.pid,
        status: read.status,
        records: read.journal.records,
      };
    } else {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  })().catch((error: unknown) => {
    res.statusCode = 500;
    res.end(String(error));
  });
});

const { port } = await link.listen('api', server, {
  port: Number(env('JOURNEY_PORT')),
  host: '127.0.0.1',
});
link.onDrain((request) => {
  void (async () => {
    await request.connectionsSettled;
    // Detaches from supervisor workloads; the next generation reattaches.
    await sessions.dispose();
    await link.reportDrained();
    process.exit(0);
  })();
});
link.setShutdownHandler(async () => {
  await sessions.dispose().catch(() => undefined);
  process.exit(1);
});
await link.ready(randomUUID(), port);
