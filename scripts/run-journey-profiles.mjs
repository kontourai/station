#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOURNEYS = [
  {
    spec: 'tests/mobile-chat-composer.spec.ts',
    grep: 'virtualizes a long real transcript|profiles switching between authoritative conversations',
    ids: ['long-transcript-stream', 'conversation-switch'],
  },
  {
    spec: 'tests/task-first-home.spec.ts',
    grep: 'profiles Home with substantial session history',
    ids: ['home-history'],
  },
];
export function validateJourneyProfile(profile, id, revision) {
  const errors = [];
  if (
    profile.id !== id ||
    profile.sourceRevision !== revision ||
    profile.outcome !== 'passed'
  )
    errors.push('identity/revision/outcome mismatch');
  if (
    !(profile.cpuSamples > 0) ||
    !(profile.counters?.commits > 0) ||
    !(profile.elapsedMs > 0)
  )
    errors.push('missing measured work');
  for (const name of [
    'TaskDuration',
    'ScriptDuration',
    'LayoutDuration',
    'RecalcStyleDuration',
  ]) {
    if (
      !Number.isFinite(profile.metricsMs?.[name]) ||
      profile.metricsMs[name] < 0
    )
      errors.push(`missing/invalid timing metric: ${name}`);
  }
  if (
    !Number.isFinite(profile.sampledAllocationBytes) ||
    profile.sampledAllocationBytes < 0
  )
    errors.push('invalid allocation sample');
  return errors;
}
export function summarizeJourneyProfiles(profiles) {
  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return Object.fromEntries(
    [...new Set(profiles.map((profile) => profile.id))].map((id) => {
      const group = profiles.filter((profile) => profile.id === id);
      return [
        id,
        {
          samples: group.length,
          elapsedMedianMs: median(group.map((p) => p.elapsedMs)),
          scriptMedianMs: median(group.map((p) => p.metricsMs.ScriptDuration)),
          layoutMedianMs: median(group.map((p) => p.metricsMs.LayoutDuration)),
          commitsMedian: median(group.map((p) => p.counters.commits)),
          storageReadsMedian: median(group.map((p) => p.counters.storageReads)),
          storageWritesMedian: median(
            group.map((p) => p.counters.storageWrites),
          ),
          sampledAllocationMedianBytes: median(
            group.map((p) => p.sampledAllocationBytes),
          ),
        },
      ];
    }),
  );
}
export function main(argv = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const raw =
    argv.find((arg) => arg.startsWith('--samples='))?.slice(10) ?? '3';
  const samples = Number(raw);
  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > 10 ||
    argv.some((arg) => !arg.startsWith('--samples=') && arg !== '--allow-dirty')
  )
    throw new Error(
      'Usage: test:journeys:profile [--samples=1..10] [--allow-dirty]',
    );
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  const dirty = Boolean(git(['status', '--porcelain']));
  if (dirty && !argv.includes('--allow-dirty'))
    throw new Error(
      'Commit first so profiles bind to a clean revision; --allow-dirty is diagnostic only.',
    );
  const output = join(
    root,
    '.kontourai',
    'journey-profiles',
    `${Date.now()}-${revision.slice(0, 9)}`,
  );
  mkdirSync(output, { recursive: true });
  const profiles = [];
  for (let sample = 0; sample < samples; sample++) {
    const directory = join(output, String(sample + 1));
    mkdirSync(directory);
    for (const journey of JOURNEYS) {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/run-e2e-suite.mjs',
          '--suite=product',
          `--spec=${journey.spec}`,
          `--grep=${journey.grep}`,
        ],
        {
          cwd: root,
          env: { ...process.env, STATION_JOURNEY_PROFILE_DIR: directory },
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );
      writeFileSync(
        join(directory, `${journey.ids[0]}.log`),
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      );
      if (result.error || result.status !== 0)
        throw new Error(`Journey failed; inspect ${directory}`);
      for (const id of journey.ids) {
        const profile = JSON.parse(
          readFileSync(join(directory, `${id}.json`), 'utf8'),
        );
        const errors = validateJourneyProfile(profile, id, revision);
        if (errors.length) throw new Error(`${id}: ${errors.join('; ')}`);
        profiles.push(profile);
      }
    }
  }
  if (git(['rev-parse', 'HEAD']) !== revision)
    throw new Error('Revision changed during profiling');
  const report = {
    version: 1,
    sourceRevision: revision,
    dirty,
    diagnostic: true,
    buildModes: [...new Set(profiles.map((profile) => profile.buildMode))],
    summary: summarizeJourneyProfiles(profiles),
  };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
