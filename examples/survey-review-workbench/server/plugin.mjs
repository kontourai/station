/**
 * Survey Review Workbench — plugin server module.
 *
 * Persists review-session event logs per project (Survey's
 * `ReviewSessionEventStore` contract, server-backed), seeds example sessions
 * from Survey's published example data, and projects completed reviews into
 * Surface trust bundles written to the project workspace.
 *
 * Storage layout:
 * - Review sessions (Station-owned state, shared per project):
 *   `<projectHomeDir>/projects/<projectSlug>/plugin-data/survey-review-workbench/review-sessions/<sessionName>.json`
 *   Each file holds `{ name, snapshot, events, updatedAt }` — the pre-decision
 *   queue snapshot plus the append-only event log, which is the auditable
 *   input Survey's replay helpers expect.
 * - Trust bundles (hand-off artifact for the trust panel):
 *   `<workspace>/.station/trust-bundles/survey-<sessionName>.json` where
 *   `<workspace>` is the project's `workingDirectory`. When the project has
 *   no working directory the bundle falls back to
 *   `<projectHomeDir>/projects/<projectSlug>/plugin-data/survey-review-workbench/trust-bundles/`
 *   and the response flags `location: "station-home"`.
 *
 * Projection follows Survey's server-apply guidance: results are derived
 * server-side from the persisted pre-decision snapshot plus events
 * (`deriveReviewSessionApplyResultForSnapshot`), never from browser-computed
 * payloads. `@kontourai/survey` is imported lazily from the plugin's own
 * node_modules so route registration never depends on it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PLUGIN_NAME = 'survey-review-workbench';
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isSafeName(value) {
  return (
    typeof value === 'string' && SAFE_NAME.test(value) && !value.includes('..')
  );
}

function projectDir(projectHomeDir, projectSlug) {
  return join(projectHomeDir, 'projects', projectSlug);
}

function pluginDataDir(projectHomeDir, projectSlug) {
  return join(
    projectDir(projectHomeDir, projectSlug),
    'plugin-data',
    PLUGIN_NAME,
  );
}

function sessionsDir(projectHomeDir, projectSlug) {
  return join(pluginDataDir(projectHomeDir, projectSlug), 'review-sessions');
}

function sessionFile(projectHomeDir, projectSlug, sessionName) {
  return join(sessionsDir(projectHomeDir, projectSlug), `${sessionName}.json`);
}

function readProjectConfig(projectHomeDir, projectSlug) {
  const file = join(projectDir(projectHomeDir, projectSlug), 'project.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

async function readSession(projectHomeDir, projectSlug, sessionName) {
  const file = sessionFile(projectHomeDir, projectSlug, sessionName);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf-8'));
}

async function writeSession(projectHomeDir, projectSlug, stored) {
  mkdirSync(sessionsDir(projectHomeDir, projectSlug), { recursive: true });
  await writeJsonAtomic(
    sessionFile(projectHomeDir, projectSlug, stored.name),
    stored,
  );
}

/** Atomic JSON write: write to a temp file in the same dir, then rename. */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await rename(tmp, file);
}

/**
 * Map a workbench ReviewCandidate (which carries source/extraction/claim
 * references) back to a Survey observation record for `SurveyInputBuilder`.
 */
function candidateToObservation(candidate) {
  const fallbackTime = new Date().toISOString();
  return {
    id: candidate.id,
    rawSource: {
      id: candidate.source.sourceId,
      kind: candidate.source.kind ?? 'manual-entry',
      sourceRef: candidate.source.sourceRef,
      observedAt: candidate.source.observedAt ?? fallbackTime,
      fetchedAt: candidate.source.fetchedAt,
      checksum: candidate.source.checksum,
      locatorScheme:
        candidate.source.locatorScheme ?? candidate.locator?.scheme ?? 'text',
    },
    extraction: {
      id: candidate.extraction.extractionId,
      target: candidate.extraction.target,
      value: candidate.value,
      confidence: candidate.extraction.confidence ?? candidate.confidence,
      locator: candidate.locator?.locator,
      excerpt: candidate.locator?.excerpt,
      extractor: candidate.extraction.extractor ?? PLUGIN_NAME,
      extractedAt: candidate.extraction.extractedAt ?? fallbackTime,
    },
    candidate: {
      id: candidate.id,
      confidence: candidate.confidence,
      sourceRank: candidate.sourceRank,
    },
    claim: {
      id: candidate.claimTarget.claimId,
      subjectType: candidate.claimTarget.subjectType,
      subjectId: candidate.claimTarget.subjectId,
      surface: candidate.claimTarget.surface,
      claimType: candidate.claimTarget.claimType,
      fieldOrBehavior: candidate.claimTarget.fieldOrBehavior,
      impactLevel: candidate.claimTarget.impactLevel,
      evidenceType: candidate.claimTarget.evidenceType,
      evidenceMethod: candidate.claimTarget.evidenceMethod,
      collectedBy:
        candidate.claimTarget.collectedBy ?? `station.${PLUGIN_NAME}`,
      derivedFrom: candidate.claimTarget.derivedFrom,
      value: candidate.value,
    },
  };
}

