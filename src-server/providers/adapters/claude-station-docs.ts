import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Writable } from 'node:stream';
import type { ProviderSessionStartInput } from '@kontourai/station-contracts/provider';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  builtinStationDocsServerPath,
  BUILTIN_STATION_DOCS_TOOL_SERVER_ID as DOCS_ID,
} from '../../runtime/bootstrap/station-control-runtime-env.js';
import { isCanonicalStationDocsDelivery } from '../../tools/station-docs-binding.js';
import { createStationDocsToolServer } from '../../tools/station-docs-tools.js';
import { raceWithSignal } from '../../utils/bounded-async.js';

declare const __STATION_DOCS_EXECUTABLE__:
  | { sha256: string; size: number }
  | undefined;

const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 60_000;
const IDLE_MS = 30_000;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const bootstrap = `
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = readFileSync(3);
if (createHash('sha256').update(source).digest('hex') !== process.argv[1])
  throw new Error('Station Docs executable digest mismatch.');
await import('data:text/javascript;base64,' + source.toString('base64'));
`
  .trim()
  .replaceAll('\n', ' ');

interface Snapshot {
  bytes: Buffer;
  sha256: string;
}

let snapshot: Promise<Snapshot | undefined> | undefined;

async function readSnapshot(): Promise<Snapshot | undefined> {
  if (
    process.platform !== 'darwin' ||
    typeof __STATION_DOCS_EXECUTABLE__ === 'undefined'
  )
    return undefined;
  const { size, sha256 } = __STATION_DOCS_EXECUTABLE__;
  if (size <= 0 || size > MAX_ENTRY_BYTES) return undefined;
  try {
    const file = await open(
      builtinStationDocsServerPath(),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== size) return undefined;
      const bytes = Buffer.alloc(size);
      for (let offset = 0; offset < size; ) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          size - offset,
          offset,
        );
        if (!bytesRead) return undefined;
        offset += bytesRead;
      }
      if (createHash('sha256').update(bytes).digest('hex') === sha256)
        return { bytes, sha256 };
    } finally {
      await file.close();
    }
  } catch {
    // Initial qualification is optional. An older or incomplete installation
    // keeps its existing stdio configuration for this host generation.
  }
  return undefined;
}

class DocsProcess {
  readonly client = new Client(
    { name: DOCS_ID, version: '1' },
    { versionNegotiation: { mode: 'legacy' } },
  );
  readonly transport: StdioClientTransport;
  readonly ready: Promise<void>;
  active = 0;
  connected = false;
  exited = false;
  idle?: NodeJS.Timeout;
  retiring?: Promise<void>;
  private exitFence: Promise<void> = Promise.resolve();

  constructor(entry: Snapshot) {
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--input-type=module',
        '--eval',
        bootstrap,
        entry.sha256,
        'station-docs.js',
      ],
      stderr: 'ignore',
      spawnProcess: (command, args, options, spawn) => {
        const child = spawn(command, args, {
          ...options,
          env: {},
          stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
        });
        const source = child.stdio[3];
        this.exitFence = new Promise((resolve) => {
          const exited = () => {
            this.exited = true;
            child.stdin?.destroy();
            child.stdout?.destroy();
            source?.destroy();
            resolve();
          };
          child.once('exit', exited);
          child.once('error', () => {
            if (child.pid === undefined) exited();
          });
        });
        if (source instanceof Writable) {
          source.on('error', () => source.destroy());
          source.end(entry.bytes);
        }
        return child;
      },
    });
    this.ready = this.client
      .connect(this.transport, { timeout: CONNECT_TIMEOUT_MS })
      .then(() => {
        this.connected = true;
      });
    // A caller may abort before the connection settles.
    void this.ready.catch(() => undefined);
  }

  retire(): Promise<void> {
    clearTimeout(this.idle);
    this.retiring ??= this.close();
    return this.retiring;
  }

  private async close(): Promise<void> {
    try {
      await this.transport.close();
    } finally {
      // Transport close can settle after requesting SIGKILL without observing
      // exit. Only this child's exit releases the generation for reuse.
      await this.exitFence;
      await this.client.close();
    }
  }
}

class ClaudeStationDocs {
  private current?: DocsProcess;
  private readonly shutdown = new AbortController();

  readonly config = {
    type: 'sdk' as const,
    name: DOCS_ID,
    // SDK v1 types name a different McpServer class. The SDK uses its public
    // connect/close transport interface, also used by Station Control.
    instance: createStationDocsToolServer((request, signal) =>
      this.call(request, signal),
    ) as never,
  };

  constructor(private readonly entry: Snapshot) {}

  async close(): Promise<void> {
    this.shutdown.abort();
    await this.current?.retire();
  }

  private async call(
    request: { name: string; args: Record<string, unknown> },
    requestSignal: AbortSignal,
  ) {
    const signal = AbortSignal.any([requestSignal, this.shutdown.signal]);
    signal.throwIfAborted();
    while (this.current?.exited || this.current?.retiring) {
      const retiring = this.current;
      await raceWithSignal(retiring.retire(), signal);
      if (this.current === retiring) this.current = undefined;
      signal.throwIfAborted();
    }
    this.current ??= new DocsProcess(this.entry);
    const child = this.current;
    clearTimeout(child.idle);
    child.active++;
    try {
      await raceWithSignal(child.ready, signal);
      return await child.client.callTool(
        { name: request.name, arguments: request.args },
        { signal, timeout: CALL_TIMEOUT_MS },
      );
    } finally {
      if (--child.active === 0 && !child.retiring) {
        if (!child.connected || child.exited) {
          await child.retire();
        } else {
          child.idle = setTimeout(() => {
            // A subsequent call or session close observes retirement.
            void child.retire().catch(() => undefined);
          }, IDLE_MS).unref();
        }
      }
    }
  }
}

export function resolveClaudeStationDocs(input: ProviderSessionStartInput) {
  if (
    input.provider !== 'claude' ||
    input.confinementPlan ||
    input.reviewIsolation ||
    input.tenantExecutionContext ||
    !input.agent ||
    !isCanonicalStationDocsDelivery(input.agent)
  )
    return undefined;
  snapshot ??= readSnapshot();
  return snapshot.then((entry) => entry && new ClaudeStationDocs(entry));
}
