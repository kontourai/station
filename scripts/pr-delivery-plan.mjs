#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';

const [base, head] = process.argv.slice(2);
if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
  throw new Error('Delivery planning requires exact base and head SHAs');
}
const paths = JSON.parse(
  readFileSync(new URL('./pr-delivery-paths.json', import.meta.url), 'utf8'),
);
const changed = execFileSyncBounded(
  'git',
  ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`],
  { encoding: 'utf8', windowsHide: true },
)
  .split('\0')
  .filter(Boolean);
const policyChanged = changed.some((path) =>
  [
    'scripts/pr-delivery-plan.mjs',
    'scripts/pr-delivery-paths.json',
    '.github/workflows/ci.yml',
    '.github/workflows/delivery-validation.yml',
  ].includes(path),
);
const plan = Object.fromEntries(
  Object.entries(paths).map(([lane, patterns]) => [
    lane,
    policyChanged ||
      changed.some((path) =>
        patterns.some((pattern) => matchesGlob(path, pattern)),
      ),
  ]),
);
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `${Object.entries(plan)
    .map(([lane, selected]) => `${lane}=${selected}`)
    .join('\n')}\n`,
);
console.log(JSON.stringify({ base, head, files: changed.length, plan }));
