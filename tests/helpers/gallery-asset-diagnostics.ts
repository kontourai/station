import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
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
const MAX_SCREENS = 128;
const MAX_ASSETS = 4096;
const MAX_ACTIVE = 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_FOLDER_BYTES = 4 * 1024 * 1024;
const SAFE_FILE = /^[A-Za-z0-9_@.-]{1,160}\.(?:m?js|css)$/;
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const sizeOf = (value: object) => Buffer.byteLength(JSON.stringify(value));

function assetPath(raw: string, origin: string): string | null {
  const url = new URL(raw);
  const file = url.pathname.slice('/assets/'.length);
  return url.origin === origin &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith('/assets/') &&
    SAFE_FILE.test(file) &&
    /\.m?js$/.test(file)
    ? `/assets/${file}`
    : null;
}
function failureCode(raw: string | undefined): string | null {
  return raw?.match(/\b(?:net::ERR_[A-Z_]+|NS_ERROR_[A-Z_]+)\b/)?.[0] ?? null;
}
function newScope(name: string, ordinal: number) {
  return {
    name,
    ordinal,
    entered: 0,
    ended: 0,
    requested: 0,
    responded: 0,
    finished: 0,
    failed: 0,
    failedWithResponse: 0,
    duplicate: 0,
    unmatched: 0,
    metadataErrors: 0,
    anomalies: 0,
    overwritten: 0,
    statuses: Array<number>(600).fill(0),
    invalidStatus: 0,
    mime: [0, 0, 0, 0, 0],
    serviceWorker: [0, 0, 0],
    redirects: 0,
    requestedAssets: Buffer.alloc(512),
    respondedAssets: Buffer.alloc(512),
    failedAssets: Buffer.alloc(512),
  };
}
type Scope = ReturnType<typeof newScope>;
type Receipt = {
  id: number;
  scope: Scope;
  asset: number;
  method: string;
  responded: boolean;
  terminal: boolean;
  anomaly: boolean;
  status: number | null;
  mime: string;
  serviceWorker: boolean | null;
  redirect: number | 'REDACTED' | null;
  failure: string | null;
  metadataError:
    | 'FAILURE_METADATA'
    | 'TIMING_METADATA'
    | 'RESPONSE_METADATA'
    | 'HEADER_METADATA'
    | null;
  timing: {
    startTime: number;
    requestStart: number;
    responseStart: number;
    responseEnd: number;
  } | null;
};

