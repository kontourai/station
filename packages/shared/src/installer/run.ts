/**
 * The installer core's entry (#2675 slice W): install.ps1 runs
 * `node <core> [install|uninstall [-PurgeData]]` with the caller's
 * environment, and this dispatches to stage-only, the full install or
 * uninstall.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installArchive, uninstallArchive } from './full-install.js';
import {
  fail,
  type InstallerEnv,
  type InstallerIo,
  InstallRefusal,
  removeTree,
  stageArchive,
} from './install.js';

/**
 * Runs the installer for `argv` and returns its exit status. Every refusal
 * prints `Station install failed: <reason>` and returns 1.
 */
export async function runInstaller(
  argv: readonly string[],
  env: InstallerEnv,
  io: InstallerIo,
): Promise<number> {
  const provided = env.STATION_INSTALLER_TEMP;
  let tmp: string;
  let ownsTmp = false;
  if (provided) {
    tmp = provided;
  } else {
    tmp = mkdtempSync(join(tmpdir(), 'station-install.'));
    ownsTmp = true;
  }
  const context = { env, io, tmp };
  try {
    const action = argv[0] ?? 'install';
    if (action === 'uninstall')
      return await uninstallArchive(context, argv.slice(1));
    if (action !== 'install')
      fail('usage: install.ps1 [install|uninstall [-PurgeData]]');
    if (argv.length > 1) fail(`unexpected argument: ${argv[1]}`);
    if (env.STATION_INSTALL_STAGE_ONLY === '1')
      return await stageArchive(context);
    return await installArchive(context);
  } catch (error) {
    if (error instanceof InstallRefusal) {
      io.err(`Station install failed: ${error.message}`);
      return 1;
    }
    io.err(
      `Station install failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  } finally {
    if (ownsTmp) removeTree(tmp);
  }
}
