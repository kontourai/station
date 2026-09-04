import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Install coordination and generated-tree retirement; not a user-data archive. */
export const DEPENDENCY_INSTALL_GUARD = '.station-dependency-install';

/** Freeze the selected tool paths before CI can move their former directory. */
export function prepareDependencyInstallDrivers({
  root,
  nodePath,
  npmCliPath,
  clean,
}) {
  const modules = join(realpathSync(root), 'node_modules');
  const inside = (path) => {
    const part = relative(modules, resolve(path));
    return (
      part === '' ||
      (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
    );
  };
  const drivers = {
    nodePath: realpathSync(nodePath),
    npmCliPath: realpathSync(npmCliPath),
  };
  for (const [name, canonical] of Object.entries(drivers)) {
    if (!lstatSync(canonical).isFile() || (clean && inside(canonical)))
      throw new Error(
        `Clean dependency installation requires ${name} outside root node_modules; select an external Node/npm toolchain before retrying.`,
      );
  }
  return drivers;
}

function entry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameEntry(path, expected) {
  const current = entry(path);
  return (
    current &&
    !current.isSymbolicLink() &&
    current.dev === expected.dev &&
    current.ino === expected.ino
  );
}

/**
 * Participating installers exclude one another; there is no PID/age reclaim.
 * CI retires only root node_modules, on the same filesystem, before npm runs.
 * The caller must include ALL approved hooks and final verification in run().
 * Failed or interrupted installs leave their guard and previous tree for
 * explicit inspection. This is not rollback, a home archive, or protection
 * against hostile same-user processes/uncoordinated dependency writers.
 */
export function withDependencyInstallGuard({
  root,
  clean = true,
  run,
  warn = console.warn,
  removeTree = rmSync,
}) {
  const canonicalRoot = realpathSync(root);
  const rootIdentity = lstatSync(canonicalRoot);
  const manifest = entry(join(canonicalRoot, 'package.json'));
  if (
    !rootIdentity.isDirectory() ||
    !manifest?.isFile() ||
    manifest.isSymbolicLink()
  )
    throw new Error('Dependency installation requires a real package root.');
  const guard = join(canonicalRoot, DEPENDENCY_INSTALL_GUARD);
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error(
        `Dependency installer guard already exists at ${JSON.stringify(guard)}. Inspect the live installer and retained state; do not reclaim by PID or age.`,
        { cause: error },
      );
    throw error;
  }
  const guardIdentity = lstatSync(guard);
  const modules = join(canonicalRoot, 'node_modules');
  const previous = join(guard, 'node_modules');
  const receiptPath = join(guard, 'receipt.json');
  let receiptFd;
  let receiptIdentity;
  let retiredIdentity;
  let result;
  const record = (phase) => {
    const text = `${JSON.stringify({ version: 1, pid: process.pid, phase, clean, previousRootTree: Boolean(retiredIdentity) })}\n`;
    ftruncateSync(receiptFd, 0);
    if (writeSync(receiptFd, text, 0, 'utf8') !== Buffer.byteLength(text))
      throw new Error('Dependency installer receipt was not fully written.');
    fsyncSync(receiptFd);
  };
  const assertOwned = () => {
    if (
      !sameEntry(canonicalRoot, rootIdentity) ||
      !sameEntry(guard, guardIdentity) ||
      !sameEntry(receiptPath, receiptIdentity) ||
      (retiredIdentity && !sameEntry(previous, retiredIdentity))
    )
      throw new Error(
        'Dependency installer ownership changed; refusing cleanup.',
      );
  };
  try {
    receiptFd = openSync(receiptPath, 'wx', 0o600);
    receiptIdentity = fstatSync(receiptFd);
    record('preparing');
    const before = entry(modules);
    if (before && (before.isSymbolicLink() || !before.isDirectory()))
      throw new Error(
        'node_modules must be a real directory owned by this package root.',
      );
    if (clean && before) {
      renameSync(modules, previous);
      retiredIdentity = before;
      assertOwned();
    }
    record('installing');
    result = run();
    if (result && typeof result.then === 'function')
      throw new Error('Dependency installation must settle synchronously.');
    assertOwned();
    record('verified');
    closeSync(receiptFd);
    receiptFd = undefined;
  } catch (error) {
    if (receiptFd !== undefined) {
      // The descriptor still names our own receipt even if its pathname moved.
      try {
        record('failed');
      } catch {
        /* Existing guard still blocks admission. */
      }
      try {
        closeSync(receiptFd);
      } catch {
        /* Preserve the original failure. */
      }
    }
    throw new Error(
      `Dependencies are not verified. Installer state is retained at ${JSON.stringify(guard)}; inspect it before recovery or another install. Do not run gates against a partial node_modules tree.`,
      { cause: error },
    );
  }
  try {
    assertOwned();
    if (retiredIdentity)
      removeTree(previous, {
        recursive: true,
        force: false,
        maxRetries: 2,
        retryDelay: 100,
      });
    // Never recursively remove the guard: unexpected children stay visible.
    if (
      !sameEntry(guard, guardIdentity) ||
      !sameEntry(receiptPath, receiptIdentity)
    )
      throw new Error('Dependency installer cleanup ownership changed.');
    unlinkSync(receiptPath);
    rmdirSync(guard);
  } catch {
    warn(
      `[dependency-lifecycle] Dependencies verified; prior generated-tree cleanup is pending at ${JSON.stringify(guard)}. Inspect retained state before the next install.`,
    );
  }
  return result;
}
