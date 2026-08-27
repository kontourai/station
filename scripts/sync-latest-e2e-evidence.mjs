#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import yauzl from 'yauzl';
import {
  E2E_LATEST_SCHEMA_VERSION,
  inspectE2EEvidenceDirectory,
  MAX_E2E_EVIDENCE_BYTES,
  MAX_E2E_EVIDENCE_FILES,
  projectLatestE2EEvidence,
  validateLatestE2EEvidence,
} from './lib/e2e-latest-evidence.mjs';

const REPOSITORY = 'kontourai/station';
const WORKFLOW = 'CI Extended';
const WORKFLOW_PATH = '.github/workflows/ci-extended.yml';
const ARTIFACT_PREFIX = 'playwright-full-verification-';
export const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = MAX_E2E_EVIDENCE_FILES + 16;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseSyncArgs(args) {
  const options = { runId: null, status: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--run-id') {
      options.runId = args[++i];
      if (!options.runId) throw new Error('--run-id requires a value');
    } else if (args[i] === '--status') {
      options.status = args[++i];
      if (!options.status) throw new Error('--status requires a value');
    } else throw new Error(`Unknown argument '${args[i]}'`);
  }
  if (options.runId && !/^\d+$/.test(options.runId))
    throw new Error('--run-id must be numeric');
  if (
    options.status &&
    !/^(success|failure|cancelled|skipped|timed_out|action_required)$/.test(
      options.status,
    )
  )
    throw new Error('--status must be a completed conclusion');
  return options;
}

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Download with a compressed-byte fence while the process is still writing. */
export function downloadArchive(
  endpoint,
  output,
  { spawnImpl = spawn, maxBytes = MAX_ARCHIVE_BYTES } = {},
) {
  return new Promise((resolveDownload, reject) => {
    let bytes = 0;
    let finished = false;
    const outputStream = createWriteStream(output, {
      flags: 'wx',
      mode: 0o600,
    });
    let child;
    const fail = (error) => {
      if (finished) return;
      finished = true;
      child?.kill?.('SIGTERM');
      outputStream.destroy();
      rmSync(output, { force: true });
      reject(error);
    };
    try {
      child = spawnImpl('gh', ['api', endpoint], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      fail(error);
      return;
    }
    child.stdout.on('data', (chunk) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new Error('E2E archive exceeds compressed byte limit'));
        return;
      }
      if (!outputStream.write(chunk)) child.stdout.pause();
    });
    // `gh api` can emit an API error body on stderr. Drain it so a full pipe
    // cannot block a failed child while its stdout is otherwise well behaved.
    child.stderr?.resume?.();
    outputStream.on('drain', () => child?.stdout.resume());
    child.stdout.on('error', fail);
    child.stderr?.on('error', fail);
    outputStream.on('error', fail);
    child.on('error', fail);
    child.on('close', (code) => {
      if (finished) return;
      if (code !== 0) {
        fail(
          new Error(`GitHub archive download failed (${code ?? 'unknown'})`),
        );
        return;
      }
      outputStream.end(() => {
        if (finished) return;
        finished = true;
        resolveDownload();
      });
    });
  });
}

function workflowIdFor(invoke) {
  const workflows = JSON.parse(
    invoke(['api', `repos/${REPOSITORY}/actions/workflows`]),
  );
  const workflow = workflows.workflows?.find(
    (entry) => entry.name === WORKFLOW && entry.path === WORKFLOW_PATH,
  );
  if (!Number.isSafeInteger(workflow?.id))
    throw new Error('Unable to resolve CI Extended workflow identity');
  return workflow.id;
}

function runsFor(options, invoke, workflowId) {
  const fields =
    'databaseId,workflowDatabaseId,workflowName,status,conclusion,headSha';
  const values = options.runId
    ? [JSON.parse(invoke(['run', 'view', options.runId, '--json', fields]))]
    : JSON.parse(
        invoke([
          'run',
          'list',
          '--workflow',
          WORKFLOW,
          '--status',
          'completed',
          '--limit',
          '30',
          '--json',
          fields,
        ]),
      );
  const candidates = values.filter(
    (run) =>
      run.status === 'completed' &&
      run.workflowName === WORKFLOW &&
      run.workflowDatabaseId === workflowId &&
      Number.isSafeInteger(run.databaseId) &&
      typeof run.headSha === 'string' &&
      (!options.status || run.conclusion === options.status),
  );
  if (!candidates.length)
    throw new Error('No compatible completed CI Extended run was found');
  if (options.runId && candidates.length !== 1)
    throw new Error('Exact run is not a completed CI Extended run');
  return candidates;
}

function artifactFor(run, invoke) {
  const data = JSON.parse(
    invoke([
      'api',
      `repos/${REPOSITORY}/actions/runs/${run.databaseId}/artifacts`,
    ]),
  );
  const artifact = data.artifacts?.find(
    (entry) =>
      entry.name === `${ARTIFACT_PREFIX}${run.databaseId}` &&
      entry.expired !== true,
  );
  if (
    !artifact ||
    !Number.isSafeInteger(artifact.id) ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > MAX_ARCHIVE_BYTES
  )
    throw new Error('Run has no bounded compatible E2E artifact');
  return artifact;
}

