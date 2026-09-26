// The entry both launchers run with the bundled Node.js. `--version` and `-v`
// report this archive's release identity and the Node.js actually executing
// (so a caller can confirm the bundled runtime, not a host Node.js, is in
// use); every other invocation is the Station CLI.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [first] = process.argv.slice(2);

if (first === '--version' || first === '-v') {
  // .station-release.json exists only in an assembled archive.
  const release = JSON.parse(
    readFileSync(join(root, '.station-release.json'), 'utf8'),
  );
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
  // Imported rather than run as the entry script: packages/cli/src/cli.ts
  // runs itself when process.argv[1] is its own module URL, which inside the
  // bundle it would be, running every command twice.
  await import(pathToFileURL(join(root, 'lib', 'station-cli.mjs')).href);
}
