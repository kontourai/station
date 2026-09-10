import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishNightlyDesktop } from './lib/publish-nightly-desktop.mjs';

const [root, output, observation] = process.argv.slice(2);
const json = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const published = publishNightlyDesktop({
  root,
  output,
  plan: json('cohort-plan.json'),
  receipts: [
    json('macos-stage-receipt.json'),
    json('windows-stage-receipt.json'),
  ],
});
writeFileSync(observation, `${JSON.stringify(published, null, 2)}\n`);
