import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Install coordination and generated-tree retirement; not a user-data archive. */
export const DEPENDENCY_INSTALL_GUARD = '.station-dependency-install';
export const DEPENDENCY_INSTALL_RECORD_PREFIX = '.station-dependency-record-';

/** Freeze the selected tool paths before an installer can replace their tree.
 * @param {{ root: string, nodePath: string, npmCliPath?: string, commandPath?: string, scriptPath?: string, clean: boolean }} options
 */
export function prepareDependencyInstallDrivers({
  root,
  nodePath,
  npmCliPath,
  commandPath,
  scriptPath,
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
    ...(npmCliPath ? { npmCliPath: realpathSync(npmCliPath) } : {}),
    ...(commandPath ? { commandPath: realpathSync(commandPath) } : {}),
    ...(scriptPath ? { scriptPath: realpathSync(scriptPath) } : {}),
  };
  for (const [name, canonical] of Object.entries(drivers)) {
    if (!lstatSync(canonical).isFile() || (clean && inside(canonical)))
      throw new Error(
        `Dependency installation requires ${name} outside root node_modules; select an external Node/package-manager toolchain before retrying.`,
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
 * Callers requesting clean mode retire and clear only root node_modules before
 * installation. The pnpm lifecycle caller retires only npm/unidentified trees;
 * established pnpm installations preserve their store-backed dependency tree.
 * The caller must include ALL approved hooks and final verification in run().
 * Failed or interrupted installs leave their guard and any cleanup remnants
 * or partial new tree for inspection. This is not rollback, an archive, or protection
 * against hostile same-user processes/uncoordinated dependency writers.
 */
export function withDependencyInstallGuard({
  root,
  clean = true,
  retireLegacy = false,
  run,
  warn = console.warn,
  removeTree = rmSync,
  moveEntry = renameSync,
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
  let recordDirectory;
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
    const before = entry(modules);
    if (before && (before.isSymbolicLink() || !before.isDirectory()))
      throw new Error(
        'node_modules must be a real directory owned by this package root.',
      );
    // Decide only after obtaining the cooperative guard and checking the root
    // entry. Never follow a redirected node_modules merely to inspect markers.
    // A hybrid tree still carries npm's hidden lock: it must retire once too.
    if (retireLegacy) {
      const pnpmMarker = before && entry(join(modules, '.modules.yaml'));
      clean = Boolean(
        before &&
          (entry(join(modules, '.package-lock.json')) || !pnpmMarker?.isFile()),
      );
    }
    record('preparing');
    if (clean && before) {
      renameSync(modules, previous);
      retiredIdentity = before;
      assertOwned();
      record('retiring');
      removeTree(previous, {
        recursive: true,
        force: false,
        maxRetries: 2,
        retryDelay: 100,
      });
      // Removal ends this ownership. Never delete a subsequently reused name.
      retiredIdentity = undefined;
      if (entry(previous))
        throw new Error('Retired dependency pathname remains or was reused.');
    }
    if (clean && entry(modules))
      throw new Error(
        'Dependency target name was reused before package-manager admission.',
      );
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
    // Publish only exact entries, then use rmdir as the atomic empty check.
    const children = readdirSync(guard);
    if (
      !sameEntry(guard, guardIdentity) ||
      !sameEntry(receiptPath, receiptIdentity)
    )
      throw new Error('Dependency installer cleanup ownership changed.');
    const metadataPath = join(guard, '.DS_Store');
    const metadata = entry(metadataPath);
    const ordinaryMetadata =
      !metadata ||
      (metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.size <= 65_536);
    if (
      !ordinaryMetadata ||
      children.some((name) => name !== 'receipt.json' && name !== '.DS_Store')
    )
      throw new Error('Dependency installer guard has unknown children.');
    recordDirectory = mkdtempSync(
      join(canonicalRoot, `${DEPENDENCY_INSTALL_RECORD_PREFIX}${process.pid}-`),
    );
    const archivedReceipt = join(recordDirectory, 'receipt.json');
    moveEntry(receiptPath, archivedReceipt);
    const receiptPublished = sameEntry(archivedReceipt, receiptIdentity);
    let metadataPublished = true;
    if (metadata) {
      const current = entry(metadataPath);
      if (
        !current ||
        current.dev !== metadata.dev ||
        current.ino !== metadata.ino ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.size > 65_536
      )
        throw new Error(
          'Dependency installer metadata changed before publication.',
        );
      // A fresh record directory may acquire its own .DS_Store concurrently;
      // publish the captured source under a name Finder does not own.
      const archivedMetadata = join(
        recordDirectory,
        'macos-directory-metadata',
      );
      moveEntry(metadataPath, archivedMetadata);
      const published = entry(archivedMetadata);
      metadataPublished =
        Boolean(published) &&
        published.dev === metadata.dev &&
        published.ino === metadata.ino &&
        published.isFile() &&
        !published.isSymbolicLink() &&
        published.size <= 65_536;
    }
    if (
      !receiptPublished ||
      !metadataPublished ||
      readdirSync(guard).length !== 0
    )
      throw new Error('Dependency installer guard changed during publication.');
    // rmdir is the atomic final check: a raced-in child retains the fixed guard.
    rmdirSync(guard);
    return result;
  } catch {
    warn(
      `[dependency-lifecycle] Dependencies verified; installer guard cleanup is pending at ${JSON.stringify(guard)}${recordDirectory ? `; record state ${JSON.stringify(recordDirectory)}` : ''}. Inspect retained state before the next install.`,
    );
  }
  return result;
}
