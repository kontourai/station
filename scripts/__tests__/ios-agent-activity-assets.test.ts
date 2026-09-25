import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The Live Activity widget's images sit under a repo-wide `*.png` ignore
// (.gitignore). A working tree that happens to hold them builds a widget with
// an icon; a clean checkout, like CI's, would ship an empty image. Ask git,
// not the filesystem, which images a clean checkout gets.
const imageSet =
  'src-desktop/ios/StationAgentActivity/Assets.xcassets/StationAppIcon.imageset';

test('every image the widget icon set references is tracked by git', () => {
  const contents = JSON.parse(
    readFileSync(join(imageSet, 'Contents.json'), 'utf8'),
  ) as { images: { filename?: string }[] };
  const files = contents.images.map((image) => image.filename);
  // One per scale; a set that loses an entry must fail here, not read clean.
  expect(files).toEqual([
    'StationAppIcon@1x.png',
    'StationAppIcon@2x.png',
    'StationAppIcon@3x.png',
  ]);
  const paths = files.map((file) => `${imageSet}/${file}`);
  const tracked = execFileSync(
    'git',
    ['ls-files', '--error-unmatch', '--', ...paths],
    { encoding: 'utf8' },
  );
  expect(tracked.trim().split('\n').sort()).toEqual([...paths].sort());
});
