import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  obtainNodeDistribution,
  readPortableNodeRuntime,
  resolvePortableServerTarget,
  stageNodeRuntime,
} from './portable-server-archive.mjs';

export async function stageDesktopNodeRuntime(projectRoot, outputRoot) {
  const target = resolvePortableServerTarget(
    process.platform,
    process.arch,
    readPortableNodeRuntime(projectRoot),
  );
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const requested =
    process.env.STATION_DESKTOP_TARGET_TRIPLE ??
    process.env.TAURI_ENV_TARGET_TRIPLE;
  if (requested && requested !== triples[target.id])
    throw new Error(
      `Desktop server staging requires a ${requested} build host; this host stages ${triples[target.id]}`,
    );
  const distribution = await obtainNodeDistribution(target, {
    cacheDir: join(projectRoot, 'node_modules/.cache/station-node'),
  });
  const runtime = join(outputRoot, 'runtime');
  stageNodeRuntime(target, distribution, runtime);
  const binary = join(
    projectRoot,
    'src-desktop/binaries',
    `station-node-${triples[target.id]}${process.platform === 'win32' ? '.exe' : ''}`,
  );
  mkdirSync(dirname(binary), { recursive: true });
  for (const file of readdirSync(dirname(binary))) {
    if (file.startsWith('station-node-')) rmSync(join(dirname(binary), file));
  }
  rmSync(binary, { force: true });
  renameSync(join(runtime, target.node.binary), binary);
  const license = join(outputRoot, 'dist-server/third-party/node/LICENSE');
  mkdirSync(dirname(license), { recursive: true });
  renameSync(join(runtime, 'LICENSE'), license);
  rmSync(runtime, { recursive: true });
}
