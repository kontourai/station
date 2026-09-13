import {
  parseIndependentReviewRequest,
  REVIEW_EVIDENCE_OPERATOR_SURFACE,
} from '@kontourai/station-contracts/review-evidence';
import type { AddJobOpts } from '@kontourai/station-contracts/scheduler';
import type { AuthenticatedFetchInit } from '@kontourai/station-sdk/client';
import {
  authenticatedFetch,
  createIntegration,
  createJob,
  deleteIntegration,
  deleteJob,
  disableJob,
  enableJob,
  fetchRegistrySkills,
  getIntegration,
  getJobLogs,
  getProviderCommands,
  getReviewReceipt,
  getReviewRequestStatus,
  getRun,
  getSchedulerStats,
  getSchedulerStatus,
  installRegistrySkill,
  listIntegrations,
  listJobs,
  listReviewReceipts,
  listRuns,
  listSchedulerProviders,
  previewSchedule,
  reconnectIntegration,
  runIndependentReview,
  runJob,
  SchedulerRunFailedError,
  updateIntegration,
  updateJob,
} from '@kontourai/station-sdk/client';
import {
  configureApiCredential,
  loadJsonPayload,
  type ParsedCoreArgs,
  parseCoreArgs,
  printFetched,
  printJson,
  requestJson,
  requirePositional,
  resolveApiBase,
  streamSse,
} from './core-api.js';
import {
  runKnowledgeMigrate,
  runKnowledgeReindex,
  runKnowledgeSearch,
} from './knowledge.js';

/**
 * Surface commands share the CLI's target and authentication contract with
 * core commands: resolve the endpoint before looking up a profile credential,
 * then install the request resolver for SDK and raw-fetch calls alike.
 */
function resolveSurfaceApiBase(parsed: ParsedCoreArgs): string {
  const apiBase = resolveApiBase(parsed);
  configureApiCredential(parsed, apiBase);
  return apiBase;
}

