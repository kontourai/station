import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

/** Restore launch resources after Tauri regenerates the selected app project. */
export function stageIosLaunchScreen(root) {
  const apple = join(root, 'src-desktop/gen/apple');
  const project = YAML.parse(readFileSync(join(apple, 'project.yml'), 'utf8'));
  const identifier =
    project.targets?.station_iOS?.settings?.base?.PRODUCT_BUNDLE_IDENTIFIER ??
    project.settingGroups?.app?.base?.PRODUCT_BUNDLE_IDENTIFIER;
  const channel = identifier?.startsWith('io.kontourai.station.dev.')
    ? 'dev'
    : {
        'io.kontourai.station': 'stable',
        'io.kontourai.station.beta': 'beta',
        'io.kontourai.station.nightly': 'nightly',
      }[identifier];
  if (!channel)
    throw new Error(`Unknown generated iOS Station identity: ${identifier}`);
  copyFileSync(
    join(root, 'scripts/templates/ios/LaunchScreen.storyboard'),
    join(apple, 'LaunchScreen.storyboard'),
  );
  const logo = join(apple, 'Assets.xcassets/StationLaunchLogo.imageset');
  mkdirSync(logo, { recursive: true });
  copyFileSync(
    join(
      root,
      'src-ui/public',
      channel === 'stable' ? 'favicon.png' : `favicon-${channel}.png`,
    ),
    join(logo, 'logo.png'),
  );
  writeFileSync(
    join(logo, 'Contents.json'),
    JSON.stringify(
      {
        images: [{ filename: 'logo.png', idiom: 'universal' }],
        info: { author: 'xcode', version: 1 },
      },
      null,
      2,
    ),
  );
  const background = join(
    apple,
    'Assets.xcassets/StationLaunchBackground.colorset',
  );
  mkdirSync(background, { recursive: true });
  writeFileSync(
    join(background, 'Contents.json'),
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
}