function safeArchivePath(name) {
  const path = name.replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes('//'))
    throw new Error(`Archive has unsafe path: ${name}`);
  const rawParts = path.split('/');
  if (rawParts.at(-1) === '') rawParts.pop();
  const parts = rawParts;
  if (
    !parts.length ||
    parts.some(
      (part) =>
        (part !== '.kontourai' && !SAFE_SEGMENT.test(part)) ||
        part === '.' ||
        part === '..',
    )
  )
    throw new Error(`Archive has unsafe path: ${name}`);
  return { path, parts };
}

function projectionEntry(name) {
  const { path } = safeArchivePath(name);
  const nestedPrefix = '.kontourai/e2e-latest/';
  if (path.startsWith(nestedPrefix))
    return { root: 'nested', path: path.slice(nestedPrefix.length) };
  // Root-form artifacts are allowed, but only their explicit projection files
  // are selected; other upload-artifact paths are validated then ignored.
  if (
    path === 'manifest.json' ||
    path === 'index.html' ||
    path.startsWith('runs/')
  )
    return { root: 'root', path };
  return null;
}

function openZip(path) {
  return new Promise((resolveOpen, rejectOpen) =>
    yauzl.open(
      path,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (error, zip) => (error ? rejectOpen(error) : resolveOpen(zip)),
    ),
  );
}

function regularArchiveEntry(entry) {
  if (entry.fileName.endsWith('/')) return true;
  const host = entry.versionMadeBy >>> 8;
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  return host !== 3 || type === 0 || type === 0o100000;
}

/** Preflight all central-directory entries before any payload byte is written. */
export async function preflightBoundedE2EZip(
  archivePath,
  {
    maxFiles = MAX_E2E_EVIDENCE_FILES,
    maxBytes = MAX_E2E_EVIDENCE_BYTES,
    maxEntryBytes = MAX_ARCHIVE_ENTRY_BYTES,
  } = {},
) {
  if (statSync(archivePath).size > MAX_ARCHIVE_BYTES)
    throw new Error('E2E archive exceeds compressed byte limit');
  const zip = await openZip(archivePath);
  return new Promise((resolvePreflight, rejectPreflight) => {
    const entries = [];
    let declaredBytes = 0;
    let fileCount = 0;
    let centralEntries = 0;
    let rootKind = null;
    let rootManifestCount = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      rejectPreflight(error);
    };
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      try {
        centralEntries += 1;
        if (
          centralEntries > maxFiles + 16 ||
          centralEntries > MAX_ARCHIVE_ENTRIES
        )
          throw new Error('E2E archive exceeds entry limit');
        if (!regularArchiveEntry(entry))
          throw new Error(`Archive has non-regular entry: ${entry.fileName}`);
        // Even ignored CI artifact paths must be normalized and link-free.
        const projected = projectionEntry(entry.fileName);
        if (projected) {
          const kind = projected.root;
          if (rootKind && rootKind !== kind)
            throw new Error('Archive mixes projection roots');
          rootKind = kind;
          if (projected.path === 'manifest.json') rootManifestCount += 1;
          if (!entry.fileName.endsWith('/')) {
            if (++fileCount > maxFiles)
              throw new Error('E2E archive exceeds evidence file limit');
            if (
              !Number.isSafeInteger(entry.uncompressedSize) ||
              entry.uncompressedSize < 0 ||
              entry.uncompressedSize > maxEntryBytes
            )
              throw new Error(
                `Archive entry has invalid per-entry size: ${projected.path}`,
              );
            declaredBytes += entry.uncompressedSize;
            if (declaredBytes > maxBytes)
              throw new Error(
                'E2E archive exceeds uncompressed evidence bounds',
              );
            if (entries.some((entry) => entry.path === projected.path))
              throw new Error(
                `Archive has duplicate projection entry: ${projected.path}`,
              );
            entries.push({
              path: projected.path,
              declaredBytes: entry.uncompressedSize,
            });
          }
        }
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      zip.close();
      if (!rootKind || rootManifestCount !== 1 || !entries.length)
        rejectPreflight(new Error('Archive has no E2E projection payload'));
      else resolvePreflight(entries);
    });
    zip.readEntry();
  });
}

async function streamEntry(zip, entry, output, expectedBytes, state, maxBytes) {
  await new Promise((resolveStream, rejectStream) =>
    zip.openReadStream(entry, (error, input) => {
      if (error) return rejectStream(error);
      const writer = createWriteStream(output, { flags: 'wx', mode: 0o600 });
      let actualBytes = 0;
      let settled = false;
      const fail = (failure) => {
        if (settled) return;
        settled = true;
        input.destroy();
        writer.destroy();
        rejectStream(failure);
      };
      input.on('data', (chunk) => {
        actualBytes += chunk.length;
        state.bytes += chunk.length;
        if (actualBytes > expectedBytes || state.bytes > maxBytes)
          fail(
            new Error('E2E archive stream exceeded declared evidence bounds'),
          );
      });
      input.on('error', fail);
      writer.on('error', fail);
      writer.on('finish', () => {
        if (settled) return;
        settled = true;
        if (actualBytes !== expectedBytes)
          rejectStream(new Error('E2E archive entry size mismatch'));
        else resolveStream();
      });
      input.pipe(writer);
    }),
  );
}

