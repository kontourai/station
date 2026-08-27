/**
 * Fieldwork Review — Station's narrow application-plugin facade.
 *
 * Station owns project confinement, metadata placement, host lifecycle, and
 * presentation. Fieldwork owns the run, review, and reviewed output. This
 * module deliberately interacts only with `createFieldworkApplication()`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, constants as fsConstants, readFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';

const PLUGIN_NAME = 'fieldwork-review';
const SAFE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SAFE_RUN_ID = /^fw_[a-z0-9]{24}$/;
const MAX_PATH_INPUT_LENGTH = 4096;
const MAX_REQUEST_BODY_BYTES = 8192;
const MAX_OPEN_RUNS = 8;
const MAX_OPEN_RUNS_PER_PROJECT = 4;
const OPEN_RUN_IDLE_MS = 30 * 60 * 1000;
const OPEN_RUN_CLOSE_RETRY_MS = 30 * 1000;
const RUN_INDEX_FILE = 'station-runs.json';
const REVIEWED_SOURCE_INDEX_FILE = 'station-reviewed-source-refs.json';
const MAX_REVIEWED_SOURCE_INDEX_BYTES = 4_194_304;
const MAX_REVIEWED_SOURCE_REFS = 10_000;

let applicationPromise;
let unsubscribeLifecycle;
let disposed = false;
const openRuns = new Map();
const projectMutations = new Map();

function projectDirectory(projectHomeDir, projectSlug) {
  return join(projectHomeDir, 'projects', projectSlug);
}

function isSafeSegment(value) {
  return (
    typeof value === 'string' && SAFE_SLUG.test(value) && !value.includes('..')
  );
}

function isSafeRunId(value) {
  return typeof value === 'string' && SAFE_RUN_ID.test(value);
}

function readProjectConfig(projectHomeDir, projectSlug) {
  const file = join(
    projectDirectory(projectHomeDir, projectSlug),
    'project.json',
  );
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function expandHomePath(value) {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) throw new Error('Project workspace is unavailable');
    return join(home, value.slice(2));
  }
  return value;
}

function pathIsInside(root, candidate) {
  const segment = relative(root, candidate);
  return !(
    segment === '..' ||
    segment.startsWith('..\\') ||
    segment.startsWith('../') ||
    isAbsolute(segment)
  );
}

async function projectWorkspace(projectHomeDir, projectSlug) {
  const project = readProjectConfig(projectHomeDir, projectSlug);
  if (!project)
    throw Object.assign(new Error('Project not found'), { status: 404 });
  if (
    typeof project.workingDirectory !== 'string' ||
    !project.workingDirectory
  ) {
    throw Object.assign(new Error('Project has no configured workspace'), {
      status: 409,
    });
  }
  const configured = expandHomePath(project.workingDirectory);
  if (!isAbsolute(configured) && !win32.isAbsolute(configured)) {
    throw Object.assign(new Error('Project workspace is invalid'), {
      status: 409,
    });
  }
  try {
    const workspace = await realpath(configured);
    if (!(await stat(workspace)).isDirectory())
      throw new Error('not a directory');
    return workspace;
  } catch {
    throw Object.assign(new Error('Project workspace is unavailable'), {
      status: 409,
    });
  }
}

async function resolveProjectFile(workspace, input, label) {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > MAX_PATH_INPUT_LENGTH ||
    input.includes('\0') ||
    isAbsolute(input) ||
    win32.isAbsolute(input) ||
    input.split(/[\\/]+/u).includes('..')
  ) {
    throw Object.assign(new Error(`${label} must be a project-relative file`), {
      status: 400,
    });
  }
  const requested = resolve(workspace, input);
  if (!pathIsInside(workspace, requested)) {
    throw Object.assign(
      new Error(`${label} must stay inside the project workspace`),
      { status: 400 },
    );
  }
  try {
    const canonical = await realpath(requested);
    if (
      !pathIsInside(workspace, canonical) ||
      !(await stat(canonical)).isFile()
    ) {
      throw new Error('outside workspace or not regular');
    }
    return canonical;
  } catch {
    throw Object.assign(
      new Error(`${label} must be an existing project file`),
      { status: 400 },
    );
  }
}

async function ensureRunsDirectory(projectHomeDir, projectSlug) {
  const projectsRoot = await realpath(join(projectHomeDir, 'projects'));
  const requestedProjectRoot = projectDirectory(projectHomeDir, projectSlug);
  let projectInfo;
  try {
    projectInfo = await lstat(requestedProjectRoot);
  } catch {
    throw Object.assign(new Error('Fieldwork run storage is unavailable'), {
      status: 409,
    });
  }
  if (projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) {
    throw Object.assign(new Error('Fieldwork run storage is unavailable'), {
      status: 409,
    });
  }
  const projectRoot = await realpath(requestedProjectRoot);
  if (!pathIsInside(projectsRoot, projectRoot)) {
    throw Object.assign(new Error('Fieldwork run storage is unavailable'), {
      status: 409,
    });
  }
  let current = projectRoot;
  for (const segment of ['plugin-data', PLUGIN_NAME, 'runs']) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('unsafe storage component');
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
        throw Object.assign(new Error('Fieldwork run storage is unavailable'), {
          status: 409,
        });
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (
          !mkdirError ||
          typeof mkdirError !== 'object' ||
          mkdirError.code !== 'EEXIST'
        ) {
          throw Object.assign(
            new Error('Fieldwork run storage is unavailable'),
            { status: 409 },
          );
        }
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw Object.assign(new Error('Fieldwork run storage is unavailable'), {
          status: 409,
        });
      }
    }
    const canonical = await realpath(current);
    if (!pathIsInside(projectRoot, canonical)) {
      throw Object.assign(new Error('Fieldwork run storage is unavailable'), {
        status: 409,
      });
    }
    current = canonical;
  }
  return current;
}

/**
 * The reviewed-sources reader is intentionally not allowed to reuse
 * ensureRunsDirectory(): a Basis read must never create a project directory,
 * hydrate a run, or repair an index merely because a person opened Sources.
 */
