/**
 * Suggestions for registered local targets (#90 D7): which local web servers
 * are listening, and which Project each belongs to.
 *
 * The approach follows t3code's `apps/server/src/preview/PortScanner.ts`
 * (MIT, © 2026 T3 Tools Inc.): `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` on macOS
 * and Linux, `Get-NetTCPConnection` on Windows, then a bounded HTTP probe
 * that keeps only listeners answering with HTML or a redirect. Station adds
 * Project attribution: a port belongs to a Project when its owning process's
 * working directory is inside the Project's workspace root.
 *
 * Scans run on demand only (a cached result is reused for a few seconds);
 * nothing polls in the background, and nothing is ever registered from here:
 * the operator decides. A platform where listing or attribution is not
 * available reports a typed `unavailable`, never an empty success.
 */
import { execFile } from 'node:child_process';
import { readlink, realpath } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, relative } from 'node:path';
import type { StationListeners } from './station-listeners.js';

export interface ListeningPort {
  port: number;
  pid: number | null;
  processName: string | null;
  /** The owning process's working directory, when attribution is available. */
  cwd: string | null;
  /** Answered the HTTP probe with HTML or a redirect. */
  web: boolean;
}

export type PortScanResult =
  | {
      state: 'ok';
      ports: ListeningPort[];
      /** Whether cwd attribution was available on this platform. */
      attribution: 'cwd' | 'unavailable';
      scannedAt: string;
    }
  | { state: 'unavailable'; reason: string };

export interface CommandResult {
  code: number | null;
  stdout: string;
  missing?: boolean;
}

export interface PortScannerDeps {
  platform: NodeJS.Platform;
  run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<CommandResult>;
  readCwd(pid: number): Promise<string | null>;
  probe(port: number): Promise<boolean>;
  now(): Date;
}

const SCAN_CACHE_MS = 5_000;
const COMMAND_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Listen addresses a loopback request reaches. */
const LOOPBACK_LISTEN = new Set([
  '*',
  '127.0.0.1',
  '0.0.0.0',
  '::',
  '[::]',
  '::1',
  '[::1]',
  'localhost',
]);

export function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === 'number'
            ? (error as unknown as { code: number }).code
            : error
              ? null
              : 0;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          ...((error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
            ? { missing: true }
            : {}),
        });
      },
    );
  });
}

/** Parse `lsof -Fpcn` output into loopback-reachable listening ports. */
export function parseLsofListeners(
  raw: string,
): Array<{ port: number; pid: number | null; processName: string | null }> {
  const seen = new Map<
    number,
    { port: number; pid: number | null; processName: string | null }
  >();
  let pid: number | null = null;
  let processName: string | null = null;
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      processName = null;
    } else if (tag === 'c') {
      processName = value.trim() || null;
    } else if (tag === 'n') {
      const name = value.split(' ')[0] ?? '';
      const colon = name.lastIndexOf(':');
      if (colon < 0) continue;
      const host = name.slice(0, colon);
      const port = Number(name.slice(colon + 1));
      if (
        !LOOPBACK_LISTEN.has(host) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535
      )
        continue;
      if (!seen.has(port)) seen.set(port, { port, pid, processName });
    }
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

