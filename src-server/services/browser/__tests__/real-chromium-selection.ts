import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Playwright's installed Chromium (Chrome for Testing) under
 * `PLAYWRIGHT_BROWSERS_PATH`, newest revision first: the pinned browser,
 * which an older system Chrome would otherwise shadow on a workstation.
 */
export function playwrightChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const builds: Record<string, string[]> = {
    darwin: [
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ],
    linux: ['chrome-linux64', 'chrome'],
  };
  const tail = builds[process.platform];
  if (!tail) return undefined;
  const revisions = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const revision of revisions) {
    const candidate = join(root, revision, ...tail);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
