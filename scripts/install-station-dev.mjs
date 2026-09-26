#!/usr/bin/env node

/**
 * Installs `station-dev` (station#4536) onto a global `PATH` by COPYING
 * `scripts/station-dev.mjs` — never symlinking. A symlink into one checkout
 * is exactly the fixed-pointer failure `station-dev` exists to avoid
 * (`npm link`'s failure mode); a copy makes every installed `station-dev`
 * independent of whichever checkout happened to run this installer, and
 * each invocation still re-resolves its own target from the caller's cwd.
 *
 * Destination: `${STATION_DEV_BIN:-$HOME/.local/bin}/station-dev`. Refuses to
 * overwrite a file that does not carry this shim's marker comment line — see
 * `scripts/station-dev.mjs`'s `station-dev-shim-marker` line — so it can
 * never silently clobber something unrelated that happens to occupy the same
 * path.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';

export const SHIM_MARKER = '// station-dev-shim-marker: v1';
const SHEBANG = '#!/usr/bin/env node';

/** Short, stable stamp identifying exactly which shim bytes are installed. */
export function stampFor(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

/** Prepends a shebang line only when the content does not already start with one. */
export function withShebang(content) {
  return content.startsWith('#!') ? content : `${SHEBANG}\n${content}`;
}

/**
 * Pure decision logic, exercised directly by tests without touching the
 * filesystem: given the source shim content and what (if anything) already
 * exists at the destination, what should the installer do?
 */
export function planInstall({ sourceContent, existingContent }) {
  if (existingContent !== undefined && !existingContent.includes(SHIM_MARKER)) {
    return {
      action: 'refuse',
      reason:
        'refusing to overwrite: an existing file at the destination does not carry the station-dev shim marker',
    };
  }
  return { action: 'write', content: withShebang(sourceContent) };
}

export function isOnPath(
  dir,
  { pathEnv = process.env.PATH ?? '', sep = delimiter } = {},
) {
  const entries = pathEnv.split(sep).filter(Boolean);
  return entries.includes(dir);
}

export function install({
  sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'station-dev.mjs'),
  destDir = process.env.STATION_DEV_BIN || join(homedir(), '.local', 'bin'),
  destName = 'station-dev',
  fs = { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync },
  env = process.env,
} = {}) {
  const sourceContent = fs.readFileSync(sourcePath, 'utf8');
  const destPath = join(destDir, destName);
  const existingContent = fs.existsSync(destPath)
    ? fs.readFileSync(destPath, 'utf8')
    : undefined;

  const plan = planInstall({ sourceContent, existingContent });
  if (plan.action === 'refuse') {
    return { ok: false, destPath, reason: plan.reason };
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(destPath, plan.content, { mode: 0o755 });
  fs.chmodSync(destPath, 0o755);

  return {
    ok: true,
    destPath,
    stamp: stampFor(plan.content),
    onPath: isOnPath(destDir, { pathEnv: env.PATH ?? '' }),
    destDir,
  };
}

if (invokedDirectly(import.meta.url)) {
  const result = install();
  if (!result.ok) {
    process.stderr.write(
      `install-station-dev: ${result.reason} (${result.destPath})\n`,
    );
    process.stderr.write(
      'Remove or rename the existing file, or set STATION_DEV_BIN to a different directory, then retry.\n',
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `station-dev installed: ${result.destPath} (${result.stamp})\n`,
    );
    if (!result.onPath) {
      process.stdout.write(
        `${result.destDir} is not on PATH. Add it, e.g.: export PATH="${result.destDir}:$PATH"\n`,
      );
    }
  }
}
