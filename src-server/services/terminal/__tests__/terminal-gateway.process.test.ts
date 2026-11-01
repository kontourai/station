import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_INPUT,
  TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  TERMINAL_SOCKET_PROTOCOL,
  TERMINAL_TICKET_PROTOCOL_PREFIX,
  terminalScopeAllows,
} from '@kontourai/station-contracts/terminal-transport';
import { TerminalOutputSession } from '@kontourai/station-sdk/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NodePtyAdapter } from '../../../adapters/node-pty-adapter.js';
import { InProcessShellHost } from '../shell-host.js';
import { TerminalGateway } from '../terminal-gateway.js';
import { TerminalSessions } from '../terminal-sessions.js';
import { TerminalTickets } from '../terminal-tickets.js';

/** The ticket mint as the runtime serves it: bearer in, single-use ticket out. */
function mintTickets(
  tickets: TerminalTickets<string>,
  admit: (credential: string | undefined) => 200 | 401 | 403,
) {
  return (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => {
    const credential = req.headers.authorization?.replace(/^Bearer /, '');
    const status = admit(credential);
    if (status !== 200 || !credential) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: tickets.mint(credential, credential),
      }),
    );
  };
}

const temp = trackTempDirs();
const scope = { projectId: 'alpha', bindingKey: 'project' };
const dimensions = { cols: 80, rows: 24 };
const controlSchema = z.object({
  type: z.string(),
  channel: z.number().optional(),
  requestId: z.string().optional(),
  code: z.string().optional(),
  discarded: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  terminalId: z.string().optional(),
  seq: z.number().optional(),
  sentThrough: z.number().optional(),
  replayThrough: z.number().optional(),
  lastSeq: z.number().optional(),
  maxOutstandingOutputFrames: z.number().optional(),
});
type Control = z.infer<typeof controlSchema>;
type Output = { channel: number; seq: number; data: string };
class Client {
  controls: Control[] = [];
  output: Output[] = [];
  private requestNumber = 0;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw, binary) => {
      if (binary) {
        const frame = decodeTerminalFrame(
          Array.isArray(raw)
            ? Buffer.concat(raw)
            : raw instanceof ArrayBuffer
              ? new Uint8Array(raw)
              : raw,
        );
        this.output.push({
          channel: frame.channel,
          seq: frame.seq,
          data: new TextDecoder().decode(frame.data),
        });
      } else
        this.controls.push(controlSchema.parse(JSON.parse(raw.toString())));
    });
  }
  send(value: object) {
    this.ws.send(JSON.stringify(value));
  }
  input(channel: number, seq: number, data: string) {
    this.ws.send(
      encodeTerminalFrame(
        TERMINAL_INPUT,
        channel,
        seq,
        new TextEncoder().encode(data),
      ),
    );
  }
  async wait(predicate: (frame: Control) => boolean) {
    await expect
      .poll(() => this.controls.find(predicate), { timeout: 10_000 })
      .toBeDefined();
    return this.controls.find(predicate)!;
  }
  async result(requestId: string) {
    return this.wait((frame) => frame.requestId === requestId);
  }
  ack(channel: number, seq: number) {
    this.send({ type: 'ack', channel, seq });
  }
  async attach(
    terminalId: string,
    channel = 1,
    fromSeq = 0,
    target = scope,
    windowBytes = 65536,
  ) {
    const requestId = `attach-${++this.requestNumber}`;
    this.send({
      type: 'attach',
      requestId,
      channel,
      ...target,
      terminalId,
      fromSeq,
      windowBytes,
    });
    return this.result(requestId);
  }
  async ready(channel = 1) {
    const progress = await this.wait(
      (frame) =>
        frame.type === 'progress' &&
        frame.channel === channel &&
        frame.sentThrough !== undefined &&
        frame.replayThrough !== undefined &&
        frame.sentThrough >= frame.replayThrough,
    );
    this.ack(channel, progress.sentThrough!);
    await this.wait(
      (frame) => frame.type === 'ready' && frame.channel === channel,
    );
  }
}

