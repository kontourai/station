// The entry both launchers run with the bundled Node.js. `--version` and `-v`
// report this archive's release identity and the Node.js actually executing
// (so a caller can confirm the bundled runtime, not a host Node.js, is in
// use); every other invocation is the Station CLI.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [first] = process.argv.slice(2);
// .station-release.json exists only in an assembled archive.
const release = JSON.parse(
  readFileSync(join(root, '.station-release.json'), 'utf8'),
);

if (first === '--version' || first === '-v') {
  const identity = {
    ref: release.ref,
    sha: release.sha,
    channel: release.channel,
    releaseChannel: release.releaseChannel,
    node: process.version,
    execPath: process.execPath,
    platform: `${process.platform}-${process.arch}`,
  };
  process.stdout.write(
    process.argv.includes('--json')
      ? `${JSON.stringify(identity)}\n`
      : `Station ${identity.ref} (${identity.sha.slice(0, 12)}, ${identity.channel}) on Node.js ${identity.node} ${identity.platform}\n`,
  );
} else {
  // The CLI's source bootstrap reads STATION_CHANNEL to pick the channel and,
  // unless STATION_INSTANCE_ID is set, uses that channel as the instance --
  // which is how install.sh's launcher runs a release (it exports the
  // channel). Unset, it would treat this archive as a development checkout
  // and try to rebuild it. The archive's own channel is the one its server
  // bundle baked, so a different explicit channel is refused, not honored.
  const configured = process.env.STATION_CHANNEL?.trim();
  if (configured && configured !== release.channel) {
    process.stderr.write(
      `Error: this Station archive is the ${release.channel} channel; STATION_CHANNEL=${configured} cannot run it.\n`,
    );
    process.exit(1);
  }
  process.env.STATION_CHANNEL = release.channel;
  // Imported rather than run as the entry script: packages/cli/src/cli.ts
  // runs itself when process.argv[1] is its own module URL, which inside the
  // bundle it would be, running every command twice.
  await import(pathToFileURL(join(root, 'lib', 'station-cli.mjs')).href);
}
