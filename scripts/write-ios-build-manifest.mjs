import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_MANIFEST_FILENAME,
  readNativeClientBuildManifest,
} from './lib/desktop-build-manifest.mjs';

const projectRoot = process.cwd();
const manifest = readNativeClientBuildManifest(projectRoot);
const appleProjectDir = join(projectRoot, 'src-desktop', 'gen', 'apple');
const assetsDir = join(appleProjectDir, 'assets');
if (!existsSync(appleProjectDir)) {
  throw new Error(
    `Cannot stage iOS build provenance: ${assetsDir} does not exist. Run \`npx tauri ios init\` first.`,
  );
}
if (!manifest) {
  console.warn(
    'No staged native client build provenance; iOS package will report no immutable artifact timestamp.',
  );
} else {
  // `assets/` is intentionally gitignored and may not exist immediately after
  // Tauri init. project.yml declares it as an iOS resource folder, so create
  // it before Xcode generation/build rather than treating absence as failure.
  mkdirSync(assetsDir, { recursive: true });
  const source = join(projectRoot, 'src-desktop', 'station-client-build.json');
  const target = join(assetsDir, BUILD_MANIFEST_FILENAME);
  writeFileSync(target, readFileSync(source));
  console.log(`Staged iOS build provenance at ${target}`);
}