/**
 * @param {import('hono').Hono} app
 * @param {{ projectHomeDir: string, logger: { warn: Function }, telemetry: { recordRoutingDecision: Function } }} context
 */
export function register(app, context) {
  const { projectHomeDir } = context;

  const guard = (c, projectSlug, sessionName) => {
    if (
      !isSafeName(projectSlug) ||
      (sessionName !== undefined && !isSafeName(sessionName))
    ) {
      return c.json({ success: false, error: 'invalid name' }, 400);
    }
    if (!readProjectConfig(projectHomeDir, projectSlug)) {
      return c.json(
        { success: false, error: `project '${projectSlug}' not found` },
        404,
      );
    }
    return null;
  };

  // List review sessions for a project.
  app.get('/projects/:projectSlug/review-sessions', async (c) => {
    const projectSlug = c.req.param('projectSlug');
    const rejected = guard(c, projectSlug);
    if (rejected) return rejected;

    const dir = sessionsDir(projectHomeDir, projectSlug);
    const sessions = [];
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.json')) continue;
        try {
          const stored = JSON.parse(await readFile(join(dir, entry), 'utf-8'));
          sessions.push({
            name: stored.name,
            eventCount: Array.isArray(stored.events) ? stored.events.length : 0,
            updatedAt: stored.updatedAt,
          });
        } catch {
          // Skip unreadable session files rather than failing the list.
        }
      }
    }
    sessions.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return c.json({ success: true, sessions });
  });

  // Create a session seeded from Survey's published example data.
  // Body: { example: "public-directory", name? }.
  app.post('/projects/:projectSlug/review-sessions', async (c) => {
    const projectSlug = c.req.param('projectSlug');
    const rejected = guard(c, projectSlug);
    if (rejected) return rejected;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'invalid JSON body' }, 400);
    }
    if (body?.example !== 'public-directory') {
      return c.json(
        {
          success: false,
          error: "unknown example (supported: 'public-directory')",
        },
        400,
      );
    }
    const name =
      typeof body.name === 'string' && body.name.length > 0
        ? body.name
        : `example-review-${Date.now().toString(36)}`;
    if (!isSafeName(name)) {
      return c.json({ success: false, error: 'invalid session name' }, 400);
    }
    if (await readSession(projectHomeDir, projectSlug, name)) {
      return c.json(
        { success: false, error: `session '${name}' already exists` },
        409,
      );
    }

    const { initialReviewQueueSessionState } = await import(
      '@kontourai/survey/review-workbench'
    );
    const { publicDirectoryReviewItemExample } = await import(
      '@kontourai/survey/example-data/public-directory-review-resource'
    );
    const stored = {
      name,
      snapshot: initialReviewQueueSessionState([
        publicDirectoryReviewItemExample,
      ]),
      events: [],
      updatedAt: new Date().toISOString(),
    };
    await writeSession(projectHomeDir, projectSlug, stored);
    return c.json({ success: true, session: stored }, 201);
  });

  // Load one session: pre-decision snapshot + persisted event log.
  app.get('/projects/:projectSlug/review-sessions/:sessionName', async (c) => {
    const projectSlug = c.req.param('projectSlug');
    const sessionName = c.req.param('sessionName');
    const rejected = guard(c, projectSlug, sessionName);
    if (rejected) return rejected;

    const stored = await readSession(projectHomeDir, projectSlug, sessionName);
    if (!stored) {
      return c.json(
        { success: false, error: `session '${sessionName}' not found` },
        404,
      );
    }
    return c.json({ success: true, session: stored });
  });

  // Save a session's event log. Body: { snapshot?, events, expectedEventCount? }.
  // `expectedEventCount` implements the optimistic-concurrency check from
  // Survey's `ReviewSessionPersistenceRequest`: it is the caller's belief
  // about how many events were already stored before this save.
  app.put('/projects/:projectSlug/review-sessions/:sessionName', async (c) => {
    const projectSlug = c.req.param('projectSlug');
    const sessionName = c.req.param('sessionName');
    const rejected = guard(c, projectSlug, sessionName);
    if (rejected) return rejected;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'invalid JSON body' }, 400);
    }
    const { snapshot, events, expectedEventCount } = body ?? {};
    if (!Array.isArray(events)) {
      return c.json({ success: false, error: 'events array required' }, 400);
    }

    const existing = await readSession(
      projectHomeDir,
      projectSlug,
      sessionName,
    );
    const storedCount = Array.isArray(existing?.events)
      ? existing.events.length
      : 0;
    if (
      typeof expectedEventCount === 'number' &&
      storedCount !== expectedEventCount
    ) {
      context.telemetry.recordRoutingDecision({
        decision: 'review-session-conflict',
        project: projectSlug,
      });
      return c.json(
        {
          success: false,
          error: `event count conflict: expected ${expectedEventCount}, stored ${storedCount}`,
          events: existing?.events ?? [],
          eventCount: storedCount,
        },
        409,
      );
    }

    const next = {
      name: sessionName,
      snapshot: snapshot ?? existing?.snapshot ?? null,
      events,
      updatedAt: new Date().toISOString(),
    };
    if (!next.snapshot) {
      return c.json(
        { success: false, error: 'snapshot required on first save' },
        400,
      );
    }
    await writeSession(projectHomeDir, projectSlug, next);
    return c.json({
      success: true,
      events: next.events,
      eventCount: next.events.length,
    });
  });

  // Project a session to a Surface trust bundle. Body: { sessionName }.
  // Derives results server-side from the persisted snapshot + events, builds
  // the SurveyInput, and writes `buildSurveyTrustBundle` output to
  // `<workspace>/.station/trust-bundles/survey-<sessionName>.json` — the
  // hand-off contract for the trust-panel slice.
  app.post('/projects/:projectSlug/trust-bundles', async (c) => {
    const projectSlug = c.req.param('projectSlug');
    const rejected = guard(c, projectSlug);
    if (rejected) return rejected;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'invalid JSON body' }, 400);
    }
    const sessionName = body?.sessionName;
    if (!isSafeName(sessionName)) {
      return c.json({ success: false, error: 'invalid session name' }, 400);
    }
    const stored = await readSession(projectHomeDir, projectSlug, sessionName);
    if (!stored) {
      return c.json(
        { success: false, error: `session '${sessionName}' not found` },
        404,
      );
    }

    const {
      buildSurveyTrustBundle,
      candidateReviewRecord,
      SurveyInputBuilder,
    } = await import('@kontourai/survey');
    const { deriveReviewSessionApplyResultForSnapshot, reviewSessionSummary } =
      await import('@kontourai/survey/review-workbench');

    const derived = deriveReviewSessionApplyResultForSnapshot({
      snapshot: stored.snapshot,
      events: stored.events ?? [],
      requiredResolvedItems: 'any',
    });
    if (!derived.ok || !derived.replayedSession) {
      return c.json(
        {
          success: false,
          error: `session is not projectable: ${
            derived.issues.map((issue) => issue.message).join('; ') ||
            'no resolved review items'
          }`,
          issues: derived.issues,
        },
        409,
      );
    }

    const session = derived.replayedSession;
    const builder = new SurveyInputBuilder({
      source: `station.${PLUGIN_NAME}.${projectSlug}.${sessionName}`,
    });
    for (const result of derived.results) {
      const item = session.items.find(
        (entry) => entry.metadata.name === result.reviewItemName,
      );
      if (!item) continue;
      builder.addClaimRecords(
        candidateReviewRecord({
          id: item.metadata.name,
          target: item.spec.target,
          observations: item.spec.candidates.map(candidateToObservation),
          selectedCandidateId: result.selectedCandidateId,
          rationale: result.rationale ?? item.spec.rationale,
          reviewOutcome: {
            candidateId: result.selectedCandidateId,
            status: result.status,
            actor: session.actorId,
            reviewedAt: session.reviewedAt,
            rationale: result.rationale,
          },
        }),
      );
    }
    const bundle = buildSurveyTrustBundle(builder.build(), {
      reviewProofs: true,
    });

    const project = readProjectConfig(projectHomeDir, projectSlug);
    const workspace =
      typeof project?.workingDirectory === 'string' &&
      project.workingDirectory.length > 0 &&
      existsSync(project.workingDirectory)
        ? project.workingDirectory
        : null;
    const baseDir = workspace
      ? join(workspace, '.station', 'trust-bundles')
      : join(pluginDataDir(projectHomeDir, projectSlug), 'trust-bundles');
    mkdirSync(baseDir, { recursive: true });
    const file = join(baseDir, `survey-${sessionName}.json`);
    await writeJsonAtomic(file, bundle);
    context.telemetry.recordRoutingDecision({
      decision: 'trust-bundle-written',
      location: workspace ? 'workspace' : 'station-home',
      project: projectSlug,
    });
    return c.json({
      success: true,
      path: file,
      location: workspace ? 'workspace' : 'station-home',
      claimCount: bundle.claims.length,
      summary: reviewSessionSummary(session),
    });
  });
}

export default { register };
