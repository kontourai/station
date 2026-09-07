import { execFileSync } from 'node:child_process';

function run(program, args, env = process.env) {
  execFileSync(program, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
}

const node = process.execPath;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run(node, ['scripts/write-native-client-build-manifest.mjs', '--refresh']);
run(node, ['scripts/channel-ports.mjs', '--sync-desktop']);
// The spawned server build is the one nested operation allowed to reuse this
// transaction's native stamp. Passing it in an explicit child env is portable
// across cmd.exe, PowerShell, and POSIX shells.
run(npm, ['run', 'build'], { ...process.env, STATION_CLIENT_BUILD_REUSE: '1' });
run(node, ['scripts/write-desktop-build-manifest.mjs']);
run(node, ['scripts/stage-desktop-server-runtime.mjs']);
