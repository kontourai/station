import { writeAndroidBuildManifest } from './lib/android-build-manifest.mjs';

const manifestPath = writeAndroidBuildManifest(process.cwd());
if (manifestPath) {
  console.log(`Staged Android build provenance at ${manifestPath}`);
} else {
  console.warn(
    'No build provenance available (no git checkout and no valid .station-release.json). The packaged APK will carry no station-build.json and a device built from it cannot report its commit.',
  );
}