/**
 * A second lazy pass streams the preflighted entries. A failure removes the
 * partial destination so an interrupted archive is never projected or reused.
 */
export async function extractBoundedE2EZip(
  archivePath,
  destination,
  {
    maxFiles = MAX_E2E_EVIDENCE_FILES,
    maxBytes = MAX_E2E_EVIDENCE_BYTES,
    maxEntryBytes = MAX_ARCHIVE_ENTRY_BYTES,
  } = {},
) {
  const plan = await preflightBoundedE2EZip(archivePath, {
    maxFiles,
    maxBytes,
    maxEntryBytes,
  });
  if (existsSync(destination))
    throw new Error('E2E extraction destination exists');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const expected = new Map(
    plan.map((entry) => [entry.path, entry.declaredBytes]),
  );
  const zip = await openZip(archivePath);
  const state = { bytes: 0, count: 0 };
  try {
    await new Promise((resolveExtract, rejectExtract) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        rejectExtract(error);
      };
      zip.on('error', fail);
      zip.on('entry', async (entry) => {
        try {
          const projected = projectionEntry(entry.fileName);
          if (!projected || entry.fileName.endsWith('/')) {
            zip.readEntry();
            return;
          }
          const declaredBytes = expected.get(projected.path);
          if (declaredBytes === undefined)
            throw new Error('Archive changed after preflight');
          expected.delete(projected.path);
          const output = resolve(destination, projected.path);
          if (!output.startsWith(`${resolve(destination)}${sep}`))
            throw new Error('Archive output escaped destination');
          mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 });
          state.count += 1;
          if (state.count > maxFiles)
            throw new Error('E2E archive exceeds evidence file limit');
          await streamEntry(zip, entry, output, declaredBytes, state, maxBytes);
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        if (expected.size)
          rejectExtract(new Error('Archive changed after preflight'));
        else resolveExtract();
      });
      zip.readEntry();
    });
    return inspectE2EEvidenceDirectory(destination);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    zip.close();
  }
}

function installExtracted(root, run, artifact, destinationDir, workflowId) {
  // GitHub's artifact can contain the projection at its archive root or under
  // its ignored checkout path; no other root is accepted by preflight.
  const sourceManifest = validateLatestE2EEvidence(root, {
    revision: run.headSha,
  });
  if (
    sourceManifest.schemaVersion !== E2E_LATEST_SCHEMA_VERSION ||
    String(sourceManifest.ciRunId) !== String(run.databaseId) ||
    sourceManifest.revision !== run.headSha
  )
    throw new Error(
      'Artifact manifest identity does not match selected workflow run',
    );
  const payload = join(root, sourceManifest.payloadDirectory);
  return projectLatestE2EEvidence({
    sourceDir: payload,
    destinationDir,
    runId: sourceManifest.runId,
    source: `github-actions:${run.databaseId}`,
    revision: run.headSha,
    ciRunId: run.databaseId,
    buckets: sourceManifest.buckets,
    remoteArtifact: {
      id: artifact.id,
      name: artifact.name,
      sizeBytes: artifact.size_in_bytes,
      workflowId,
    },
  });
}

export async function syncLatestE2EEvidence(
  options,
  {
    invoke = gh,
    spawnImpl = spawn,
    destinationDir = join(process.cwd(), '.kontourai', 'e2e-latest'),
  } = {},
) {
  const temporary = mkdtempSync(join(tmpdir(), 'station-e2e-sync-'));
  try {
    const workflowId = workflowIdFor(invoke);
    let lastError;
    for (const run of runsFor(options, invoke, workflowId))
      try {
        const artifact = artifactFor(run, invoke);
        const archive = join(temporary, `${artifact.id}.zip`);
        await downloadArchive(
          `repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
          archive,
          { spawnImpl },
        );
        const extracted = join(temporary, String(artifact.id));
        await extractBoundedE2EZip(archive, extracted);
        return {
          run,
          manifest: installExtracted(
            extracted,
            run,
            artifact,
            destinationDir,
            workflowId,
          ),
        };
      } catch (error) {
        lastError = error;
        if (options.runId) throw error;
      }
    throw new Error(
      `No completed CI Extended run had compatible bounded E2E evidence: ${lastError?.message ?? 'unknown'}`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function formatSyncResult(result) {
  return `Installed CI Extended run ${result.run.databaseId} (${result.manifest.verdict}) at .kontourai/e2e-latest/`;
}

export async function main(args = process.argv.slice(2)) {
  const result = await syncLatestE2EEvidence(parseSyncArgs(args));
  console.log(formatSyncResult(result));
}
if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`)
  main().catch((error) => {
    console.error(`E2E evidence sync failed: ${error.message}`);
    process.exitCode = 1;
  });
