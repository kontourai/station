#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { holdHeavyCheckSlotForProcess } from './lib/heavy-check-slots.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { startFixtureUi } from './lib/ui-profile-server.mjs';

export const JOURNEYS = [
  {
    spec: 'tests/mobile-chat-composer.spec.ts',
    grep: 'virtualizes a long real transcript|profiles switching between authoritative conversations',
    ids: ['long-transcript-stream', 'conversation-switch'],
  },
  {
    spec: 'tests/task-first-home.spec.ts',
    grep: 'profiles Home with substantial session history',
    ids: [
      'home-history',
      'home-history-mobile',
      'home-composer-typing',
      'home-composer-typing-mobile',
      'home-refresh',
      'home-refresh-mobile',
    ],
  },
  {
    spec: 'tests/transcript-load-stability.spec.ts',
    grep: 'the composer measuring itself never opens a gap under the newest message',
    ids: ['reply-composer'],
  },
  {
    spec: 'tests/task-first-home.spec.ts',
    grep: 'desktop active work reveals real files and task context beside usable chat',
    ids: ['desktop-workspace'],
  },
];
export function validateJourneyProfile(
  profile,
  id,
  revision,
  expectedDirty,
  { uiOnly = false, buildProvenanceSha256 = '' } = {},
) {
  const errors = [];
  if (expectedDirty !== undefined && profile.dirty !== expectedDirty)
    errors.push('workspace changed during profiling');
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
  if (uiOnly) {
    if (profile.buildMode !== 'production')
      errors.push('UI-only profile requires a production build');
    if (
      !buildProvenanceSha256 ||
      profile.buildProvenanceSha256 !== buildProvenanceSha256
    )
      errors.push('missing/mismatched production build provenance');
    if (
      !(profile.viewport?.width > 0) ||
      !(profile.viewport?.height > 0) ||
      !(profile.device?.devicePixelRatio > 0) ||
      !profile.device?.userAgent
    )
      errors.push('missing browser device provenance');
    const responsiveness = profile.responsiveness;
    if (
      !responsiveness ||
      responsiveness.scope !== 'final-document' ||
      !Number.isFinite(responsiveness.phaseStartMs) ||
      !Number.isFinite(responsiveness.phaseEndMs) ||
      responsiveness.phaseStartMs < 0 ||
      responsiveness.phaseEndMs < responsiveness.phaseStartMs ||
      !Array.isArray(responsiveness.longTasks) ||
      responsiveness.longTasks.some(
        (entry) =>
          !Number.isFinite(entry.duration) ||
          entry.duration < 50 ||
          !Number.isFinite(entry.startTime) ||
          entry.startTime < responsiveness.phaseStartMs ||
          entry.startTime + entry.duration > responsiveness.phaseEndMs,
      ) ||
      responsiveness.longTaskCount !== responsiveness.longTasks.length ||
      responsiveness.longestTaskMs !==
        Math.max(
          0,
          ...responsiveness.longTasks.map((entry) => entry.duration),
        ) ||
      responsiveness.blockingOver50Ms !==
        responsiveness.longTasks.reduce(
          (sum, entry) => sum + Math.max(0, entry.duration - 50),
          0,
        )
    )
      errors.push('missing/invalid responsiveness observation');
  }
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
          ...(group.every((profile) => profile.responsiveness)
            ? {
                longTaskCountMedian: median(
                  group.map((p) => p.responsiveness.longTaskCount),
                ),
                longestTaskMedianMs: median(
                  group.map((p) => p.responsiveness.longestTaskMs),
                ),
                blockingOver50MedianMs: median(
                  group.map((p) => p.responsiveness.blockingOver50Ms),
                ),
              }
            : {}),
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
export async function main(argv = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const raw =
    argv.find((arg) => arg.startsWith('--samples='))?.slice(10) ?? '3';
  const samples = Number(raw);
  const selectedSpec = argv.find((arg) => arg.startsWith('--spec='))?.slice(7);
  const selectedGroup = argv
    .find((arg) => arg.startsWith('--group='))
    ?.slice(8);
  const journeys = JOURNEYS.filter(
    (journey) =>
      (!selectedSpec || journey.spec === selectedSpec) &&
      (!selectedGroup || journey.ids[0] === selectedGroup),
  );
  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > 10 ||
    journeys.length === 0 ||
    selectedSpec === '' ||
    selectedGroup === '' ||
    argv.some(
      (arg) =>
        !arg.startsWith('--samples=') &&
        !arg.startsWith('--spec=') &&
        !arg.startsWith('--group=') &&
        arg !== '--allow-dirty' &&
        arg !== '--ui-only',
    )
  )
    throw new Error(
      'Usage: test:journeys:profile [--samples=1..10] [--spec=<registered spec>] [--group=<registered primary journey>] [--allow-dirty] [--ui-only]',
    );
  const git = (args) =>
    execFileSyncBounded('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  const dirty = Boolean(git(['status', '--porcelain']));
  const diffDigest = () => {
    const hash = createHash('sha256').update(git(['diff', '--binary', 'HEAD']));
    for (const path of git(['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean))
      hash.update(
        JSON.stringify([
          path,
          createHash('sha256')
            .update(readFileSync(join(root, path)))
            .digest('hex'),
        ]),
      );
    return hash.digest('hex');
  };
  const sourceDiffSha256 = diffDigest();
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
  const uiOnly = argv.includes('--ui-only');
  if (uiOnly && !(await holdHeavyCheckSlotForProcess('test:journeys:profile')))
    throw new Error('UI profiling could not acquire a heavy-check slot');
  const lane = uiOnly
    ? await startFixtureUi(root, output, {
        sourceRevision: revision,
        sourceDiffSha256,
      })
    : null;
  const profiles = [];
  try {
    for (let sample = 0; sample < samples; sample++) {
      const directory = join(output, String(sample + 1));
      mkdirSync(directory);
      for (const journey of journeys) {
        if (lane) await lane.run(journey, directory);
        else {
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
        }
        for (const id of journey.ids) {
          const profile = JSON.parse(
            readFileSync(join(directory, `${id}.json`), 'utf8'),
          );
          const errors = validateJourneyProfile(profile, id, revision, dirty, {
            uiOnly,
            buildProvenanceSha256: lane?.buildProvenanceSha256,
          });
          if (errors.length) throw new Error(`${id}: ${errors.join('; ')}`);
          const rawCpu = JSON.parse(
            readFileSync(join(directory, `${id}.cpuprofile`), 'utf8'),
          );
          const rawHeap = JSON.parse(
            readFileSync(join(directory, `${id}.heapprofile`), 'utf8'),
          );
          if (
            !rawCpu.nodes?.length ||
            !rawCpu.samples?.length ||
            !rawHeap.head ||
            !Array.isArray(rawHeap.samples)
          )
            throw new Error(`${id}: raw profile artifacts are incomplete`);
          profiles.push(profile);
        }
      }
    }
  } finally {
    await lane?.stop();
  }
  if (!dirty && git(['status', '--porcelain']))
    throw new Error('Workspace changed during profiling');
  if (git(['rev-parse', 'HEAD']) !== revision)
    throw new Error('Revision changed during profiling');
  if (diffDigest() !== sourceDiffSha256)
    throw new Error('Source diff changed during profiling');
  const report = {
    version: 1,
    sourceRevision: revision,
    dirty,
    diagnostic: true,
    lane: uiOnly ? 'fixture-backed-ui-only' : 'isolated-station-e2e',
    sourceDiffSha256,
    buildProvenanceSha256: lane?.buildProvenanceSha256,
    selectedSpecs: [...new Set(journeys.map((journey) => journey.spec))],
    selectedGroups: journeys.map((journey) => journey.ids[0]),
    buildModes: [...new Set(profiles.map((profile) => profile.buildMode))],
    summary: summarizeJourneyProfiles(profiles),
  };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
if (invokedDirectly(import.meta.url)) await main();
