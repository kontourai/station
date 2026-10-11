#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { readLedgerFromGit } from './nightly-cohort-decide.mjs';
import {
  inspectCommitFromGit,
  normalizeDeployLedgerHead,
} from './normalize-deploy-ledger-head.mjs';
import { findQualification, listGithub } from './qualification-evidence.mjs';

export function runnerProfile(env = process.env) {
  const name = env.STATION_QUALIFICATION_RUNNER_PROFILE || 'free';
  if (!['free', 'expanded', 'custom'].includes(name))
    throw new Error(
      'STATION_QUALIFICATION_RUNNER_PROFILE must be free, expanded or custom',
    );
  const integer = (value, label) => {
    if (
      !/^[1-9][0-9]*$/.test(value ?? '') ||
      !Number.isSafeInteger(Number(value))
    )
      throw new Error(`${label} must be a positive integer`);
    return Number(value);
  };
  const total = integer(
    env.STATION_HOSTED_TOTAL_SLOTS || '20',
    'hosted total slots',
  );
  const macos = integer(
    env.STATION_HOSTED_MACOS_SLOTS || '5',
    'hosted macOS slots',
  );
  const ordinary =
    name === 'custom'
      ? integer(
          env.STATION_QUALIFICATION_ORDINARY_SLOTS,
          'custom ordinary slots',
        )
      : name === 'free'
        ? 2
        : 4;
  const heavy =
    name === 'custom'
      ? integer(
          env.STATION_QUALIFICATION_PROCESS_HEAVY_SLOTS,
          'custom process-heavy slots',
        )
      : name === 'free'
        ? 1
        : 2;
  const integrationReserve =
    name === 'custom'
      ? integer(env.STATION_INTEGRATION_RESERVE, 'custom integration reserve')
      : name === 'free'
        ? 12
        : 20;
  const background = 3 + ordinary + heavy;
  if (
    ordinary > 4 ||
    heavy > 2 ||
    macos > total ||
    background + integrationReserve > total
  )
    throw new Error(
      'configured capacity cannot retain all phases and the integration reserve',
    );
  return {
    name,
    ordinary,
    heavy,
    background,
    total,
    macos,
    integrationReserve,
  };
}

export function publicationInterval(env = process.env) {
  const value = env.STATION_NIGHTLY_INTERVAL_HOURS || '6';
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 168)
    throw new Error(
      'STATION_NIGHTLY_INTERVAL_HOURS must be an integer from 1 to 168',
    );
  return Number(value) * 3_600_000;
}

// A completed failed producer permits a new immutable reservation. Never infer
// terminality from age, a missing process, or a missing ledger row.
export function recoveryDisposition(runs, source, repository) {
  const matching = runs.filter(
    (run) =>
      run.head_sha === source &&
      run.head_repository?.full_name === repository &&
      run.head_branch === 'main' &&
      [
        '.github/workflows/main-qualification.yml',
        '.github/workflows/nightly.yml',
      ].includes(run.path) &&
      ['push', 'schedule', 'workflow_dispatch'].includes(run.event),
  );
  if (!matching.length)
    return { recover: false, reason: 'reservation producer unavailable' };
  if (matching.some((run) => run.status !== 'completed'))
    return { recover: false, reason: 'a source producer remains live' };
  const attempts = matching.filter((run) =>
    ['failure', 'timed_out'].includes(run.conclusion),
  );
  if (!attempts.length || attempts.length > 2)
    return {
      recover: false,
      reason: 'no terminal failure or bounded recovery exhausted',
    };
  return {
    recover: true,
    reason:
      'terminal failed producer; retain old reservation and allocate a new identity',
  };
}

export async function qualificationAdmission(env = process.env) {
  const profile = runnerProfile(env);
  // Observe all workflows in this repository, not just this qualification.
  // Matrix caps bound our own fanout; this is a snapshot, not an org reservation.
  const repositories = (
    env.STATION_CAPACITY_REPOSITORIES ||
    env.GITHUB_REPOSITORY ||
    ''
  )
    .split(',')
    .map((item) => item.trim());
  if (
    !repositories.length ||
    repositories.some((item) => !/^[\w.-]+\/[\w.-]+$/.test(item)) ||
    new Set(repositories).size !== repositories.length ||
    repositories.length > 32
  )
    throw new Error(
      'capacity repositories must be 1–32 distinct owner/repository names',
    );
  let occupied = 0;
  let macos = 0;
  for (const repository of repositories) {
    const repositoryEnv = { ...env, GITHUB_REPOSITORY: repository };
    const runs = await listGithub(
      'actions/runs?status=in_progress',
      'workflow_runs',
      { env: repositoryEnv },
    );
    for (const run of runs) {
      if (
        repository === env.GITHUB_REPOSITORY &&
        String(run.id) === String(env.GITHUB_RUN_ID)
      )
        continue;
      const jobs = await listGithub(`actions/runs/${run.id}/jobs`, 'jobs', {
        env: repositoryEnv,
      });
      for (const job of jobs.filter((job) => job.status === 'in_progress')) {
        occupied++;
        if ((job.labels ?? []).some((label) => /^macos/.test(label))) macos++;
      }
    }
  }
  return {
    ...profile,
    repositories,
    occupied,
    macosOccupied: macos,
    admitted:
      occupied + profile.background <= profile.total && macos < profile.macos,
    observedAt: new Date().toISOString(),
    scope:
      'configured repository snapshot; omitted organization workloads are not certified',
  };
}

