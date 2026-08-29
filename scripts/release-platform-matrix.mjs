#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const defaultRoot = resolve(import.meta.dirname, '..');
const CHANNELS = ['development', 'nightly', 'preview', 'stable'];
const PLATFORMS = [
  'web-portable',
  'macos',
  'windows',
  'linux',
  'android',
  'ios',
];
const CELL_STATES = new Set(['configured', 'gated', 'unsupported']);
const REQUIRED_CELL_FIELDS = [
  'testLane',
  'publicationTarget',
  'updateAuthority',
  'rollbackSource',
];

export function readReleasePlatformMatrix(root = defaultRoot) {
  return JSON.parse(
    readFileSync(resolve(root, 'config/release-platform-matrix.json'), 'utf8'),
  );
}

function workflowJobs(root, file) {
  const parsed = load(
    readFileSync(resolve(root, '.github/workflows', file), 'utf8'),
  );
  return parsed?.jobs ?? {};
}

function buildJobReferences(value) {
  if (typeof value !== 'string' || value.startsWith('local:')) return [];
  return value.split(' and ').map((reference) => {
    const [workflow, job, extra] = reference.split('#');
    return { workflow, job, extra };
  });
}

export function validateReleasePlatformMatrix({
  matrix,
  root = defaultRoot,
  ledger = JSON.parse(
    readFileSync(resolve(root, 'docs/reference/deploy-ledger.json'), 'utf8'),
  ),
}) {
  const errors = [];
  if (matrix?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  for (const channel of CHANNELS) {
    if (!matrix?.channels?.[channel]) errors.push(`missing channel ${channel}`);
  }
  for (const platform of PLATFORMS) {
    const entry = matrix?.platforms?.[platform];
    if (!entry) {
      errors.push(`missing platform ${platform}`);
      continue;
    }
    for (const field of ['artifactIdentity', 'signingRequirement']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        errors.push(`${platform}.${field} must be a non-empty string`);
      }
    }
  }

  const workflowCache = new Map();
  for (const channel of CHANNELS) {
    for (const platform of PLATFORMS) {
      const cell = matrix?.cells?.[channel]?.[platform];
      const label = `${channel}:${platform}`;
      if (!cell) {
        errors.push(`missing cell ${label}`);
        continue;
      }
      if (!CELL_STATES.has(cell.state)) {
        errors.push(`${label}.state is invalid: ${String(cell.state)}`);
      }
      for (const field of REQUIRED_CELL_FIELDS) {
        if (typeof cell[field] !== 'string' || cell[field].trim() === '') {
          errors.push(`${label}.${field} must be a non-empty string`);
        }
      }
      if (cell.state === 'configured' && !cell.buildJob) {
        errors.push(`${label} is configured but has no buildJob`);
      }
      for (const reference of buildJobReferences(cell.buildJob)) {
        if (!reference.workflow || !reference.job || reference.extra) {
          errors.push(`${label}.buildJob is malformed: ${cell.buildJob}`);
          continue;
        }
        let jobs = workflowCache.get(reference.workflow);
        if (!jobs) {
          try {
            jobs = workflowJobs(root, reference.workflow);
            workflowCache.set(reference.workflow, jobs);
          } catch (error) {
            errors.push(
              `${label}.buildJob cannot read ${reference.workflow}: ${error.message}`,
            );
            continue;
          }
        }
        if (!jobs[reference.job]) {
          errors.push(
            `${label}.buildJob references missing ${reference.workflow}#${reference.job}`,
          );
        }
      }

      const evidence = cell.evidence;
      if (evidence?.kind === 'deploy-ledger') {
        const entry = ledger.find(
          (candidate) => candidate.channel === evidence.selector,
        );
        if (!entry) {
          errors.push(
            `${label}.evidence has no deploy-ledger entry for ${String(evidence.selector)}`,
          );
        }
      } else if (evidence?.kind === 'not-verified') {
        if (!evidence.owner || !evidence.reason) {
          errors.push(`${label}.evidence must name an owner and reason`);
        }
      } else if (evidence?.kind === 'unsupported') {
        if (cell.state !== 'unsupported' || !evidence.reason) {
          errors.push(`${label}.unsupported evidence must match cell state`);
        }
      } else {
        errors.push(`${label}.evidence kind is invalid`);
      }
    }
  }
  return errors;
}

export function projectReleasePlatformMatrix({ matrix, ledger }) {
  const cells = [];
  for (const channel of CHANNELS) {
    for (const platform of PLATFORMS) {
      const cell = matrix.cells[channel][platform];
      let currentEvidence;
      if (cell.evidence.kind === 'deploy-ledger') {
        const entry = ledger.find(
          (candidate) => candidate.channel === cell.evidence.selector,
        );
        currentEvidence = entry
          ? {
              status: 'VERIFIED',
              sha: entry.sha,
              version: entry.version,
              workflowRunUrl: entry.workflowRunUrl,
              observedAt: entry.timestampUtc,
            }
          : {
              status: 'NOT_VERIFIED',
              owner: '#844',
              reason: `No ${cell.evidence.selector} deploy-ledger entry exists.`,
            };
      } else {
        currentEvidence = {
          status:
            cell.evidence.kind === 'unsupported'
              ? 'UNSUPPORTED'
              : 'NOT_VERIFIED',
          owner: cell.evidence.owner ?? null,
          reason: cell.evidence.reason,
        };
      }
      cells.push({
        channel,
        platform,
        sourceAuthority: matrix.channels[channel].sourceAuthority,
        versionAuthority: matrix.channels[channel].versionAuthority,
        artifactIdentity: matrix.platforms[platform].artifactIdentity,
        signingRequirement: matrix.platforms[platform].signingRequirement,
        ...cell,
        currentEvidence,
      });
    }
  }
  return { schemaVersion: 1, cells };
}

export function main(argv = process.argv.slice(2), root = defaultRoot) {
  const matrix = readReleasePlatformMatrix(root);
  const ledger = JSON.parse(
    readFileSync(resolve(root, 'docs/reference/deploy-ledger.json'), 'utf8'),
  );
  const errors = validateReleasePlatformMatrix({ matrix, root, ledger });
  if (errors.length > 0) {
    throw new Error(
      `release platform matrix is invalid:\n- ${errors.join('\n- ')}`,
    );
  }
  if (argv.includes('--project')) {
    const projection = `${JSON.stringify(
      projectReleasePlatformMatrix({ matrix, ledger }),
      null,
      2,
    )}\n`;
    const outputAt = argv.indexOf('--output');
    if (outputAt >= 0) {
      const output = argv[outputAt + 1];
      if (!output) throw new Error('--output requires a path');
      writeFileSync(resolve(root, output), projection);
    } else {
      process.stdout.write(projection);
    }
  } else {
    process.stdout.write('release platform matrix: valid\n');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