function buildQuery(
  parsed: ParsedCoreArgs,
  mappings: Array<{ flag: string; param?: string; multi?: boolean }>,
) {
  const params = new URLSearchParams();
  for (const mapping of mappings) {
    const raw = parsed.flags[mapping.flag];
    if (typeof raw !== 'string' || raw.length === 0) {
      continue;
    }
    const param = mapping.param ?? mapping.flag;
    if (mapping.multi) {
      for (const entry of raw.split(',').map((item) => item.trim())) {
        if (entry) params.append(param, entry);
      }
      continue;
    }
    params.set(param, raw);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function requestAndPrint<T>(
  apiBase: string,
  path: string,
  init?: AuthenticatedFetchInit,
) {
  const data = await requestJson<T>(apiBase, path, init);
  printJson(data);
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireSchedulerCreateBody(body: JsonRecord): AddJobOpts {
  if (
    typeof body.name !== 'string' ||
    body.name.length === 0 ||
    typeof body.prompt !== 'string' ||
    body.prompt.length === 0
  ) {
    throw new Error('Scheduler create requires nonempty name and prompt');
  }
  return body as AddJobOpts;
}

function safeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Credential recovery responses are deliberately projected again at the CLI
 * boundary. This keeps an accidental server-side addition (for example a
 * profile directory, raw import result, or credentials) out of normal CLI
 * output. Labels are management metadata and are shown only by `profiles`.
 */
function credentialRecoveryOutput(
  data: unknown,
  options: { includeLabels: boolean },
): JsonRecord {
  const source = isRecord(data) ? data : {};
  const profiles = Array.isArray(source.profiles)
    ? source.profiles.flatMap((profile) => {
        if (!isRecord(profile) || typeof profile.ref !== 'string') return [];
        const result: JsonRecord = { ref: profile.ref };
        if (options.includeLabels && typeof profile.label === 'string') {
          result.label = profile.label;
        }
        return [result];
      })
    : undefined;
  const group = isRecord(source.group)
    ? {
        profileRefs: safeStringList(source.group.profileRefs),
        enrolledProfileRefs: safeStringList(source.group.enrolledProfileRefs),
      }
    : undefined;
  const policy = isRecord(source.policy)
    ? { automatic: source.policy.automatic === true }
    : undefined;
  const rawApplication = isRecord(source.application)
    ? source.application
    : source;
  const application: JsonRecord = {};
  for (const key of [
    'capability',
    'activeProfileRef',
    'pendingProfileRef',
    'outcome',
  ]) {
    if (typeof rawApplication[key] === 'string') {
      application[key] = rawApplication[key];
    }
  }

  return {
    ...(profiles ? { profiles } : {}),
    ...(group ? { group } : {}),
    ...(policy ? { policy } : {}),
    ...(Object.keys(application).length > 0 ? { application } : {}),
  };
}

async function requestCredentialRecoveryAndPrint(
  apiBase: string,
  path: string,
  options: { includeLabels: boolean },
  init?: AuthenticatedFetchInit,
) {
  const data = await requestJson<unknown>(apiBase, path, init);
  printJson(credentialRecoveryOutput(data, options));
}

function requireBooleanFlag(parsed: ParsedCoreArgs, flag: string): boolean {
  const raw = parsed.flags[flag];
  if (raw === true || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`--${flag}=true or --${flag}=false is required.`);
}

function optionalCredentialProfileApplyTimeoutFlag(
  parsed: ParsedCoreArgs,
  flag: string,
): number | undefined {
  const raw = parsed.flags[flag];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`--${flag} requires an integer from 5000 to 60000.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 5_000 || value > 60_000) {
    throw new Error(`--${flag} requires an integer from 5000 to 60000.`);
  }
  return value;
}

function includeCredentialsFlag(parsed: ParsedCoreArgs): boolean {
  const raw = parsed.flags['include-credentials'];
  if (raw === undefined) return false;
  if (raw === true || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('--include-credentials must be true or false when provided.');
}

/** Import results can include filenames; expose only counts and provenance. */
function credentialProfileImportOutput(data: unknown): JsonRecord {
  const source = isRecord(data) ? data : {};
  return {
    ...(typeof source.outcome === 'string' ? { outcome: source.outcome } : {}),
    copiedCount: Array.isArray(source.copied) ? source.copied.length : 0,
    skippedCount: Array.isArray(source.skipped) ? source.skipped.length : 0,
    ...(typeof source.provenanceUpdated === 'boolean'
      ? { provenanceUpdated: source.provenanceUpdated }
      : {}),
  };
}

async function requestCredentialProfileImportAndPrint(
  apiBase: string,
  path: string,
  init: AuthenticatedFetchInit,
) {
  const data = await requestJson<unknown>(apiBase, path, init);
  printJson(credentialProfileImportOutput(data));
}

async function requestRawAndPrint(
  apiBase: string,
  path: string,
  init?: AuthenticatedFetchInit,
) {
  const response = await authenticatedFetch(`${apiBase}${path}`, {
    method: init?.method || 'GET',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }

  printJson(await response.json());
}

function getNamespaceBase(project: string, namespace?: string) {
  const encodedProject = encodeURIComponent(project);
  if (namespace && namespace.length > 0) {
    return `/api/projects/${encodedProject}/knowledge/ns/${encodeURIComponent(namespace)}`;
  }
  return `/api/projects/${encodedProject}/knowledge`;
}

async function runConnectionsCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'connections action');

  switch (action) {
    case 'list':
      await requestAndPrint(apiBase, '/api/connections');
      return;
    case 'models':
      await requestAndPrint(apiBase, '/api/connections/models');
      return;
    case 'runtimes':
      await requestAndPrint(apiBase, '/api/connections/agents');
      return;
    case 'get': {
      const id = requirePositional(parsed, 1, 'connection id');
      await requestAndPrint(
        apiBase,
        `/api/connections/${encodeURIComponent(id)}`,
      );
      return;
    }
    case 'create': {
      const body = await loadJsonPayload(parsed);
      await requestAndPrint(apiBase, '/api/connections', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return;
    }
    case 'update': {
      const id = requirePositional(parsed, 1, 'connection id');
      const body = await loadJsonPayload(parsed);
      await requestAndPrint(
        apiBase,
        `/api/connections/${encodeURIComponent(id)}`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        },
      );
      return;
    }
    case 'delete': {
      const id = requirePositional(parsed, 1, 'connection id');
      await requestAndPrint(
        apiBase,
        `/api/connections/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
        },
      );
      return;
    }
    case 'test': {
      const id = requirePositional(parsed, 1, 'connection id');
      await requestAndPrint(
        apiBase,
        `/api/connections/${encodeURIComponent(id)}/test`,
        // POST, but nothing is persisted, so a deadline miss here has no
        // state for the user to go and check. It is not free of side effects
        // at the PROVIDER, though (station RT-06 delta2 review M2): the route
        // asks for the model catalogue, and when the endpoint has none it
        // sends one minimal chat request (`max_tokens: 1`), which some
        // providers bill. This command is one of the callers that reaches
        // that endpoint — the disclosure is not a UI-button-only concern.
        { method: 'POST', readOnly: true },
      );
      return;
    }
    case 'recovery': {
      const id = requirePositional(parsed, 1, 'connection id');
      await requestCredentialRecoveryAndPrint(
        apiBase,
        `/api/connections/agent/${encodeURIComponent(id)}/credential-recovery`,
        { includeLabels: false },
      );
      return;
    }
    case 'profiles': {
      const id = requirePositional(parsed, 1, 'connection id');
      await requestCredentialRecoveryAndPrint(
        apiBase,
        `/api/connections/agent/${encodeURIComponent(id)}/credential-recovery`,
        { includeLabels: true },
      );
      return;
    }
    case 'profile-upsert': {
      const id = requirePositional(parsed, 1, 'connection id');
      const body = await loadJsonPayload(parsed);
      await requestCredentialRecoveryAndPrint(
        apiBase,
        `/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles`,
        { includeLabels: false },
        { method: 'POST', body: JSON.stringify(body) },
      );
      return;
    }
    case 'profile-delete': {
      const id = requirePositional(parsed, 1, 'connection id');
      const ref = requirePositional(parsed, 2, 'credential profile ref');
      await requestCredentialRecoveryAndPrint(
        apiBase,
        `/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles/${encodeURIComponent(ref)}`,
        { includeLabels: false },
        { method: 'DELETE' },
      );
      return;
    }
    case 'profile-enroll':
    case 'profile-unenroll': {
      const id = requirePositional(parsed, 1, 'connection id');
      const ref = requirePositional(parsed, 2, 'credential profile ref');
      await requestCredentialRecoveryAndPrint(
        apiBase,
        `/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles/${encodeURIComponent(ref)}/enrollment`,
        { includeLabels: false },
        {
          method: 'PUT',
          body: JSON.stringify({ enrolled: action === 'profile-enroll' }),
        },
      );
      return;
    }
    case 'recovery-policy': {
      const id = requirePositional(parsed, 1, 'connection id');
      const automatic = requireBooleanFlag(parsed, 'automatic');
      await requestCredentialRecoveryAndPrint(
        apiBase,
        `/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/policy`,
        { includeLabels: false },
        { method: 'PUT', body: JSON.stringify({ automatic }) },
      );
      return;
    }
    case 'profile-import': {
      const id = requirePositional(parsed, 1, 'connection id');
      const ref = requirePositional(parsed, 2, 'credential profile ref');
      const includeCredentials = includeCredentialsFlag(parsed);
      await requestCredentialProfileImportAndPrint(
        apiBase,
        `/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles/${encodeURIComponent(ref)}/import`,
        {
          method: 'POST',
          body: JSON.stringify(
            includeCredentials ? { includeCredentials: true } : {},
          ),
        },
      );
      return;
    }
    case 'profile-apply': {
      const id = requirePositional(parsed, 1, 'connection id');
      const ref = requirePositional(parsed, 2, 'credential profile ref');
      if (parsed.flags.confirm !== true && parsed.flags.confirm !== 'true') {
        throw new Error(
          'Refusing to apply a credential profile without --confirm. This can start a billable provider-backed check.',
        );
      }
      const timeoutMs = optionalCredentialProfileApplyTimeoutFlag(
        parsed,
        'timeout-ms',
      );
      await requestCredentialRecoveryAndPrint(
        apiBase,
        `/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles/${encodeURIComponent(ref)}/apply`,
        { includeLabels: false },
        {
          method: 'POST',
          body: JSON.stringify({
            confirmed: true,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          }),
        },
      );
      return;
    }
    default:
      throw new Error(
        "Unknown connections action. Use 'list', 'models', 'runtimes', 'get', 'create', 'update', 'delete', 'test', 'recovery', 'profiles', 'profile-upsert', 'profile-delete', 'profile-enroll', 'profile-unenroll', 'recovery-policy', 'profile-import', or 'profile-apply'.",
      );
  }
}

