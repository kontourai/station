import { readFileSync } from 'node:fs';
import {
  NIGHTLY_DESKTOP_PRUNE_VARIABLE,
  retainNightlyDesktopAssets,
} from './lib/publish-nightly-desktop.mjs';

// Exits 0 on every path: retention follows a completed publication, and its
// failures are warnings, never a change to that publication's outcome.
const [planPath] = process.argv.slice(2);
let currentVersion;
try {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (plan?.versionIdentities?.desktop?.releaseTag !== 'nightly-desktop')
    throw new Error('the cohort plan is not a nightly-desktop plan');
  currentVersion = plan.versionIdentities.desktop.version;
} catch (error) {
  console.log(
    `::warning title=Nightly desktop retention::Skipped: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (currentVersion !== undefined)
  retainNightlyDesktopAssets({
    currentVersion,
    switchValue: process.env[NIGHTLY_DESKTOP_PRUNE_VARIABLE],
  });
