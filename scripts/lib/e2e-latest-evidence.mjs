import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const E2E_LATEST_SCHEMA_VERSION = 2;
export const MAX_E2E_EVIDENCE_FILES = 500;
export const MAX_E2E_EVIDENCE_BYTES = 100 * 1024 * 1024;
export const MAX_E2E_EVIDENCE_TEXT_BYTES = 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.json',
  '.html',
  '.txt',
  '.md',
  '.log',
  '.zip',
]);
const TEXT_EXTENSIONS = new Set(['.json', '.html', '.txt', '.md', '.log']);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertDirectory(path, label, { create = false } = {}) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new Error(`${label} must be a regular directory`);
}

function assertSafeWorkspaceDirectory(
  workspaceRoot,
  path,
  label,
  { create = false } = {},
) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot)
    throw new Error('E2E evidence projection requires a workspace root');
  const root = resolve(workspaceRoot);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error('E2E evidence projection escapes its workspace root');
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('E2E evidence workspace root must be a regular directory');
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) {
      if (!create) throw new Error(`${label} does not exist`);
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`${label} has a symlinked or non-directory ancestor`);
  }
  return target;
}

function safeRelativePath(path) {
  const segments = path.split(/[\\/]/);
  if (
    !segments.length ||
    !segments.every(
      (segment) =>
        SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..',
    )
  )
    throw new Error(`E2E evidence rejects unsafe path: ${path}`);
  return segments.join('/');
}

function extension(path) {
  return path.slice(path.lastIndexOf('.')).toLowerCase();
}

function contained(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!resolvedCandidate.startsWith(`${resolvedRoot}${sep}`))
    throw new Error('E2E evidence path escapes root');
  return resolvedCandidate;
}

/** Read only a bounded, link-free tree whose names can be rendered safely. */
export function inspectE2EEvidenceDirectory(
  sourceDir,
  {
    maxFiles = MAX_E2E_EVIDENCE_FILES,
    maxBytes = MAX_E2E_EVIDENCE_BYTES,
    maxTextBytes = MAX_E2E_EVIDENCE_TEXT_BYTES,
    allowMissing = false,
    ignoredBasenames = [],
  } = {},
) {
  if (!existsSync(sourceDir)) {
    if (allowMissing) return [];
    throw new Error('E2E evidence source does not exist');
  }
  assertDirectory(sourceDir, 'E2E evidence source');
  const root = resolve(sourceDir);
  const files = [];
  const ignored = new Set(ignoredBasenames);
  let bytes = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = contained(root, join(directory, entry.name));
      const info = lstatSync(candidate);
      if (info.isSymbolicLink())
        throw new Error(
          `E2E evidence rejects symlink: ${relative(root, candidate)}`,
        );
      if (ignored.has(entry.name) && !info.isFile())
        throw new Error(
          `E2E evidence ignored entry is not a regular file: ${relative(root, candidate)}`,
        );
      if (info.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!info.isFile())
        throw new Error(
          `E2E evidence rejects non-regular file: ${relative(root, candidate)}`,
        );
      if (ignored.has(entry.name)) continue;
      const path = safeRelativePath(relative(root, candidate));
      const ext = extension(path);
      if (!ALLOWED_EXTENSIONS.has(ext))
        throw new Error(`E2E evidence rejects unsupported file: ${path}`);
      if (TEXT_EXTENSIONS.has(ext) && info.size > maxTextBytes)
        throw new Error(
          `E2E evidence text file exceeds ${maxTextBytes} bytes: ${path}`,
        );
      files.push({ path, bytes: info.size });
      bytes += info.size;
      if (files.length > maxFiles)
        throw new Error(`E2E evidence exceeds ${maxFiles} files`);
      if (bytes > maxBytes)
        throw new Error(`E2E evidence exceeds ${maxBytes} bytes`);
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function copyBoundedE2EEvidence(
  sourceDir,
  destinationDir,
  options = {},
) {
  const inventory = inspectE2EEvidenceDirectory(sourceDir, options);
  assertDirectory(destinationDir, 'E2E evidence destination', { create: true });
  for (const file of inventory) {
    const source = contained(sourceDir, join(sourceDir, file.path));
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink())
      throw new Error('E2E evidence source changed during copy');
    const target = contained(destinationDir, join(destinationDir, file.path));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
  }
  return inventory;
}

