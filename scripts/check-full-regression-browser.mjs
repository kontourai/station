#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
const browserRoot =
  configured && configured !== '0'
    ? resolve(root, configured)
    : join(root, 'node_modules', 'playwright-core', '.local-browsers');
const available =
  existsSync(browserRoot) &&
  readdirSync(browserRoot).some(
    (entry) =>
      /^chromium-\d/.test(entry) &&
      existsSync(join(browserRoot, entry, 'INSTALLATION_COMPLETE')),
  );

if (!available) {
  console.error(
    `Full regression requires its pinned Chromium at ${browserRoot}. ` +
      'Run npm run install:playwright, then retry.',
  );
  process.exitCode = 1;
} else {
  console.log(`Full regression Chromium prerequisite: ${browserRoot}`);
}
