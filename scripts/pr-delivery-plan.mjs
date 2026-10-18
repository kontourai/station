#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { github } from './qualification-evidence.mjs';

const [base, head] = process.argv.slice(2);
if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
  throw new Error('Delivery planning requires exact base and head SHAs');
}
const paths = JSON.parse(
  readFileSync(new URL('./pr-delivery-paths.json', import.meta.url), 'utf8'),
);
const number = Number(process.env.PR_NUMBER);
if (
  !Number.isSafeInteger(number) ||
  number <= 0 ||
  !process.env.GH_TOKEN ||
  !/^[\w.-]+\/[\w.-]+$/.test(process.env.PR_HEAD_REPOSITORY ?? '')
)
  throw new Error('Delivery planning requires authenticated live PR ownership');
const pr = await github(`pulls/${number}`);
const eligible =
  pr.number === number &&
  pr.state === 'open' &&
  pr.base?.ref === 'main' &&
  pr.base?.repo?.full_name === process.env.GITHUB_REPOSITORY &&
  pr.head?.repo?.full_name === process.env.PR_HEAD_REPOSITORY &&
  pr.head?.sha === head;
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
    eligible &&
      (policyChanged ||
        changed.some((path) =>
          patterns.some((pattern) => matchesGlob(path, pattern)),
        )),
  ]),
);
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `${Object.entries(plan)
    .map(([lane, selected]) => `${lane}=${selected}`)
    .join('\n')}\n`,
);
console.log(
  JSON.stringify({ base, head, files: changed.length, eligible, plan }),
);
