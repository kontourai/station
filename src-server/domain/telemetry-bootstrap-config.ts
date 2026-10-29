import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';

/** Reads only the existing config document; no migration, mutation or instrumentation imports. */
export function observeOtelBootstrapConfig(
  homeDir: string,
): Pick<AppConfig, 'otelTelemetryEndpoint' | 'otelTelemetryKeyRef'> {
  let descriptor: number | undefined;
  try {
    const directory = lstatSync(join(homeDir, 'config'));
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error();
    descriptor = openSync(
      join(homeDir, 'config', 'app.json'),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.size > 2 * 1024 * 1024) throw new Error();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    let offset = 0;
    for (;;) {
      const read = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (read === 0) break;
      offset += read;
      if (offset === bytes.length) throw new Error();
    }
    const document: unknown = JSON.parse(
      bytes.subarray(0, offset).toString('utf8'),
    );
    if (!document || typeof document !== 'object' || Array.isArray(document))
      throw new Error();
    const result: Pick<
      AppConfig,
      'otelTelemetryEndpoint' | 'otelTelemetryKeyRef'
    > = {};
    for (const name of [
      'otelTelemetryEndpoint',
      'otelTelemetryKeyRef',
    ] as const) {
      if (!(name in document)) continue;
      const value = (document as Record<string, unknown>)[name];
      if (typeof value !== 'string') throw new Error();
      if (!value.trim()) continue;
      if (
        value !== value.trim() ||
        (name === 'otelTelemetryKeyRef' &&
          !/^[a-z][a-z0-9-]{0,63}$/.test(value))
      )
        throw new Error();
      if (name === 'otelTelemetryEndpoint') {
        const address = new URL(value);
        if (
          value.length > 2048 ||
          !['http:', 'https:'].includes(address.protocol) ||
          address.username ||
          address.password ||
          address.search ||
          address.hash
        )
          throw new Error();
      }
      result[name] = value;
    }
    if (
      Object.keys(result).length &&
      process.platform !== 'win32' &&
      ((file.mode & 0o077) !== 0 ||
        (process.getuid && file.uid !== process.getuid()))
    )
      throw new Error();
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Saved OTel configuration could not be admitted.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
