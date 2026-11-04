import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runInProcessGroup } from '../utils/process-group-exec.js';
import {
  COMPANION_FILES,
  type CompanionBuildManifest,
  verifyTelemetryCompanion,
} from './telemetry-companion-artifact.mjs';

/** Materializes fixed text files only; tar never writes paths into the host filesystem. */
export async function materializeTelemetryCompanion(input: {
  archive: string;
  destination: string;
  source: string;
  expectedBytes: number;
  expectedSha256: string;
  signal: AbortSignal;
  requireOperator(): Promise<void>;
}): Promise<CompanionBuildManifest> {
  const original = await open(
    input.archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const identity = await original.stat();
    if (!identity.isFile() || identity.size !== input.expectedBytes)
      throw new Error('Companion archive changed');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < identity.size; ) {
      input.signal.throwIfAborted();
      const { bytesRead } = await original.read(
        buffer,
        0,
        Math.min(buffer.length, identity.size - position),
        position,
      );
      if (!bytesRead) throw new Error('Companion archive truncated');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (hash.digest('hex') !== input.expectedSha256)
      throw new Error('Companion archive digest mismatch');
    await input.requireOperator();
    await mkdir(input.destination, { mode: 0o700 });
    const directories = new Set([input.destination]);
    for (const path of ['companion-manifest.json', ...COMPANION_FILES]) {
      await input.requireOperator();
      input.signal.throwIfAborted();
      // Each fresh descriptor starts at zero and must still name the authenticated inode.
      const file = await open(
        input.archive,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let value: string;
      try {
        const current = await file.stat();
        if (
          !current.isFile() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          current.size !== identity.size ||
          current.mtimeMs !== identity.mtimeMs ||
          current.ctimeMs !== identity.ctimeMs
        )
          throw new Error('Companion archive changed');
        const result = await runInProcessGroup(
          'tar',
          ['-xOzf', '-', '--', `station/telemetry-companion/${path}`],
          {
            inputFileDescriptor: file.fd,
            env: { ...process.env, TAR_OPTIONS: undefined, GZIP: undefined },
            timeout: 30_000,
            maxBuffer:
              path === 'companion-manifest.json' ? 64 * 1024 : 32 * 1024 * 1024,
            signal: input.signal,
            retireDescendantsOnExit: true,
          },
        );
        value = result.stdout;
      } finally {
        await file.close();
      }
      const target = join(input.destination, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      for (let directory = dirname(target); ; directory = dirname(directory)) {
        directories.add(directory);
        if (directory === input.destination) break;
      }
      await writeFile(target, value, { mode: 0o600, flag: 'wx' });
      const written = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await written.sync();
      } finally {
        await written.close();
      }
    }
    const after = await original.stat();
    if (
      after.mtimeMs !== identity.mtimeMs ||
      after.ctimeMs !== identity.ctimeMs
    )
      throw new Error('Companion archive changed');
    const manifest = await verifyTelemetryCompanion(input.destination);
    if (manifest.source !== input.source)
      throw new Error('Companion payload source mismatch');
    for (const directory of [...directories].sort(
      (a, b) => b.length - a.length,
    )) {
      const handle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await input.requireOperator();
    input.signal.throwIfAborted();
    return manifest;
  } finally {
    await original.close();
  }
}