function writeAtomically(path, contents) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const POINTER_TEMP = /^\.(?:index\.html|manifest\.json)-\d+-\d+\.tmp$/;
const RUN_STAGE = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.\d+\.stage$/;
const PROJECTION_LOCK_WAIT_MS = 60_000;
const MALFORMED_LOCK_STALE_MS = 5 * 60_000;

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const command =
      process.platform === 'win32'
        ? [
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
            ],
          ]
        : ['ps', ['-p', String(pid), '-o', 'lstart=']];
    return (
      execFileSync(command[0], command[1], {
        encoding: 'utf8',
        // lstart is locale- and TZ-shaped; pin so identity is
        // env-independent (#3049). Inert for the powershell branch.
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function acquireProjectionLock(
  destinationDir,
  waitMs = PROJECTION_LOCK_WAIT_MS,
  processStartIdentityFn = processStartIdentity,
) {
  const path = join(
    dirname(destinationDir),
    `.${basename(destinationDir)}.projection.lock`,
  );
  const record = `${JSON.stringify({
    pid: process.pid,
    processStart: processStartIdentityFn(process.pid),
    nonce: randomUUID(),
  })}\n`;
  const started = Date.now();
  while (true) {
    try {
      writeFileSync(path, record, { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (readFileSync(path, 'utf8') === record)
            rmSync(path, { force: true });
        } catch {
          // Another recovery already removed or replaced the exact lock.
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('E2E evidence projection lock is unsafe');
      let existing;
      let contents;
      try {
        contents = readFileSync(path, 'utf8');
      } catch {
        throw new Error('E2E evidence projection lock is unreadable');
      }
      try {
        existing = JSON.parse(contents);
      } catch {
        if (Date.now() - info.mtimeMs >= MALFORMED_LOCK_STALE_MS) {
          try {
            if (readFileSync(path, 'utf8') === contents)
              rmSync(path, { force: true });
          } catch {
            // A replacement won the comparison; retry without touching it.
          }
          continue;
        }
        throw new Error('E2E evidence projection lock is invalid');
      }
      const live = processIsAlive(existing?.pid);
      const observedStart = live ? processStartIdentityFn(existing.pid) : null;
      const knownStartMismatch =
        live &&
        typeof existing?.processStart === 'string' &&
        existing.processStart.length > 0 &&
        typeof observedStart === 'string' &&
        observedStart.length > 0 &&
        observedStart !== existing.processStart;
      if (!live || knownStartMismatch) {
        try {
          if (readFileSync(path, 'utf8') === contents)
            rmSync(path, { force: true });
        } catch {
          // The owner or another recovery won the race; retry normally.
        }
        continue;
      }
      if (Date.now() - started >= waitMs)
        throw new Error('E2E evidence projection is busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function recoverOwnedProjectionDebris(latestDir) {
  for (const entry of readdirSync(latestDir, { withFileTypes: true })) {
    if (POINTER_TEMP.test(entry.name)) {
      rmSync(join(latestDir, entry.name), { force: true });
    }
  }
  const runs = join(latestDir, 'runs');
  if (!existsSync(runs)) return;
  assertDirectory(runs, 'E2E runs directory');
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    const target = join(runs, entry.name);
    if (RUN_STAGE.test(entry.name)) {
      rmSync(target, { recursive: true, force: true });
      continue;
    }
    const info = lstatSync(target);
    if (info.isSymbolicLink()) {
      rmSync(target, { force: true });
      continue;
    }
    if (!info.isDirectory())
      throw new Error(
        `E2E runs directory contains unsafe entry: ${entry.name}`,
      );
  }
}

function pruneUnreferencedRuns(runs, runId) {
  for (const entry of readdirSync(runs, { withFileTypes: true }))
    if (
      entry.isDirectory() &&
      entry.name !== runId &&
      !entry.name.startsWith('.')
    )
      rmSync(join(runs, entry.name), { recursive: true, force: true });
}

function htmlEscape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ],
  );
}

function galleryHref(manifest, file) {
  return [manifest.payloadDirectory, file]
    .join('/')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function renderStableIndex(manifest = null) {
  const prefix = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>Station latest E2E evidence</title><style>body{font:14px system-ui;margin:2rem;background:#101418;color:#e7edf4}a{color:#8cc8ff}.fail{color:#ff9b9b}.pass{color:#79d99b}li{margin:1rem 0}img{display:block;max-width:min(100%,960px);max-height:720px;margin-top:.5rem;border:1px solid #35404b}</style>`;
  if (!manifest)
    return `${prefix}<main><p>No completed E2E evidence has been projected yet.</p></main>`;
  const items = manifest.files
    .map((file) => {
      const href = htmlEscape(galleryHref(manifest, file.path));
      const label = htmlEscape(file.path);
      const preview = /\.(?:png|jpe?g|webp)$/i.test(file.path)
        ? `<img src="${href}" alt="${label}" loading="lazy">`
        : '';
      return `<li><a href="${href}">${label}</a>${preview}</li>`;
    })
    .join('');
  const omission = manifest.evidenceOmission
    ? `<p class="fail">Evidence payload omitted: ${htmlEscape(manifest.evidenceOmission.reason)}</p>`
    : '';
  return `${prefix}<main><h1 class="${manifest.verdict === 'PASS' ? 'pass' : 'fail'}">Latest full E2E evidence: ${htmlEscape(manifest.verdict)}</h1><p>Run ${htmlEscape(manifest.runId)} · ${htmlEscape(manifest.createdAt)}</p>${omission}<ul>${items}</ul></main>`;
}

function writeStableIndex(latestDir, manifest = null) {
  const index = join(latestDir, 'index.html');
  // Embed only the bounded, path-safe display projection. A local file opened
  // directly in a browser cannot fetch its sibling manifest under normal
  // file:// origin rules. The canonical manifest is still the atomic truth;
  // this independently swapped viewer always refers to an immutable payload.
  const html = renderStableIndex(manifest);
  writeAtomically(index, html);
  return Buffer.byteLength(html);
}

function bounded(value, max = 4096) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}
function resultRecord(result) {
  return {
    name: result.name,
    verdict: result.verdict,
    counts: result.counts ?? {},
    seconds: result.seconds ?? 0,
    runnerError: bounded(result.runnerError),
    specs: Array.isArray(result.specs)
      ? result.specs.slice(0, 40).map(String)
      : [],
    details: bounded(result.details ?? result.output),
  };
}

function manifestBytes(manifest) {
  const placeholder = {
    ...manifest,
    generated: {
      indexBytes: String(manifest.generated.indexBytes).padStart(12, '0'),
      indexDigest: manifest.generated.indexDigest,
      manifestBytes: '000000000000',
    },
  };
  const bytes = Buffer.byteLength(`${JSON.stringify(placeholder, null, 2)}\n`);
  return {
    ...placeholder,
    generated: {
      indexBytes: placeholder.generated.indexBytes,
      indexDigest: placeholder.generated.indexDigest,
      manifestBytes: String(bytes).padStart(12, '0'),
    },
  };
}

function buildManifest(draft) {
  const index = renderStableIndex(draft);
  return manifestBytes({
    ...draft,
    generated: {
      indexBytes: Buffer.byteLength(index),
      indexDigest: sha256(index),
      manifestBytes: '000000000000',
    },
  });
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('E2E latest manifest is invalid');
  }
}

/**
 * Validate the installed pointer and the immutable payload it selects. This is
 * deliberately stronger than checking that a receipt merely says an E2E lane
 * ran: both same-worktree and cross-worktree reuse must have a current,
 * bounded, link-free visual surface to reuse.
 */
export function validateLatestE2EEvidence(
  latestDir,
  {
    revision = null,
    receiptRequestKey = null,
    ownerBinding = null,
    includeUnreferenced = true,
    maxFiles = MAX_E2E_EVIDENCE_FILES,
    maxBytes = MAX_E2E_EVIDENCE_BYTES,
    maxTextBytes = MAX_E2E_EVIDENCE_TEXT_BYTES,
  } = {},
) {
  assertDirectory(latestDir, 'E2E latest directory');
  const manifestPath = join(latestDir, 'manifest.json');
  const indexPath = join(latestDir, 'index.html');
  const manifestInfo = lstatSync(manifestPath, { throwIfNoEntry: false });
  const indexInfo = lstatSync(indexPath, { throwIfNoEntry: false });
  if (
    !manifestInfo?.isFile() ||
    manifestInfo.isSymbolicLink() ||
    !indexInfo?.isFile() ||
    indexInfo.isSymbolicLink()
  )
    throw new Error('E2E latest pointer is incomplete or unsafe');
  const manifest = readManifest(manifestPath);
  if (
    manifest.schemaVersion !== E2E_LATEST_SCHEMA_VERSION ||
    !SAFE_SEGMENT.test(manifest.runId ?? '') ||
    manifest.payloadDirectory !== `runs/${manifest.runId}` ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.buckets)
  )
    throw new Error('E2E latest manifest has an invalid identity');
  if (manifest.generated != null) {
    if (
      !/^\d{12}$/.test(manifest.generated.indexBytes ?? '') ||
      !/^[0-9a-f]{64}$/.test(manifest.generated.indexDigest ?? '') ||
      !/^\d{12}$/.test(manifest.generated.manifestBytes ?? '')
    )
      throw new Error('E2E latest manifest has invalid generated metadata');
    const index = readFileSync(indexPath, 'utf8');
    if (
      Buffer.byteLength(index) !== Number(manifest.generated.indexBytes) ||
      sha256(index) !== manifest.generated.indexDigest ||
      index !== renderStableIndex(manifest)
    )
      throw new Error('E2E latest manifest and gallery index are inconsistent');
  }
  if (revision && manifest.revision !== revision)
    throw new Error('E2E latest evidence revision does not match its receipt');
  if (
    receiptRequestKey &&
    manifest.reusedFrom?.requestKey !== receiptRequestKey
  )
    throw new Error('E2E latest evidence is not bound to the owner receipt');
  if (
    ownerBinding &&
    ['path', 'runId', 'manifestDigest', 'payloadDigest'].some(
      (field) => manifest.reusedFrom?.[field] !== ownerBinding[field],
    )
  )
    throw new Error('E2E latest evidence does not match its owner binding');
  const payload = contained(
    latestDir,
    join(latestDir, manifest.payloadDirectory),
  );
  const inventory = inspectE2EEvidenceDirectory(payload, {
    maxFiles,
    maxBytes,
    maxTextBytes,
  });
  const expected = manifest.files
    .map((file) => ({ path: file?.path, bytes: file?.bytes }))
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  if (JSON.stringify(inventory) !== JSON.stringify(expected))
    throw new Error('E2E latest payload inventory does not match its manifest');
  // The complete installed tree, including pointer files, must remain within
  // the same advertised bounds as the source payload.
  if (includeUnreferenced)
    inspectE2EEvidenceDirectory(latestDir, {
      maxFiles,
      maxBytes,
      maxTextBytes,
    });
  return manifest;
}

/** Exact content binding used by reusable verification receipts. */
export function latestE2EEvidenceBinding(latestDir, options = {}) {
  const manifest = validateLatestE2EEvidence(latestDir, options);
  const manifestContents = readFileSync(join(latestDir, 'manifest.json'));
  const payload = join(latestDir, manifest.payloadDirectory);
  const files = inspectE2EEvidenceDirectory(payload, options).map((file) => {
    const contents = readFileSync(join(payload, file.path));
    if (contents.length !== file.bytes)
      throw new Error('E2E latest payload changed while binding its receipt');
    return { ...file, sha256: sha256(contents) };
  });
  return {
    path: '.kontourai/e2e-latest/',
    runId: manifest.runId,
    manifestDigest: sha256(manifestContents),
    payloadDigest: sha256(JSON.stringify(files)),
  };
}

function recoverLatestIndex(latestDir) {
  const manifestPath = join(latestDir, 'manifest.json');
  if (!existsSync(manifestPath)) return;
  const manifestInfo = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink())
    throw new Error('E2E latest manifest is unsafe');
  const manifest = readManifest(manifestPath);
  if (manifest.schemaVersion !== E2E_LATEST_SCHEMA_VERSION)
    throw new Error('E2E latest manifest cannot be recovered across schemas');
  const expected = renderStableIndex(manifest);
  const indexPath = join(latestDir, 'index.html');
  const current = lstatSync(indexPath, { throwIfNoEntry: false });
  if (
    !current?.isFile() ||
    current.isSymbolicLink() ||
    readFileSync(indexPath, 'utf8') !== expected
  )
    writeAtomically(indexPath, expected);
}

/**
 * Writes an immutable runs/<runId> payload, then atomically swaps only the
 * manifest pointer. The stable latest directory never moves or disappears.
 */
export function projectLatestE2EEvidence(options = {}) {
  const destinationDir = options.destinationDir;
  const workspaceRoot =
    options.workspaceRoot ?? dirname(dirname(resolve(destinationDir)));
  assertSafeWorkspaceDirectory(
    workspaceRoot,
    dirname(resolve(destinationDir)),
    'E2E latest parent directory',
    { create: true },
  );
  const release = acquireProjectionLock(
    destinationDir,
    options.projectionLockWaitMs ?? PROJECTION_LOCK_WAIT_MS,
    options.processStartIdentityFn ?? processStartIdentity,
  );
  try {
    const manifest = projectLatestE2EEvidenceLocked({
      ...options,
      workspaceRoot,
    });
    const projectionBinding = latestE2EEvidenceBinding(destinationDir, {
      includeUnreferenced: false,
      maxFiles: options.maxFiles ?? MAX_E2E_EVIDENCE_FILES,
      maxBytes: options.maxBytes ?? MAX_E2E_EVIDENCE_BYTES,
      maxTextBytes: options.maxTextBytes ?? MAX_E2E_EVIDENCE_TEXT_BYTES,
    });
    Object.defineProperty(manifest, 'projectionBinding', {
      value: projectionBinding,
      enumerable: false,
    });
    return manifest;
  } finally {
    release();
  }
}

function projectLatestE2EEvidenceLocked({
  sourceDir,
  destinationDir,
  runId,
  source = 'local',
  revision = 'unknown',
  ciRunId = null,
  buckets,
  createdAt = new Date().toISOString(),
  allowMissingSource = false,
  remoteArtifact = null,
  reusedFrom = null,
  afterPayloadCommit = null,
  afterIndexCommit = null,
  afterManifestCommit = null,
  evidenceOmission = null,
  workspaceRoot = dirname(dirname(resolve(destinationDir))),
  maxFiles = MAX_E2E_EVIDENCE_FILES,
  maxBytes = MAX_E2E_EVIDENCE_BYTES,
  maxTextBytes = MAX_E2E_EVIDENCE_TEXT_BYTES,
} = {}) {
  if (!SAFE_SEGMENT.test(runId ?? ''))
    throw new Error('E2E evidence run ID is unsafe');
  if (!Array.isArray(buckets) || buckets.length === 0)
    throw new Error('E2E evidence requires bucket results');
  assertSafeWorkspaceDirectory(
    workspaceRoot,
    destinationDir,
    'E2E latest directory',
    { create: true },
  );
  recoverOwnedProjectionDebris(destinationDir);
  recoverLatestIndex(destinationDir);
  if (!existsSync(join(destinationDir, 'index.html')))
    writeStableIndex(destinationDir);
  const sourceInventory = evidenceOmission
    ? []
    : inspectE2EEvidenceDirectory(sourceDir, {
        allowMissing: allowMissingSource,
        maxFiles,
        maxBytes,
        maxTextBytes,
      });
  const runs = assertSafeWorkspaceDirectory(
    workspaceRoot,
    join(destinationDir, 'runs'),
    'E2E runs directory',
    { create: true },
  );
  const stage = join(runs, `.${runId}.${process.pid}.stage`);
  const payload = join(runs, runId);
  if (existsSync(payload)) {
    const current = validateLatestE2EEvidence(destinationDir, {
      includeUnreferenced: false,
      maxFiles,
      maxBytes,
      maxTextBytes,
    });
    if (current.runId !== runId) {
      const orphanInventory = inspectE2EEvidenceDirectory(payload, {
        maxFiles,
        maxBytes,
        maxTextBytes,
      });
      if (JSON.stringify(orphanInventory) !== JSON.stringify(sourceInventory))
        throw new Error('E2E evidence payload run ID already exists');
      // An interruption after the immutable payload rename but before either
      // pointer moved leaves an unreferenced exact-run payload. Its full
      // inventory must match before reclaiming it for an exact retry.
      rmSync(payload, { recursive: true, force: true });
    }
  }
  if (existsSync(payload)) {
    const current = validateLatestE2EEvidence(destinationDir, {
      includeUnreferenced: false,
      maxFiles,
      maxBytes,
      maxTextBytes,
    });
    if (current.runId === runId) {
      if (JSON.stringify(current.files) !== JSON.stringify(sourceInventory))
        throw new Error(
          'E2E evidence payload run ID conflicts with source inventory',
        );
      // A receipt reuse can legitimately bind an already materialized immutable
      // payload to a newer receiving-worktree receipt. Upgrade only the pointer
      // through an atomic file replacement; never rewrite the payload.
      if (reusedFrom) {
        if (
          latestE2EEvidenceBinding(destinationDir, {
            includeUnreferenced: false,
            maxFiles,
            maxBytes,
            maxTextBytes,
          }).payloadDigest !== reusedFrom.payloadDigest
        )
          throw new Error(
            'E2E evidence payload does not match the owner receipt binding',
          );
        const replacementDraft = {
          ...current,
          source,
          revision,
          ciRunId,
          buckets: buckets.map(resultRecord),
          remoteArtifact,
          reusedFrom,
        };
        const replacement = buildManifest(replacementDraft);
        const finalBytes =
          Buffer.byteLength(`${JSON.stringify(replacement, null, 2)}\n`) +
          Number(replacement.generated.indexBytes) +
          current.files.reduce((sum, file) => sum + file.bytes, 0);
        if (current.files.length + 2 > maxFiles || finalBytes > maxBytes)
          throw new Error('E2E evidence generated projection exceeds bounds');
        writeStableIndex(destinationDir, replacement);
        afterIndexCommit?.();
        writeAtomically(
          join(destinationDir, 'manifest.json'),
          `${JSON.stringify(replacement, null, 2)}\n`,
        );
        afterManifestCommit?.();
        pruneUnreferencedRuns(runs, runId);
        return replacement;
      }
      writeStableIndex(destinationDir, current);
      pruneUnreferencedRuns(runs, runId);
      return current;
    }
    throw new Error('E2E evidence payload run ID already exists');
  }
  mkdirSync(stage, { mode: 0o700 });
  try {
    const copied = evidenceOmission
      ? []
      : copyBoundedE2EEvidence(sourceDir, stage, {
          allowMissing: allowMissingSource,
          maxFiles,
          maxBytes,
          maxTextBytes,
        });
    const files = copied.map((file) => ({ ...file, path: file.path }));
    const draft = {
      schemaVersion: E2E_LATEST_SCHEMA_VERSION,
      runId,
      source,
      revision,
      ciRunId,
      createdAt,
      verdict:
        !evidenceOmission &&
        buckets.every((bucket) => bucket.verdict === 'PASS')
          ? 'PASS'
          : 'FAIL',
      payloadDirectory: `runs/${runId}`,
      buckets: buckets.map(resultRecord),
      files,
      remoteArtifact,
      reusedFrom,
      evidenceOmission: evidenceOmission
        ? { reason: bounded(evidenceOmission.reason, 512) ?? 'unknown' }
        : null,
    };
    const manifest = buildManifest(draft);
    const finalBytes =
      Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`) +
      Number(manifest.generated.indexBytes) +
      files.reduce((sum, file) => sum + file.bytes, 0);
    if (files.length + 2 > maxFiles || finalBytes > maxBytes)
      throw new Error('E2E evidence generated projection exceeds bounds');
    renameSync(stage, payload);
    // Test seams cover both durable boundary windows: the immutable payload
    // exists before either pointer moves, then the derived viewer moves before
    // the canonical manifest. A later projection repairs the viewer from the
    // still-canonical manifest if interrupted between those two swaps.
    afterPayloadCommit?.();
    writeStableIndex(destinationDir, manifest);
    afterIndexCommit?.();
    const manifestPath = join(destinationDir, 'manifest.json');
    writeAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    afterManifestCommit?.();
    pruneUnreferencedRuns(runs, runId);
    return manifest;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
