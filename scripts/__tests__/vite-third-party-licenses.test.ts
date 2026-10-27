import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs';
import { packageRootOf } from '../vite-third-party-licenses';

const makeTempDir = trackTempDirs({
  base: path.resolve('node_modules/.cache'),
});

function writePackage(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.2.3', main: 'index.js', ...manifest }),
  );
  writeFileSync(
    path.join(dir, 'index.js'),
    `export default ${JSON.stringify(name)};`,
  );
  for (const [file, text] of Object.entries(files))
    writeFileSync(path.join(dir, file), text);
}

it('resolves package roots for plain, scoped and pnpm-store module ids', () => {
  expect(packageRootOf('/r/node_modules/react/index.js')).toBe(
    '/r/node_modules/react',
  );
  expect(
    packageRootOf(
      '\0/r/node_modules/.pnpm/@a+b@1/node_modules/@a/b/dist/x.js?commonjs',
    ),
  ).toBe('/r/node_modules/.pnpm/@a+b@1/node_modules/@a/b');
  expect(packageRootOf('/r/src-ui/src/main.tsx')).toBeUndefined();
  expect(packageRootOf('/r/node_modules/.pnpm/x')).toBeUndefined();
});

it('ships the notices of exactly the packages bundled into the UI build', async () => {
  mkdirSync(path.resolve('node_modules/.cache'), { recursive: true });
  const root = makeTempDir('station-third-party-licenses-');
  writePackage(
    root,
    'licensed-pkg',
    { license: 'MIT', repository: 'git+https://github.com/o/licensed.git' },
    { LICENSE: 'MIT License\nCopyright (c) Someone\n' },
  );
  writePackage(root, '@scope/bare', {
    license: { type: 'ISC' },
    repository: 'o/bare',
  });
  writePackage(root, 'unused-pkg', { license: 'GPL-3.0' });
  writeFileSync(
    path.join(root, 'index.html'),
    '<head></head><body><script type="module" src="/main.js"></script></body>',
  );
  writeFileSync(
    path.join(root, 'main.js'),
    "import a from 'licensed-pkg'; import b from '@scope/bare'; console.log(a, b);",
  );
  const result = await build({
    configFile: path.resolve('vite.config.ts'),
    mode: 'native',
    root,
    logLevel: 'silent',
    build: { write: false, minify: false },
  });
  if (!('output' in result)) throw new Error('Expected one Vite build output');
  const asset = result.output.find(
    (output) => output.fileName === 'third-party-licenses.json',
  );
  if (asset?.type !== 'asset') throw new Error('License list was not emitted');
  expect(JSON.parse(String(asset.source))).toEqual({
    packages: [
      {
        name: '@scope/bare',
        version: '1.2.3',
        license: 'ISC',
        repository: 'https://github.com/o/bare',
      },
      {
        name: 'licensed-pkg',
        version: '1.2.3',
        license: 'MIT',
        repository: 'https://github.com/o/licensed',
        text: 'MIT License\nCopyright (c) Someone',
      },
    ],
  });
});
