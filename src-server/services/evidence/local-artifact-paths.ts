import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { runDir } from '@kontourai/flow';
import { flowAgentsArtifactRoot, KONTOURAI_DIR } from '@kontourai/flow-agents';

// `@kontourai/flow-agents` 3.x removed the legacy ephemeral workflow-session
// alias entirely: `.flow-agents` is now exclusively the package's own durable
// install/config root (`DURABLE_FLOW_AGENTS_DIR`), a different concept. There
// is no drop-in replacement export for the pre-3.x legacy-read fallback this
// file relies on, so Station owns the `.flow-agents` legacy-compatibility
// string and its resolution logic locally (same semantics the removed
// package export previously implemented).
const LEGACY_FLOW_AGENTS_DIR = '.flow-agents';

function legacyFlowAgentsArtifactRoot(cwd: string): string {
  return resolve(cwd, LEGACY_FLOW_AGENTS_DIR);
}

export const STATION_KONTOURAI_ROOT = KONTOURAI_DIR;

export const STATION_ARTIFACT_ROOTS = {
  console: join(STATION_KONTOURAI_ROOT, 'console'),
  flowRuns: join(STATION_KONTOURAI_ROOT, 'flow', 'runs'),
  flowAgents: join(STATION_KONTOURAI_ROOT, 'flow-agents'),
  surfaceRuns: join(STATION_KONTOURAI_ROOT, 'surface', 'runs'),
  veritas: join(STATION_KONTOURAI_ROOT, 'veritas'),
} as const;

/**
 * Generated-artifact roots that predate the `.kontourai/` consolidation and
 * are still read for back-compat.
 *
 * `.flow/runs` is deliberately ABSENT (#290): Flow 3 writes generated run
 * state to `.kontourai/flow/runs` and nothing else, and the issue forbids a
 * legacy fallback, dual read, or dual write for it. A run present only under
 * `.flow/runs` must not be discovered. `.flow` itself is still Flow's own
 * durable definitions/config root and is untouched.
 */
export const STATION_LEGACY_ROOTS = {
  console: '.kontour',
  flowAgents: LEGACY_FLOW_AGENTS_DIR,
  surfaceRuns: join('.surface', 'runs'),
  veritas: '.veritas',
} as const;

export type VeritasGeneratedKind =
  | 'claims'
  | 'evidence'
  | 'eval-drafts'
  | 'external'
  | 'repo-conformance'
  | 'runs'
  | 'standards-feedback'
  | 'standards-feedback-drafts';

const VERITAS_GENERATED_KINDS = new Set<VeritasGeneratedKind>([
  'claims',
  'evidence',
  'eval-drafts',
  'external',
  'repo-conformance',
  'runs',
  'standards-feedback',
  'standards-feedback-drafts',
]);

export function stationArtifactPath(
  cwd: string,
  relativeArtifactPath: string,
): string {
  return join(cwd, relativeArtifactPath);
}

export function consoleArtifactRoot(cwd: string): string {
  return stationArtifactPath(cwd, STATION_ARTIFACT_ROOTS.console);
}

/**
 * Station's own spelling of the runs root. Since {@link flowRunDir} began
 * delegating to Flow (#290) nothing in production calls this — it is kept
 * deliberately, as the thing the location-contract test cross-checks against
 * Flow's published `flowRuntimeRoot()`. That comparison is what would catch
 * Flow moving its runtime root; a helper that merely forwarded to Flow could
 * not disagree with Flow and so could not detect the drift. Delete it only
 * together with that test.
 */
export function flowRunsRoot(cwd: string): string {
  return stationArtifactPath(cwd, STATION_ARTIFACT_ROOTS.flowRuns);
}

