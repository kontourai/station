import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface SanitizedPathEntry {
  entry: string;
  reason:
    | 'duplicate'
    | 'empty'
    | 'group-writable'
    | 'missing'
    | 'not-absolute'
    | 'not-directory'
    | 'untrusted-owner'
    | 'world-writable';
}

export interface LaunchPathFs {
  lstatSync: typeof lstatSync;
  realpathSync: typeof realpathSync;
}

export function sanitizePath(
  value: string | undefined,
  dependencies: LaunchPathFs = { lstatSync, realpathSync },
): { accepted: string[]; rejected: SanitizedPathEntry[] } {
  const accepted: string[] = [];
  const rejected: SanitizedPathEntry[] = [];
  const seen = new Set<string>();
  for (const entry of String(value ?? '').split(':')) {
    if (!entry) {
      rejected.push({ entry, reason: 'empty' });
      continue;
    }
    if (!path.isAbsolute(entry)) {
      rejected.push({ entry, reason: 'not-absolute' });
      continue;
    }
    let resolved: string;
    let info: ReturnType<typeof lstatSync>;
    try {
      resolved = dependencies.realpathSync(entry);
      info = dependencies.lstatSync(resolved);
    } catch {
      rejected.push({ entry, reason: 'missing' });
      continue;
    }
    if (!info.isDirectory()) {
      rejected.push({ entry, reason: 'not-directory' });
      continue;
    }
    let inspected = resolved;
    let unsafeReason: SanitizedPathEntry['reason'] | undefined;
    while (true) {
      const inspectedInfo =
        inspected === resolved ? info : dependencies.lstatSync(inspected);
      const currentUid = process.getuid?.();
      if (
        currentUid !== undefined &&
        inspectedInfo.uid !== 0 &&
        inspectedInfo.uid !== currentUid
      ) {
        unsafeReason = 'untrusted-owner';
        break;
      }
      // A sticky ancestor such as /tmp does not let another user replace an
      // entry owned by this user. The leaf itself never receives this
      // exception because its executable search contents remain mutable.
      const protectedStickyAncestor =
        inspected !== resolved && (inspectedInfo.mode & 0o1000) !== 0;
      if (!protectedStickyAncestor && (inspectedInfo.mode & 0o020) !== 0) {
        unsafeReason = 'group-writable';
        break;
      }
      if (!protectedStickyAncestor && (inspectedInfo.mode & 0o002) !== 0) {
        unsafeReason = 'world-writable';
        break;
      }
      const parent = path.dirname(inspected);
      if (parent === inspected) break;
      inspected = parent;
    }
    if (unsafeReason) {
      rejected.push({ entry, reason: unsafeReason });
      continue;
    }
    if (seen.has(resolved)) {
      rejected.push({ entry, reason: 'duplicate' });
      continue;
    }
    seen.add(resolved);
    accepted.push(resolved);
  }
  return { accepted, rejected };
}