/** Complete scoped counters are independent from intentionally sampled detail. */
export function createGalleryAssetDiagnostics(
  origin: string,
  declaredScreens: readonly string[],
) {
  const startedAt = Date.now();
  let incomplete =
    declaredScreens.length + 1 > MAX_SCREENS ||
    new Set(declaredScreens).size !== declaredScreens.length;
  const setup = newScope('setup-or-unattributed', 0);
  setup.entered = 1;
  const scopes = [
    setup,
    ...declaredScreens
      .slice(0, MAX_SCREENS - 1)
      .map((name, index) => newScope(name, index + 1)),
  ];
  let current = setup;
  const enteredOrder: number[] = [];
  const assets: Array<{
    path: string;
    requested: number;
    responded: number;
    failed: number;
  }> = [];
  const assetIds = new Map<string, number>();
  const active = new Map<AssetRequest, Receipt>();
  const completed = new WeakMap<AssetRequest, Scope>();
  const samples = new Map<
    Scope,
    { normal: Receipt | null; anomalies: Receipt[] }
  >();
  const pending = new Set<Promise<void>>();
  let nextId = 0;
  let activeOverflows = 0;
  let dictionaryOverflows = 0;
  let asyncOverflows = 0;
  let counterOverflows = 0;
  let accepting = true;
  const increment = (
    scope: Scope,
    key:
      | 'requested'
      | 'responded'
      | 'finished'
      | 'failed'
      | 'failedWithResponse'
      | 'duplicate'
      | 'unmatched'
      | 'metadataErrors'
      | 'anomalies'
      | 'overwritten'
      | 'redirects',
  ) => {
    if (scope[key] === Number.MAX_SAFE_INTEGER) {
      counterOverflows++;
      incomplete = true;
    } else scope[key]++;
  };
  const observe = (scope: Scope, read: () => void, onError?: () => void) => {
    if (!accepting) return;
    try {
      read();
    } catch {
      increment(scope, 'metadataErrors');
      incomplete = true;
      onError?.();
    }
  };
  const mask = (buffer: Buffer, id: number) => {
    buffer[id >> 3] |= 1 << (id & 7);
  };
  const markAnomaly = (receipt: Receipt) => {
    if (receipt.anomaly) return;
    receipt.anomaly = true;
    increment(receipt.scope, 'anomalies');
    const selected = samples.get(receipt.scope);
    if (!selected) return;
    if (selected.anomalies.length < 2) selected.anomalies.push(receipt);
    else {
      selected.anomalies[1] = receipt;
      increment(receipt.scope, 'overwritten');
    }
  };
  const metadataAnomaly = (
    receipt: Receipt,
    code: NonNullable<Receipt['metadataError']>,
  ) => {
    receipt.metadataError = code;
    markAnomaly(receipt);
  };
  const eligible = (request: AssetRequest) => {
    const path = assetPath(request.url(), origin);
    return path && ['GET', 'HEAD'].includes(request.method()) ? path : null;
  };
  const lookup = (request: AssetRequest) => {
    const receipt = active.get(request);
    if (receipt) return receipt;
    const origin = completed.get(request);
    if (origin) {
      increment(origin, 'duplicate');
      return null;
    }
    if (!eligible(request)) return null;
    increment(current, 'unmatched');
    incomplete = true;
    return null;
  };
  const terminal = (request: AssetRequest, failed: boolean) => {
    const receipt = lookup(request);
    if (!receipt) return;
    receipt.terminal = true;
    active.delete(request);
    completed.set(request, receipt.scope);
    increment(receipt.scope, failed ? 'failed' : 'finished');
    if (failed) {
      assets[receipt.asset].failed++;
      mask(receipt.scope.failedAssets, receipt.asset);
      if (receipt.responded) increment(receipt.scope, 'failedWithResponse');
      markAnomaly(receipt);
      observe(
        receipt.scope,
        () => {
          receipt.failure = failureCode(request.failure()?.errorText);
        },
        () => metadataAnomaly(receipt, 'FAILURE_METADATA'),
      );
    }
    observe(
      receipt.scope,
      () => {
        const timing = request.timing();
        if (
          ![
            timing.startTime,
            timing.requestStart,
            timing.responseStart,
            timing.responseEnd,
          ].every(Number.isFinite)
        )
          throw new Error('INVALID_TIMING');
        receipt.timing = {
          startTime: timing.startTime,
          requestStart: timing.requestStart,
          responseStart: timing.responseStart,
          responseEnd: timing.responseEnd,
        };
      },
      () => metadataAnomaly(receipt, 'TIMING_METADATA'),
    );
  };
  return {
    screen(name: string) {
      observe(current, () => {
        const scope = scopes.find(
          (entry) => entry.name === name && entry !== setup,
        );
        if (!scope) {
          incomplete = true;
          return;
        }
        if (scope.ordinal !== enteredOrder.length + 1) incomplete = true;
        enteredOrder.push(scope.ordinal);
        current = scope;
        scope.entered++;
        if (scope.entered !== 1) incomplete = true;
      });
    },
    screenFinished(name: string) {
      observe(current, () => {
        const scope = scopes.find(
          (entry) => entry.name === name && entry !== setup,
        );
        if (!scope || scope.entered !== 1) {
          incomplete = true;
          return;
        }
        scope.ended++;
        if (scope.ended !== 1) incomplete = true;
      });
    },
    request(request: AssetRequest) {
      observe(current, () => {
        if (active.has(request) || completed.has(request)) {
          increment(
            active.get(request)?.scope ?? completed.get(request) ?? current,
            'duplicate',
          );
          return;
        }
        const path = eligible(request);
        if (!path) return;
        increment(current, 'requested');
        let asset = assetIds.get(path);
        if (asset === undefined) {
          if (assets.length >= MAX_ASSETS) {
            dictionaryOverflows++;
            incomplete = true;
            return;
          }
          asset = assets.length;
          assetIds.set(path, asset);
          assets.push({ path, requested: 0, responded: 0, failed: 0 });
        }
        assets[asset].requested++;
        mask(current.requestedAssets, asset);
        if (active.size >= MAX_ACTIVE) {
          activeOverflows++;
          incomplete = true;
          return;
        }
        const receipt: Receipt = {
          id: ++nextId,
          scope: current,
          asset,
          method: request.method(),
          responded: false,
          terminal: false,
          anomaly: false,
          status: null,
          mime: 'MISSING',
          serviceWorker: null,
          redirect: null,
          failure: null,
          metadataError: null,
          timing: null,
        };
        active.set(request, receipt);
        let selected = samples.get(current);
        if (!selected) {
          selected = { normal: null, anomalies: [] };
          samples.set(current, selected);
        }
        if (!selected.normal) selected.normal = receipt;
        const from = request.redirectedFrom();
        if (from) {
          const path = eligible(from);
          receipt.redirect = path
            ? (assetIds.get(path) ?? 'REDACTED')
            : 'REDACTED';
          increment(current, 'redirects');
        }
      });
    },
    response(response: AssetResponse) {
      observe(current, () => {
        const receipt = lookup(response.request());
        if (!receipt) return;
        if (receipt.responded) {
          increment(receipt.scope, 'duplicate');
          return;
        }
        receipt.responded = true;
        increment(receipt.scope, 'responded');
        assets[receipt.asset].responded++;
        mask(receipt.scope.respondedAssets, receipt.asset);
        observe(
          receipt.scope,
          () => {
            const status = response.status();
            if (Number.isInteger(status) && status >= 0 && status < 600) {
              receipt.status = status;
              receipt.scope.statuses[status]++;
            } else {
              receipt.scope.invalidStatus++;
              incomplete = true;
              markAnomaly(receipt);
            }
            if (status < 200 || status >= 400) markAnomaly(receipt);
            receipt.serviceWorker = response.fromServiceWorker();
            receipt.scope.serviceWorker[receipt.serviceWorker ? 0 : 1]++;
          },
          () => metadataAnomaly(receipt, 'RESPONSE_METADATA'),
        );
        if (pending.size >= MAX_ACTIVE) {
          asyncOverflows++;
          incomplete = true;
          return;
        }
        const task = (async () => {
          try {
            const raw = await response.headerValue('content-type');
            if (!accepting) return;
            const mime = raw?.split(';')[0].trim().toLowerCase();
            const category =
              mime === 'text/javascript' || mime === 'application/javascript'
                ? 0
                : mime === 'text/html'
                  ? 1
                  : mime === 'application/json'
                    ? 2
                    : mime
                      ? 3
                      : 4;
            receipt.mime = ['JAVASCRIPT', 'HTML', 'JSON', 'OTHER', 'MISSING'][
              category
            ];
            receipt.scope.mime[category]++;
            if (category !== 0) markAnomaly(receipt);
          } catch {
            increment(receipt.scope, 'metadataErrors');
            incomplete = true;
            metadataAnomaly(receipt, 'HEADER_METADATA');
          }
        })();
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
    },
    finished(request: AssetRequest) {
      observe(current, () => terminal(request, false));
    },
    failed(request: AssetRequest) {
      observe(current, () => terminal(request, true));
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
      setup.ended = 1;
      const summaryRows = scopes.map((scope) => ({
        ...scope,
        statuses: [...scope.statuses],
        mime: [...scope.mime],
        serviceWorker: [...scope.serviceWorker],
        requestedAssets: scope.requestedAssets.toString('base64'),
        respondedAssets: scope.respondedAssets.toString('base64'),
        failedAssets: scope.failedAssets.toString('base64'),
      }));
      const balanced = scopes.every(
        (scope) =>
          scope.entered === 1 &&
          scope.ended === 1 &&
          scope.requested === scope.finished + scope.failed &&
          scope.responded === scope.finished + scope.failedWithResponse &&
          scope.mime.reduce((sum, count) => sum + count, 0) ===
            scope.responded &&
          scope.metadataErrors === 0 &&
          scope.unmatched === 0,
      );
      const summary = {
        complete:
          !incomplete && balanced && active.size === 0 && pending.size === 0,
        declared: declaredScreens.length,
        enteredOrder,
        scopes: summaryRows,
        active: active.size,
        pending: pending.size,
        activeOverflows,
        dictionaryOverflows,
        asyncOverflows,
        counterOverflows,
      };
      if (sizeOf(summary) > 512 * 1024) {
        summary.complete = false;
        incomplete = true;
      }
      const rows = [...samples.values()]
        .flatMap((selected) => [
          ...new Set([
            ...(selected.normal ? [selected.normal] : []),
            ...selected.anomalies,
          ]),
        ])
        .map((receipt) => ({
          id: receipt.id,
          scope: receipt.scope.ordinal,
          asset: receipt.asset,
          method: receipt.method,
          status: receipt.status,
          mime: receipt.mime,
          serviceWorker: receipt.serviceWorker,
          redirect: receipt.redirect,
          failure: receipt.failure,
          metadataError: receipt.metadataError,
          terminal: receipt.terminal,
          timing: receipt.timing,
        }));
      const retained = rows.filter((row) => sizeOf(row) <= 768).slice(0, 384);
      const total = scopes.reduce((sum, scope) => sum + scope.requested, 0);
      const details = {
        mode: 'SAMPLED',
        exhaustive: false,
        omitted: Math.max(0, total - retained.length),
        overwritten: scopes.reduce((sum, scope) => sum + scope.overwritten, 0),
        rows: retained,
      };
      const dictionary = { complete: dictionaryOverflows === 0, assets };
      if (sizeOf(dictionary) > 768 * 1024) dictionary.complete = false;
      return {
        schemaVersion: 2,
        startedAt,
        summary,
        dictionary,
        details,
        incomplete:
          !summary.complete || !details.exhaustive || !dictionary.complete,
        cacheDisposition: 'UNKNOWN',
      };
    },
  };
}

/** File identity and recognized literal references have independent fidelity. */
export function inventoryGalleryAssets(directory: string) {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const references: Array<{
    from: string;
    target: string;
    count: number;
    firstOffset: number;
    lastOffset: number;
  }> = [];
  const edges = new Map<string, (typeof references)[number]>();
  const stream = createHash('sha256');
  let scannedBytes = 0;
  let fileInventoryComplete = true;
  let referenceProjectionComplete = true;
  let occurrences = 0;
  let omittedEdges = 0;
  const collect = (path: string, file: string) => {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size + scannedBytes > 64 * 1024 * 1024 ||
      files.length >= 4096
    ) {
      fileInventoryComplete = false;
      referenceProjectionComplete = false;
      return;
    }
    const body = readFileSync(file);
    if (
      body.length !== stat.size ||
      scannedBytes + body.length > 64 * 1024 * 1024
    ) {
      fileInventoryComplete = false;
      referenceProjectionComplete = false;
      return;
    }
    scannedBytes += body.length;
    files.push({ path, bytes: body.length, sha256: digest(body) });
    if (path === 'index.html' || /\.m?js$/.test(path)) {
      const text = body.toString('utf8');
      let lastIndex = 0;
      let byteOffset = 0;
      for (const match of text.matchAll(
        /["'](?:\.\/|\/assets\/)([A-Za-z0-9_@.-]{1,160}\.m?js)["']/g,
      )) {
        byteOffset += Buffer.byteLength(text.slice(lastIndex, match.index));
        lastIndex = match.index;
        occurrences++;
        const target = `assets/${match[1]}`;
        stream.update(`${JSON.stringify([path, target, byteOffset])}\n`);
        const key = `${path}\n${target}`;
        const existing = edges.get(key);
        if (existing) {
          existing.count++;
          existing.lastOffset = byteOffset;
        } else if (references.length < 4096) {
          const edge = {
            from: path,
            target,
            count: 1,
            firstOffset: byteOffset,
            lastOffset: byteOffset,
          };
          edges.set(key, edge);
          references.push(edge);
        } else {
          omittedEdges++;
          referenceProjectionComplete = false;
        }
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
      else if (entry.isSymbolicLink()) {
        fileInventoryComplete = false;
        referenceProjectionComplete = false;
      }
    }
  } catch {
    fileInventoryComplete = false;
    referenceProjectionComplete = false;
  }
  const known = new Set(files.map((file) => file.path));
  const unresolved = references.filter(
    (edge) => !known.has(edge.target),
  ).length;
  if (unresolved > 0) referenceProjectionComplete = false;
  const fileCount = files.length;
  const identity = digest(JSON.stringify(files));
  const projectionDigest = stream.digest('hex');
  let referenceBytes = 32;
  const retainedEdges = references.filter((edge) => {
    const bytes = sizeOf(edge) + 1;
    if (referenceBytes + bytes > 256 * 1024) {
      omittedEdges += edge.count;
      referenceProjectionComplete = false;
      return false;
    }
    referenceBytes += bytes;
    return true;
  });
  references.length = 0;
  references.push(...retainedEdges);
  if (sizeOf({ files }) > 768 * 1024) {
    files.length = 0;
    fileInventoryComplete = false;
  }
  return {
    observedAt: new Date().toISOString(),
    files,
    fileCount,
    identity,
    fileInventoryComplete,
    references,
    occurrences,
    projectionDigest,
    referenceProjectionComplete,
    omittedEdgeObservations: omittedEdges,
    unresolved,
    recognizedScanComplete: fileInventoryComplete,
    graphScope: 'RECOGNIZED_LITERAL_REFERENCES_ONLY',
    scannedBytes,
    incomplete: !fileInventoryComplete || !referenceProjectionComplete,
  };
}

type Inventory = ReturnType<typeof inventoryGalleryAssets>;
function diagnosticNodeIdentity(stat: Stats) {
  return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.birthtimeMs]);
}
function diagnosticFileIdentity(stat: Stats) {
  return JSON.stringify([
    diagnosticNodeIdentity(stat),
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ]);
}
function inspectDiagnosticFolder(directory: string) {
  const files: Array<{
    path: string;
    bytes: number;
    sha256: string;
    identity: string;
  }> = [];
  const directories: Array<{ path: string; identity: string }> = [];
  const ancestors: Array<{ path: string; identity: string }> = [];
  let bytes = 0;
  let readBytes = 0;
  let incomplete = false;
  let entries = 0;
  let rootIdentity: string | null = null;
  const stableAncestors = () =>
    ancestors.every((ancestor) => {
      const stat = lstatSync(ancestor.path);
      return (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        diagnosticNodeIdentity(stat) === ancestor.identity
      );
    });
  const visit = (folder: string, prefix: string) => {
    const folderStat = lstatSync(folder);
    if (!folderStat.isDirectory() || folderStat.isSymbolicLink())
      throw new Error('UNSAFE_DIRECTORY');
    const identity = diagnosticNodeIdentity(folderStat);
    ancestors.push({ path: folder, identity });
    directories.push({ path: prefix, identity });
    if (!prefix) rootIdentity = identity;
    if (!stableAncestors()) throw new Error('DIRECTORY_CHANGED');
    const names = readdirSync(folder).sort();
    for (const name of names) {
      if (++entries > 128) throw new Error('ENTRY_LIMIT');
      if (!stableAncestors()) throw new Error('DIRECTORY_CHANGED');
      const path = prefix + name;
      const file = join(folder, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('SYMLINK_ENTRY');
      if (stat.isDirectory()) {
        visit(file, `${path}/`);
        continue;
      }
      if (!stat.isFile() || !/^[A-Za-z0-9_./-]{1,200}$/.test(path))
        throw new Error('UNSUPPORTED_ENTRY');
      if (stat.size > 16 * 1024 * 1024 - readBytes)
        throw new Error('INSPECTION_LIMIT');
      const fd = openSync(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const before = fstatSync(fd);
        if (
          !before.isFile() ||
          diagnosticFileIdentity(before) !== diagnosticFileIdentity(stat) ||
          !stableAncestors()
        )
          throw new Error('FILE_CHANGED');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(
          Math.min(64 * 1024, Math.max(1, before.size)),
        );
        let actual = 0;
        while (actual < before.size) {
          const length = Math.min(
            buffer.length,
            before.size - actual,
            16 * 1024 * 1024 - readBytes,
          );
          if (length <= 0) throw new Error('INSPECTION_LIMIT');
          const count = readSync(fd, buffer, 0, length, actual);
          if (count <= 0 || count > length) throw new Error('UNSTABLE_READ');
          readBytes += count;
          actual += count;
          hash.update(buffer.subarray(0, count));
        }
        const after = fstatSync(fd);
        const linked = lstatSync(file);
        if (
          !linked.isFile() ||
          linked.isSymbolicLink() ||
          diagnosticFileIdentity(before) !== diagnosticFileIdentity(after) ||
          diagnosticFileIdentity(after) !== diagnosticFileIdentity(linked) ||
          !stableAncestors()
        )
          throw new Error('FILE_CHANGED');
        bytes += actual;
        files.push({
          path,
          bytes: actual,
          sha256: hash.digest('hex'),
          identity: diagnosticFileIdentity(after),
        });
      } finally {
        closeSync(fd);
      }
    }
    if (
      JSON.stringify(readdirSync(folder).sort()) !== JSON.stringify(names) ||
      !stableAncestors()
    )
      throw new Error('DIRECTORY_CHANGED');
    ancestors.pop();
  };
  try {
    visit(directory, '');
  } catch {
    incomplete = true;
  }
  return { files, directories, rootIdentity, bytes, readBytes, incomplete };
}
/** Fresh single-writer output; never overwrite or delete earlier diagnostic evidence. */
export function retainGalleryAssetDiagnostics(
  directory: string,
  network: Awaited<
    ReturnType<ReturnType<typeof createGalleryAssetDiagnostics>['finish']>
  >,
  before: Inventory | null,
  after: Inventory | null,
  provenance: { complete: boolean; [key: string]: unknown },
) {
  const output = 'asset-network-v2.json';
  const prior = inspectDiagnosticFolder(directory);
  if (prior.incomplete || prior.rootIdentity === null)
    return {
      retention: 'INCOMPLETE',
      incomplete: true,
      reason: 'UNSAFE_OR_UNSTABLE_INSPECTION',
      totalBytes: null,
      inspectedBytes: prior.readBytes,
    };
  if (prior.files.some((file) => file.path === output))
    return {
      retention: 'INCOMPLETE',
      incomplete: true,
      reason: 'OWNED_OUTPUT_EXISTS',
      totalBytes: prior.bytes,
    };
  const beforeFiles = new Map(
    before?.files.map((file) => [file.path, file.sha256]),
  );
  const afterFiles = new Map(
    after?.files.map((file) => [file.path, file.sha256]),
  );
  const afterProjection = after
    ? {
        ...after,
        files: after.files.filter(
          (file) => beforeFiles.get(file.path) !== file.sha256,
        ),
        removedFiles:
          before?.files
            .filter((file) => !afterFiles.has(file.path))
            .map((file) => file.path) ?? [],
        references:
          after.projectionDigest === before?.projectionDigest
            ? []
            : after.references,
        sameFileIdentity: after.identity === before?.identity,
        sameLiteralProjection:
          after.projectionDigest === before?.projectionDigest,
      }
    : null;
  if (
    sizeOf({ before: before?.references, after: afterProjection?.references }) >
      256 * 1024 &&
    afterProjection
  ) {
    afterProjection.references = [];
    afterProjection.referenceProjectionComplete = false;
    afterProjection.incomplete = true;
  }
  const packet = {
    network,
    emittedBefore: before,
    emittedAfter: afterProjection,
    provenance,
    incomplete:
      prior.incomplete ||
      network.incomplete ||
      !before ||
      !after ||
      before.incomplete ||
      after.incomplete ||
      !provenance.complete,
    budget: {
      capBytes: MAX_FOLDER_BYTES,
      jsonCapBytes: MAX_JSON_BYTES,
      priorBytes: prior.bytes,
      existingFiles: prior.files,
      projectedBytes: 0,
    },
  };
  const room = Math.min(
    MAX_JSON_BYTES,
    Math.max(0, MAX_FOLDER_BYTES - prior.bytes),
  );
  const encode = () => {
    let body = Buffer.from(JSON.stringify(packet));
    for (let step = 0; step < 3; step++) {
      packet.budget.projectedBytes = prior.bytes + body.length;
      body = Buffer.from(JSON.stringify(packet));
    }
    return body;
  };
  let body = encode();
  if (body.length > room) {
    network.details.omitted += network.details.rows.length;
    network.details.rows = [];
    network.details.exhaustive = false;
    network.incomplete = true;
    packet.incomplete = true;
    body = encode();
  }
  if (body.length > room) {
    if (before) {
      before.references = [];
      before.referenceProjectionComplete = false;
      before.incomplete = true;
    }
    if (afterProjection) {
      afterProjection.references = [];
      afterProjection.referenceProjectionComplete = false;
      afterProjection.incomplete = true;
    }
    packet.incomplete = true;
    body = encode();
  }
  const { lifecycle, ...otherProvenance } = provenance;
  const componentOverflow =
    sizeOf(network.summary) > 512 * 1024 ||
    sizeOf({
      dictionary: network.dictionary,
      before: before?.files,
      after: afterProjection?.files,
      removed: afterProjection?.removedFiles,
    }) >
      768 * 1024 ||
    sizeOf(network.details) > 288 * 1024 ||
    sizeOf(otherProvenance) > 64 * 1024 ||
    (typeof lifecycle === 'object' &&
      lifecycle !== null &&
      sizeOf(lifecycle) > 128 * 1024);
  if (body.length > room || prior.incomplete || componentOverflow) {
    body = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        incomplete: true,
        reason: 'DIAGNOSTIC_BUDGET_OR_INSPECTION',
        priorBytes: prior.bytes,
        capBytes: MAX_FOLDER_BYTES,
      }),
    );
    if (body.length > room)
      return {
        retention: 'INCOMPLETE',
        incomplete: true,
        reason: 'NO_ROOM_FOR_RECEIPT',
        totalBytes: prior.bytes,
      };
    packet.incomplete = true;
  }
  try {
    const root = lstatSync(directory);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      diagnosticNodeIdentity(root) !== prior.rootIdentity
    )
      throw new Error('DIRECTORY_CHANGED');
    writeFileSync(join(directory, output), body, { flag: 'wx' });
  } catch {
    return {
      retention: 'INCOMPLETE',
      incomplete: true,
      reason: 'WRITE_FAILED',
      totalBytes: prior.bytes,
    };
  }
  const final = inspectDiagnosticFolder(directory);
  const others = final.files.filter((file) => file.path !== output);
  const changed = JSON.stringify(others) !== JSON.stringify(prior.files);
  const owned = final.files.find((file) => file.path === output);
  const ownedMatches =
    owned !== undefined &&
    owned.bytes === body.length &&
    owned.sha256 === digest(body);
  const directoryStable =
    final.rootIdentity === prior.rootIdentity &&
    JSON.stringify(final.directories) === JSON.stringify(prior.directories);
  const completeBudget =
    !final.incomplete &&
    ownedMatches &&
    directoryStable &&
    !changed &&
    final.bytes <= MAX_FOLDER_BYTES &&
    body.length <= MAX_JSON_BYTES;
  return {
    retention: completeBudget ? 'RETAINED' : 'INCOMPLETE',
    incomplete: packet.incomplete || !completeBudget,
    totalBytes: final.incomplete ? null : final.bytes,
    inspectedBytes: final.readBytes,
    jsonBytes: body.length,
    files: final.files,
    postWriteComplete: completeBudget,
  };
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
