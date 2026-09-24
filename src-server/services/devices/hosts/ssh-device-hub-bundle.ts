/**
 * The verified hub tree Station sends to an SSH device host (#1973).
 *
 * The source is Station's OWN install of the pinned expo-device-hub
 * (`<STATION_HOME>/devices/tools/expo-device-hub/<version>/`), which exists
 * only after `device-toolchain.ts` fetched it from the pinned lockfile and
 * `device-tool-verify.ts` checked every integrity and the tool's own bytes.
 * The manifest lists every regular file under its `node_modules` with its
 * sha256; the host re-hashes each file as it arrives and publishes nothing
 * unless all match (`ssh-device-remote-script.ts`). Symlinks (npm's `.bin`
 * links) are not sent: nothing Station runs resolves through them.
 *
 * `digest` is the sha256 of the manifest itself, recorded in the host's
 * sentinel and naming the directory the tree is published into. "Installed"
 * on the host therefore means "this exact tree was verified AT INSTALL
 * TIME"; later starts trust the install sentinel and do not re-hash the
 * files (see `ssh-device-remote-script.ts`).
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

export interface HubBundleFile {
  /** `node_modules/…`, `/`-separated, relative to the install directory. */
  path: string;
  size: number;
  sha256: string;
  exec: boolean;
}

export interface HubBundle {
  version: string;
  installDir: string;
  files: HubBundleFile[];
  digest: string;
  totalBytes: number;
}

const MAX_FILES = 20_000;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Build the manifest of a verified install. Throws when the tree is unusable. */
export function buildHubBundle(installDir: string, version: string): HubBundle {
  const files: HubBundleFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const path = join(dir, entry.name);
      const relPath = `${rel}/${entry.name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path, relPath);
      else if (stat.isFile()) {
        files.push({
          path: relPath,
          size: stat.size,
          sha256: sha256File(path),
          exec: (stat.mode & 0o111) !== 0,
        });
        if (files.length > MAX_FILES)
          throw new Error('The hub install has too many files to send.');
      }
    }
  };
  walk(join(installDir, 'node_modules'), 'node_modules');
  if (files.length === 0) throw new Error('The hub install is empty.');
  const digest = createHash('sha256')
    .update(JSON.stringify({ version, files }))
    .digest('hex');
  return {
    version,
    installDir,
    files,
    digest,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

/** Memoized per install directory: rebuilt only when the sentinel changes. */
export function createHubBundleCache(): (
  installDir: string,
  version: string,
) => HubBundle {
  let cached: { key: string; bundle: HubBundle } | undefined;
  return (installDir, version) => {
    let mtime = 0;
    try {
      mtime = statSync(join(installDir, '.install-complete')).mtimeMs;
    } catch {
      // Unknown: rebuild.
    }
    const key = `${installDir}\0${version}\0${mtime}`;
    if (cached?.key !== key)
      cached = { key, bundle: buildHubBundle(installDir, version) };
    return cached.bundle;
  };
}

/**
 * Stream the bundle's bytes in manifest order. A file whose size changed
 * since the manifest was built stops the stream (the host would then reject
 * the install on its hash check anyway).
 */
export async function writeHubBundle(
  bundle: HubBundle,
  stdin: Writable,
): Promise<void> {
  for (const file of bundle.files) {
    const source = join(bundle.installDir, ...file.path.split('/'));
    if (statSync(source).size !== file.size)
      throw new Error('The hub install changed while it was being sent.');
    for await (const chunk of createReadStream(source)) {
      if (!stdin.write(chunk))
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            stdin.off('error', onError);
            resolve();
          };
          const onError = (error: Error) => {
            stdin.off('drain', onDrain);
            reject(error);
          };
          stdin.once('drain', onDrain);
          stdin.once('error', onError);
        });
    }
  }
}
