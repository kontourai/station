import { resolve } from 'node:path';
import {
  assertNativeClientBuildManifestBytes,
  readNativeClientBuildManifest,
  stageNativeClientBuildManifest,
  writeNativeClientBuildManifest,
} from './lib/desktop-build-manifest.mjs';

function usage() {
  throw new Error(
    'Usage: release-client-build-provenance.mjs <create|stage|verify> --source-sha <sha> [--source-ref <ref>] [--artifact <path>] [--expected <path>] [--actual <path>]',
  );
}

function options(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || values.has(key)) usage();
    values.set(key, value);
  }
  return values;
}

const [command, ...args] = process.argv.slice(2);
const values = options(args);
const sourceSha = values.get('--source-sha');
if (!sourceSha) usage();
const root = process.cwd();

if (command === 'create') {
  const sourceRef = values.get('--source-ref');
  if (!sourceRef) usage();
  const path = writeNativeClientBuildManifest(root, {
    refresh: true,
    env: { ...process.env, STATION_BUILD_BRANCH: sourceRef },
  });
  const manifest = readNativeClientBuildManifest(root);
  if (!path || !manifest || manifest.sha !== sourceSha) {
    throw new Error(
      'Could not create a native client build manifest for the bound release source.',
    );
  }
  console.log(path);
} else if (command === 'stage') {
  const artifact = values.get('--artifact');
  if (!artifact) usage();
  console.log(
    stageNativeClientBuildManifest(root, resolve(artifact), {
      expectedSha: sourceSha,
    }),
  );
} else if (command === 'verify') {
  const expected = values.get('--expected');
  const actual = values.get('--actual');
  if (!expected || !actual) usage();
  assertNativeClientBuildManifestBytes(resolve(expected), resolve(actual), {
    expectedSha: sourceSha,
  });
} else {
  usage();
}