async function runsDirectoryForRead(projectHomeDir, projectSlug) {
  const projectsRoot = await realpath(join(projectHomeDir, 'projects'));
  const requestedProjectRoot = projectDirectory(projectHomeDir, projectSlug);
  let projectInfo;
  try {
    projectInfo = await lstat(requestedProjectRoot);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT')
      return undefined;
    throw new Error('Fieldwork run storage is unavailable');
  }
  if (projectInfo.isSymbolicLink() || !projectInfo.isDirectory())
    throw new Error('Fieldwork run storage is unavailable');
  const projectRoot = await realpath(requestedProjectRoot);
  if (!pathIsInside(projectsRoot, projectRoot))
    throw new Error('Fieldwork run storage is unavailable');
  let current = projectRoot;
  for (const segment of ['plugin-data', PLUGIN_NAME, 'runs']) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error('unsafe storage component');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT')
        return undefined;
      throw new Error('Fieldwork run storage is unavailable');
    }
    const canonical = await realpath(current);
    if (!pathIsInside(projectRoot, canonical))
      throw new Error('Fieldwork run storage is unavailable');
    current = canonical;
  }
  return current;
}

function indexPath(runRoot) {
  return join(runRoot, RUN_INDEX_FILE);
}

function reviewedSourceIndexPath(runRoot) {
  return join(runRoot, REVIEWED_SOURCE_INDEX_FILE);
}

function isValidRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    isSafeRunId(value.id) &&
    typeof value.runDirectory === 'string' &&
    typeof value.proposalCount === 'number' &&
    Number.isSafeInteger(value.proposalCount) &&
    value.proposalCount >= 0 &&
    typeof value.createdAt === 'string' &&
    typeof value.open === 'boolean'
  );
}

async function readRunIndex(runRoot) {
  try {
    const raw = JSON.parse(await readFile(indexPath(runRoot), 'utf8'));
    if (
      raw?.version !== 1 ||
      !Array.isArray(raw.runs) ||
      !raw.runs.every(isValidRecord)
    ) {
      throw new Error('invalid run index');
    }
    return raw.runs;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT')
      return [];
    throw Object.assign(new Error('Fieldwork run index is unavailable'), {
      status: 409,
    });
  }
}

async function writeRunIndex(runRoot, runs) {
  const file = indexPath(runRoot);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ version: 1, runs }, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  await rename(temporary, file);
}

function isExactReviewedSourceRef(value) {
  return (
    typeof value === 'string' &&
    /^fieldwork-reviewed-source:v1:[a-f0-9]{64}$/.test(value)
  );
}

