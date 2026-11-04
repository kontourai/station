import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from '@playwright/test';

type AssetRequest = Pick<
  Request,
  'url' | 'method' | 'resourceType' | 'redirectedFrom' | 'failure' | 'timing'
>;
type AssetResponse = Pick<
  Response,
  'status' | 'headerValue' | 'fromServiceWorker'
> & { request(): AssetRequest };
const MAX_REQUESTS = 512;
const MAX_EVENTS = 2048;
const MAX_NETWORK_BYTES = 1536 * 1024;
const SAFE_FILE = /^[A-Za-z0-9_@.-]{1,160}\.(?:m?js|css)$/;

function assetPath(raw: string, origin: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password) return null;
    const file = url.pathname.slice('/assets/'.length);
    return url.pathname.startsWith('/assets/') &&
      SAFE_FILE.test(file) &&
      /\.m?js$/.test(file)
      ? `/assets/${file}`
      : null;
  } catch {
    return null;
  }
}

function failureCode(raw: string | undefined): string | null {
  // Retain known browser failure codes, never arbitrary URL-bearing error text.
  return raw?.match(/\b(?:net::ERR_[A-Z_]+|NS_ERROR_[A-Z_]+)\b/)?.[0] ?? null;
}

/** Passive metadata only. Missing/overflowed observations remain incomplete. */
export function createGalleryAssetDiagnostics(origin: string) {
  const startedAt = Date.now();
  const start = performance.now();
  let screen = 'before-first-screen';
  let navigation = 0;
  let bytes = 0;
  let dropped = 0;
  let metadataErrors = 0;
  let accepting = true;
  const requests = new WeakMap<AssetRequest, number>();
  const records: object[] = [];
  const pending = new Set<Promise<void>>();
  let requestCount = 0;
  const record = (value: object) => {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (!accepting) return;
    if (
      size > 2048 ||
      records.length >= MAX_EVENTS ||
      bytes + size > MAX_NETWORK_BYTES
    ) {
      dropped++;
      return;
    }
    records.push(value);
    bytes += size;
  };
  const identify = (request: AssetRequest) => {
    const existing = requests.get(request);
    if (existing !== undefined) return existing;
    const path = assetPath(request.url(), origin);
    if (!path || !['GET', 'HEAD'].includes(request.method())) return null;
    if (requestCount >= MAX_REQUESTS) {
      dropped++;
      return null;
    }
    const id = ++requestCount;
    requests.set(request, id);
    const redirected = request.redirectedFrom();
    record({
      event: 'request',
      id,
      path,
      method: request.method(),
      resourceType: request.resourceType(),
      screen,
      navigation,
      offsetMs: performance.now() - start,
      redirectedFrom: redirected
        ? (requests.get(redirected) ?? 'unobserved-or-redacted')
        : null,
    });
    return id;
  };
  const observe = (read: () => void) => {
    try {
      read();
    } catch {
      metadataErrors++;
    }
  };
  return {
    screen(name: string) {
      screen = name;
      navigation++;
    },
    request(request: AssetRequest) {
      observe(() => {
        identify(request);
      });
    },
    response(response: AssetResponse) {
      observe(() => {
        const id = identify(response.request());
        if (id === null) return;
        const observed = {
          screen,
          navigation,
          offsetMs: performance.now() - start,
        };
        const task = (async () => {
          try {
            const raw = await response.headerValue('content-type');
            const mime = raw?.split(';')[0].trim().toLowerCase();
            record({
              event: 'response',
              id,
              ...observed,
              status: response.status(),
              mime:
                mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)
                  ? mime.slice(0, 128)
                  : null,
              fromServiceWorker: response.fromServiceWorker(),
              cache: 'UNKNOWN',
            });
          } catch {
            metadataErrors++;
          }
        })();
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
    },
    finished(request: AssetRequest) {
      observe(() => {
        const id = identify(request);
        if (id === null) return;
        const timing = request.timing();
        record({
          event: 'finished',
          id,
          offsetMs: performance.now() - start,
          timing: {
            startTime: timing.startTime,
            domainLookupStart: timing.domainLookupStart,
            domainLookupEnd: timing.domainLookupEnd,
            connectStart: timing.connectStart,
            secureConnectionStart: timing.secureConnectionStart,
            connectEnd: timing.connectEnd,
            requestStart: timing.requestStart,
            responseStart: timing.responseStart,
            responseEnd: timing.responseEnd,
          },
        });
      });
    },
    failed(request: AssetRequest) {
      observe(() => {
        const id = identify(request);
        if (id === null) return;
        record({
          event: 'failed',
          id,
          offsetMs: performance.now() - start,
          failureCode: failureCode(request.failure()?.errorText),
        });
        this.finished(request);
      });
    },
    async finish() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      accepting = false;
      return {
        schemaVersion: 1,
        startedAt,
        requests: requestCount,
        records,
        dropped,
        metadataErrors,
        pending: pending.size,
        incomplete: dropped > 0 || metadataErrors > 0 || pending.size > 0,
        cacheDisposition: 'UNKNOWN',
        bytes,
      };
    },
  };
}

