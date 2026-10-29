import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';

/** Resolve the installed Playwright revision, never another browser in the cache. */
export function configuredPinnedChromium({
  root = process.cwd(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform !== 'linux' || !configured) return undefined;

  const require = createRequire(join(resolve(root), 'package.json'));
  const packageFile = require.resolve('playwright-core/package.json');
  const metadata = JSON.parse(
    readFileSync(join(packageFile, '..', 'browsers.json'), 'utf8'),
  );
  const revision = metadata.browsers?.find(
    (browser) => browser.name === 'chromium',
  )?.revision;
  if (typeof revision !== 'string' || !/^\d+$/.test(revision))
    throw new Error(
      'Installed Playwright does not identify its Chromium revision.',
    );

  const browserRoot =
    configured === '0'
      ? join(packageFile, '..', '.local-browsers')
      : resolve(root, configured);
  const directory = join(browserRoot, `chromium-${revision}`);
  const executable = join(directory, 'chrome-linux64', 'chrome');
  try {
    if (
      !statSync(join(directory, 'INSTALLATION_COMPLETE')).isFile() ||
      !statSync(executable).isFile()
    )
      throw new Error('The configured Chromium installation is incomplete.');
    accessSync(executable, constants.X_OK);
  } catch (cause) {
    throw new Error(
      `Configured full-regression Chromium revision ${revision} is unavailable at ${executable}. Run npm run install:playwright with the same PLAYWRIGHT_BROWSERS_PATH.`,
      { cause },
    );
  }
  return executable;
}

/** The explicit cache opt-in must also govern real installed-browser tests. */
export function bindPinnedVitestChromium(runRoot, options = {}) {
  const env = options.env ?? process.env;
  const executable = configuredPinnedChromium({ ...options, env });
  if (!executable) return () => {};

  const bin = join(runRoot, 'browser-bin');
  mkdirSync(bin, { mode: 0o700 });
  // Acquisition searches every google-chrome location before any chromium one.
  symlinkSync(executable, join(bin, 'google-chrome'));
  const previousPath = env.PATH;
  const selectedPath = `${bin}${previousPath ? `${delimiter}${previousPath}` : ''}`;
  env.PATH = selectedPath;
  return () => {
    if (env.PATH !== selectedPath) return;
    if (previousPath === undefined) delete env.PATH;
    else env.PATH = previousPath;
  };
}
