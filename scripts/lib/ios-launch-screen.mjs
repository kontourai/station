import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { iosIconChannelForConfig } from '../ios-channel-icons.mjs';

/** Restore launch resources after Tauri regenerates the selected app project. */
export function stageIosLaunchScreen(
  root,
  { channel = iosIconChannelForConfig(root) } = {},
) {
  const apple = join(root, 'src-desktop/gen/apple');
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
