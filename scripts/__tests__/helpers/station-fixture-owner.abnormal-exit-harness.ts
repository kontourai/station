import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProcessFingerprint } from '../../../packages/cli/src/commands/platform.js';
import { StationFixtureOwner } from './station-fixture-owner.js';

const root = mkdtempSync(join(tmpdir(), 'station-fixture-owner-abnormal-'));
const statePath = join(root, 'instance.json');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)'], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
if (!child.pid) throw new Error('fixture child has no pid');
const fingerprint = inspectProcessFingerprint(child.pid);
if (!fingerprint) throw new Error('fixture child has no fingerprint');
writeFileSync(
  statePath,
  JSON.stringify({ serverPid: child.pid, serverFingerprint: fingerprint }),
  { mode: 0o600 },
);

const owner = new StationFixtureOwner();
owner.registerStatePath(statePath);
owner.capturePublishedBoot(statePath);
owner.installAbnormalExitReaper();
process.stdout.write(`${JSON.stringify({ pid: child.pid, fingerprint })}\n`);
setInterval(() => {}, 10_000);
