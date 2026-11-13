/**
 * Test fixtures for managed installs: a minimal ustar writer (so an archive
 * can carry exactly the hostile entry a test needs, which a system `tar`
 * refuses to create) and a local HTTP server that serves a manifest and its
 * artifacts with injectable faults. The installer under test keeps its
 * https-only rule; the test's `fetch` maps `https://kas.test` onto the local
 * server, so every byte still crosses a real socket.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'fifo';
  body?: string | Buffer;
  mode?: number;
  linkTarget?: string;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512, 0);
  if (Buffer.byteLength(entry.name) > 100)
    throw new Error(`fixture name too long: ${entry.name}`);
  block.write(entry.name, 0, 100, 'utf8');
  const type = entry.type ?? 'file';
  const mode = entry.mode ?? (type === 'dir' ? 0o755 : 0o644);
  block.write(octal(mode, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(1_700_000_000, 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  const flag =
    type === 'dir'
      ? '5'
      : type === 'symlink'
        ? '2'
        : type === 'hardlink'
          ? '1'
          : type === 'fifo'
            ? '6'
            : '0';
  block.write(flag, 156, 1, 'ascii');
  if (entry.linkTarget) block.write(entry.linkTarget, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** A gzip-compressed ustar archive of `entries`, in order. */
export function tarGz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body =
      entry.type === undefined || entry.type === 'file'
        ? Buffer.from(entry.body ?? '')
        : Buffer.alloc(0);
    parts.push(header(entry, body.length));
    if (body.length > 0) {
      parts.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad > 0) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export type ServeFault = 'truncate' | 'not-found';

export interface FixtureServer {
  readonly origin: string;
  /** Paths requested, in order. */
  readonly requests: string[];
  put(path: string, body: Buffer | string, fault?: ServeFault): void;
  /** A `fetch` that sends `https://kas.test/...` to this server. */
  fetch: typeof fetch;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const files = new Map<string, { body: Buffer; fault?: ServeFault }>();
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    requests.push(path);
    const file = files.get(path);
    if (!file || file.fault === 'not-found') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(file.body.length),
    });
    if (file.fault === 'truncate') {
      res.write(file.body.subarray(0, Math.floor(file.body.length / 2)), () =>
        res.socket?.destroy(),
      );
      return;
    }
    res.end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    put(path, body, fault) {
      files.set(path, {
        body: Buffer.isBuffer(body) ? body : Buffer.from(body),
        ...(fault ? { fault } : {}),
      });
    },
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://kas.test/'))
        throw new Error(`fixture fetch refuses ${url}`);
      return globalThis.fetch(
        `${origin}/${url.slice('https://kas.test/'.length)}`,
        init,
      );
    }) as typeof fetch,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
