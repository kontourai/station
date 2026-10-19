import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { stageIosLaunchScreen } from '../lib/ios-launch-screen.mjs';

const makeTempDir = trackTempDirs();

test.each([
  ['io.kontourai.station', 'stable'],
  ['io.kontourai.station.dev.instance', 'dev'],
  ['io.kontourai.station.beta', 'beta'],
  ['io.kontourai.station.nightly', 'nightly'],
])(
  'configured %s stages its exact channel launch mark despite a preserved Stable project',
  (identifier, channel) => {
    const root = makeTempDir('station-ios-launch-');
    const apple = join(root, 'src-desktop/gen/apple');
    mkdirSync(apple, { recursive: true });
    mkdirSync(join(root, 'src-ui/public'), { recursive: true });
    mkdirSync(join(root, 'scripts/templates/ios'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/templates/ios/LaunchScreen.storyboard'),
      'reviewed-storyboard',
    );
    writeFileSync(join(root, 'src-ui/public/favicon.png'), 'stable-artwork');
    for (const variant of ['dev', 'beta', 'nightly'])
      writeFileSync(
        join(root, `src-ui/public/favicon-${variant}.png`),
        `${variant}-artwork`,
      );
    writeFileSync(
      join(apple, 'project.yml'),
      'settingGroups:\n  app:\n    base:\n      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\n',
    );
    writeFileSync(
      join(root, 'src-desktop/tauri.conf.json'),
      JSON.stringify({ identifier }),
    );
    stageIosLaunchScreen(root);
    expect(
      readFileSync(
        join(apple, 'Assets.xcassets/StationLaunchLogo.imageset/logo.png'),
        'utf8',
      ),
    ).toBe(`${channel}-artwork`);
    expect(readFileSync(join(apple, 'LaunchScreen.storyboard'), 'utf8')).toBe(
      'reviewed-storyboard',
    );
    const background = JSON.parse(
      readFileSync(
        join(
          apple,
          'Assets.xcassets/StationLaunchBackground.colorset/Contents.json',
        ),
        'utf8',
      ),
    );
    expect(background.colors).toHaveLength(2);
    expect(background.colors[1].appearances).toEqual([
      { appearance: 'luminosity', value: 'dark' },
    ]);
  },
);

test('unknown configured app identity cannot silently ship Stable launch artwork', () => {
  const root = makeTempDir('station-ios-launch-refusal-');
  const apple = join(root, 'src-desktop/gen/apple');
  mkdirSync(apple, { recursive: true });
  writeFileSync(
    join(root, 'src-desktop/tauri.conf.json'),
    JSON.stringify({ identifier: 'io.example.other' }),
  );
  expect(() => stageIosLaunchScreen(root)).toThrow(
    'Unknown configured iOS Station identity',
  );
});