async function main() {
  if (process.argv[2] === 'publisher') return publisherAdmission();
  if (!['admission', 'profile'].includes(process.argv[2]))
    throw new Error('usage: release-pipeline.mjs profile|admission');
  const receipt =
    process.argv[2] === 'profile'
      ? runnerProfile()
      : await qualificationAdmission();
  console.log(JSON.stringify(receipt));
  if (receipt.admitted === false)
    throw new Error(
      'qualification deferred: insufficient observed repository capacity',
    );
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT required');
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `admitted=${receipt.admitted}\nordinary=${receipt.ordinary}\nheavy=${receipt.heavy}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Qualification admission: ${JSON.stringify(receipt)}\n`,
    );
}
if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

export function finalPublicationDecision({
  source,
  ledger,
  ancestor,
  qualification,
  sourceCandidates = {},
  now = Date.now(),
  intervalMs = publicationInterval(),
}) {
  if (!qualification)
    throw new Error('exact-source qualification unavailable or invalidated');
  const native = ledger.filter((row) =>
    ['nightly-android', 'nightly-desktop'].includes(row.channel),
  );
  const latest = [...native].sort(
    (a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc),
  )[0];
  const matchesSource = (row) =>
    row.sha === source || sourceCandidates[row.channel] === row.sha;
  if (latest && !matchesSource(latest)) {
    const age = now - Date.parse(latest.timestampUtc);
    if (!Number.isFinite(age) || age < intervalMs)
      throw new Error('native publication cadence has not elapsed');
  }
  const latestByChannel = Object.values(
    Object.fromEntries(
      [...native]
        .sort((a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc))
        .map((row) => [row.channel, row]),
    ),
  );
  for (const row of latestByChannel) {
    if (
      !Number.isFinite(Date.parse(row.timestampUtc)) ||
      Date.parse(row.timestampUtc) > now
    )
      throw new Error('published timestamp invalid');
    if (!/^[0-9a-f]{40}$/.test(row.sha))
      throw new Error('invalid published source');
    if (row.sha !== source && !ancestor(row.sha, source))
      throw new Error(
        'published source is newer or divergent; refusing pointer rollback',
      );
  }
  return {
    androidNeeded: !latestByChannel.some(
      (row) => row.channel === 'nightly-android' && matchesSource(row),
    ),
    desktopNeeded: !latestByChannel.some(
      (row) => row.channel === 'nightly-desktop' && matchesSource(row),
    ),
  };
}

async function publisherAdmission(env = process.env) {
  const source = env.SOURCE_SHA;
  const actual = execFileSyncBounded('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(source ?? '') || source !== actual)
    throw new Error('publisher source does not match checkout');
  execFileSyncBounded('git', ['fetch', '--no-tags', 'origin', 'main'], {
    windowsHide: true,
  });
  const recoveryLock = execFileSyncBounded(
    'git',
    ['ls-remote', '--refs', 'origin', 'refs/tags/nightly-recovery-lock'],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  if (recoveryLock)
    throw new Error('native publication is held by the recovery lock');
  const qualification = await findQualification(source, {
    ...env,
    GITHUB_RUN_ID: '0',
  });
  const ledger = readLedgerFromGit(process.cwd(), 'origin/main');
  const sourceCandidates = Object.fromEntries(
    ['nightly-android', 'nightly-desktop'].map((channel) => {
      const latest = ledger
        .filter((row) => row.channel === channel)
        .sort(
          (a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc),
        )[0];
      return [
        channel,
        normalizeDeployLedgerHead(
          source,
          (sha) => inspectCommitFromGit(process.cwd(), sha),
          latest?.sha || '',
        ),
      ];
    }),
  );
  const decision = finalPublicationDecision({
    source,
    qualification,
    ledger,
    sourceCandidates,
    ancestor: (prior, candidate) => {
      try {
        execFileSyncBounded(
          'git',
          ['merge-base', '--is-ancestor', prior, candidate],
          { windowsHide: true },
        );
        return true;
      } catch {
        return false;
      }
    },
    intervalMs: publicationInterval(env),
  });
  if (env.FORCE_REBUILD === 'true') {
    decision.androidNeeded = true;
    decision.desktopNeeded = true;
  }
  console.log(JSON.stringify({ source, qualification, ...decision }));
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT required');
  appendFileSync(
    env.GITHUB_OUTPUT,
    `android_needed=${decision.androidNeeded}\ndesktop_needed=${decision.desktopNeeded}\n`,
  );
}

export async function reservationRecovery(source, env = process.env) {
  const runs = await listGithub(
    `actions/runs?head_sha=${source}`,
    'workflow_runs',
    { env },
  );
  const previous = runs.filter(
    (run) => String(run.id) !== String(env.GITHUB_RUN_ID),
  );
  const disposition = recoveryDisposition(
    previous,
    source,
    env.GITHUB_REPOSITORY,
  );
  if (!disposition.recover) return disposition;
  // An actual completed qualification gate separates a delivery failure from a
  // source failure. Never recover a reserved source merely because its run red.
  for (const run of previous) {
    if (
      run.head_sha !== source ||
      run.head_repository?.full_name !== env.GITHUB_REPOSITORY ||
      run.head_branch !== 'main' ||
      ![
        '.github/workflows/main-qualification.yml',
        '.github/workflows/nightly.yml',
      ].includes(run.path) ||
      !['push', 'schedule', 'workflow_dispatch'].includes(run.event) ||
      !['failure', 'timed_out'].includes(run.conclusion)
    )
      continue;
    const jobs = await listGithub(`actions/runs/${run.id}/jobs`, 'jobs', {
      env,
    });
    const qualified = jobs.some(
      (job) =>
        job.name.endsWith('Full source qualification') &&
        job.conclusion === 'success',
    );
    if (!qualified)
      return {
        recover: false,
        reason: 'reserved source lacks a passing qualification gate',
      };
  }
  return disposition;
}
