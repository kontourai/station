import { readFileSync, writeFileSync } from 'node:fs';
import {
  generateDesktopReleaseNotes,
  publishDesktopReleaseNotes,
} from './lib/desktop-release-notes.mjs';

const [command, planFile, file] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const options = {
  plan,
  repository: process.env.GITHUB_REPOSITORY,
  token: process.env.GITHUB_TOKEN,
};
if (command === 'generate') {
  writeFileSync(file, await generateDesktopReleaseNotes(options));
} else if (command === 'publish') {
  await publishDesktopReleaseNotes({
    ...options,
    manifest: JSON.parse(readFileSync(file, 'utf8')),
  });
} else {
  throw new Error(
    'Usage: desktop-release-notes.mjs <generate|publish> <cohort-plan.json> <notes.md|latest.json>',
  );
}