// Real POSIX PTYs and a real HTTP/WebSocket listener, all owned by this fixture.
describe.skipIf(process.platform === 'win32')(
  'same-origin terminal gateway with real sockets',
  () => {
    let server: Server;
    let root: string;
    let gateway: TerminalGateway<string>;
    let sessions: TerminalSessions<string>;
    let tickets: TerminalTickets<string>;
    let url: string;
    const clients: Client[] = [];
    const outputReaders: TerminalOutputSession[] = [];
    const grants = new Map<string, string>();

    beforeEach(async () => {
      const home = temp('terminal-gateway-3994-');
      root = join(home, 'project');
      await mkdir(root);
      grants.clear();
      grants.set('operator', 'terminal:operate');
      grants.set('writer', 'terminal:operate');
      grants.set('observer', 'terminal:observe');
      sessions = new TerminalSessions(
        home,
        new InProcessShellHost(new NodePtyAdapter(), () => '/bin/sh'),
        {
          authorize: (principal, target, operation) =>
            ['alpha', 'beta'].includes(target.projectId) &&
            ['project', 'thread:one'].includes(target.bindingKey) &&
            terminalScopeAllows(grants.get(principal) ?? '', operation),
          resolveRoot: async () => root,
        },
      );
      tickets = new TerminalTickets<string>();
      const mint = mintTickets(tickets, (credential) =>
        credential === 'revoked'
          ? 401
          : credential && grants.has(credential)
            ? 200
            : 403,
      );
      server = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/terminal/tickets')
          mint(req, res);
        else if (req.url === '/api/terminal/socket') {
          const credential = req.headers.authorization?.replace(/^Bearer /, '');
          res.writeHead(
            credential === 'revoked'
              ? 401
              : credential && grants.has(credential)
                ? 204
                : 403,
          );
          res.end();
        } else res.end('ordinary HTTP on the same listener');
      });
      gateway = new TerminalGateway({
        sessions,
        tickets,
        reserved: (principal) => principal === 'operator',
      });
      gateway.mount(server, { upgraded: () => undefined });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing owned port');
      url = `ws://127.0.0.1:${address.port}/api/terminal/socket`;
    });
    afterEach(async () => {
      for (const reader of outputReaders.splice(0)) reader.dispose();
      for (const client of clients.splice(0)) client.ws.terminate();
      gateway.stop();
      vi.restoreAllMocks();
      await sessions.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    async function connect(principal = 'operator') {
      const client = new Client(
        new WebSocket(url, [
          TERMINAL_SOCKET_PROTOCOL,
          `${TERMINAL_TICKET_PROTOCOL_PREFIX}${tickets.mint(principal, principal)!.ticket}`,
        ]),
      );
      clients.push(client);
      await once(client.ws, 'open');
      await client.wait((frame) => frame.type === 'authenticated');
      return client;
    }
    async function open() {
      return sessions.open('operator', scope, dimensions);
    }

    test('the public SDK authenticates a loopback output session against the real gateway', async () => {
      const record = await open();
      const apiBase = url
        .replace(/^ws:/, 'http:')
        .replace('/api/terminal/socket', '');
      const output: string[] = [];
      const reader = new TerminalOutputSession({
        apiBase,
        ...scope,
        terminalId: record.terminalId,
        resolveCredential: () => ({ origin: apiBase, credential: 'observer' }),
        onOutput: (bytes) => {
          output.push(new TextDecoder().decode(bytes));
        },
        onReset: () => {
          output.length = 0;
        },
      });
      outputReaders.push(reader);
      await reader.connect();
      await sessions.write(
        'operator',
        scope,
        record.terminalId,
        "printf 'sdk-replayed\\n'\r",
      );
      await expect.poll(() => output.join('')).toContain('sdk-replayed');
      expect(reader.appliedThrough).toBeGreaterThan(0);
      const after = await sessions.read('operator', scope, record.terminalId);
      expect(after.terminalId).toBe(record.terminalId);
      expect(after.status).toBe('running');
    });

    test('the public SDK reports refused loopback credentials without receiving terminal output', async () => {
      const record = await open();
      const apiBase = url
        .replace(/^ws:/, 'http:')
        .replace('/api/terminal/socket', '');
      const output = vi.fn();
      const reader = new TerminalOutputSession({
        apiBase,
        ...scope,
        terminalId: record.terminalId,
        resolveCredential: () => ({
          origin: apiBase,
          credential: 'not-a-grant',
        }),
        onOutput: output,
        onReset: () => undefined,
      });
      outputReaders.push(reader);
      await expect(reader.connect()).rejects.toMatchObject({
        code: 'terminal-refused',
      });
      expect(output).not.toHaveBeenCalled();
    });

    test('bounded frame credit carries small and sanitized-empty journal records through the real gateway', async () => {
      const record = await open();
      await sessions.write(
        'operator',
        scope,
        record.terminalId,
        "stty -echo; printf 'start-marker\\n'\r",
      );
      await journal(record.terminalId, 'start-marker');
      const start = (await sessions.read('operator', scope, record.terminalId))
        .journal.lastSeq;
      await sessions.write(
        'operator',
        scope,
        record.terminalId,
        "i=0; while [ $i -lt 160 ]; do printf x; sleep 0.01; i=$((i+1)); done; printf '\\033]8;;file:///tmp/private\\007'; sleep 0.05; printf 'end-marker\\n'\r",
      );
      await journal(record.terminalId, 'end-marker');
      const end = (await sessions.read('operator', scope, record.terminalId))
        .journal.lastSeq;
      expect(end - start).toBeGreaterThan(140);

      const client = await connect();
      const attached = await client.attach(record.terminalId, 1, start);
      expect(attached.maxOutstandingOutputFrames).toBe(
        TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
      );
      await expect
        .poll(() => client.output.length)
        .toBe(TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES);
      const progressCount = client.controls.filter(
        (item) => item.type === 'progress',
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(client.output).toHaveLength(
        TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
      );
      expect(
        client.controls.filter((item) => item.type === 'progress'),
      ).toHaveLength(progressCount);
      client.ack(1, client.output.at(-1)!.seq);
      await expect.poll(() => client.output.at(-1)?.seq).toBe(end);
      expect(client.output.some((item) => item.data === '')).toBe(true);
      client.ack(1, end);
      await client.wait((item) => item.type === 'ready' && item.seq === end);

      const apiBase = url
        .replace(/^ws:/, 'http:')
        .replace('/api/terminal/socket', '');
      let release!: () => void;
      let started!: () => void;
      const rendering = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rendered: number[] = [];
      const reader = new TerminalOutputSession({
        apiBase,
        ...scope,
        terminalId: record.terminalId,
        fromSeq: start,
        resolveCredential: () => ({ origin: apiBase, credential: 'operator' }),
        onOutput: async (_bytes, seq) => {
          started();
          await blocked;
          rendered.push(seq);
        },
        onReset: () => undefined,
      });
      outputReaders.push(reader);
      const connected = reader.connect();
      await rendering;
      expect(reader.appliedThrough).toBe(start);
      release();
      await connected;
      expect(reader.appliedThrough).toBe(end);
      expect(rendered.length).toBeGreaterThan(140);
    });

    test('SDK reports a grant revoked between its ticket and its attach', async () => {
      const record = await open();
      grants.set('probe-only', 'terminal:operate');
      const apiBase = url
        .replace(/^ws:/, 'http:')
        .replace('/api/terminal/socket', '');
      const reader = new TerminalOutputSession({
        apiBase,
        ...scope,
        terminalId: record.terminalId,
        resolveCredential: () => ({
          origin: apiBase,
          credential: 'probe-only',
        }),
        createSocket: (target, protocols) => {
          grants.delete('probe-only');
          return new WebSocket(
            target,
            protocols,
          ) as unknown as import('@kontourai/station-sdk/client').TerminalOutputSocket;
        },
        onOutput: () => undefined,
        onReset: () => undefined,
      });
      outputReaders.push(reader);
      await expect(reader.connect()).rejects.toMatchObject({
        code: 'terminal-refused',
      });
    });
    test('a real HTTP probe 401 notifies its captured credential owner', async () => {
      const record = await open();
      const apiBase = url
        .replace(/^ws:/, 'http:')
        .replace('/api/terminal/socket', '');
      const onUnauthorized = vi.fn();
      const reader = new TerminalOutputSession({
        apiBase,
        ...scope,
        terminalId: record.terminalId,
        resolveCredential: () => ({
          origin: apiBase,
          credential: 'revoked',
          onUnauthorized,
        }),
        onOutput: () => undefined,
        onReset: () => undefined,
      });
      outputReaders.push(reader);
      await expect(reader.connect()).rejects.toMatchObject({
        code: 'terminal-refused',
      });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    test('SDK survives a retention reset after its last outstanding frame is acknowledged', async () => {
      const home = temp('terminal-reset-gateway-');
      const isolatedRoot = join(home, 'project');
      await mkdir(isolatedRoot);
      const isolated = new TerminalSessions(
        home,
        new InProcessShellHost(new NodePtyAdapter(), () => '/bin/sh'),
        { authorize: () => true, resolveRoot: async () => isolatedRoot },
        {
          persist: false,
          maxBytes: 4096,
          maxLines: 10000,
          tailBytes: 1024,
          tailLines: 10000,
          segmentBytes: 1024,
        },
      );
      const isolatedTickets = new TerminalTickets<string>();
      const listener = createServer(mintTickets(isolatedTickets, () => 200));
      const transport = new TerminalGateway({
        sessions: isolated,
        tickets: isolatedTickets,
        reserved: () => true,
      });
      transport.mount(listener, { upgraded: () => undefined });
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const address = listener.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing owned port');
      const apiBase = `http://127.0.0.1:${address.port}`;
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rendering = new Promise<void>((resolve) => {
        started = resolve;
      });
      const errors: string[] = [];
      let hold = false;
      let resets = 0;
      let output = '';
      let reader: TerminalOutputSession | undefined;
      try {
        const opened = await isolated.open('operator', scope, dimensions);
        reader = new TerminalOutputSession({
          apiBase,
          ...scope,
          terminalId: opened.terminalId,
          resolveCredential: () => ({
            origin: apiBase,
            credential: 'operator',
          }),
          onOutput: async (bytes) => {
            if (hold) {
              hold = false;
              started();
              await blocked;
            }
            output += new TextDecoder().decode(bytes);
          },
          onReset: () => {
            resets++;
            output = '';
          },
          onError: (error) => errors.push(error.code),
        });
        await reader.connect();
        hold = true;
        await isolated.write(
          'operator',
          scope,
          opened.terminalId,
          "printf 'first-frame\\n'\r",
        );
        await rendering;
        await isolated.write(
          'operator',
          scope,
          opened.terminalId,
          "printf '%0200000d' 0; printf 'reset-marker\\n'\r",
        );
        await expect
          .poll(async () => {
            const snapshot = await isolated.read(
              'operator',
              scope,
              opened.terminalId,
              0,
            );
            return (
              snapshot.journal.reset &&
              snapshot.journal.records
                .map((item) => item.data)
                .join('')
                .includes('reset-marker')
            );
          })
          .toBe(true);
        release();
        await expect.poll(() => resets).toBeGreaterThan(0);
        await expect.poll(() => output).toContain('reset-marker');
        expect(errors).toEqual([]);
      } finally {
        release();
        reader?.dispose();
        transport.stop();
        await isolated.dispose();
        await new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
    async function journal(id: string, text: string) {
      await expect
        .poll(
          async () =>
            (await sessions.read('operator', scope, id)).journal.records
              .map((r) => r.data)
              .join(''),
          { timeout: 10_000 },
        )
        .toContain(text);
      return sessions.read('operator', scope, id);
    }
    async function write(
      client: Client,
      channel: number,
      seq: number,
      command: string,
    ) {
      const start = client.controls.length;
      client.input(channel, seq, command);
      const result = await client.wait(
        (frame) =>
          client.controls.indexOf(frame) >= start &&
          frame.channel === channel &&
          (frame.type === 'input-ack' || frame.type === 'error'),
      );
      return result;
    }

    test('quiet shell revocation is published without client input or PTY output', async () => {
      const opened = await open();
      await sessions.write(
        'operator',
        scope,
        opened.terminalId,
        "stty -echo; printf '%s%s' 'quiet:' 'ready'; read pending\r",
      );
      await journal(opened.terminalId, 'quiet:ready');
      const observer = await connect('observer');
      await observer.attach(opened.terminalId);
      await observer.ready();
      grants.delete('observer');
      const error = await observer.wait(
        (frame) => frame.type === 'error' && frame.channel === 1,
      );
      expect(error.code).toBe('terminal-refused');
    });

    test('aggregate channel credit fits the socket output backlog guard', async () => {
      const client = await connect();
      const opened = await open();
      await writeFile(join(root, 'credit.txt'), 'x'.repeat(64 * 1024));
      await sessions.write(
        'operator',
        scope,
        opened.terminalId,
        "cat credit.txt; printf '%s%s' 'credit:' 'done'\r",
      );
      await journal(opened.terminalId, 'credit:done');
      // Model the aggregate payload already queued by the other 31 channels.
      const backlog = vi
        .spyOn(WebSocket.prototype, 'bufferedAmount', 'get')
        .mockReturnValue(32 * 65536 + 1);
      const reads = vi.spyOn(sessions, 'read');
      expect((await client.attach(opened.terminalId)).type).toBe('attached');
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      await expect
        .poll(() => reads.mock.calls.findIndex((args) => args[4] === 65536))
        .toBeGreaterThanOrEqual(0);
      await reads.mock.results[
        reads.mock.calls.findIndex((args) => args[4] === 65536)
      ]!.value;
      // The list reply follows the completed pump attempt on the ordered wire.
      client.send({ type: 'list', requestId: 'pressure-barrier', ...scope });
      await client.result('pressure-barrier');
      expect(client.output).toHaveLength(0);
      backlog.mockRestore();
      await client.wait(
        (frame) =>
          frame.type === 'progress' &&
          frame.channel === 1 &&
          (frame.sentThrough ?? 0) > 0,
      );
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      expect(client.output.length).toBeGreaterThan(0);
    });

    test('shares HTTP listener and refuses an upgrade without a ticket even on loopback', async () => {
      const response = await fetch(url.replace('ws:', 'http:'));
      expect(response.status).toBe(403);
      const ordinary = await fetch(new URL('/', url.replace('ws:', 'http:')));
      expect(await ordinary.text()).toBe('ordinary HTTP on the same listener');
      // A forged credential frame is no longer an admission path at all.
      const ws = new WebSocket(url, [TERMINAL_SOCKET_PROTOCOL]);
      clients.push(new Client(ws));
      ws.on('error', () => undefined);
      const [, refused] = (await once(ws, 'unexpected-response')) as [
        unknown,
        { statusCode: number; resume(): void },
      ];
      refused.resume();
      expect(refused.statusCode).toBe(401);
    });

    test.each([
      [
        'an origin without a ticket',
        '/api/terminal/socket',
        'http://foreign.test',
        401,
      ],
      [
        'query credential',
        '/api/terminal/socket?token=operator',
        'http://station.test',
        404,
      ],
      [
        'unknown path',
        '/api/terminal/socket/extra',
        'http://station.test',
        404,
      ],
    ])('refuses %s before upgrade', async (_name, path, origin, status) => {
      const target = new URL(url);
      const ws = new WebSocket(`${target.origin}${path}`, { origin });
      clients.push(new Client(ws));
      const response = new Promise<number>((resolve, reject) => {
        ws.once('unexpected-response', (_req, res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        ws.once('open', () => reject(new Error('Unexpected upgrade')));
        ws.once('error', reject);
      });
      expect(await response).toBe(status);
    });

    test('opens and closes a scoped session through socket lifecycle commands', async () => {
      const client = await connect();
      client.send({
        type: 'open',
        requestId: 'socket-open',
        channel: 1,
        ...scope,
        ...dimensions,
      });
      const attached = await client.result('socket-open');
      expect(attached.type).toBe('attached');
      expect(attached.terminalId).toMatch(/^[0-9a-f-]{36}$/);
      await client.ready();
      expect(
        (
          await write(
            client,
            1,
            1,
            "printf '%s%s\\n' 'socket-open:' 'marker'\r",
          )
        ).type,
      ).toBe('input-ack');
      await journal(attached.terminalId!, 'socket-open:marker');
      client.send({ type: 'close', requestId: 'socket-close', channel: 1 });
      expect((await client.result('socket-close')).type).toBe('done');
      expect(
        (await sessions.read('operator', scope, attached.terminalId!)).status,
      ).toBe('exited');
    });

    test('resumes after a drop without a sequence gap while the same PTY continues', async () => {
      const record = await open();
      const client = await connect();
      expect((await client.attach(record.terminalId)).type).toBe('attached');
      await client.ready();
      expect(
        (await write(client, 1, 1, "printf '%s%s\\n' 'first:' 'marker'\r"))
          .type,
      ).toBe('input-ack');
      const before = await journal(record.terminalId, 'first:marker');
      await client.wait(
        (frame) =>
          frame.type === 'progress' &&
          frame.sentThrough === before.journal.lastSeq,
      );
      const fromSeq = before.journal.lastSeq;
      client.ack(1, fromSeq);
      client.ws.terminate();
      await sessions.write(
        'operator',
        scope,
        record.terminalId,
        "printf '%s%s\\n' 'offline:' 'marker'\r",
      );
      await journal(record.terminalId, 'offline:marker');
      const resumed = await connect();
      await resumed.attach(record.terminalId, 1, fromSeq);
      await resumed.ready();
      expect(
        (await write(resumed, 1, 1, "printf '%s%s\\n' 'after:' 'marker'\r"))
          .type,
      ).toBe('input-ack');
      const after = await journal(record.terminalId, 'after:marker');
      await resumed.wait(
        (frame) =>
          frame.type === 'progress' &&
          frame.sentThrough === after.journal.lastSeq,
      );
      expect(after.pid).toBe(record.pid);
      expect(resumed.output.map((r) => r.seq)).toEqual(
        after.journal.records.filter((r) => r.seq > fromSeq).map((r) => r.seq),
      );
      expect(resumed.output.map((r) => r.data).join('')).toContain(
        'offline:marker',
      );
    });

    test('credit backpressure bounds a flooding channel without starving another channel', async () => {
      const flood = await open();
      const quiet = await open();
      const client = await connect();
      await client.attach(flood.terminalId, 1, 0, scope, 16384);
      await client.ready(1);
      await client.attach(quiet.terminalId, 2);
      await client.ready(2);
      const acknowledged = Math.max(
        0,
        ...client.output.filter((r) => r.channel === 1).map((r) => r.seq),
      );
      await write(
        client,
        1,
        1,
        "printf '%040000d\\n' 0; printf '%s%s\\n' 'flood:' 'done'\r",
      );
      const snapshot = await journal(flood.terminalId, 'flood:done');
      const blocked = await client.wait(
        (frame) =>
          frame.type === 'progress' &&
          frame.channel === 1 &&
          (frame.sentThrough ?? 0) > acknowledged,
      );
      expect(blocked.sentThrough).toBeLessThan(snapshot.journal.lastSeq);
      const pending = client.output.filter(
        (r) => r.channel === 1 && r.seq > acknowledged,
      );
      expect(
        pending.reduce((sum, r) => sum + Buffer.byteLength(r.data), 0),
      ).toBeLessThanOrEqual(16384);
      expect(
        (await write(client, 2, 1, "printf '%s%s\\n' 'quiet:' 'done'\r")).type,
      ).toBe('input-ack');
      const quietSnapshot = await journal(quiet.terminalId, 'quiet:done');
      await client.wait(
        (frame) =>
          frame.type === 'progress' &&
          frame.channel === 2 &&
          frame.sentThrough === quietSnapshot.journal.lastSeq,
      );
      expect(
        client.output
          .filter((r) => r.channel === 2)
          .map((r) => r.data)
          .join(''),
      ).toContain('quiet:done');
      client.ack(1, blocked.sentThrough!);
      await client.wait(
        (frame) =>
          frame.type === 'progress' &&
          frame.channel === 1 &&
          frame.sentThrough! > blocked.sentThrough!,
      );
    });

    test('transport replay and live output admit only http and https hyperlink schemes', async () => {
      const record = await open();
      const safe = `https://example.test/${'a'.repeat(3000)}`;
      const controls =
        'x'.repeat(2047) +
        `\x1b]8;;javascript:alert(1)\x07bad-js\x1b]8;;\x07` +
        `\x1b]8;;file:///terminal-private\x1b\\bad-file\x1b]8;;\x1b\\` +
        `\x1b]8;;${safe}\x07good-https\x1b]8;;\x07` +
        `\x9d8;;http://example.test/\x9cgood-http\x9d8;;\x9c`;
      await writeFile(join(root, 'link-controls.txt'), controls);
      await sessions.write(
        'operator',
        scope,
        record.terminalId,
        "cat link-controls.txt; printf '%s%s\\n' 'links:' 'replay'\r",
      );
      const stored = await journal(record.terminalId, 'links:replay');
      expect(stored.journal.records.map((row) => row.data).join('')).toContain(
        'javascript:alert(1)',
      );
      const client = await connect();
      await client.attach(record.terminalId);
      await client.ready();
      const assertLinks = () => {
        const text = client.output.map((row) => row.data).join('');
        expect(text).not.toContain('javascript:');
        expect(text).not.toContain('file:///');
        expect(text).toContain(safe);
        expect(text).toContain('http://example.test/');
        expect(text).toContain('bad-js');
        expect(text).toContain('bad-file');
      };
      assertLinks();
      expect(
        (
          await write(
            client,
            1,
            1,
            "cat link-controls.txt; printf '%s%s\\n' 'links:' 'live'\r",
          )
        ).type,
      ).toBe('input-ack');
      const live = await journal(record.terminalId, 'links:live');
      await client.wait(
        (frame) =>
          frame.type === 'progress' &&
          frame.sentThrough === live.journal.lastSeq,
      );
      assertLinks();
    });

    test('observer mouse and focus reports are discarded without typing or losing input order', async () => {
      const record = await open();
      const observer = await connect('observer');
      await observer.attach(record.terminalId);
      const replayReport = await write(observer, 1, 1, '\x1b[I');
      expect(replayReport.type).toBe('input-ack');
      expect(replayReport.discarded).toBe(true);
      await observer.ready();
      const report = await write(observer, 1, 2, '\x1b[I\x1b[<0;12;24M\x1b[O');
      expect(report.type).toBe('input-ack');
      expect(report.discarded).toBe(true);
      expect(
        (await write(observer, 1, 3, 'ordinary observer input\r')).code,
      ).toBe('terminal-refused');
      expect(
        (await sessions.read('operator', scope, record.terminalId)).status,
      ).toBe('running');
    });

    test('an observer can replay but input, resize, close and open are refused', async () => {
      const record = await open();
      const observer = await connect('observer');
      await observer.attach(record.terminalId);
      await observer.ready();
      expect(
        (await write(observer, 1, 1, "printf 'observer-wrote\\n'\r")).code,
      ).toBe('terminal-refused');
      for (const type of ['resize', 'close'] as const) {
        observer.send({
          type,
          requestId: type,
          channel: 1,
          ...(type === 'resize' && dimensions),
        });
        expect((await observer.result(type)).code).toBe('terminal-refused');
      }
      observer.send({
        type: 'open',
        requestId: 'open',
        channel: 2,
        ...scope,
        ...dimensions,
      });
      expect((await observer.result('open')).code).toBe('terminal-refused');
      expect(
        (await sessions.read('operator', scope, record.terminalId)).status,
      ).toBe('running');
    });

    test.each([
      ['cross-project', { projectId: 'beta', bindingKey: 'project' }],
      ['cross-binding', { projectId: 'alpha', bindingKey: 'thread:one' }],
    ])(
      '%s attach is refused even for a caller allowed in both scopes',
      async (_name, target) => {
        const record = await open();
        const client = await connect();
        const result = await client.attach(record.terminalId, 1, 0, target);
        expect(result.type).toBe('error');
        expect(result.code).toBe('terminal-refused');
        expect(client.output).toEqual([]);
      },
    );

    test('a forged session UUID is refused without disclosing another journal', async () => {
      await open();
      const client = await connect();
      const result = await client.attach(
        '00000000-0000-4000-8000-000000000000',
      );
      expect(result.type).toBe('error');
      expect(result.code).toBe('terminal-refused');
      expect(client.output).toEqual([]);
    });

    test('replay input, duplicate input and channel reuse cannot type into a PTY', async () => {
      const record = await open();
      const client = await connect();
      await client.attach(record.terminalId);
      expect((await write(client, 1, 1, 'unsafe replay\r')).code).toBe(
        'terminal-refused',
      );
      await client.ready();
      expect(
        (await write(client, 1, 1, "printf '%s%s\\n' 'input:' 'once'\r")).type,
      ).toBe('input-ack');
      expect((await write(client, 1, 1, 'duplicate\r')).code).toBe(
        'terminal-refused',
      );
      client.send({ type: 'detach', requestId: 'detach', channel: 1 });
      expect((await client.result('detach')).type).toBe('done');
      expect((await client.attach(record.terminalId)).code).toBe(
        'terminal-refused',
      );
    });

    test('a resize storm converges to the latest size before the following input', async () => {
      const record = await open();
      const client = await connect();
      await client.attach(record.terminalId);
      await client.ready();
      for (let cols = 81; cols <= 180; cols++)
        client.send({
          type: 'resize',
          requestId: `resize-${cols}`,
          channel: 1,
          cols,
          rows: 40,
        });
      expect(
        (
          await write(
            client,
            1,
            1,
            "stty size; printf '%s%s\\n' 'resize:' 'done'\r",
          )
        ).type,
      ).toBe('input-ack');
      const snapshot = await journal(record.terminalId, 'resize:done');
      expect(snapshot.cols).toBe(180);
      expect(snapshot.rows).toBe(40);
      expect(snapshot.journal.records.map((r) => r.data).join('')).toContain(
        '40 180',
      );
      expect((await client.result('resize-180')).type).toBe('done');
      expect(
        client.controls.filter((r) => r.type === 'superseded').length,
      ).toBeGreaterThan(0);
    });

    test('revocation refuses the next input and stops output on the channel', async () => {
      const record = await open();
      const client = await connect();
      await client.attach(record.terminalId);
      await client.ready();
      grants.delete('operator');
      expect((await write(client, 1, 1, 'revoked\r')).code).toBe(
        'terminal-refused',
      );
      const afterInput = client.controls.length;
      await sessions.write(
        'writer',
        scope,
        record.terminalId,
        "printf '%s%s\\n' 'revoked-output:' 'marker'\r",
      );
      await client.wait(
        (frame) =>
          client.controls.indexOf(frame) >= afterInput &&
          frame.type === 'error' &&
          frame.code === 'terminal-refused',
      );
      expect(client.output.map((frame) => frame.data).join('')).not.toContain(
        'revoked-output:marker',
      );
    });
  },
);
