import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isTelemetryCompanionOperationId,
  TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL,
  type TelemetryCompanionArchivePreparation,
} from '@kontourai/station-contracts/telemetry-delivery';
import { writeJsonAtomically } from '@kontourai/station-shared/service-launcher-protocol';
import { z } from 'zod/v3';
import type { InstallProvenance } from '../routes/system/install-provenance.js';
import { readCompanionFile } from './telemetry-companion-artifact.mjs';
import {
  type CompanionParentVerificationOptions,
  readTelemetryCompanionVerifiedParent,
} from './telemetry-companion-release.js';

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const receiptSchema = z
  .object({
    protocol: z.literal(TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL),
    operationId: z.string().refine(isTelemetryCompanionOperationId),
    phase: z.enum(['pending', 'authenticated', 'failed']),
    version: z.string().min(1).max(128),
    source: z.string().regex(/^[a-f0-9]{40}$/),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedBytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
    receivedBytes: z.number().int().nonnegative().max(MAX_ARCHIVE_BYTES),
    createdAt: z.string().datetime(),
    installationAuthority: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      value.receivedBytes <= value.expectedBytes &&
      (value.phase !== 'authenticated' ||
        value.receivedBytes === value.expectedBytes),
  );

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!errno(error, 'EEXIST')) throw error;
    }
  }
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()))
  )
    throw new Error('Companion private storage unavailable');
}

async function preparationRoot(home: string, create: boolean): Promise<string> {
  const root = join(await realpath(home), 'telemetry-companion');
  await privateDirectory(root, create);
  const preparations = join(root, 'archive-preparations');
  await privateDirectory(preparations, create);
  return preparations;
}

async function durableJson(path: string, value: unknown): Promise<void> {
  writeJsonAtomically(path, value);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export class CompanionArchivePreparationBusyError extends Error {
  constructor() {
    super('A companion preparation needs reconciliation');
  }
}

/** This read never resumes work or interprets a pending receipt as a live process. */
export async function readTelemetryCompanionArchivePreparation(
  home: string,
  operationId: string,
): Promise<TelemetryCompanionArchivePreparation | null> {
  if (!isTelemetryCompanionOperationId(operationId))
    throw new Error('Invalid companion operation');
  try {
    const root = await preparationRoot(home, false);
    const directory = join(root, operationId);
    await privateDirectory(directory, false);
    const receipt = receiptSchema.parse(
      JSON.parse(
        (
          await readCompanionFile(join(directory, 'receipt.json'), 8192)
        ).toString(),
      ),
    );
    if (receipt.operationId !== operationId)
      throw new Error('Companion receipt identity mismatch');
    return receipt;
  } catch (error) {
    if (errno(error, 'ENOENT')) return null;
    throw error;
  }
}

async function downloadResponse(
  url: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
  requireOperator: () => Promise<void>,
): Promise<Response> {
  for (let hop = 0; ; hop += 1) {
    await requireOperator();
    signal.throwIfAborted();
    const response = await fetchFn(url, {
      signal,
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: {
        accept: 'application/octet-stream',
        'accept-encoding': 'identity',
      },
    });
    if (response.status < 300 || response.status > 399) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || hop >= 3)
      throw new Error('Companion download redirect refused');
    if (
      [...location].some(
        (character) => character <= ' ' || character === '\u007f',
      )
    )
      throw new Error('Companion download redirect refused');
    const next = new URL(location, url);
    if (
      next.protocol !== 'https:' ||
      next.username ||
      next.password ||
      next.hash
    )
      throw new Error('Companion download redirect refused');
    url = next.href;
  }
}

async function receiveArchive(
  response: Response,
  file: FileHandle,
  expectedBytes: number,
  receipt: TelemetryCompanionArchivePreparation,
): Promise<string> {
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  if (
    response.status !== 200 ||
    !response.body ||
    (encoding && encoding.toLowerCase() !== 'identity') ||
    (length !== null &&
      (!/^\d+$/.test(length) || Number(length) !== expectedBytes))
  ) {
    await response.body?.cancel();
    throw new Error('Companion download refused');
  }
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (receipt.receivedBytes + value.byteLength > expectedBytes)
        throw new Error('Companion signed size exceeded');
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten === 0)
          throw new Error('Companion archive write made no progress');
        offset += bytesWritten;
      }
      receipt.receivedBytes += value.byteLength;
      hash.update(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return hash.digest('hex');
}