/** Parse `address|port|pid` lines from the Windows listener query. */
export function parseWindowsListeners(
  raw: string,
): Array<{ port: number; pid: number | null; processName: string | null }> {
  const seen = new Map<
    number,
    { port: number; pid: number | null; processName: string | null }
  >();
  for (const line of raw.split(/\r?\n/)) {
    const [host, portRaw, pidRaw] = line.trim().split('|');
    if (!host || !LOOPBACK_LISTEN.has(host)) continue;
    const port = Number(portRaw);
    const pid = Number(pidRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    if (!seen.has(port))
      seen.set(port, {
        port,
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        processName: null,
      });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

/** True when an HTTP GET to the loopback port answers HTML or a redirect. */
export function probeWebPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        timeout: PROBE_TIMEOUT_MS,
        headers: { accept: 'text/html' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers['content-type'] ?? '');
        res.destroy();
        resolve(
          REDIRECTS.has(status) ||
            (status >= 200 && status < 300 && type.includes('text/html')),
        );
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

export function defaultPortScannerDeps(): PortScannerDeps {
  return {
    platform: process.platform,
    run: runCommand,
    readCwd: async (pid) => {
      if (process.platform === 'linux') {
        return readlink(`/proc/${pid}/cwd`).catch(() => null);
      }
      if (process.platform === 'darwin') {
        const out = await runCommand(
          'lsof',
          ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
          COMMAND_TIMEOUT_MS,
        );
        const line = out.stdout.split('\n').find((l) => l.startsWith('n'));
        return line ? line.slice(1) : null;
      }
      return null;
    },
    probe: probeWebPort,
    now: () => new Date(),
  };
}

export class LocalPortScanner {
  private cached: { at: number; result: PortScanResult } | undefined;
  private inFlight: Promise<PortScanResult> | undefined;

  constructor(
    private readonly deps: PortScannerDeps = defaultPortScannerDeps(),
  ) {}

  /** On-demand scan, single-flight, reused for a few seconds. */
  scan(): Promise<PortScanResult> {
    const now = this.deps.now().getTime();
    if (this.cached && now - this.cached.at < SCAN_CACHE_MS)
      return Promise.resolve(this.cached.result);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scanNow()
      .then((result) => {
        this.cached = { at: this.deps.now().getTime(), result };
        return result;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async scanNow(): Promise<PortScanResult> {
    const { platform } = this.deps;
    let listeners: Array<{
      port: number;
      pid: number | null;
      processName: string | null;
    }>;
    let attribution: 'cwd' | 'unavailable';
    if (platform === 'darwin' || platform === 'linux') {
      const out = await this.deps.run(
        'lsof',
        ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'],
        COMMAND_TIMEOUT_MS,
      );
      if (out.missing)
        return { state: 'unavailable', reason: 'lsof is not installed' };
      // lsof exits 1 with no output when nothing matches.
      if (out.code !== 0 && !(out.code === 1 && out.stdout.trim() === ''))
        return {
          state: 'unavailable',
          reason: `lsof failed (exit ${out.code ?? 'signal'})`,
        };
      listeners = parseLsofListeners(out.stdout);
      attribution = 'cwd';
    } else if (platform === 'win32') {
      const out = await this.deps.run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-NetTCPConnection -State Listen | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" }',
        ],
        COMMAND_TIMEOUT_MS,
      );
      if (out.missing || out.code !== 0)
        return {
          state: 'unavailable',
          reason: 'Get-NetTCPConnection is not available',
        };
      listeners = parseWindowsListeners(out.stdout);
      // Windows exposes no cheap, unprivileged way to read another process's
      // working directory, so ports are listed but never attributed.
      attribution = 'unavailable';
    } else {
      return {
        state: 'unavailable',
        reason: `port detection is not supported on ${platform}`,
      };
    }
    const ports = await Promise.all(
      listeners.map(async (listener) => ({
        ...listener,
        cwd:
          attribution === 'cwd' && listener.pid !== null
            ? await this.deps.readCwd(listener.pid).catch(() => null)
            : null,
        web: await this.deps.probe(listener.port).catch(() => false),
      })),
    );
    return {
      state: 'ok',
      ports,
      attribution,
      scannedAt: this.deps.now().toISOString(),
    };
  }
}

export type LocalTargetSuggestions =
  | {
      state: 'ok';
      suggestions: Array<{
        host: 'localhost';
        port: number;
        label: string;
        pid: number | null;
      }>;
    }
  | { state: 'unavailable'; reason: string };

async function inside(child: string, root: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    realpath(child).catch(() => child),
    realpath(root).catch(() => root),
  ]);
  const rel = relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The web listeners attributed to one Project: owning process cwd inside its
 * workspace root, not a Station listener, not already registered.
 */
export async function suggestLocalTargets(
  scan: PortScanResult,
  project: {
    workspaceRoot: string | undefined;
    registered: ReadonlyArray<{ host: string; port: number }>;
  },
  listeners: StationListeners,
): Promise<LocalTargetSuggestions> {
  if (scan.state === 'unavailable') return scan;
  if (scan.attribution === 'unavailable')
    return {
      state: 'unavailable',
      reason: 'this platform cannot attribute listening ports to a Project',
    };
  if (!project.workspaceRoot)
    return {
      state: 'unavailable',
      reason: 'the Project has no workspace directory',
    };
  const suggestions = [];
  for (const port of scan.ports) {
    if (!port.web || port.cwd === null) continue;
    if (listeners.ports.includes(port.port)) continue;
    if (project.registered.some((t) => t.port === port.port)) continue;
    if (!(await inside(port.cwd, project.workspaceRoot))) continue;
    suggestions.push({
      host: 'localhost' as const,
      port: port.port,
      label: port.processName
        ? `${port.processName} :${port.port}`
        : `:${port.port}`,
      pid: port.pid,
    });
  }
  return { state: 'ok', suggestions };
}