/**
 * The one location a Flow run's generated state lives. This DELEGATES to
 * Flow's published `runDir()` rather than re-deriving the layout locally
 * (#290): re-joining `.kontourai/flow/runs/<runId>` here would be a mirror of
 * an upstream contract with nothing tying the two together, so a change to
 * Flow's runtime root would silently leave Station computing a directory Flow
 * no longer writes — discovery would return nothing rather than fail.
 *
 * Delegating also inherits Flow's `assertSafeRunId`, which matters because
 * `FlowRunService.discardRun` feeds this path to a recursive `rm`. Be precise
 * about why that is defence in depth and not a fix for a live hole:
 * `discardRun` is not reachable from HTTP at all — its only caller is the
 * adoption-reservation cleanup, whose run id is always a `session-<threadId>`
 * value that cannot traverse. And the run ids that DO arrive from HTTP are
 * safe because Flow re-asserts them inside `resolveRunLocation`, not because
 * Station validates the `:runId` path parameter (only the `POST /runs` body
 * is schema-checked, via `safeRunIdSchema`). So: no reachable hole today, and
 * the guard now sits on the destructive path rather than depending on every
 * future caller having been reached through Flow first.
 *
 * Note the argument order flips at this boundary: `flowRunDir(cwd, runId)`
 * delegates to `runDir(runId, cwd)`. Both are strings, so a transposition
 * would not be a type error — it fails loudly instead, because an absolute
 * `cwd` in the run-id position trips `assertSafeRunId`.
 *
 * There is no legacy counterpart and no resolver: #290 forbids a dual read.
 */
export function flowRunDir(cwd: string, runId: string): string {
  return runDir(runId, cwd);
}

/** Workspace-relative reference to a run artifact, for event payloads. */
export function flowRunArtifactReference(
  runId: string,
  ...segments: string[]
): string {
  return [STATION_ARTIFACT_ROOTS.flowRuns, runId, ...segments].join('/');
}

export function flowAgentsRoot(cwd: string): string {
  return flowAgentsArtifactRoot(cwd);
}

export function legacyFlowAgentsRoot(cwd: string): string {
  return legacyFlowAgentsArtifactRoot(cwd);
}

export function workflowSidecarTaskDir(cwd: string, taskSlug: string): string {
  return join(flowAgentsRoot(cwd), taskSlug);
}

export function workflowSidecarTaskReference(taskSlug: string): string {
  return `${STATION_ARTIFACT_ROOTS.flowAgents}/${taskSlug}`;
}

export function legacyWorkflowSidecarTaskDir(
  cwd: string,
  taskSlug: string,
): string {
  return join(legacyFlowAgentsRoot(cwd), taskSlug);
}

export function resolveWorkflowSidecarTaskDir(
  cwd: string,
  taskSlug: string,
): string {
  const next = workflowSidecarTaskDir(cwd, taskSlug);
  return existsSync(next) ? next : legacyWorkflowSidecarTaskDir(cwd, taskSlug);
}

export interface WorkflowSidecarTaskPaths {
  canonicalRelativeDir: string;
  legacyRelativeDir: string;
  canonicalDir: string;
  legacyDir: string;
  readDir: string;
  writeDir: string;
  canonicalStateFile: string;
  legacyStateFile: string;
  readStateFile: string;
  writeStateFile: string;
  canonicalHandoffFile: string;
  legacyHandoffFile: string;
  readHandoffFile: string;
  writeHandoffFile: string;
  /**
   * `trust.bundle` — @kontourai/flow-agents' session evidence store (issue
   * #753). Read-only from Station's side: Station never writes trust.bundle
   * (that stays the sidecar CLI's job), so there is deliberately no
   * `writeTrustBundleFile` counterpart to `writeStateFile`/`writeHandoffFile`.
   */
  canonicalTrustBundleFile: string;
  legacyTrustBundleFile: string;
  readTrustBundleFile: string;
  compatibilityStateMirrorFile: string;
}

