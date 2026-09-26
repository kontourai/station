// Prints the identity of a portable Station server archive: the release it was
// packaged as, and the Node.js runtime that is actually executing, so a
// caller can confirm the bundled runtime (not a host Node.js) is in use.
import { readFileSync } from 'node:fs';

const release = JSON.parse(
  readFileSync(new URL('../.station-release.json', import.meta.url), 'utf8'),
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
