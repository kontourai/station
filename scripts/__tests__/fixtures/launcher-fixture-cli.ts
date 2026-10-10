/**
 * The CLI a launcher test's archive version runs (#2675 D), bundled by
 * `bundleLauncherFixtureCli` into `lib/station-cli.mjs` (the real
 * bin/station.mjs imports it). Everything the launcher protocol depends on is
 * Station's real code: the launcher link (request pickup, staging, prepared,
 * the liveness handoff), the liveness records, and the home backup/restore of
 * `service update-home`. Only the server is fake: `service run` "serves"
 * without starting one, and behaves as `fixture.json` in the version
 * directory says.
 *
 * fixture.json: {
 *   trial?: 'prepare' | 'exit' | 'hang',   // what a trial of this version does
 *   ignoreTerm?: boolean,                   // `service run` ignores SIGTERM
 *   homeSchemaVersion?: number,             // a trial migrates the home to it
 *   stage?: 'real' | string                 // how an active child stages:
 *                                           // install.sh stage-only, or this version
 * }
 * Every event is appended to STATION_FIXTURE_LOG as `<version> <event>`.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createServiceLauncherLink,
  readServiceLauncherContext,
  stageServiceUpdate,
} from '../../../packages/cli/src/commands/service-launcher-link.js';
import {
  handOffServiceLivenessToLauncher,
  publishServiceLivenessRecord,
} from '../../../packages/cli/src/commands/service-liveness.js';
import { runServiceUpdateHome } from '../../../packages/cli/src/commands/service-update-home.js';
import { ensureStationHomeSchemaSync } from '../../../packages/shared/src/station-home-schema.js';

const versionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const version = basename(versionDir);
const args = process.argv.slice(2);
const flag = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const home = flag('base') ?? '';
const instanceName = flag('instance') ?? 'default';

const fixture: {
  trial?: 'prepare' | 'exit' | 'hang';
  ignoreTerm?: boolean;
  homeSchemaVersion?: number;
  stage?: string;
} = existsSync(join(versionDir, 'fixture.json'))
  ? JSON.parse(readFileSync(join(versionDir, 'fixture.json'), 'utf8'))
  : {};

function log(event: string): void {
  const file = process.env.STATION_FIXTURE_LOG;
  if (file) appendFileSync(file, `${version} ${event}\n`);
}

async function waitForGate(name: string): Promise<void> {
  const gate = process.env[name];
  if (!gate) return;
  log(`waiting ${name}`);
  // Bounded, so a gate a failed test never opens leaves no process behind.
  const deadline = Date.now() + 60_000;
  while (!existsSync(gate)) {
    if (Date.now() > deadline) throw new Error(`${name} never opened`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function serviceRun(): Promise<void> {
  const context = readServiceLauncherContext();
  if (!context) throw new Error('fixture service run needs a launcher');
  log(`run ${context.role}`);
  // A booting server establishes its home, as Station's does.
  // (A version that migrates the home knows its own schema; this fixture's
  // bundled Station code knows only the current one.)
  if (context.role === 'active' && fixture.homeSchemaVersion === undefined)
    ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  process.on('SIGTERM', () => {
    if (fixture.ignoreTerm) {
      log('term-ignored');
      return;
    }
    log('term');
    publishServiceLivenessRecord(target, false);
    process.exit(0);
  });
  const target = {
    instanceName,
    home,
    serverPort: 3999,
    uiPort: 3998,
  };
  const link = createServiceLauncherLink(
    {
      context,
      send: (message) => process.send?.(message),
      onMessage: (listener) => process.on('message', listener),
      onDisconnect: (listener) => process.once('disconnect', listener),
      handOffLiveness: (launcherPid) => {
        const block = Number(process.env.STATION_FIXTURE_HANDOFF_BLOCK_MS);
        if (block > 0) {
          // A supervisor too busy to confirm the handoff for a while.
          log('handoff-blocked');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, block);
        }
        handOffServiceLivenessToLauncher(target, launcherPid);
        log(`handoff ${launcherPid}`);
      },
      stage:
        fixture.stage === 'real'
          ? stageServiceUpdate
          : async ({ targetVersion }) =>
              fixture.stage ?? targetVersion ?? version,
      log,
    },
    () => {
      log('launcher-gone');
      process.exit(0);
    },
  );
  if (context.role === 'trial') {
    if (fixture.homeSchemaVersion !== undefined) {
      // The trial migrates the home, as a new Station's boot would.
      const marker = join(home, '.station-home-schema.json');
      const value = JSON.parse(readFileSync(marker, 'utf8'));
      writeFileSync(
        marker,
        `${JSON.stringify({ ...value, version: fixture.homeSchemaVersion })}\n`,
      );
      log(`schema ${fixture.homeSchemaVersion}`);
    }
    writeFileSync(join(home, 'config', 'trial-wrote.json'), `"${version}"\n`);
    if (fixture.trial === 'exit') {
      log('trial-exit');
      process.exit(3);
    }
    if (fixture.trial === 'hang') {
      log('trial-hang');
      setInterval(() => undefined, 1_000);
      return;
    }
  }
  publishServiceLivenessRecord(target, true);
  log('ready');
  link.onReady();
  setInterval(() => {
    // STATION_FIXTURE_ACTIVE_EXIT names a file whose appearance makes the
    // active child exit on its own (a crashed supervisor); it is consumed.
    const crash = process.env.STATION_FIXTURE_ACTIVE_EXIT;
    if (context.role === 'active' && crash && existsSync(crash)) {
      rmSync(crash, { force: true });
      log('active-exit');
      process.exit(4);
    }
    link.tick();
  }, 50);
}

async function main(): Promise<void> {
  if (args[0] === 'service' && args[1] === 'run') return serviceRun();
  if (args[0] === 'service' && args[1] === 'update-home') {
    log(`update-home ${args[2]}`);
    if (args[2] === 'backup') {
      await waitForGate('STATION_FIXTURE_BACKUP_GATE');
      if (process.env.STATION_FIXTURE_BACKUP_FAIL) {
        // The disk filled while the backup was written.
        throw Object.assign(
          new Error('ENOSPC: no space left on device, copyfile'),
          { code: 'ENOSPC' },
        );
      }
    }
    if (args[2] === 'restore' && process.env.STATION_FIXTURE_RESTORE_FAIL)
      throw Object.assign(new Error('EACCES: permission denied, rmdir'), {
        code: 'EACCES',
      });
    runServiceUpdateHome(args.slice(2), home);
    return;
  }
  if (args[0] === 'service' && args[1] === 'status') {
    // The unit of a service a launcher runs, as the service backend reports it.
    process.stdout.write(
      `${JSON.stringify({ unit: { active: true, present: true, enabled: true } })}\n`,
    );
    return;
  }
  if (args[0] === 'stop') {
    log('stop');
    return;
  }
  throw new Error(`fixture CLI does not model: ${args.join(' ')}`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
