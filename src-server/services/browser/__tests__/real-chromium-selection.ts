import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Playwright's installed Chromium (Chrome for Testing) under
 * `PLAYWRIGHT_BROWSERS_PATH`, newest revision first: the pinned browser,
 * which an older system Chrome would otherwise shadow on a workstation.
 *
 * macOS only. On Linux the host launches the browser with Chrome's sandbox
 * on, and Chrome for Testing has no AppArmor profile, so on a distribution
 * that restricts unprivileged user namespaces (Ubuntu 23.10 and later, which
 * the hosted runners are) it aborts at launch. The installed system browser
 * has a profile and is the one these suites use there.
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
