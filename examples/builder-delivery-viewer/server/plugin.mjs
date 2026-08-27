/** Read-only adapter for published Builder Kit artifacts. */
import {
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrustBundle } from '@kontourai/flow-agents';
import { buildTrustReport } from '@kontourai/surface';
import Ajv2020 from 'ajv/dist/2020.js';

const PLUGIN = 'builder-delivery-viewer';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 100;
const MAX_DIRECTORY_ENTRIES = 1000;
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEAL_FILES = [
  'trust.bundle',
  'trust.checkpoint.json',
  'trust.checkpoint.intoto.json',
  'trust.checkpoint.sig.json',
  'trust.checkpoint.attestation.json',
];

function safeSlug(value) {
  return (
    typeof value === 'string' && SAFE_SLUG.test(value) && !value.includes('..')
  );
}

function projectConfig(projectHomeDir, projectSlug) {
  if (!safeSlug(projectSlug)) return null;
  const file = join(projectHomeDir, 'projects', projectSlug, 'project.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function confinedResolved(resolvedRoot, resolvedCandidate) {
  return (
    resolvedCandidate === resolvedRoot ||
    (relative(resolvedRoot, resolvedCandidate) !== '' &&
      !relative(resolvedRoot, resolvedCandidate).startsWith('..'))
  );
}

function confined(root, candidate) {
  try {
    return confinedResolved(realpathSync(root), realpathSync(candidate));
  } catch {
    return false;
  }
}

function requestBudget() {
  return { remaining: MAX_REQUEST_BYTES };
}

async function readJson(root, file, budget = requestBudget()) {
  let handle;
  try {
    const pathStat = await lstat(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink())
      return {
        available: false,
        warning: 'artifact must be a regular file',
      };
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile())
      return {
        available: false,
        warning: 'artifact must be a regular file',
      };
    const resolvedRoot = realpathSync(root);
    const resolvedFile = realpathSync(file);
    const resolvedStat = statSync(resolvedFile);
    if (
      !confinedResolved(resolvedRoot, resolvedFile) ||
      resolvedStat.dev !== descriptorStat.dev ||
      resolvedStat.ino !== descriptorStat.ino
    )
      return {
        available: false,
        warning: 'artifact is outside the project workspace',
      };
    if (descriptorStat.size > MAX_FILE_BYTES)
      return { available: false, warning: 'artifact exceeds read limit' };
    if (descriptorStat.size > budget.remaining)
      return {
        available: false,
        warning: 'request artifact budget exhausted',
      };
    const limit = Math.min(MAX_FILE_BYTES, budget.remaining);
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    budget.remaining = Math.max(0, budget.remaining - offset);
    if (offset > limit)
      return { available: false, warning: 'artifact exceeds read limit' };
    try {
      return {
        available: true,
        value: JSON.parse(buffer.subarray(0, offset).toString('utf8')),
      };
    } catch {
      return { available: false, warning: 'artifact is invalid JSON' };
    }
  } catch {
    return { available: false, warning: 'artifact is unavailable' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Locate the installed flow-agents package by walking up from this file.
 *
 * This used to join a `node_modules` directory beside the plugin, which only
 * held when the plugin was installed standalone. Declared as a workspace its
 * dependencies hoist to the repo root, so that path does not exist. Walking up
 * finds it either way — and it stays inside this plugin's sanctioned
 * capabilities (read-only `node:fs` plus `dirname`/`join`), where resolving via
 * `node:module` would not.
 */
function flowAgentsPackageRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(
      directory,
      'node_modules',
      '@kontourai',
      'flow-agents',
    );
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('@kontourai/flow-agents is not installed');
}

function validators() {
  const packageRoot = flowAgentsPackageRoot();
  const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
  const schema = (name) =>
    JSON.parse(readFileSync(join(packageRoot, 'schemas', name), 'utf8'));
  // flow-agents 5.x split the run-correlation envelope into its own schema and
  // `$ref`s it from workflow-state, so it has to be registered before compiling
  // or Ajv fails with MissingRefError on a reference it cannot fetch.
  ajv.addSchema(schema('run-correlation-envelope.schema.json'));
  return {
    state: ajv.compile(schema('workflow-state.schema.json')),
    acceptance: ajv.compile(schema('workflow-acceptance.schema.json')),
  };
}

function validity(validate, artifact) {
  if (!artifact.available)
    return { valid: false, warning: artifact.warning ?? 'artifact is missing' };
  return validate(artifact.value)
    ? { valid: true }
    : { valid: false, warning: 'artifact does not match its published schema' };
}

function claims(bundle) {
  const entries = Array.isArray(bundle?.claims) ? bundle.claims : [];
  const checks = [];
  const critiques = [];
  const gates = [];
  for (const entry of entries) {
    const metadata = entry?.metadata ?? {};
    if (metadata.gate_claim) gates.push(entry);
    else if (metadata.origin === 'critique') critiques.push(entry);
    else if (metadata.origin === 'check') checks.push(entry);
  }
  return { checks, critiques, gates };
}

function seal(root, slug) {
  const directory = join(root, 'delivery', slug);
  if (!existsSync(directory) || !confined(root, directory))
    return { available: false, companions: [] };
  return {
    available: true,
    companions: SEAL_FILES.filter((name) => {
      const file = join(directory, name);
      try {
        return lstatSync(file).isFile() && confined(root, file);
      } catch {
        return false;
      }
    }),
  };
}

async function session(
  root,
  directory,
  slug,
  validate,
  budget = requestBudget(),
) {
  const state = await readJson(root, join(directory, 'state.json'), budget);
  const stateValidity = validity(validate.state, state);
  const publishedSlug =
    stateValidity.valid && safeSlug(state.value?.task_slug)
      ? state.value.task_slug
      : slug;
  const acceptance = await readJson(
    root,
    join(directory, 'acceptance.json'),
    budget,
  );
  const acceptanceValidity = validity(validate.acceptance, acceptance);
  const trust = await readJson(root, join(directory, 'trust.bundle'), budget);
  let trustValidity = {
    valid: false,
    warning: trust.warning ?? 'trust bundle is missing',
  };
  let report = null;
  let classified = { checks: [], critiques: [], gates: [] };
  if (trust.available) {
    const result = await validateTrustBundle(trust.value);
    trustValidity =
      result.available && result.valid
        ? { valid: true }
        : {
            valid: false,
            warning: result.available
              ? result.errors.join('; ') || 'trust bundle is invalid'
              : 'trust bundle validation is unavailable',
          };
    if (trustValidity.valid) {
      classified = claims(trust.value);
      try {
        report = buildTrustReport(trust.value);
      } catch {
        trustValidity = {
          valid: false,
          warning: 'trust report derivation failed',
        };
      }
    }
  }
  return {
    slug: publishedSlug,
    state: stateValidity.valid
      ? state.value
      : {
          status: 'unavailable',
          phase: 'unavailable',
          updated_at: null,
          next_action: { summary: 'State artifact is unavailable or invalid.' },
        },
    acceptance: acceptanceValidity.valid ? acceptance.value : null,
    validation: {
      state: stateValidity,
      acceptance: acceptanceValidity,
      trust: trustValidity,
    },
    report,
    claims: classified,
    seal: seal(root, publishedSlug),
  };
}

async function sessionsFor(projectHomeDir, projectSlug) {
  const project = projectConfig(projectHomeDir, projectSlug);
  if (
    !project ||
    typeof project.workingDirectory !== 'string' ||
    !existsSync(project.workingDirectory)
  )
    return { error: 'project workspace is unavailable' };
  const root = realpathSync(project.workingDirectory);
  const base = join(root, '.kontourai', 'flow-agents');
  if (!existsSync(base) || !confined(root, base)) return { root, sessions: [] };
  const validate = validators();
  const budget = requestBudget();
  const sessions = [];
  const entries = [];
  let scanned = 0;
  let truncated = false;
  const directory = await opendir(base);
  for await (const entry of directory) {
    scanned += 1;
    if (scanned > MAX_DIRECTORY_ENTRIES) {
      truncated = true;
      break;
    }
    if (
      !entry.isDirectory() ||
      !safeSlug(entry.name) ||
      !existsSync(join(base, entry.name, 'state.json'))
    )
      continue;
    entries.push(entry);
    if (entries.length > MAX_SESSIONS) {
      truncated = true;
      entries.pop();
      break;
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    sessions.push(
      await session(root, join(base, entry.name), entry.name, validate, budget),
    );
  }
  sessions.sort((a, b) =>
    String(b.state.updated_at).localeCompare(String(a.state.updated_at)),
  );
  return { root, sessions, truncated };
}

function record(context, outcome) {
  context.telemetry?.recordRoutingDecision?.({
    decision: `${PLUGIN}.${outcome}`,
  });
}

export function register(app, context) {
  app.get('/projects/:projectSlug/builder-sessions', async (c) => {
    const projectSlug = c.req.param('projectSlug');
    if (!safeSlug(projectSlug))
      return c.json({ success: false, error: 'invalid project' }, 400);
    const result = await sessionsFor(context.projectHomeDir, projectSlug);
    if (result.error) {
      record(context, 'list-unavailable');
      return c.json({ success: false, error: result.error }, 404);
    }
    record(context, 'list-loaded');
    return c.json({
      success: true,
      truncated: result.truncated,
      sessions: result.sessions.map(
        ({ acceptance, report, claims, ...summary }) => summary,
      ),
    });
  });
  app.get('/projects/:projectSlug/builder-sessions/:slug', async (c) => {
    const projectSlug = c.req.param('projectSlug');
    const slug = c.req.param('slug');
    if (!safeSlug(projectSlug) || !safeSlug(slug))
      return c.json({ success: false, error: 'invalid name' }, 400);
    const result = await sessionsFor(context.projectHomeDir, projectSlug);
    const item = result.sessions?.find((candidate) => candidate.slug === slug);
    if (!item) {
      record(context, 'detail-unavailable');
      return c.json({ success: false, error: 'session unavailable' }, 404);
    }
    record(context, 'detail-loaded');
    return c.json({ success: true, session: item });
  });
}

export const __test__ = { safeSlug, confined, session, sessionsFor };
export default { register };