function isValidReviewedSourceIndexEntry(value) {
  return (
    value &&
    typeof value === 'object' &&
    isSafeRunId(value.runId) &&
    typeof value.runDirectory === 'string' &&
    value.runDirectory.length > 0 &&
    value.runDirectory.length <= MAX_PATH_INPUT_LENGTH
  );
}

async function readBoundedRegularJson(file, maxBytes) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('unsafe index file');
    const raw = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('large index file');
    return JSON.parse(raw);
  } finally {
    await handle?.close();
  }
}

async function readReviewedSourceIndex(runRoot) {
  try {
    const raw = await readBoundedRegularJson(
      reviewedSourceIndexPath(runRoot),
      MAX_REVIEWED_SOURCE_INDEX_BYTES,
    );
    if (
      raw?.version !== 1 ||
      !raw.refs ||
      typeof raw.refs !== 'object' ||
      Array.isArray(raw.refs) ||
      Object.keys(raw.refs).length > MAX_REVIEWED_SOURCE_REFS ||
      !Object.entries(raw.refs).every(
        ([exactRef, entry]) =>
          isExactReviewedSourceRef(exactRef) &&
          isValidReviewedSourceIndexEntry(entry),
      )
    ) {
      throw new Error('invalid reviewed source index');
    }
    return raw.refs;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT')
      return undefined;
    throw Object.assign(
      new Error('Fieldwork reviewed source index is unavailable'),
      { status: 409 },
    );
  }
}

async function writeReviewedSourceIndex(runRoot, refs) {
  const file = reviewedSourceIndexPath(runRoot);
  try {
    const existing = await lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error('unsafe reviewed source index');
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT')
      throw error;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ version: 1, refs })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    try {
      await lstat(temporary);
      await import('node:fs/promises').then(({ unlink }) => unlink(temporary));
    } catch {
      // The temporary file is private and unreachable; a later writer may
      // clean it after a fault without exposing it to read-only resolution.
    }
    throw error;
  }
}

function publicRun(record) {
  return {
    id: record.id,
    proposalCount: record.proposalCount,
    createdAt: record.createdAt,
    open: record.open,
  };
}

async function loadRunRecord(runRoot, runId) {
  const record = (await readRunIndex(runRoot)).find(
    (entry) => entry.id === runId,
  );
  if (!record)
    throw Object.assign(new Error('Fieldwork run not found'), { status: 404 });
  const canonical = await realpath(record.runDirectory);
  if (
    !pathIsInside(runRoot, canonical) ||
    !(await lstat(canonical)).isDirectory()
  ) {
    throw Object.assign(new Error('Stored Fieldwork run is unavailable'), {
      status: 409,
    });
  }
  return {
    record: { ...record, runDirectory: canonical },
    runs: await readRunIndex(runRoot),
  };
}

async function loadIndexedRunRecord(runRoot, entry) {
  const canonical = await realpath(entry.runDirectory);
  if (
    !pathIsInside(runRoot, canonical) ||
    !(await lstat(canonical)).isDirectory()
  ) {
    throw Object.assign(new Error('Stored Fieldwork run is unavailable'), {
      status: 409,
    });
  }
  return { id: entry.runId ?? entry.id, runDirectory: canonical };
}

function validReviewedSourcesInvocation(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === 'station.reviewed-sources/v1' &&
    (value.operation === 'describe' || value.operation === 'currentness') &&
    value.pluginName === PLUGIN_NAME &&
    isSafeSegment(value.projectId) &&
    typeof value.exactRef === 'string' &&
    value.exactRef.length <= 1024 &&
    value.assessment &&
    typeof value.assessment === 'object' &&
    Number.isSafeInteger(value.assessment.revision) &&
    value.assessment.revision > 0 &&
    [
      'sourceClaimId',
      'sourceEvidenceId',
      'answerClaimId',
      'answerCitationEvidenceId',
    ].every(
      (key) =>
        typeof value.assessment[key] === 'string' &&
        value.assessment[key].length > 0 &&
        value.assessment[key].length <= 1024,
    )
  );
}