/** Authenticates bytes only; never extracts, executes, installs, enables sending or retries. */
export async function prepareTelemetryCompanionArchive(
  provenance: InstallProvenance,
  input: {
    home: string;
    operationId: string;
    requireOperator(): Promise<void>;
    signal?: AbortSignal;
    fetchFn?: typeof fetch;
    verification?: CompanionParentVerificationOptions;
  },
): Promise<TelemetryCompanionArchivePreparation> {
  if (
    process.platform === 'win32' ||
    !isTelemetryCompanionOperationId(input.operationId)
  )
    throw new Error('Companion archive preparation unsupported');
  await input.requireOperator();
  const existing = await readTelemetryCompanionArchivePreparation(
    input.home,
    input.operationId,
  );
  if (existing) return existing;
  const parent = await readTelemetryCompanionVerifiedParent(
    provenance,
    input.verification,
  );
  if (
    parent.kind !== 'verified' ||
    parent.artifact.format !== 'tar.gz' ||
    parent.artifact.size > MAX_ARCHIVE_BYTES
  )
    throw new Error('Companion parent archive unavailable');
  const receipt: TelemetryCompanionArchivePreparation = receiptSchema.parse({
    protocol: TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL,
    operationId: input.operationId,
    phase: 'pending',
    version: parent.release.version,
    source: parent.release.sourceSha,
    artifactSha256: parent.artifact.sha256,
    expectedBytes: parent.artifact.size,
    receivedBytes: 0,
    createdAt: new Date().toISOString(),
    installationAuthority: false,
  });
  await input.requireOperator();
  const root = await preparationRoot(input.home, true);
  const lockPath = join(root, 'preparation.lock');
  let lock: FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (!errno(error, 'EEXIST')) throw error;
    const prior = await readTelemetryCompanionArchivePreparation(
      input.home,
      input.operationId,
    );
    if (prior) return prior;
    throw new CompanionArchivePreparationBusyError();
  }
  let lockIdentity: { dev: number; ino: number } | undefined;
  const directory = join(root, input.operationId);
  let directoryOwned = false;

  try {
    lockIdentity = await lock.stat();
    await lock.writeFile(
      JSON.stringify({ operationId: input.operationId, pid: process.pid }),
    );
    await lock.sync();
    await mkdir(directory, { mode: 0o700 });
    directoryOwned = true;
    await syncDirectory(root);
    await durableJson(join(directory, 'intent.json'), {
      operationId: input.operationId,
      envelope: parent.envelope,
      artifact: parent.artifact,
    });
    await durableJson(join(directory, 'receipt.json'), receipt);
    const signal = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const file = await open(
      join(directory, 'parent-archive.tar.gz'),
      'wx',
      0o600,
    );
    try {
      const response = await downloadResponse(
        parent.artifact.url,
        signal,
        input.fetchFn ?? fetch,
        input.requireOperator,
      );
      let digest: string;
      try {
        await input.requireOperator();
        digest = await receiveArchive(
          response,
          file,
          parent.artifact.size,
          receipt,
        );
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      if (
        receipt.receivedBytes !== parent.artifact.size ||
        digest !== parent.artifact.sha256
      )
        throw new Error('Companion archive identity mismatch');
      await file.sync();
    } finally {
      await file.close();
    }
    await input.requireOperator();
    signal.throwIfAborted();
    receipt.phase = 'authenticated';
    await durableJson(join(directory, 'receipt.json'), receipt);
    return receipt;
  } catch {
    if (!directoryOwned) throw new CompanionArchivePreparationBusyError();
    receipt.phase = 'failed';
    await durableJson(join(directory, 'receipt.json'), receipt);
    return receipt;
  } finally {
    await lock.close();
    if (!lockIdentity) throw new CompanionArchivePreparationBusyError();
    const current = await lstat(lockPath);
    if (
      !current.isSymbolicLink() &&
      current.dev === lockIdentity.dev &&
      current.ino === lockIdentity.ino
    ) {
      await unlink(lockPath);
      await syncDirectory(root);
    }
  }
}