/** Inspect only emitted public files; never serialize bundle bodies or arbitrary strings. */
export function inventoryGalleryAssets(directory: string) {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const references: Array<{ from: string; target: string; offset: number }> =
    [];
  let scannedBytes = 0;
  let incomplete = false;
  const collect = (path: string, file: string) => {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size + scannedBytes > 64 * 1024 * 1024 ||
      files.length >= 4096
    ) {
      incomplete = true;
      return;
    }
    const body = readFileSync(file);
    scannedBytes += body.length;
    files.push({
      path,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    if (path === 'index.html' || /\.m?js$/.test(path)) {
      const text = body.toString('utf8');
      // Public import/preload asset references only, with byte offsets; no body excerpts.
      for (const match of text.matchAll(
        /["'](?:\.\/|\/assets\/)([A-Za-z0-9_@.-]{1,160}\.m?js)["']/g,
      )) {
        if (references.length >= 4096) {
          incomplete = true;
          break;
        }
        references.push({
          from: path,
          target: match[1],
          offset: Buffer.byteLength(text.slice(0, match.index)),
        });
      }
    }
  };
  try {
    collect('index.html', join(directory, 'index.html'));
    if (lstatSync(join(directory, 'assets')).isSymbolicLink())
      throw new Error('Asset directory symlink');
    for (const entry of readdirSync(join(directory, 'assets'), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && SAFE_FILE.test(entry.name))
        collect(`assets/${entry.name}`, join(directory, 'assets', entry.name));
    }
  } catch {
    incomplete = true;
  }
  const result = {
    observedAt: new Date().toISOString(),
    files,
    references,
    scannedBytes,
    incomplete,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) {
    return {
      observedAt: result.observedAt,
      files: [],
      references: [],
      scannedBytes,
      incomplete: true,
    };
  }
  return result;
}

/** The journal is server lifecycle evidence, not an asset access log. */
export function readGalleryLifecycle(file: string) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) {
      return { incomplete: true, events: [] };
    }
    const events = [];
    let incomplete = false;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      if (events.length >= 1024) {
        incomplete = true;
        break;
      }
      try {
        const row = JSON.parse(line);
        const type = [
          'started',
          'stop_intent',
          'stop_result',
          'shutdown_observed',
          'process_exit',
        ].includes(row.type)
          ? row.type
          : null;
        if (!type) {
          incomplete = true;
          continue;
        }
        events.push({
          type,
          timestamp:
            typeof row.timestamp === 'string' &&
            row.timestamp.length <= 32 &&
            /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(row.timestamp)
              ? row.timestamp
              : null,
          pid: Number.isSafeInteger(row.pid) ? row.pid : null,
          sha:
            typeof row.sha === 'string' && /^[a-f0-9]{7,40}$/.test(row.sha)
              ? row.sha
              : null,
          generation: Number.isSafeInteger(row.supervisor?.generation)
            ? row.supervisor.generation
            : null,
          exitCode: Number.isSafeInteger(row.exitCode) ? row.exitCode : null,
        });
      } catch {
        incomplete = true;
      }
    }
    return { incomplete, events };
  } catch {
    return { incomplete: true, events: [] };
  }
}