export function workflowSidecarTaskPaths(
  cwd: string,
  taskSlug: string,
): WorkflowSidecarTaskPaths {
  const canonicalRelativeDir = workflowSidecarTaskReference(taskSlug);
  const legacyRelativeDir = `${STATION_LEGACY_ROOTS.flowAgents}/${taskSlug}`;
  const canonicalDir = workflowSidecarTaskDir(cwd, taskSlug);
  const legacyDir = legacyWorkflowSidecarTaskDir(cwd, taskSlug);
  const canonicalStateFile = join(canonicalDir, 'state.json');
  const legacyStateFile = join(legacyDir, 'state.json');
  const canonicalHandoffFile = join(canonicalDir, 'handoff.json');
  const legacyHandoffFile = join(legacyDir, 'handoff.json');
  const canonicalTrustBundleFile = join(canonicalDir, 'trust.bundle');
  const legacyTrustBundleFile = join(legacyDir, 'trust.bundle');

  return {
    canonicalRelativeDir,
    legacyRelativeDir,
    canonicalDir,
    legacyDir,
    readDir: existsSync(canonicalDir) ? canonicalDir : legacyDir,
    writeDir: canonicalDir,
    canonicalStateFile,
    legacyStateFile,
    readStateFile: existsSync(canonicalStateFile)
      ? canonicalStateFile
      : legacyStateFile,
    writeStateFile: canonicalStateFile,
    canonicalHandoffFile,
    legacyHandoffFile,
    readHandoffFile: existsSync(canonicalHandoffFile)
      ? canonicalHandoffFile
      : legacyHandoffFile,
    writeHandoffFile: canonicalHandoffFile,
    canonicalTrustBundleFile,
    legacyTrustBundleFile,
    readTrustBundleFile: existsSync(canonicalTrustBundleFile)
      ? canonicalTrustBundleFile
      : legacyTrustBundleFile,
    compatibilityStateMirrorFile: legacyStateFile,
  };
}

export function surfaceRunsRoot(cwd: string): string {
  return stationArtifactPath(cwd, STATION_ARTIFACT_ROOTS.surfaceRuns);
}

export function legacySurfaceRunsRoot(cwd: string): string {
  return stationArtifactPath(cwd, STATION_LEGACY_ROOTS.surfaceRuns);
}

export function veritasGeneratedRoot(cwd: string): string {
  return stationArtifactPath(cwd, STATION_ARTIFACT_ROOTS.veritas);
}

export function veritasGeneratedPath(
  cwd: string,
  kind: VeritasGeneratedKind,
  ...segments: string[]
): string {
  return join(veritasGeneratedRoot(cwd), kind, ...segments);
}

export function legacyVeritasGeneratedPath(
  cwd: string,
  kind: VeritasGeneratedKind,
  ...segments: string[]
): string {
  return join(cwd, STATION_LEGACY_ROOTS.veritas, kind, ...segments);
}

export function resolveVeritasGeneratedPath(
  cwd: string,
  kind: VeritasGeneratedKind,
  ...segments: string[]
): string {
  const next = veritasGeneratedPath(cwd, kind, ...segments);
  return existsSync(next)
    ? next
    : legacyVeritasGeneratedPath(cwd, kind, ...segments);
}

export function remapGeneratedArtifactReference(reference: string): string {
  if (reference.startsWith('.surface/runs/')) {
    return reference.replace(
      /^\.surface\/runs\//,
      `${STATION_ARTIFACT_ROOTS.surfaceRuns}/`,
    );
  }
  if (reference.startsWith('.flow-agents/')) {
    return reference.replace(
      /^\.flow-agents\//,
      `${STATION_ARTIFACT_ROOTS.flowAgents}/`,
    );
  }
  const match = reference.match(/^\.veritas\/([^/]+)(\/.*)?$/);
  if (match && VERITAS_GENERATED_KINDS.has(match[1] as VeritasGeneratedKind)) {
    return `${STATION_ARTIFACT_ROOTS.veritas}/${match[1]}${match[2] ?? ''}`;
  }
  if (reference.startsWith('.kontour/events/')) {
    return reference.replace(
      /^\.kontour\/events\//,
      `${STATION_ARTIFACT_ROOTS.console}/events/`,
    );
  }
  if (reference.startsWith('.kontour/resources/station/')) {
    return reference.replace(
      /^\.kontour\/resources\/station\//,
      `${STATION_ARTIFACT_ROOTS.console}/resources/station/`,
    );
  }
  return reference;
}

export function resolveGeneratedArtifactReference(
  cwd: string,
  reference: string,
): string {
  const nextReference = remapGeneratedArtifactReference(reference);
  const nextPath = join(cwd, nextReference);
  if (existsSync(nextPath)) return nextPath;
  return join(cwd, reference);
}

export function workspaceRelativePath(cwd: string, path: string): string {
  const rel = relative(cwd, path).split(sep).join('/');
  return rel.startsWith('..') ? path : rel;
}
