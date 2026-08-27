/**
 * Node-side `StorageAdapter` (station#1096 R2) — lets the CLI use the same
 * `KnownEnvironmentRegistry` (`./knownEnvironmentRegistry`) the browser uses
 * via `LocalStorageAdapter` (`./storage`), without either side importing the
 * other's runtime. Kept in its own module (not `./storage.ts`) specifically
 * so a browser bundle that imports `@kontourai/station-connect`'s main entry
 * never pulls in `node:fs` — only a caller that explicitly imports
 * `@kontourai/station-connect/node-storage` (the CLI) does.
 *
 * Stores every key/value pair in one JSON file (all keys this process's
 * `StorageAdapter` consumers ever use share the file), written with the same
 * atomic temp-file + rename discipline as
 * `packages/cli/src/commands/hosts.ts` — a crash mid-write can never leave a
 * half-parsed file behind.
 *
 * STATUS (honesty note, fix round 1, station#1096): this class is currently
 * UNWIRED — nothing in `packages/cli` constructs a `KnownEnvironmentRegistry`
 * backed by it. The CLI's own read path today is
 * `hostRegistryToKnownEnvironments` in `packages/cli/src/commands/hosts.ts`,
 * which reads `hosts.json` directly rather than going through this adapter
 * + the registry class. "One registry, two backends" describes the intended
 * end state, not what shipped: today it is a browser-backed registry
 * (`KnownEnvironmentRegistry` + `LocalStorageAdapter`) plus a separate
 * CLI-side read-adapter over its own existing store — this file exists and
 * is tested (`../__tests__/nodeStorage.test.ts`) so wiring the CLI onto the
 * shared registry is a drop-in follow-up, not new design. When that wiring
 * lands, close the parity gap with `host-credentials.ts` first: this
 * adapter's `writeFile` has no `O_EXCL|O_NOFOLLOW` symlink hardening or
 * `0o600` permission tightening the way `host-credentials.ts`'s writer does
 * — acceptable today only because `KnownEnvironment` holds no secrets, but a
 * gap worth closing before anything writes through this path for real.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { StorageAdapter } from './types';

function readFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    // A corrupt file must never wedge the caller: fall back to empty and let
    // the next write rewrite it (same rule as the CLI's hosts.json loader).
    return {};
  }
}

function writeFile(path: string, contents: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(contents, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, serialized, 'utf-8');
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}

export class NodeFileStorageAdapter implements StorageAdapter {
  constructor(private readonly path: string) {}

  get(key: string): string | null {
    const value = readFile(this.path)[key];
    return typeof value === 'string' ? value : null;
  }

  set(key: string, value: string): void {
    const contents = readFile(this.path);
    contents[key] = value;
    writeFile(this.path, contents);
  }

  remove(key: string): void {
    const contents = readFile(this.path);
    if (!(key in contents)) return;
    delete contents[key];
    writeFile(this.path, contents);
  }
}