async function sourceOwnerApplication(runRoot, record) {
  const fieldwork = await import('@kontourai/fieldwork');
  // The plugin alone resolves these paths from its private run index. Station
  // receives only the opaque exactRef; it cannot nominate a run or storage
  // root. The source-check roots are deliberately owner-local as well.
  return {
    application: fieldwork.createFieldworkApplication({
      reviewedWebSourceOwner: {
        runDirectory: record.runDirectory,
        snapshotRoot: join(runRoot, 'snapshots'),
        sourceChecks: {
          receiptRoot: join(runRoot, 'source-checks'),
          observationRoot: join(runRoot, 'source-observations'),
          authorizeCurrentness: () => ({ isCurrent: () => !disposed }),
        },
        authorize: () => !disposed,
      },
    }),
    parseDescriptor: fieldwork.parseReviewedWebSourceDescriptor,
    parseCurrentness: fieldwork.parseReviewedWebSourceCurrentness,
    parseRefs: fieldwork.parseReviewedWebSourceRefs,
  };
}

async function reviewedRefsForRun(runRoot, record) {
  const source = await sourceOwnerApplication(runRoot, record);
  try {
    const refs = [];
    let cursor;
    do {
      const result = source.parseRefs(
        await source.application.listReviewedWebSourceRefs(cursor),
      );
      if (result.status !== 'available')
        throw new Error('reviewed source refs unavailable');
      refs.push(...result.refs);
      if (refs.length > MAX_REVIEWED_SOURCE_REFS)
        throw new Error('reviewed source refs exceed retained capacity');
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    if (
      new Set(refs).size !== refs.length ||
      !refs.every(isExactReviewedSourceRef)
    )
      throw new Error('invalid reviewed source refs');
    return refs;
  } finally {
    await source.application.close();
  }
}

/** Producer-only rebuild path. Resolution never discovers or repairs refs. */
async function projectReviewedSourceIndex(runRoot, runs) {
  const refs = {};
  for (const raw of runs) {
    const record = await loadIndexedRunRecord(runRoot, raw);
    for (const exactRef of await reviewedRefsForRun(runRoot, record)) {
      if (refs[exactRef])
        throw Object.assign(new Error('duplicate reviewed source ref'), {
          status: 409,
        });
      refs[exactRef] = {
        runId: raw.id,
        runDirectory: record.runDirectory,
      };
    }
  }
  if (Object.keys(refs).length > MAX_REVIEWED_SOURCE_REFS)
    throw Object.assign(
      new Error('Fieldwork reviewed source capacity is unavailable'),
      { status: 409 },
    );
  return refs;
}

/**
 * One opaque owner read. Metadata/currentness operations are intentionally
 * bounded to the plugin's persisted run list and do not touch source bytes.
 */
export const reviewedSources = {
  async readReviewedSource(input, context) {
    if (
      !validReviewedSourcesInvocation(input) ||
      !context ||
      typeof context.projectHomeDir !== 'string' ||
      disposed
    )
      return { version: 'station.reviewed-sources/v1', status: 'restricted' };
    try {
      const runRoot = await runsDirectoryForRead(
        // This home comes from Station composition under its module lease,
        // never from a client request or the association itself.
        context.projectHomeDir,
        input.projectId,
      );
      if (!runRoot)
        return { version: 'station.reviewed-sources/v1', status: 'missing' };
      const refs = await readReviewedSourceIndex(runRoot);
      // A missing producer index is a historical owner gap, not a scan or
      // write on the read path.  Only a truly absent exact ref is "missing".
      if (!refs)
        return {
          version: 'station.reviewed-sources/v1',
          status: 'unavailable',
        };
      const entry = refs[input.exactRef];
      if (!entry)
        if (Object.keys(refs).length >= MAX_REVIEWED_SOURCE_REFS)
          // At retained capacity an absent ref might be a just-refused
          // registration. Do not mislabel that producer-limit outcome as an
          // affirmative historical absence.
          return {
            version: 'station.reviewed-sources/v1',
            status: 'unavailable',
          };
      if (!entry)
        return { version: 'station.reviewed-sources/v1', status: 'missing' };
      const record = await loadIndexedRunRecord(runRoot, entry);
      const source = await sourceOwnerApplication(runRoot, record);
      try {
        const result =
          input.operation === 'describe'
            ? await source.application.describeReviewedWebSource(input.exactRef)
            : await source.application.readReviewedWebSourceCurrentness(
                input.exactRef,
              );
        if (input.operation === 'describe') {
          // Strict published decoder: no plugin-provided object crosses the
          // Station boundary merely because it happens to have a status.
          const descriptor = source.parseDescriptor(result);
          if (descriptor.status !== 'available')
            return {
              version: 'station.reviewed-sources/v1',
              status: descriptor.status,
            };
          return {
            version: 'station.reviewed-sources/v1',
            status: 'available',
            payload: descriptor,
          };
        }
        // Fieldwork's closed currentness arms are meaningful owner facts:
        // Station carries the decoded arm to Surface so it can derive an
        // unknown source state. Only authorization remains descriptor-only.
        return {
          version: 'station.reviewed-sources/v1',
          status: 'available',
          payload: source.parseCurrentness(result),
        };
      } finally {
        await source.application.close();
      }
      return { version: 'station.reviewed-sources/v1', status: 'missing' };
    } catch {
      return { version: 'station.reviewed-sources/v1', status: 'unavailable' };
    }
  },
};

function presentation() {
  return {
    apiVersion: 'fieldwork.kontourai.io/v1',
    kind: 'FieldworkHostPresentation',
    eyebrow: 'Station',
    title: 'Fieldwork review',
    theme: 'dark',
    navigation: [],
  };
}

function embeddingOrigin(request) {
  const value = request.header('origin');
  let parsed;
  try {
    parsed = value ? new URL(value) : null;
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== value
  ) {
    throw Object.assign(new Error('A canonical browser origin is required'), {
      status: 400,
    });
  }
  return value;
}

async function application(context) {
  if (disposed) {
    throw Object.assign(new Error('Fieldwork plugin is unavailable'), {
      status: 503,
    });
  }
  if (!applicationPromise) {
    applicationPromise = import('@kontourai/fieldwork').then(
      ({ createFieldworkApplication }) => {
        const created = createFieldworkApplication();
        unsubscribeLifecycle = created.subscribe((event) => {
          context.telemetry.recordRoutingDecision({
            domain: 'fieldwork',
            eventCount: event.eventCount,
            eventSequence: event.sequence,
            eventType: event.type,
            revision: event.revision,
          });
        });
        return created;
      },
    );
  }
  return applicationPromise;
}

function runKey(projectSlug, runId) {
  return `${projectSlug}:${runId}`;
}

async function serializeProjectMutation(projectSlug, operation) {
  const prior = projectMutations.get(projectSlug) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(operation);
  projectMutations.set(projectSlug, next);
  try {
    return await next;
  } finally {
    if (projectMutations.get(projectSlug) === next) {
      projectMutations.delete(projectSlug);
    }
  }
}

async function closeRun(projectSlug, runId) {
  const key = runKey(projectSlug, runId);
  const opened = openRuns.get(key);
  if (opened) {
    clearTimeout(opened.timer);
    if (opened.service) {
      await opened.service.close();
      opened.service = undefined;
    }
  }
}

async function closeRunAndPersist(projectHomeDir, projectSlug, runId) {
  const runRoot = await ensureRunsDirectory(projectHomeDir, projectSlug);
  const { runs } = await loadRunRecord(runRoot, runId);
  await closeRun(projectSlug, runId);
  const next = runs.map((entry) =>
    entry.id === runId ? { ...entry, open: false } : entry,
  );
  await writeRunIndex(runRoot, next);
  openRuns.delete(runKey(projectSlug, runId));
  return next.find((entry) => entry.id === runId);
}

async function requestBody(c) {
  const declaredLength = Number(c.req.header('content-length') ?? 0);
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > MAX_REQUEST_BODY_BYTES
  ) {
    throw Object.assign(new Error('Request body is too large'), {
      status: 413,
    });
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('Request body is too large'), {
          status: 413,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (Number.isInteger(error?.status)) throw error;
    throw Object.assign(new Error('Request body must be valid JSON'), {
      status: 400,
    });
  }
}

function assertOpenCapacity(projectSlug, runId) {
  if (openRuns.has(runKey(projectSlug, runId))) return;
  const projectOpenCount = [...openRuns.keys()].filter((key) =>
    key.startsWith(`${projectSlug}:`),
  ).length;
  if (
    openRuns.size >= MAX_OPEN_RUNS ||
    projectOpenCount >= MAX_OPEN_RUNS_PER_PROJECT
  ) {
    throw Object.assign(new Error('Too many Fieldwork reviews are open'), {
      status: 429,
    });
  }
}

function scheduleIdleClose(context, projectSlug, runId, delay) {
  const timer = setTimeout(async () => {
    try {
      await serializeProjectMutation(projectSlug, () =>
        closeRunAndPersist(context.projectHomeDir, projectSlug, runId),
      );
    } catch {
      context.logger.warn('Fieldwork idle close failed; retrying', {
        plugin: PLUGIN_NAME,
        project: projectSlug,
        run: runId,
      });
      const opened = openRuns.get(runKey(projectSlug, runId));
      if (opened) {
        opened.timer = scheduleIdleClose(
          context,
          projectSlug,
          runId,
          OPEN_RUN_CLOSE_RETRY_MS,
        );
      }
    }
  }, delay);
  timer.unref?.();
  return timer;
}

function retainOpenRun(context, projectSlug, runId, service) {
  const timer = scheduleIdleClose(
    context,
    projectSlug,
    runId,
    OPEN_RUN_IDLE_MS,
  );
  openRuns.set(runKey(projectSlug, runId), {
    projectHomeDir: context.projectHomeDir,
    service,
    timer,
  });
}

function failure(c, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message =
    status >= 500 ? 'Fieldwork request could not be completed' : error.message;
  return c.json({ success: false, error: message }, status);
}

function guardProject(projectSlug) {
  if (!isSafeSegment(projectSlug)) {
    throw Object.assign(new Error('Invalid project'), { status: 400 });
  }
}

function guardRun(runId) {
  if (!isSafeRunId(runId)) {
    throw Object.assign(new Error('Invalid run'), { status: 400 });
  }
}

function installListRoute(app, context) {
  app.get('/projects/:projectSlug/runs', async (c) => {
    try {
      const projectSlug = c.req.param('projectSlug');
      guardProject(projectSlug);
      await projectWorkspace(context.projectHomeDir, projectSlug);
      const runRoot = await ensureRunsDirectory(
        context.projectHomeDir,
        projectSlug,
      );
      const runs = await readRunIndex(runRoot);
      return c.json({ success: true, runs: runs.map(publicRun) });
    } catch (error) {
      return failure(c, error);
    }
  });
}

async function createRun(context, projectSlug, body) {
  const workspace = await projectWorkspace(context.projectHomeDir, projectSlug);
  const taskPath = await resolveProjectFile(workspace, body?.taskPath, 'Task');
  const sourcePath =
    body?.sourcePath === undefined || body?.sourcePath === ''
      ? undefined
      : await resolveProjectFile(workspace, body.sourcePath, 'Source');
  const runRoot = await ensureRunsDirectory(
    context.projectHomeDir,
    projectSlug,
  );
  const result = await (await application(context)).run({
    taskPath,
    sourcePath,
    root: runRoot,
  });
  return recordCreatedRun(runRoot, result);
}

async function recordCreatedRun(runRoot, result) {
  const runDirectory = await realpath(result.runDirectory);
  if (
    !pathIsInside(runRoot, runDirectory) ||
    !(await lstat(runDirectory)).isDirectory()
  ) {
    throw new Error('Fieldwork returned an invalid run location');
  }
  const runs = await readRunIndex(runRoot);
  const existing = runs.find((entry) => entry.runDirectory === runDirectory);
  const record = existing ?? {
    id: `fw_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    runDirectory,
    proposalCount: result.proposalCount,
    createdAt: new Date().toISOString(),
    open: false,
  };
  const next = existing ? runs : [record, ...runs];
  // Build and bound the full producer map before exposing a new run.  A cap
  // refusal leaves the prior run ledger untouched, so a restart cannot turn a
  // just-registered source into a false missing result.
  const refs = await projectReviewedSourceIndex(runRoot, next);
  // Publish the resolver map before the listing record. A fault can leave an
  // unlisted but resolvable run, never a listed run whose exact refs vanished.
  await writeReviewedSourceIndex(runRoot, refs);
  if (!existing) await writeRunIndex(runRoot, next);
  return record;
}

function installLaunchRoute(app, context) {
  app.post('/projects/:projectSlug/runs', async (c) => {
    try {
      const projectSlug = c.req.param('projectSlug');
      guardProject(projectSlug);
      return await serializeProjectMutation(projectSlug, async () => {
        const body = await requestBody(c);
        const record = await createRun(context, projectSlug, body);
        return c.json({ success: true, run: publicRun(record) }, 201);
      });
    } catch (error) {
      return failure(c, error);
    }
  });
}

async function openStoredRun(context, projectSlug, runId, hostOrigin) {
  const runRoot = await ensureRunsDirectory(
    context.projectHomeDir,
    projectSlug,
  );
  const { record, runs } = await loadRunRecord(runRoot, runId);
  assertOpenCapacity(projectSlug, runId);
  if (openRuns.has(runKey(projectSlug, runId))) {
    await closeRunAndPersist(context.projectHomeDir, projectSlug, runId);
  }
  const opened = await (await application(context)).open({
    runDirectory: record.runDirectory,
    presentation: presentation(),
    embeddingOrigin: hostOrigin,
  });
  retainOpenRun(context, projectSlug, runId, opened);
  const next = runs.map((entry) =>
    entry.id === runId ? { ...entry, open: true } : entry,
  );
  await writeRunIndex(runRoot, next);
  return { opened, record: next.find((entry) => entry.id === runId) };
}

function installOpenRoute(app, context) {
  app.post('/projects/:projectSlug/runs/:runId/open', async (c) => {
    try {
      const projectSlug = c.req.param('projectSlug');
      const runId = c.req.param('runId');
      const hostOrigin = embeddingOrigin(c.req);
      guardProject(projectSlug);
      guardRun(runId);
      return await serializeProjectMutation(projectSlug, async () => {
        const { opened, record } = await openStoredRun(
          context,
          projectSlug,
          runId,
          hostOrigin,
        );
        return c.json({
          success: true,
          run: publicRun(record),
          review: { url: opened.url },
        });
      });
    } catch (error) {
      return failure(c, error);
    }
  });
}

function installReviewedOutputRoute(app, context) {
  app.get('/projects/:projectSlug/runs/:runId/reviewed-output', async (c) => {
    try {
      const projectSlug = c.req.param('projectSlug');
      const runId = c.req.param('runId');
      guardProject(projectSlug);
      guardRun(runId);
      const runRoot = await ensureRunsDirectory(
        context.projectHomeDir,
        projectSlug,
      );
      const { record } = await loadRunRecord(runRoot, runId);
      await (await application(context)).reviewedOutput(record.runDirectory);
      return c.json({ success: true, available: true });
    } catch (error) {
      if (Number.isInteger(error?.status)) return failure(c, error);
      return c.json({ success: true, available: false });
    }
  });
}

function installCloseRoute(app, context) {
  app.post('/projects/:projectSlug/runs/:runId/close', async (c) => {
    try {
      const projectSlug = c.req.param('projectSlug');
      const runId = c.req.param('runId');
      guardProject(projectSlug);
      guardRun(runId);
      return await serializeProjectMutation(projectSlug, async () => {
        const record = await closeRunAndPersist(
          context.projectHomeDir,
          projectSlug,
          runId,
        );
        return c.json({
          success: true,
          run: publicRun(record),
        });
      });
    } catch (error) {
      return failure(c, error);
    }
  });
}

/** @param {import('hono').Hono} app */
export function register(app, context) {
  disposed = false;
  installListRoute(app, context);
  installLaunchRoute(app, context);
  installOpenRoute(app, context);
  installReviewedOutputRoute(app, context);
  installCloseRoute(app, context);
}

/** Station calls this before update, uninstall, reload, and shutdown. */
export async function dispose() {
  disposed = true;
  await Promise.allSettled([...projectMutations.values()]);
  const pendingCloses = [...openRuns.entries()].map(
    ([key, { projectHomeDir }]) => {
      const [projectSlug, runId] = key.split(':');
      return serializeProjectMutation(projectSlug, () =>
        closeRunAndPersist(projectHomeDir, projectSlug, runId),
      );
    },
  );
  const closeResults = await Promise.allSettled(pendingCloses);
  const closeFailures = closeResults
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (unsubscribeLifecycle) unsubscribeLifecycle();
  unsubscribeLifecycle = undefined;
  if (applicationPromise) {
    const active = await applicationPromise;
    await active.close();
  }
  applicationPromise = undefined;
  if (closeFailures.length > 0) {
    throw new AggregateError(
      closeFailures,
      'Fieldwork run disposal was incomplete',
    );
  }
}

export const close = dispose;
