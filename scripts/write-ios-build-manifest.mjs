import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
// Reapply after Tauri init, which regenerates the native launch storyboard.
copyFileSync(
  join(projectRoot, 'scripts/templates/ios/LaunchScreen.storyboard'),
  join(appleProjectDir, 'LaunchScreen.storyboard'),
);
const launchLogoDir = join(
  appleProjectDir,
  'Assets.xcassets/StationLaunchLogo.imageset',
);
mkdirSync(launchLogoDir, { recursive: true });
copyFileSync(
  join(projectRoot, 'src-ui/public/favicon.png'),
  join(launchLogoDir, 'logo.png'),
);
writeFileSync(
  join(launchLogoDir, 'Contents.json'),
  JSON.stringify(
    {
      images: [{ filename: 'logo.png', idiom: 'universal' }],
      info: { author: 'xcode', version: 1 },
    },
    null,
    2,
  ),
);
const launchBackgroundDir = join(
  appleProjectDir,
  'Assets.xcassets/StationLaunchBackground.colorset',
);
mkdirSync(launchBackgroundDir, { recursive: true });
writeFileSync(
  join(launchBackgroundDir, 'Contents.json'),
  JSON.stringify(
    {
      colors: [
        {
          idiom: 'universal',
          color: {
            'color-space': 'srgb',
            components: {
              red: '0.960784',
              green: '0.956863',
              blue: '0.937255',
              alpha: '1.000',
            },
          },
        },
        {
          idiom: 'universal',
          appearances: [{ appearance: 'luminosity', value: 'dark' }],
          color: {
            'color-space': 'srgb',
            components: {
              red: '0.039216',
              green: '0.054902',
              blue: '0.074510',
              alpha: '1.000',
            },
          },
        },
      ],
      info: { author: 'xcode', version: 1 },
    },
    null,
    2,
  ),
);

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