async function runToolsCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'tools action');

  switch (action) {
    case 'list': {
      const data = await listIntegrations(apiBase);
      printFetched(data);
      return;
    }
    case 'get': {
      const id = requirePositional(parsed, 1, 'tool server id');
      const data = await getIntegration(apiBase, id);
      printFetched(data);
      return;
    }
    case 'create': {
      const body = await loadJsonPayload(parsed);
      const data = await createIntegration(apiBase, body);
      printFetched(data);
      return;
    }
    case 'update': {
      const id = requirePositional(parsed, 1, 'tool server id');
      const body = await loadJsonPayload(parsed);
      const data = await updateIntegration(apiBase, id, body);
      printFetched(data);
      return;
    }
    case 'delete': {
      const id = requirePositional(parsed, 1, 'tool server id');
      const data = await deleteIntegration(apiBase, id);
      printFetched(data);
      return;
    }
    case 'reconnect': {
      const id = requirePositional(parsed, 1, 'tool server id');
      const data = await reconnectIntegration(apiBase, id);
      printFetched(data);
      return;
    }
    default:
      throw new Error(
        "Unknown tools action. Use 'list', 'get', 'create', 'update', 'delete', or 'reconnect'.",
      );
  }
}

async function runNotificationsCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'notifications action');

  switch (action) {
    case 'list': {
      const query = buildQuery(parsed, [
        { flag: 'status', multi: true },
        { flag: 'category', multi: true },
      ]);
      await requestAndPrint(apiBase, `/notifications${query}`);
      return;
    }
    case 'create': {
      const body = await loadJsonPayload(parsed);
      await requestAndPrint(apiBase, '/notifications', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return;
    }
    case 'delete':
    case 'dismiss': {
      const id = requirePositional(parsed, 1, 'notification id');
      await requestAndPrint(
        apiBase,
        `/notifications/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
        },
      );
      return;
    }
    case 'clear':
      await requestAndPrint(apiBase, '/notifications', { method: 'DELETE' });
      return;
    case 'providers':
      await requestAndPrint(apiBase, '/notifications/providers');
      return;
    case 'action': {
      const id = requirePositional(parsed, 1, 'notification id');
      const actionId = requirePositional(parsed, 2, 'action id');
      await requestAndPrint(
        apiBase,
        `/notifications/${encodeURIComponent(id)}/action/${encodeURIComponent(actionId)}`,
        { method: 'POST' },
      );
      return;
    }
    case 'snooze': {
      const id = requirePositional(parsed, 1, 'notification id');
      let until: string | boolean | undefined = parsed.flags.until;
      if (typeof until !== 'string') {
        const body = await loadJsonPayload(parsed);
        until = body.until as string | boolean | undefined;
      }
      if (typeof until !== 'string' || until.length === 0) {
        throw new Error(
          'Provide snooze time with --until=<iso> or JSON input.',
        );
      }
      await requestAndPrint(
        apiBase,
        `/notifications/${encodeURIComponent(id)}/snooze`,
        {
          method: 'POST',
          body: JSON.stringify({ until }),
        },
      );
      return;
    }
    default:
      throw new Error(
        "Unknown notifications action. Use 'list', 'create', 'delete', 'dismiss', 'clear', 'providers', 'action', or 'snooze'.",
      );
  }
}

async function runMonitoringCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'monitoring action');

  switch (action) {
    case 'stats':
      await requestAndPrint(apiBase, '/monitoring/stats');
      return;
    case 'metrics': {
      const query = buildQuery(parsed, [{ flag: 'range' }]);
      await requestAndPrint(apiBase, `/monitoring/metrics${query}`);
      return;
    }
    case 'events': {
      const query = buildQuery(parsed, [
        { flag: 'start' },
        { flag: 'end' },
        { flag: 'user-id', param: 'userId' },
        // Without this the verb had no way to bound a read at all — the
        // route's cap is opt-in, and a flag the route honours but the verb
        // drops is a flag that does not exist.
        { flag: 'limit' },
      ]);
      // A TIME BOUND selects the JSON branch, not "any query string". The
      // route reads historical rows only when start or end is present;
      // everything else streams SSE, and requestJson awaits .json() on a
      // body that never ends. Branching on `query` meant adding --limit
      // above silently turned `station monitoring events --limit=10` into a
      // hang — the identical defect this change fixed for `insights events`,
      // reintroduced one verb over by the flag that advertises the fix.
      // `--user-id` alone had the same shape already.
      const bounded =
        parsed.flags.start !== undefined || parsed.flags.end !== undefined;
      if (bounded) {
        await requestAndPrint(apiBase, `/monitoring/events${query}`);
        return;
      }
      const response = await authenticatedFetch(`${apiBase}/monitoring/events`);
      if (!response.ok) {
        throw new Error(
          `Monitoring stream failed with HTTP ${response.status}`,
        );
      }
      await streamSse(response, (event) => {
        console.log(JSON.stringify(event));
      });
      return;
    }
    default:
      throw new Error(
        "Unknown monitoring action. Use 'stats', 'metrics', or 'events'.",
      );
  }
}

async function runScheduleCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'schedule action');

  switch (action) {
    case 'list':
    case 'jobs': {
      const data = await listJobs(apiBase);
      printFetched(data);
      return;
    }
    case 'providers':
      printFetched(await listSchedulerProviders(apiBase));
      return;
    case 'stats':
      printFetched(await getSchedulerStats(apiBase));
      return;
    case 'status':
      printFetched(await getSchedulerStatus(apiBase));
      return;
    case 'preview': {
      const cron = requirePositional(parsed, 1, 'cron');
      const count = parsed.positionals[2];
      // #1536 R8: a cron alone is evaluated as UTC, so an operator previewing a
      // ZONED job's schedule could not express the one fact that decides its
      // instants. Absent stays absent — the server treats an unzoned schedule
      // as UTC and the preview must agree rather than substitute a default.
      const timezone =
        typeof parsed.flags.timezone === 'string' &&
        parsed.flags.timezone.trim().length > 0
          ? parsed.flags.timezone.trim()
          : undefined;
      printFetched(
        await previewSchedule(
          apiBase,
          cron,
          count === undefined ? undefined : Number.parseInt(count, 10),
          timezone ? { timezone } : undefined,
        ),
      );
      return;
    }
    case 'logs': {
      const target = requirePositional(parsed, 1, 'job target');
      const count = parsed.positionals[2];
      printFetched(
        await getJobLogs(apiBase, target, {
          count: count === undefined ? undefined : Number.parseInt(count, 10),
        }),
      );
      return;
    }
    case 'create': {
      const body = await loadJsonPayload(parsed);
      const data = await createJob(apiBase, requireSchedulerCreateBody(body));
      printFetched(data);
      return;
    }
    case 'update': {
      const target = requirePositional(parsed, 1, 'job target');
      const body = await loadJsonPayload(parsed);
      printFetched(await updateJob(apiBase, target, body));
      return;
    }
    case 'run': {
      const target = requirePositional(parsed, 1, 'job target');
      try {
        const data = await runJob(apiBase, target);
        printFetched(data);
        return;
      } catch (error) {
        if (error instanceof SchedulerRunFailedError) {
          throw new Error(`${error.message} Run ID: ${error.receipt.runId}`, {
            cause: error,
          });
        }
        throw error;
      }
    }
    case 'enable': {
      const target = requirePositional(parsed, 1, 'job target');
      printFetched(await enableJob(apiBase, target));
      return;
    }
    case 'disable': {
      const target = requirePositional(parsed, 1, 'job target');
      printFetched(await disableJob(apiBase, target));
      return;
    }
    case 'delete': {
      const target = requirePositional(parsed, 1, 'job target');
      printFetched(await deleteJob(apiBase, target));
      return;
    }
    default:
      throw new Error(
        "Unknown schedule action. Use 'list', 'jobs', 'providers', 'stats', 'status', 'preview', 'logs', 'create', 'update', 'run', 'enable', 'disable', or 'delete'.",
      );
  }
}

async function runRunsCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'runs action');

  switch (action) {
    case 'list': {
      const data = await listRuns(apiBase);
      printFetched(data);
      return;
    }
    case 'read': {
      const runId = requirePositional(parsed, 1, 'run id');
      const data = await getRun(apiBase, runId);
      printFetched(data);
      return;
    }
    case 'output': {
      const body = await loadJsonPayload(parsed);
      await requestAndPrint(apiBase, '/api/runs/output', {
        method: 'POST',
        body: JSON.stringify(body),
        // POST because the output reference travels in the body; the route
        // reads that output and writes nothing.
        readOnly: true,
      });
      return;
    }
    default:
      throw new Error("Unknown runs action. Use 'list', 'read', or 'output'.");
  }
}

async function runReviewCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'review action');
  const projectSlug = requirePositional(parsed, 1, 'project slug');

  switch (action) {
    case REVIEW_EVIDENCE_OPERATOR_SURFACE.run.cli: {
      const request = parseIndependentReviewRequest(
        await loadJsonPayload(parsed),
      );
      if (request.target.projectSlug !== projectSlug) {
        throw new Error(
          'Review request project must match the project argument',
        );
      }
      printFetched(await runIndependentReview(apiBase, request));
      return;
    }
    case REVIEW_EVIDENCE_OPERATOR_SURFACE.list.cli:
      printFetched(await listReviewReceipts(apiBase, projectSlug));
      return;
    case REVIEW_EVIDENCE_OPERATOR_SURFACE.status.cli: {
      const requestId = requirePositional(parsed, 2, 'review request id');
      printFetched(
        await getReviewRequestStatus(apiBase, projectSlug, requestId),
      );
      return;
    }
    case REVIEW_EVIDENCE_OPERATOR_SURFACE.read.cli: {
      const receiptId = requirePositional(parsed, 2, 'review receipt id');
      printFetched(await getReviewReceipt(apiBase, projectSlug, receiptId));
      return;
    }
    default:
      throw new Error(
        "Unknown review action. Use 'run', 'status', 'list', or 'read'.",
      );
  }
}

async function runKnowledgeCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'knowledge action');

  switch (action) {
    case 'reindex':
      await runKnowledgeReindex(apiBase, parsed);
      return;
    case 'migrate':
      await runKnowledgeMigrate(apiBase, parsed);
      return;
    case 'status':
      await requestAndPrint(apiBase, '/api/knowledge/status');
      return;
    // `search` targets the K3 successor index (`/api/knowledge/index/search`),
    // not the pre-K2 `/api/knowledge/search` — the K6 boundary: pre-index
    // KnowledgeService namespaces never gain new surfaces. Their documents
    // become searchable here after `knowledge migrate`.
    case 'search':
      await runKnowledgeSearch(apiBase, parsed);
      return;
    case 'namespaces': {
      const subaction = requirePositional(parsed, 1, 'namespaces action');
      const project = requirePositional(parsed, 2, 'project slug');
      const base = `/api/projects/${encodeURIComponent(project)}/knowledge/namespaces`;
      if (subaction === 'list') {
        await requestAndPrint(apiBase, base);
        return;
      }
      if (subaction === 'create') {
        const body = await loadJsonPayload(parsed);
        await requestAndPrint(apiBase, base, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return;
      }
      if (subaction === 'update') {
        const nsId = requirePositional(parsed, 3, 'namespace id');
        const body = await loadJsonPayload(parsed);
        await requestAndPrint(apiBase, `${base}/${encodeURIComponent(nsId)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        return;
      }
      if (subaction === 'delete') {
        const nsId = requirePositional(parsed, 3, 'namespace id');
        await requestAndPrint(apiBase, `${base}/${encodeURIComponent(nsId)}`, {
          method: 'DELETE',
        });
        return;
      }
      throw new Error(
        "Unknown namespaces action. Use 'list', 'create', 'update', or 'delete'.",
      );
    }
    case 'docs':
    case 'documents': {
      const subaction = requirePositional(parsed, 1, 'documents action');
      const project = requirePositional(parsed, 2, 'project slug');
      const namespace =
        typeof parsed.flags.namespace === 'string'
          ? parsed.flags.namespace
          : undefined;
      const base = getNamespaceBase(project, namespace);

      if (subaction === 'list') {
        const query = buildQuery(parsed, [
          { flag: 'tags' },
          { flag: 'after' },
          { flag: 'before' },
          { flag: 'path-prefix', param: 'pathPrefix' },
          { flag: 'status' },
        ]);
        await requestAndPrint(apiBase, `${base}${query}`);
        return;
      }
      if (subaction === 'status') {
        await requestAndPrint(apiBase, `${base}/status`);
        return;
      }
      if (subaction === 'upload') {
        const body = await loadJsonPayload(parsed);
        await requestAndPrint(apiBase, `${base}/upload`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return;
      }
      if (subaction === 'scan') {
        const body = await loadJsonPayload(parsed);
        await requestAndPrint(apiBase, `${base}/scan`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return;
      }
      if (subaction === 'search') {
        const body = await loadJsonPayload(parsed);
        await requestAndPrint(apiBase, `${base}/search`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return;
      }
      if (subaction === 'bulk-delete') {
        const body = await loadJsonPayload(parsed);
        await requestAndPrint(apiBase, `${base}/bulk-delete`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return;
      }
      if (subaction === 'content') {
        const docId = requirePositional(parsed, 3, 'document id');
        await requestAndPrint(
          apiBase,
          `${base}/${encodeURIComponent(docId)}/content`,
        );
        return;
      }
      if (subaction === 'tree') {
        await requestAndPrint(apiBase, `${base}/tree`);
        return;
      }
      if (subaction === 'update') {
        const docId = requirePositional(parsed, 3, 'document id');
        const body = await loadJsonPayload(parsed);
        await requestAndPrint(apiBase, `${base}/${encodeURIComponent(docId)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        return;
      }
      if (subaction === 'delete') {
        const docId = requirePositional(parsed, 3, 'document id');
        await requestAndPrint(apiBase, `${base}/${encodeURIComponent(docId)}`, {
          method: 'DELETE',
        });
        return;
      }
      if (subaction === 'clear') {
        await requestAndPrint(apiBase, base, { method: 'DELETE' });
        return;
      }
      throw new Error(
        "Unknown documents action. Use 'list', 'status', 'upload', 'scan', 'search', 'bulk-delete', 'content', 'tree', 'update', 'delete', or 'clear'.",
      );
    }
    default:
      throw new Error(
        "Unknown knowledge action. Use 'reindex', 'migrate', 'status', 'search', 'namespaces', 'docs', or 'documents'.",
      );
  }
}

async function runAuthCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'auth action');

  switch (action) {
    case 'status':
      await requestRawAndPrint(apiBase, '/api/auth/status');
      return;
    case 'renew':
      await requestAndPrint(apiBase, '/api/auth/renew', { method: 'POST' });
      return;
    case 'terminal':
      await requestAndPrint(apiBase, '/api/auth/terminal', { method: 'POST' });
      return;
    case 'users': {
      const subaction = requirePositional(parsed, 1, 'users action');
      if (subaction === 'search') {
        const query = requirePositional(parsed, 2, 'query');
        await requestRawAndPrint(
          apiBase,
          `/api/users/search?q=${encodeURIComponent(query)}`,
        );
        return;
      }
      if (subaction === 'get') {
        const alias = requirePositional(parsed, 2, 'alias');
        await requestRawAndPrint(
          apiBase,
          `/api/users/${encodeURIComponent(alias)}`,
        );
        return;
      }
      throw new Error("Unknown auth users action. Use 'search' or 'get'.");
    }
    default:
      throw new Error(
        "Unknown auth action. Use 'status', 'renew', 'terminal', or 'users'.",
      );
  }
}

async function runBrandingCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'branding action');

  if (action !== 'get') {
    throw new Error("Unknown branding action. Use 'get'.");
  }
  await requestAndPrint(apiBase, '/api/branding');
}

async function runFeedbackCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'feedback action');

  switch (action) {
    case 'rate': {
      const body = await loadJsonPayload(parsed);
      await requestAndPrint(apiBase, '/api/feedback/rate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return;
    }
    case 'delete':
    case 'unrate': {
      const body = await loadJsonPayload(parsed);
      await requestAndPrint(apiBase, '/api/feedback/rate', {
        method: 'DELETE',
        body: JSON.stringify(body),
      });
      return;
    }
    case 'ratings':
      await requestAndPrint(apiBase, '/api/feedback/ratings');
      return;
    case 'guidelines':
      await requestAndPrint(apiBase, '/api/feedback/guidelines');
      return;
    case 'analyze': {
      const body =
        parsed.flags.data || parsed.flags.file || !process.stdin.isTTY
          ? await loadJsonPayload(parsed)
          : {};
      await requestAndPrint(apiBase, '/api/feedback/analyze', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return;
    }
    case 'clear-analysis':
      await requestAndPrint(apiBase, '/api/feedback/clear-analysis', {
        method: 'POST',
      });
      return;
    case 'status':
      await requestAndPrint(apiBase, '/api/feedback/status');
      return;
    case 'test':
      await requestAndPrint(apiBase, '/api/feedback/test', {
        method: 'POST',
      });
      return;
    default:
      throw new Error(
        "Unknown feedback action. Use 'rate', 'delete', 'unrate', 'ratings', 'guidelines', 'analyze', 'clear-analysis', 'status', or 'test'.",
      );
  }
}

async function runInsightsCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'insights action');

  if (action !== 'get' && action !== 'events') {
    throw new Error("Unknown insights action. Use 'get' or 'events'.");
  }
  if (action === 'events') {
    // The rows behind the rollup (station#3076): the same filters, so a
    // number and the events under it are reachable with one vocabulary.
    // ALWAYS bound the window. Without start/end the route falls through to
    // its SSE branch, and requestJson then awaits .json() on a stream that
    // never ends — the command hangs (station#3076 review). `station
    // monitoring events` gets this right by branching to streamSse; this verb
    // is a bounded read, so it supplies a default window instead.
    const rawDays = parsed.flags.days;
    const days = Number.parseInt(String(rawDays ?? ''), 10);
    if (rawDays !== undefined && !(days > 0)) {
      throw new Error(
        `--days must be a positive integer, got: ${String(rawDays)}`,
      );
    }
    const window = (days > 0 ? days : 14) * 86_400_000;
    if (parsed.flags.start === undefined) {
      // Anchor the default window on --end when one was given. Anchoring it
      // on `now` regardless produced start > end for any historical --end,
      // and the route answers that with an empty array and exit 0 — a
      // successful-looking report that the past contains nothing.
      // Parse --end the way the ROUTE parses it. Date.parse('1767225600000')
      // is NaN, so an epoch-ms --end — a form both cli.md and api.md
      // advertise — fell back to anchoring on now, producing start > end and
      // an empty result with exit 0: the exact bug this block was added to
      // fix, for the other documented input shape.
      const rawEnd = String(parsed.flags.end ?? '');
      const anchor = /^\d+$/.test(rawEnd) ? Number(rawEnd) : Date.parse(rawEnd);
      const from = Number.isFinite(anchor) ? anchor : Date.now();
      parsed.flags.start = new Date(from - window).toISOString();
    }
    const query = buildQuery(parsed, [
      { flag: 'start' },
      { flag: 'end' },
      { flag: 'agent' },
      { flag: 'tool' },
      { flag: 'engine' },
      { flag: 'conversation' },
      { flag: 'limit' },
    ]);
    // `--tools` is a bare boolean flag, and buildQuery only forwards string
    // values — so the documented form was silently doing nothing (fail-open:
    // the user got every event instead of tool events, with no error).
    const toolsOnly =
      parsed.flags.tools === true || parsed.flags.tools === 'true';
    const suffix = toolsOnly ? `${query ? `${query}&` : '?'}tools=true` : query;
    await requestAndPrint(apiBase, `/monitoring/events${suffix}`);
    return;
  }
  const query = buildQuery(parsed, [
    { flag: 'days' },
    { flag: 'agent' },
    { flag: 'tool' },
    { flag: 'engine' },
    { flag: 'limit' },
  ]);
  await requestAndPrint(apiBase, `/api/insights/${query}`);
}

/**
 * station#2844: `acp connections create` accepts ergonomic flags
 * (`--id`, `--command`, repeatable `--args`, `--name`, `--cwd`) as an
 * alternative to the generic JSON payload channels (`--data`/`--file`/piped
 * stdin, unchanged). Validation is deliberately NOT re-derived here: the
 * body is posted to the same `POST /acp/connections` route the Connections
 * hub uses, whose `acpConnectionSchema` stays the single authority — a bad
 * id or a missing command surfaces that schema's own message. Flag and
 * payload input are mutually exclusive; providing both is a usage error
 * rather than a silent precedence rule.
 */
const ACP_CONNECTION_CREATE_FLAGS = [
  'id',
  'command',
  'args',
  'name',
  'cwd',
] as const;

async function loadAcpConnectionCreateBody(
  parsed: ParsedCoreArgs,
): Promise<Record<string, unknown>> {
  const flagUsed = ACP_CONNECTION_CREATE_FLAGS.some(
    (flag) => parsed.flags[flag] !== undefined,
  );
  const payloadFlagUsed =
    typeof parsed.flags.data === 'string' ||
    typeof parsed.flags.file === 'string';

  if (flagUsed && payloadFlagUsed) {
    throw new Error(
      'Pass either create flags (--id/--command/--args/--name/--cwd) or a JSON payload (--data/--file), not both.',
    );
  }
  if (flagUsed) {
    // A bare `--id` (no `=value`) parses as boolean `true`, and the value the
    // caller meant lands in positionals. Silently dropping it would post a
    // body missing the field the caller believed they set — `--args acp`
    // creating an engine with no argv is the case that motivated this.
    const bare = ACP_CONNECTION_CREATE_FLAGS.filter(
      (flag) => parsed.flags[flag] === true,
    );
    if (bare.length > 0) {
      throw new Error(
        `${bare
          .map((flag) => `--${flag}`)
          .join(', ')} requires a value, e.g. --${bare[0]}=<value>.`,
      );
    }
    // Deliberately NOT reading stdin here. Detecting a piped body would mean
    // draining stdin, which blocks whenever it is open but idle (a script
    // that inherited a terminal-less stdin, a CI step) — the flag form would
    // hang for callers who never intended to pipe anything. So the flags are
    // the highest-precedence source and stdin is simply not consulted, which
    // is the same precedence `loadJsonPayload` already applies between
    // --data, --file and stdin. Help states that explicitly rather than
    // promising an exclusivity this cannot enforce without the hang.
    const body: Record<string, unknown> = {};
    for (const flag of ['id', 'command', 'name', 'cwd'] as const) {
      const value = parsed.flags[flag];
      if (typeof value === 'string') body[flag] = value;
    }
    const args = parsed.repeatedFlags.args;
    if (args && args.length > 0) body.args = args;
    return body;
  }
  if (!payloadFlagUsed && process.stdin.isTTY) {
    throw new Error(
      'Provide --id and --command (plus optional repeatable --args, --name, --cwd), or JSON input with --data=<json>, --file=<path>, or piped stdin.',
    );
  }
  return loadJsonPayload(parsed);
}

async function runAcpCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'acp action');

  switch (action) {
    case 'status':
      await requestAndPrint(apiBase, '/acp/status');
      return;
    case 'commands': {
      // #173: the real ACP slash-command surface is provider-keyed, not
      // agent-slug-keyed (`acp-adapter.ts`'s single `provider = 'acp'`
      // instance aggregates every ACP connection) — there is no
      // `<agent-slug>` positional to preserve from the old dead
      // `/acp/commands/:slug` route.
      const data = await getProviderCommands(apiBase, 'acp');
      printFetched(data);
      return;
    }
    case 'command-options': {
      // No server-side filtered-search route exists for this (the real
      // route returns the full command list, no `?q=`) — `--q` is a
      // client-side substring filter over `name`/`description`, not a
      // server capability.
      const data = await getProviderCommands<
        Array<{ name?: string; description?: string }>
      >(apiBase, 'acp');
      const q =
        typeof parsed.flags.q === 'string'
          ? parsed.flags.q.toLowerCase()
          : undefined;
      const filtered = q
        ? data.filter(
            (cmd) =>
              cmd.name?.toLowerCase().includes(q) ||
              cmd.description?.toLowerCase().includes(q),
          )
        : data;
      printFetched(filtered);
      return;
    }
    case 'connections': {
      const subaction = requirePositional(parsed, 1, 'connections action');
      if (subaction === 'list') {
        await requestAndPrint(apiBase, '/acp/connections');
        return;
      }
      if (subaction === 'create') {
        const body = await loadAcpConnectionCreateBody(parsed);
        await requestAndPrint(apiBase, '/acp/connections', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return;
      }
      if (subaction === 'update') {
        const id = requirePositional(parsed, 2, 'connection id');
        const body = await loadJsonPayload(parsed);
        await requestAndPrint(
          apiBase,
          `/acp/connections/${encodeURIComponent(id)}`,
          {
            method: 'PUT',
            body: JSON.stringify(body),
          },
        );
        return;
      }
      if (subaction === 'delete') {
        const id = requirePositional(parsed, 2, 'connection id');
        await requestAndPrint(
          apiBase,
          `/acp/connections/${encodeURIComponent(id)}`,
          {
            method: 'DELETE',
          },
        );
        return;
      }
      if (subaction === 'reconnect') {
        const id = requirePositional(parsed, 2, 'connection id');
        await requestAndPrint(
          apiBase,
          `/acp/connections/${encodeURIComponent(id)}/reconnect`,
          { method: 'POST' },
        );
        return;
      }
      throw new Error(
        "Unknown acp connections action. Use 'list', 'create', 'update', 'delete', or 'reconnect'.",
      );
    }
    default:
      throw new Error(
        "Unknown acp action. Use 'status', 'commands', 'command-options', or 'connections'.",
      );
  }
}

async function runVoiceCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'voice action');

  switch (action) {
    case 'status':
      await requestAndPrint(apiBase, '/api/voice/status');
      return;
    case 'agent':
      await requestAndPrint(apiBase, '/api/voice/agent');
      return;
    case 'create-session': {
      const body =
        parsed.flags.data || parsed.flags.file || !process.stdin.isTTY
          ? await loadJsonPayload(parsed)
          : {};
      await requestAndPrint(apiBase, '/api/voice/sessions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return;
    }
    case 'delete-session': {
      const id = requirePositional(parsed, 1, 'session id');
      await requestAndPrint(
        apiBase,
        `/api/voice/sessions/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
        },
      );
      return;
    }
    default:
      throw new Error(
        "Unknown voice action. Use 'status', 'agent', 'create-session', or 'delete-session'.",
      );
  }
}

function requireStringFlag(parsed: ParsedCoreArgs, flag: string): string {
  const value = parsed.flags[flag];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required flag: --${flag}=<value>`);
  }
  return value;
}

function optionalStringFlag(
  parsed: ParsedCoreArgs,
  flag: string,
): string | undefined {
  const value = parsed.flags[flag];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalListFlag(
  parsed: ParsedCoreArgs,
  flag: string,
): string[] | undefined {
  const entries = optionalStringFlag(parsed, flag)
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries?.length ? entries : undefined;
}

async function runFlowCommand(args: string[]) {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const action = requirePositional(parsed, 0, 'flow action');
  const project = requirePositional(parsed, 1, 'project slug');
  const base = `/api/projects/${encodeURIComponent(project)}/flow`;

  switch (action) {
    case 'definitions':
      await requestAndPrint(apiBase, `${base}/definitions`);
      return;
    case 'runs':
      await requestAndPrint(apiBase, `${base}/runs`);
      return;
    case 'start': {
      const body = {
        definition: requireStringFlag(parsed, 'definition'),
        runId: optionalStringFlag(parsed, 'run-id'),
      };
      await requestAndPrint(apiBase, `${base}/runs`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return;
    }
    case 'get': {
      const runId = requirePositional(parsed, 2, 'run id');
      await requestAndPrint(
        apiBase,
        `${base}/runs/${encodeURIComponent(runId)}`,
      );
      return;
    }
    case 'attach-command': {
      // Runs a command server-side in the project workspace and attaches its
      // output tail as claim evidence: exit 0 → trusted claim; non-zero →
      // failed evidence with route_reason implementation_defect.
      const runId = requirePositional(parsed, 2, 'run id');
      const expectationIds = optionalListFlag(parsed, 'expectation-ids');
      const supersede = optionalListFlag(parsed, 'supersede');
      const timeoutMs = optionalStringFlag(parsed, 'timeout-ms');
      const body = {
        gate: requireStringFlag(parsed, 'gate'),
        command: requireStringFlag(parsed, 'command'),
        claimType: requireStringFlag(parsed, 'claim-type'),
        producer: optionalStringFlag(parsed, 'producer'),
        label: optionalStringFlag(parsed, 'label'),
        ...(expectationIds ? { expectationIds } : {}),
        ...(supersede ? { supersede } : {}),
        ...(timeoutMs ? { timeoutMs: Number.parseInt(timeoutMs, 10) } : {}),
      };
      await requestAndPrint(
        apiBase,
        `${base}/runs/${encodeURIComponent(runId)}/evidence/command`,
        {
          method: 'POST',
          body: JSON.stringify(body),
          // The server runs the gate command synchronously; a build or test
          // suite legitimately outlives any client-side default. The request's
          // own --timeout-ms flag is the bound that belongs here.
          timeoutMs: null,
        },
      );
      return;
    }
    case 'evaluate': {
      const runId = requirePositional(parsed, 2, 'run id');
      const body = { gate: optionalStringFlag(parsed, 'gate') };
      await requestAndPrint(
        apiBase,
        `${base}/runs/${encodeURIComponent(runId)}/evaluate`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      return;
    }
    case 'report': {
      const runId = requirePositional(parsed, 2, 'run id');
      await requestAndPrint(
        apiBase,
        `${base}/runs/${encodeURIComponent(runId)}/report`,
      );
      return;
    }
    default:
      throw new Error(
        "Unknown flow action. Use 'definitions', 'runs', 'start', 'get', 'attach-command', 'evaluate', or 'report'.",
      );
  }
}

export async function runSurfaceCommand(
  command: string,
  args: string[],
): Promise<void> {
  switch (command) {
    case 'connections':
      await runConnectionsCommand(args);
      return;
    case 'flow':
      await runFlowCommand(args);
      return;
    case 'tools':
      await runToolsCommand(args);
      return;
    case 'notifications':
      await runNotificationsCommand(args);
      return;
    case 'monitoring':
      await runMonitoringCommand(args);
      return;
    case 'schedule':
      await runScheduleCommand(args);
      return;
    case 'runs':
      await runRunsCommand(args);
      return;
    case 'review':
      await runReviewCommand(args);
      return;
    case 'knowledge':
      await runKnowledgeCommand(args);
      return;
    case 'auth':
      await runAuthCommand(args);
      return;
    case 'branding':
      await runBrandingCommand(args);
      return;
    case 'feedback':
      await runFeedbackCommand(args);
      return;
    case 'insights':
      await runInsightsCommand(args);
      return;
    case 'acp':
      await runAcpCommand(args);
      return;
    case 'voice':
      await runVoiceCommand(args);
      return;
    default:
      throw new Error(`Unknown surface command: ${command}`);
  }
}

export async function runRegistryCatalogCommand(args: string[]): Promise<void> {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveSurfaceApiBase(parsed);
  const tab = requirePositional(parsed, 0, 'registry catalog');
  const action = requirePositional(parsed, 1, 'registry action');

  if (!['agents', 'skills', 'integrations', 'plugins'].includes(tab)) {
    throw new Error(
      "Unknown registry catalog. Use 'agents', 'skills', 'integrations', or 'plugins'.",
    );
  }

  // Only the 'skills' tab's 'list'/'install' actions are named in the #167
  // audit's triplication table (`GET /api/registry/skills`,
  // `POST /api/registry/skills/install` — shared with the SDK's
  // `useRegistrySkillsQuery`/`useInstallSkillMutation` and station-control's
  // `list_registry_skills`/`install_skill` tools). The other tabs
  // (agents/integrations/plugins) and the 'installed'/'delete' actions have
  // no canonical-fetcher equivalent and stay on the generic dispatcher.
  if (tab === 'skills' && action === 'list') {
    const data = await fetchRegistrySkills(apiBase);
    printFetched(data);
    return;
  }
  if (tab === 'skills' && action === 'install') {
    const id = requirePositional(parsed, 2, 'registry item id');
    const data = await installRegistrySkill(apiBase, id);
    printJson(data);
    return;
  }

  switch (action) {
    case 'list':
      await requestAndPrint(apiBase, `/api/registry/${tab}`);
      return;
    case 'installed':
      await requestAndPrint(apiBase, `/api/registry/${tab}/installed`);
      return;
    case 'install': {
      const id = requirePositional(parsed, 2, 'registry item id');
      await requestAndPrint(apiBase, `/api/registry/${tab}/install`, {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      return;
    }
    case 'delete':
    case 'remove':
    case 'uninstall': {
      const id = requirePositional(parsed, 2, 'registry item id');
      await requestAndPrint(
        apiBase,
        `/api/registry/${tab}/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
        },
      );
      return;
    }
    default:
      throw new Error(
        "Unknown registry action. Use 'list', 'installed', 'install', 'remove', 'uninstall', or 'delete'.",
      );
  }
}
