#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  NEEDS_MAINTAINER,
  NEEDS_REPORTER,
} from './issue-lifecycle-reducer.mjs';

export const MANIFEST_PATH = '.github/labels.json';
export const REPOSITORY = 'kontourai/station';
export const EXPECTED_LABEL_NAMES = Object.freeze([
  'P1',
  'P2',
  'P3',
  'acceptance-needed',
  'agent:claimed',
  'blocked',
  'bug',
  'decision-needed',
  'dependencies',
  'documentation',
  'duplicate',
  'enhancement',
  'epic',
  'github_actions',
  'good first issue',
  'help wanted',
  'invalid',
  'javascript',
  NEEDS_MAINTAINER,
  NEEDS_REPORTER,
  'needs-regrounding',
  'question',
  'rust',
  'security',
  'stage:preview',
  'stage:source',
  'stage:stable',
  'wontfix',
]);
export const RETIRED_LABELS = Object.freeze([
  'needs:info',
  'needs:response',
  'needs:triage',
  'status:source',
  'status:preview',
  'status:stable',
]);
const AXES = Object.freeze([
  Object.freeze({ name: 'priority', labels: ['P1', 'P2', 'P3'] }),
  Object.freeze({
    name: 'lifecycle',
    labels: [NEEDS_MAINTAINER, NEEDS_REPORTER],
  }),
  Object.freeze({
    name: 'stage',
    labels: ['stage:source', 'stage:preview', 'stage:stable'],
  }),
]);

function names(labels = []) {
  return labels.map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}
function sorted(values) {
  return [...values].sort();
}

export function validateLabelManifest(manifest) {
  const findings = [];
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest?.labels)) {
    return ['Label manifest must declare schemaVersion 1 and a labels array.'];
  }
  const labels = manifest.labels;
  const actual = names(labels);
  const duplicates = actual.filter(
    (name, index) => actual.indexOf(name) !== index,
  );
  if (duplicates.length)
    findings.push(
      `Duplicate label names: ${sorted(new Set(duplicates)).join(', ')}.`,
    );
  const missing = EXPECTED_LABEL_NAMES.filter((name) => !actual.includes(name));
  const unexpected = actual.filter(
    (name) => !EXPECTED_LABEL_NAMES.includes(name),
  );
  if (missing.length) findings.push(`Missing labels: ${missing.join(', ')}.`);
  if (unexpected.length)
    findings.push(`Unexpected labels: ${sorted(unexpected).join(', ')}.`);
  for (const label of labels) {
    if (!label || typeof label.name !== 'string' || !label.name.trim())
      findings.push('Every label needs a nonblank name.');
    if (
      !label ||
      typeof label.description !== 'string' ||
      !label.description.trim()
    )
      findings.push(
        `Label '${label?.name ?? '<unknown>'}' needs a nonblank description.`,
      );
    if (
      !label ||
      typeof label.color !== 'string' ||
      !/^[0-9a-fA-F]{6}$/.test(label.color)
    )
      findings.push(
        `Label '${label?.name ?? '<unknown>'}' needs a six-digit color.`,
      );
  }
  return [...new Set(findings)];
}

export function validateIssueLabelAxes(labels) {
  const present = names(labels);
  const findings = [];
  for (const retired of RETIRED_LABELS)
    if (present.includes(retired))
      findings.push(`Retired label '${retired}' is not allowed.`);
  for (const axis of AXES) {
    const selected = axis.labels.filter((label) => present.includes(label));
    if (selected.length > 1)
      findings.push(`Conflicting ${axis.name} labels: ${selected.join(', ')}.`);
  }
  return findings;
}

export function reconcilePlan(manifestLabels, liveLabels) {
  const desired = new Map(manifestLabels.map((label) => [label.name, label]));
  const live = new Map(liveLabels.map((label) => [label.name, label]));
  const create = [...desired.values()].filter((label) => !live.has(label.name));
  const update = [...desired.values()].filter((label) => {
    const current = live.get(label.name);
    return (
      current &&
      (current.color.toLowerCase() !== label.color.toLowerCase() ||
        current.description !== label.description)
    );
  });
  // Unexpected labels are intentionally reported, never deleted by this tool.
  const unexpected = [...live.keys()]
    .filter((name) => !desired.has(name))
    .sort();
  return { create, update, unexpected };
}

/** Verify a fetched label set exactly, including presentation fields. */
export function validateLiveLabels(manifestLabels, liveLabels) {
  const plan = reconcilePlan(manifestLabels, liveLabels);
  const findings = [];
  const liveNames = new Set(names(liveLabels));
  const missing = manifestLabels
    .map(({ name }) => name)
    .filter((name) => !liveNames.has(name));
  if (missing.length)
    findings.push(`Missing live labels: ${missing.join(', ')}.`);
  if (plan.unexpected.length)
    findings.push(`Unexpected live labels: ${plan.unexpected.join(', ')}.`);
  for (const label of plan.update)
    findings.push(`Live label '${label.name}' drifts from the manifest.`);
  return findings;
}

export function assertReconcileAuthority(argv) {
  const value = (name) =>
    argv
      .find((argument) => argument.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  if (!argv.includes('--reconcile'))
    throw new Error('Reconciliation requires --reconcile.');
  if (!argv.includes('--write-authorized'))
    throw new Error('Reconciliation requires --write-authorized.');
  if (
    value('--repo') !== REPOSITORY ||
    value('--confirm-repository') !== REPOSITORY
  ) {
    throw new Error(
      `Reconciliation requires --repo=${REPOSITORY} and --confirm-repository=${REPOSITORY}.`,
    );
  }
}

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}
function main(argv = process.argv.slice(2)) {
  const manifest = readManifest();
  const findings = validateLabelManifest(manifest);
  if (findings.length) throw new Error(findings.join('\n'));
  const input = argv.find((argument) => argument.startsWith('--input='));
  if (input) {
    const live = JSON.parse(
      readFileSync(input.slice('--input='.length), 'utf8'),
    );
    const liveFindings = validateLiveLabels(manifest.labels, live);
    if (liveFindings.length) throw new Error(liveFindings.join('\n'));
  }
  if (!argv.includes('--reconcile')) {
    console.log(`Validated ${manifest.labels.length} declared labels.`);
    return;
  }
  assertReconcileAuthority(argv);
  const live = JSON.parse(
    execFileSync(
      'gh',
      ['api', '--paginate', `repos/${REPOSITORY}/labels?per_page=100`],
      { encoding: 'utf8' },
    ),
  );
  const plan = reconcilePlan(manifest.labels, live);
  if (plan.unexpected.length)
    throw new Error(
      `Unexpected live labels require a separate human decision: ${plan.unexpected.join(', ')}.`,
    );
  for (const label of plan.create)
    execFileSync(
      'gh',
      [
        'label',
        'create',
        label.name,
        '--repo',
        REPOSITORY,
        '--color',
        label.color,
        '--description',
        label.description,
      ],
      { stdio: 'inherit' },
    );
  for (const label of plan.update)
    execFileSync(
      'gh',
      [
        'label',
        'edit',
        label.name,
        '--repo',
        REPOSITORY,
        '--color',
        label.color,
        '--description',
        label.description,
      ],
      { stdio: 'inherit' },
    );
  console.log(
    JSON.stringify({
      created: plan.create.map(({ name }) => name),
      updated: plan.update.map(({ name }) => name),
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
