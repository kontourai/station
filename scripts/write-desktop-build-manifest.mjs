import { writeDesktopBuildManifest } from './lib/desktop-build-manifest.mjs';

const manifestPath = writeDesktopBuildManifest(process.cwd());
if (manifestPath) {
  console.log(`Wrote desktop build provenance to ${manifestPath}`);
} else {
  console.warn(
    'No build provenance available (no git checkout and no valid .station-release.json). The packaged app will report partial provenance.',
  );
}
