import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';
import { validateTaskReferenceInput } from '@kontourai/station-contracts';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { STATION_TASK_BASIS_COLLECTION_VERSION } from '@kontourai/station-contracts/task-basis';
import {
  attachAnswerSupport,
  attachTaskToolResultReference,
  attachTaskUserInputReference,
  createAgentRaw,
  createProject,
  createProjectLayout,
  createProjectLayoutFromPlugin,
  deleteAgentRaw,
  deleteProject,
  deleteProjectLayout,
  downloadTaskOutputContent,
  fetchInstalledSkills,
  getAgent,
  getConversationMessages,
  getProject,
  getProjectLayout,
  getSessionToolResult,
  getTaskAnswerSupportCards,
  getTaskBasis,
  getTaskToolResultReferences,
  getTaskUserInputReferences,
  listAgentConversations,
  listAnswerSupportBundles,
  listAnswerSupportClaims,
  listProjectLayouts,
  removeAnswerSupport,
  replaceAnswerSupport,
  updateAgentRaw,
  updateProject,
  updateProjectLayout,
} from '@kontourai/station-sdk/client';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { actionsFor, didYouMean } from '../help.js';
import { runApprovalsCommand } from './approvals.js';
import {
  configureApiCredential,
  loadJsonPayload,
  loadTextInput,
  optionalValueFlag,
  type ParsedCoreArgs,
  parseCoreArgs,
  printFetched,
  printJson,
  printJsonMode,
  requestJson,
  requirePositional,
  resolveApiBase,
} from './core-api.js';
import { runDelegateCommand } from './delegate.js';
import {
  executionEnvironment,
  rejectRetiredExecutionSelectors,
} from './execution-target.js';
import { collectModelOptions, resolveOnRequestMode } from './model-options.js';
import { runOperateCommand } from './operate/index.js';
import {
  createSessionClient,
  sendExecutionTargetChat,
} from './session-client.js';

/**
 * `station connections bogus` already named its valid actions; `station agents
 * bogus` said only "Unknown agents action: bogus". Same sentence everywhere
 * now, sourced from the one action table in `help.ts`.
 */
function describeValidActions(command: string): string {
  const actions = actionsFor(command);
  if (!actions || actions.length === 0) {
    return `Run \`station ${command} --help\` for the supported actions.`;
  }
  return `Use ${actions.map((action) => `'${action}'`).join(', ')}.`;
}

interface ResourceSpec {
  collectionPath: string;
  createPath?: string;
  deletePath?: (id: string) => string;
  getPath?: (id: string) => string;
  updatePath?: (id: string) => string;
  /**
   * Optional canonical-fetcher overrides (#167 Wave 2A). When present, these
   * replace the generic `requestJson(apiBase, <path>)` call for the
   * corresponding `runStandardCrud` action with the matching
   * `@kontourai/station-sdk/client` function — this keeps `ResourceSpec`'s
   * path constants (still needed for actions with no canonical fetcher, e.g.
   * `skills` get/update/delete) while removing the duplicate `fetch()` call
   * for the audited operations. See the #167 plan's "projects + layouts"
   * task for why this shape (rather than removing the path-based dispatcher
   * entirely) was chosen: it is the smaller diff that still removes every
   * in-scope duplicate path string.
   */
  list?: (apiBase: string) => Promise<unknown>;
  get?: (apiBase: string, id: string) => Promise<unknown>;
  create?: (apiBase: string, body: Record<string, unknown>) => Promise<unknown>;
  update?: (
    apiBase: string,
    id: string,
    body: Record<string, unknown>,
  ) => Promise<unknown>;
  delete?: (apiBase: string, id: string) => Promise<unknown>;
  customActions?: Record<
    string,
    (apiBase: string, parsed: ParsedCoreArgs) => Promise<void>
  >;
}

const resourceSpecs: Record<string, ResourceSpec> = {
  tasks: {
    collectionPath: '/api/tasks',
    createPath: '/api/tasks',
    getPath: (id) => `/api/tasks/${encodeURIComponent(id)}`,
    customActions: {
      'attach-turn': async (apiBase, parsed) => {
        await runTaskAttachTurn(apiBase, parsed);
      },
      'attach-input': async (apiBase, parsed) => {
        await runTaskAttachInput(apiBase, parsed);
      },
      'attach-result': async (apiBase, parsed) => {
        await runTaskAttachResult(apiBase, parsed);
      },
      'show-results': async (apiBase, parsed) => {
        await runTaskShowResults(apiBase, parsed);
      },
      'show-turn': async (apiBase, parsed) => {
        await runTaskShowTurn(apiBase, parsed);
      },
      'show-inputs': async (apiBase, parsed) => {
        await runTaskShowInputs(apiBase, parsed);
      },
      'list-outputs': async (apiBase, parsed) => {
        await runTaskListOutputs(apiBase, parsed);
      },
      'keep-output': async (apiBase, parsed) => {
        await runTaskKeepOutput(apiBase, parsed);
      },
      'get-output': async (apiBase, parsed) => {
        await runTaskGetOutput(apiBase, parsed);
      },
      'download-output': async (apiBase, parsed) => {
        await runTaskDownloadOutput(apiBase, parsed);
      },
      'delete-output': async (apiBase, parsed) => {
        await runTaskDeleteOutput(apiBase, parsed);
      },
      'show-support': async (apiBase, parsed) => {
        await runTaskShowSupport(apiBase, parsed);
      },
      basis: async (apiBase, parsed) => {
        const taskId = requirePositional(parsed, 1, 'task id');
        const reference = optionalValueFlag(parsed, 'answer-reference');
        const format = optionalValueFlag(parsed, 'format') ?? 'summary';
        if (format !== 'summary' && format !== 'json') {
          throw new Error('basis --format must be summary or json.');
        }
        const basis = await getTaskBasis(apiBase, taskId, {
          ...(reference ? { answerReferenceId: reference } : {}),
        });
        if (parsed.flags.json === true || format === 'json') {
          printJsonMode(basis, true);
          return;
        }
        printTaskBasisSummary(basis);
      },
      'list-support-bundles': async (apiBase, parsed) => {
        await runTaskListSupportBundles(apiBase, parsed);
      },
      'list-support-claims': async (apiBase, parsed) => {
        await runTaskListSupportClaims(apiBase, parsed);
      },
      'attach-support': async (apiBase, parsed) => {
        await runTaskAttachSupport(apiBase, parsed);
      },
      'replace-support': async (apiBase, parsed) => {
        await runTaskReplaceSupport(apiBase, parsed);
      },
      'remove-support': async (apiBase, parsed) => {
        await runTaskRemoveSupport(apiBase, parsed);
      },
    },
  },
  agents: {
    collectionPath: '/api/agents',
    createPath: '/agents',
    getPath: (slug) => `/api/agents/${encodeURIComponent(slug)}`,
    updatePath: (slug) => `/agents/${encodeURIComponent(slug)}`,
    deletePath: (slug) => `/agents/${encodeURIComponent(slug)}`,
    // CLI errors use the shared generic envelope path so structured server
    // diagnostics are rendered consistently with every other core verb.
    list: (apiBase) => requestJson(apiBase, '/api/agents'),
    get: (apiBase, slug) => getAgent(apiBase, slug),
    create: (apiBase, body) => createAgentRaw(apiBase, body),
    update: (apiBase, slug, body) => updateAgentRaw(apiBase, slug, body),
    delete: (apiBase, slug) => deleteAgentRaw(apiBase, slug),
    customActions: {
      // Positional 0 is the action word `chat`; the agent is at 1, matching
      // `conversations`/`messages` below (station#3529).
      chat: async (apiBase, parsed) => {
        await runChat(parsed, apiBase, 1);
      },
      conversations: async (apiBase, parsed) => {
        const slug = requirePositional(parsed, 1, 'agent');
        const data = await listAgentConversations(apiBase, slug);
        printFetched(data);
      },
      messages: async (apiBase, parsed) => {
        const slug = requirePositional(parsed, 1, 'agent');
        const conversationId = requirePositional(parsed, 2, 'conversationId');
        const data = await getConversationMessages(
          apiBase,
          slug,
          conversationId,
        );
        printFetched(data);
      },
      workflows: async (apiBase, parsed) => {
        await runAgentWorkflowCommand(apiBase, parsed);
      },
    },
  },
  projects: {
    collectionPath: '/api/projects',
    createPath: '/api/projects',
    getPath: (slug) => `/api/projects/${encodeURIComponent(slug)}`,
    updatePath: (slug) => `/api/projects/${encodeURIComponent(slug)}`,
    deletePath: (slug) => `/api/projects/${encodeURIComponent(slug)}`,
    list: (apiBase) => requestJson(apiBase, '/api/projects'),
    get: (apiBase, slug) => getProject(apiBase, slug),
    create: (apiBase, body) => createProject(apiBase, body),
    update: (apiBase, slug, body) => updateProject(apiBase, slug, body),
    delete: (apiBase, slug) => deleteProject(apiBase, slug),
    customActions: {
      layouts: async (apiBase, parsed) => {
        await runProjectLayoutCommand(apiBase, parsed);
      },
    },
  },
  skills: {
    collectionPath: '/api/skills',
    getPath: (name) => `/api/skills/${encodeURIComponent(name)}`,
    updatePath: (name) => `/api/skills/${encodeURIComponent(name)}`,
    deletePath: (name) => `/api/skills/${encodeURIComponent(name)}`,
    list: (apiBase) => fetchInstalledSkills(apiBase),
    customActions: {
      create: async (apiBase, parsed) => {
        const body = await loadJsonPayload(parsed);
        const data = await requestJson(apiBase, '/api/skills/local', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        printJson(data);
      },
      install: async (apiBase, parsed) => {
        const name = requirePositional(parsed, 1, 'skill name');
        const data = await requestJson(apiBase, '/api/skills', {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        printJson(data);
      },
    },
  },
  'secret-bindings': {
    collectionPath: '/api/secret-bindings',
    createPath: '/api/secret-bindings',
    getPath: (id) => `/api/secret-bindings/${encodeURIComponent(id)}`,
    customActions: {
      replace: async (apiBase, parsed) => {
        const id = requirePositional(parsed, 1, 'binding id');
        const data = await requestJson(
          apiBase,
          `/api/secret-bindings/${encodeURIComponent(id)}`,
          {
            method: 'PUT',
            body: JSON.stringify(await loadJsonPayload(parsed)),
          },
        );
        printFetched(data);
      },
      revoke: async (apiBase, parsed) => {
        const id = requirePositional(parsed, 1, 'binding id');
        const data = await requestJson(
          apiBase,
          `/api/secret-bindings/${encodeURIComponent(id)}/revoke`,
          {
            method: 'POST',
            body: JSON.stringify(await loadJsonPayload(parsed)),
          },
        );
        printFetched(data);
      },
      bind: async (apiBase, parsed) => {
        const id = requirePositional(parsed, 1, 'binding id');
        const data = await requestJson(
          apiBase,
          `/api/secret-bindings/${encodeURIComponent(id)}/bind`,
          {
            method: 'POST',
            body: JSON.stringify(await loadJsonPayload(parsed)),
          },
        );
        printFetched(data);
      },
      unbind: async (apiBase, parsed) => {
        const id = requirePositional(parsed, 1, 'binding id');
        const data = await requestJson(
          apiBase,
          `/api/secret-bindings/${encodeURIComponent(id)}/unbind`,
          {
            method: 'POST',
            body: JSON.stringify(await loadJsonPayload(parsed)),
          },
        );
        printFetched(data);
      },
      // The resolver/migration lane owns material establishment. This client
      // only forwards a structured request; it never reads the stored value.
      'migrate-stored-env': async (apiBase, parsed) => {
        const integrationId = requirePositional(parsed, 1, 'integration id');
        const data = await requestJson(
          apiBase,
          `/api/secret-bindings/integrations/${encodeURIComponent(integrationId)}/migrate-stored-env`,
          {
            method: 'POST',
            body: JSON.stringify(await loadJsonPayload(parsed)),
          },
        );
        printFetched(data);
      },
    },
  },
};

/**
 * Task creation is documented with a JSON payload flag while the established
 * generic dispatcher consumes `--data=<json>`. Keep this compatibility at the
 * task command boundary so the shared parser and every existing resource keep
 * their current flag behavior.
 */
function normalizeTaskCreateArgs(command: string, args: string[]): string[] {
  if (command !== 'tasks' || args[0] !== 'create') {
    return args;
  }

  const inlineJsonIndex = args.findIndex((arg) => arg.startsWith('--json='));
  if (inlineJsonIndex !== -1) {
    const normalized = [...args];
    normalized[inlineJsonIndex] =
      `--data=${args[inlineJsonIndex].slice('--json='.length)}`;
    return normalized;
  }

  const jsonFlagIndex = args.indexOf('--json');
  const payload = args[jsonFlagIndex + 1];
  if (jsonFlagIndex === -1 || !payload || payload.startsWith('--')) {
    return args;
  }

  return args.flatMap((arg, index) => {
    if (index === jsonFlagIndex) {
      return `--data=${payload}`;
    }
    if (index === jsonFlagIndex + 1) {
      return [];
    }
    return arg;
  });
}

function basisItemCount(
  value: unknown,
  key: 'inputs' | 'execution' | 'outcomes' | 'support',
): number {
  if (typeof value !== 'object' || value === null) return 0;
  const regions = (value as Record<string, unknown>).regions;
  if (typeof regions !== 'object' || regions === null) return 0;
  const items = (regions as Record<string, unknown>)[key];
  return Array.isArray(items) ? items.length : 0;
}

/** Stable human form: Surface owns standing; a Task collection has none. */
function printTaskBasisSummary(basis: unknown): void {
  const value =
    typeof basis === 'object' && basis !== null
      ? (basis as Record<string, unknown>)
      : {};
  if (value.version === STATION_TASK_BASIS_COLLECTION_VERSION) {
    const answers = Array.isArray(value.answers) ? value.answers.length : 0;
    const unassociated = Array.isArray(value.unassociated)
      ? value.unassociated.length
      : 0;
    const keptToolResults = Array.isArray(value.keptToolResults)
      ? value.keptToolResults.length
      : 0;
    const keptGateEvaluations = Array.isArray(value.keptGateEvaluations)
      ? value.keptGateEvaluations.length
      : 0;
    console.log(
      `scope=task collection answers=${answers} unassociated=${unassociated} kept-tool-results=${keptToolResults} kept-gate-evaluations=${keptGateEvaluations}`,
    );
    return;
  }
  const standingClass =
    typeof value.standing === 'string' ? value.standing : 'unresolved';
  console.log(
    `scope=answer standing=${standingClass} inputs=${basisItemCount(value, 'inputs')} execution=${basisItemCount(value, 'execution')} outcomes=${basisItemCount(value, 'outcomes')} support=${basisItemCount(value, 'support')}`,
  );
}

/**
 * Attach an exact completed assistant answer without accepting a caller-built
 * graph target. The server reauthorizes and confirms the Session/turn tuple
 * before it creates the Task relation, matching the UI/API path.
 */
async function runTaskAttachTurn(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const sessionId = optionalValueFlag(parsed, 'session');
  const turnId = optionalValueFlag(parsed, 'turn');
  if (!sessionId) {
    throw new Error('attach-turn requires --session=<sessionId>.');
  }
  if (!turnId) {
    throw new Error('attach-turn requires --turn=<turnId>.');
  }
  const data = await requestJson(
    apiBase,
    `/api/tasks/${encodeURIComponent(taskId)}/references`,
    {
      method: 'POST',
      body: JSON.stringify({
        kind: 'turn',
        sessionId,
        turnId,
        sourceSurface: 'cli',
      }),
    },
  );
  printFetched(data);
}

/** Attach an exact authored-input identity through the canonical SDK client. */
async function runTaskAttachInput(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const sessionId = optionalValueFlag(parsed, 'session');
  const eventId = optionalValueFlag(parsed, 'event');
  if (!sessionId) {
    throw new Error('attach-input requires --session=<sessionId>.');
  }
  if (!eventId) {
    throw new Error('attach-input requires --event=<eventId>.');
  }
  const validation = validateTaskReferenceInput({
    kind: 'user-input',
    sessionId,
    eventId,
    sourceSurface: 'cli',
  });
  if (validation.length > 0) {
    throw new Error(
      `attach-input has invalid reference: ${validation.join('; ')}`,
    );
  }
  printFetched(
    await attachTaskUserInputReference(apiBase, taskId, {
      sessionId,
      eventId,
      sourceSurface: 'cli',
    }),
  );
}

/**
 * Reopen the same authorized answer projection the Task basis uses. This is
 * intentionally not a graph read: the orchestration route reauthorizes the
 * Session/turn tuple and returns only the answer-safe text/provenance shape.
 */
async function runTaskShowTurn(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const data = await requestJson(
    apiBase,
    `/api/tasks/${encodeURIComponent(taskId)}/turn-references`,
  );
  printFetched(data);
}

/** Reopen only server-authorized authored-input projections. */
async function runTaskShowInputs(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  printJsonMode(
    await getTaskUserInputReferences(apiBase, taskId),
    parsed.flags.json === true,
  );
}

async function runTaskAttachResult(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const sessionId = optionalValueFlag(parsed, 'session');
  const eventId = optionalValueFlag(parsed, 'event');
  if (!sessionId)
    throw new Error('attach-result requires --session=<sessionId>.');
  if (!eventId) throw new Error('attach-result requires --event=<eventId>.');
  const validation = validateTaskReferenceInput({
    kind: 'tool-result',
    sessionId,
    eventId,
    sourceSurface: 'cli',
  });
  if (validation.length)
    throw new Error(
      `attach-result has invalid reference: ${validation.join('; ')}`,
    );
  printFetched(
    await attachTaskToolResultReference(apiBase, taskId, {
      sessionId,
      eventId,
      sourceSurface: 'cli',
    }),
  );
}
async function runTaskShowResults(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  printJsonMode(
    await getTaskToolResultReferences(
      apiBase,
      requirePositional(parsed, 1, 'task id'),
    ),
    parsed.flags.json === true,
  );
}

/** Shows reauthorized answer cards and their bounded support standing. */
async function runTaskShowSupport(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  printFetched(await getTaskAnswerSupportCards(apiBase, taskId));
}

function requiredTaskSupportFlag(
  parsed: ParsedCoreArgs,
  action: string,
  flag: string,
): string {
  const value = optionalValueFlag(parsed, flag);
  if (!value) throw new Error(`${action} requires --${flag}=<${flag}Id>.`);
  return value;
}

function requiredExpectedRevision(
  parsed: ParsedCoreArgs,
  action: string,
): number {
  const value = optionalValueFlag(parsed, 'revision');
  if (!value) throw new Error(`${action} requires --revision=<revision>.`);
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision <= 0)
    throw new Error(`${action} requires --revision=<positive integer>.`);
  return revision;
}

async function runTaskListSupportBundles(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const referenceId = requiredTaskSupportFlag(
    parsed,
    'list-support-bundles',
    'reference',
  );
  printFetched(await listAnswerSupportBundles(apiBase, taskId, referenceId));
}

async function runTaskListSupportClaims(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const referenceId = requiredTaskSupportFlag(
    parsed,
    'list-support-claims',
    'reference',
  );
  const bundleId = requiredTaskSupportFlag(
    parsed,
    'list-support-claims',
    'bundle',
  );
  printFetched(
    await listAnswerSupportClaims(apiBase, taskId, referenceId, bundleId),
  );
}

async function runTaskAttachSupport(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const referenceId = requiredTaskSupportFlag(
    parsed,
    'attach-support',
    'reference',
  );
  const bundleId = requiredTaskSupportFlag(parsed, 'attach-support', 'bundle');
  const claimId = requiredTaskSupportFlag(parsed, 'attach-support', 'claim');
  printFetched(
    await attachAnswerSupport(apiBase, taskId, referenceId, {
      bundleId,
      claimId,
    }),
  );
}

async function runTaskReplaceSupport(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const referenceId = requiredTaskSupportFlag(
    parsed,
    'replace-support',
    'reference',
  );
  const bundleId = requiredTaskSupportFlag(parsed, 'replace-support', 'bundle');
  const claimId = requiredTaskSupportFlag(parsed, 'replace-support', 'claim');
  const expectedRevision = requiredExpectedRevision(parsed, 'replace-support');
  printFetched(
    await replaceAnswerSupport(apiBase, taskId, referenceId, {
      bundleId,
      claimId,
      expectedRevision,
    }),
  );
}

async function runTaskRemoveSupport(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const referenceId = requiredTaskSupportFlag(
    parsed,
    'remove-support',
    'reference',
  );
  const expectedRevision = requiredExpectedRevision(parsed, 'remove-support');
  await removeAnswerSupport(apiBase, taskId, referenceId, { expectedRevision });
  printFetched(undefined);
}

async function runTaskListOutputs(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  printFetched(
    await requestJson(
      apiBase,
      `/api/tasks/${encodeURIComponent(taskId)}/outputs`,
    ),
  );
}

async function runTaskKeepOutput(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const relativePath = parsed.flags.path;
  const title = parsed.flags.title;
  const operationId = parsed.flags.operation;
  if (!relativePath || !title || !operationId) {
    throw new Error(
      'keep-output requires --path=<relativePath> --title=<title> --operation=<operationId>.',
    );
  }
  printFetched(
    await requestJson(
      apiBase,
      `/api/tasks/${encodeURIComponent(taskId)}/outputs`,
      {
        method: 'POST',
        body: JSON.stringify({
          operationId,
          relativePath,
          title,
          ...(parsed.flags.media
            ? { declaredMediaType: parsed.flags.media }
            : {}),
        }),
      },
    ),
  );
}

async function runTaskGetOutput(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const outputId = requirePositional(parsed, 2, 'output id');
  printFetched(
    await requestJson(
      apiBase,
      `/api/tasks/${encodeURIComponent(taskId)}/outputs/${encodeURIComponent(outputId)}`,
    ),
  );
}

async function runTaskDownloadOutput(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const outputId = requirePositional(parsed, 2, 'output id');
  const requested = parsed.flags.out;
  if (!requested || requested === true)
    throw new Error('download-output requires --out=<destination>.');
  if (!isAbsolute(requested)) {
    throw new Error('download-output destination must be an absolute path.');
  }
  const destination = resolve(requested);
  if (existsSync(destination)) {
    const entry = lstatSync(destination);
    if (entry.isSymbolicLink())
      throw new Error('download-output refuses a symlink destination.');
    throw new Error(
      'download-output refuses to overwrite an existing destination.',
    );
  }
  const parent = dirname(destination);
  const parentBefore = assertSafeOutputParent(parent);
  const content = await downloadTaskOutputContent(apiBase, taskId, outputId);
  const parentBeforePublish = assertSafeOutputParent(parent);
  if (
    parentBefore.dev !== parentBeforePublish.dev ||
    parentBefore.ino !== parentBeforePublish.ino
  )
    throw new Error(
      'download-output destination parent changed during download.',
    );
  const temporary = join(
    parentBefore.canonicalPath,
    `.${basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content.bytes, { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const parentAtLink = assertSafeOutputParent(parent);
    if (!sameFileIdentity(parentBefore, parentAtLink))
      throw new Error(
        'download-output destination parent changed during publication.',
      );
    try {
      // linkSync is an atomic no-replace publication: EEXIST means another
      // writer won after the network request, and its bytes stay untouched.
      linkSync(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          'download-output refuses to overwrite an existing destination.',
        );
      }
      throw error;
    }
    const staged = lstatSync(temporary);
    let parentAfterLink: ReturnType<typeof assertSafeOutputParent>;
    try {
      parentAfterLink = assertSafeOutputParent(parent);
    } catch {
      containUnstablePublication(destination, staged);
      throw new Error('download-output publication is uncertain.');
    }
    if (!sameFileIdentity(parentBefore, parentAfterLink)) {
      containUnstablePublication(destination, staged);
      throw new Error('download-output publication is uncertain.');
    }
    try {
      fsyncDirectorySync(parent);
    } catch {
      const bytes = readFileSync(destination);
      const entry = lstatSync(destination);
      const parentAfterFsync = assertSafeOutputParent(parent);
      if (
        entry.isFile() &&
        entry.dev === staged.dev &&
        entry.ino === staged.ino &&
        bytes.equals(Buffer.from(content.bytes)) &&
        sameFileIdentity(parentAfterFsync, parentBefore)
      ) {
        // Publication is durable enough to observe exactly even when a
        // directory fsync cannot be performed on this filesystem.
      } else {
        throw new Error('download-output publication is uncertain.');
      }
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
  printJson({
    destination,
    byteLength: content.bytes.byteLength,
    mediaType: content.mediaType,
    etag: content.etag,
  });
}

function assertSafeOutputParent(parent: string) {
  if (!existsSync(parent))
    throw new Error('download-output destination parent is unavailable.');
  const absolute = resolve(parent);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const next = join(current, segment);
    const entry = lstatSync(next);
    if (entry.isSymbolicLink()) {
      const allowedSystemAlias =
        index === 0 &&
        process.platform === 'darwin' &&
        ['/var', '/tmp', '/etc'].includes(next);
      if (!allowedSystemAlias)
        throw new Error('download-output destination parent is unavailable.');
      current = realpathSync(next);
      if (!lstatSync(current).isDirectory())
        throw new Error('download-output destination parent is unavailable.');
      continue;
    }
    if (!entry.isDirectory())
      throw new Error('download-output destination parent is unavailable.');
    current = next;
  }
  const final = lstatSync(current);
  if (!final.isDirectory() || final.isSymbolicLink())
    throw new Error('download-output destination parent is unavailable.');
  return { canonicalPath: current, dev: final.dev, ino: final.ino };
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
) {
  return left.dev === right.dev && left.ino === right.ino;
}

function containUnstablePublication(
  destination: string,
  staged: { dev: number; ino: number },
) {
  try {
    const published = lstatSync(destination);
    if (sameFileIdentity(published, staged)) unlinkSync(destination);
  } catch {
    // A missing or attacker-replaced path is not ours to remove.
  }
}

async function runTaskDeleteOutput(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const taskId = requirePositional(parsed, 1, 'task id');
  const outputId = requirePositional(parsed, 2, 'output id');
  printFetched(
    await requestJson(
      apiBase,
      `/api/tasks/${encodeURIComponent(taskId)}/outputs/${encodeURIComponent(outputId)}`,
      { method: 'DELETE' },
    ),
  );
}

async function runStandardCrud(
  apiBase: string,
  parsed: ParsedCoreArgs,
  spec: ResourceSpec,
): Promise<boolean> {
  const action = parsed.positionals[0];
  switch (action) {
    case 'list': {
      const data = spec.list
        ? await spec.list(apiBase)
        : await requestJson(apiBase, spec.collectionPath);
      printFetched(data);
      return true;
    }
    case 'get': {
      if (!spec.getPath && !spec.get) {
        throw new Error('Get is not supported for this resource.');
      }
      const id = requirePositional(parsed, 1, 'id');
      const data = spec.get
        ? await spec.get(apiBase, id)
        : await requestJson(apiBase, spec.getPath!(id));
      printFetched(data);
      return true;
    }
    case 'create': {
      if (!spec.createPath && !spec.create) {
        throw new Error('Create is not supported for this resource.');
      }
      const body = await loadJsonPayload(parsed);
      const data = spec.create
        ? await spec.create(apiBase, body)
        : await requestJson(apiBase, spec.createPath!, {
            method: 'POST',
            body: JSON.stringify(body),
          });
      printFetched(data);
      return true;
    }
    case 'update': {
      if (!spec.updatePath && !spec.update) {
        throw new Error('Update is not supported for this resource.');
      }
      const id = requirePositional(parsed, 1, 'id');
      const body = await loadJsonPayload(parsed);
      const data = spec.update
        ? await spec.update(apiBase, id, body)
        : await requestJson(apiBase, spec.updatePath!(id), {
            method: 'PUT',
            body: JSON.stringify(body),
          });
      printFetched(data);
      return true;
    }
    case 'delete': {
      if (!spec.deletePath && !spec.delete) {
        throw new Error('Delete is not supported for this resource.');
      }
      const id = requirePositional(parsed, 1, 'id');
      const data = spec.delete
        ? await spec.delete(apiBase, id)
        : await requestJson(apiBase, spec.deletePath!(id), {
            method: 'DELETE',
          });
      printFetched(data);
      return true;
    }
    default:
      return false;
  }
}

async function runAgentWorkflowCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const action = requirePositional(parsed, 1, 'workflow action');

  if (action === 'list') {
    const slug = requirePositional(parsed, 2, 'agent');
    const data = await requestJson(
      apiBase,
      `/agents/${encodeURIComponent(slug)}/workflows/files`,
    );
    printJson(data);
    return;
  }

  if (action === 'get') {
    const slug = requirePositional(parsed, 2, 'agent');
    const workflowId = requirePositional(parsed, 3, 'workflowId');
    const data = await requestJson(
      apiBase,
      `/agents/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(workflowId)}`,
    );
    printJson(data);
    return;
  }

  if (action === 'create') {
    const slug = requirePositional(parsed, 2, 'agent');
    const body = await loadJsonPayload(parsed);
    const data = await requestJson(
      apiBase,
      `/agents/${encodeURIComponent(slug)}/workflows`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    printJson(data);
    return;
  }

  if (action === 'update') {
    const slug = requirePositional(parsed, 2, 'agent');
    const workflowId = requirePositional(parsed, 3, 'workflowId');
    const body = await loadJsonPayload(parsed);
    const data = await requestJson(
      apiBase,
      `/agents/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(workflowId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    );
    printJson(data);
    return;
  }

  if (action === 'delete') {
    const slug = requirePositional(parsed, 2, 'agent');
    const workflowId = requirePositional(parsed, 3, 'workflowId');
    const data = await requestJson(
      apiBase,
      `/agents/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(workflowId)}`,
      {
        method: 'DELETE',
      },
    );
    printJson(data);
    return;
  }

  throw new Error(
    "Unknown workflow action. Use 'list', 'get', 'create', 'update', or 'delete'.",
  );
}

async function runProjectLayoutCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const action = requirePositional(parsed, 1, 'layout action');

  if (action === 'available') {
    const data = await requestJson(apiBase, '/api/projects/layouts/available');
    printJson(data);
    return;
  }

  if (action === 'list') {
    const project = requirePositional(parsed, 2, 'project');
    const data = await listProjectLayouts(apiBase, project);
    printFetched(data);
    return;
  }

  if (action === 'get') {
    const project = requirePositional(parsed, 2, 'project');
    const layout = requirePositional(parsed, 3, 'layout');
    const data = await getProjectLayout(apiBase, project, layout);
    printFetched(data);
    return;
  }

  if (action === 'create') {
    const project = requirePositional(parsed, 2, 'project');
    const body = await loadJsonPayload(parsed);
    const data = await createProjectLayout(apiBase, project, body);
    printFetched(data);
    return;
  }

  if (action === 'update') {
    const project = requirePositional(parsed, 2, 'project');
    const layout = requirePositional(parsed, 3, 'layout');
    const body = await loadJsonPayload(parsed);
    const data = await updateProjectLayout(apiBase, project, layout, body);
    printFetched(data);
    return;
  }

  if (action === 'delete') {
    const project = requirePositional(parsed, 2, 'project');
    const layout = requirePositional(parsed, 3, 'layout');
    // `deleteProjectLayout` returns `void` (matching the route's bare
    // `{success:true}` response, which has no `data` field to unwrap) — see
    // `printFetched`'s docblock for why this needs the fallback.
    await deleteProjectLayout(apiBase, project, layout);
    printFetched(undefined);
    return;
  }

  if (action === 'from-plugin') {
    const project = requirePositional(parsed, 2, 'project');
    const plugin = requirePositional(parsed, 3, 'plugin');
    const data = await createProjectLayoutFromPlugin(apiBase, project, plugin);
    printFetched(data);
    return;
  }

  throw new Error(
    "Unknown layout action. Use 'available', 'list', 'get', 'create', 'update', 'delete', or 'from-plugin'.",
  );
}

/**
 * Shared by two positional layouts, which is why `agentIndex` is explicit
 * rather than assumed (station#3529):
 *
 * - the canonical top-level verb `station chat <agent> <message>` — the agent
 *   is positional 0;
 * - the resource action `station agents chat <agent> <message>` — custom
 *   actions receive the full positional list with the action word still at
 *   index 0, so the agent is positional 1. Its siblings `conversations` and
 *   `messages` already read index 1; `chat` passed this function's default and
 *   so resolved the literal action word `chat` as the agent, folding the real
 *   slug into the message. That failed as a bare "Agent not found" — or, with
 *   an agent literally named `chat` present, silently ran the wrong agent with
 *   a corrupted prompt and exited 0.
 */
async function runChat(
  parsed: ParsedCoreArgs,
  apiBase: string,
  agentIndex = 0,
): Promise<void> {
  rejectRetiredExecutionSelectors(parsed);
  const selectedAgent = agentId(requirePositional(parsed, agentIndex, 'agent'));
  const content = await loadTextInput(parsed, agentIndex + 1);
  const sessionFlag = optionalValueFlag(parsed, 'session');
  const conversationFlag =
    typeof parsed.flags.conversation === 'string'
      ? parsed.flags.conversation
      : undefined;
  if (sessionFlag && conversationFlag && sessionFlag !== conversationFlag) {
    throw new Error(
      '--session and --conversation must identify the same session.',
    );
  }
  // station#978 AC1/AC2/AC5/AC7: usage errors here throw before any request,
  // same as every other flag check above.
  const { modelOptions, cwd } = collectModelOptions(parsed);
  const projectSlug =
    typeof parsed.flags.project === 'string' ? parsed.flags.project : undefined;
  // A shell already has an authoritative execution workspace: the directory
  // from which it was invoked. Never silently turn an ordinary CLI chat into
  // an unbound/home chat. A project, when selected, is a separate resource and
  // organizational context; it can contribute knowledge, layouts, policies,
  // and agent availability beyond the directory where a tool happens to run.
  //
  // Match delegate's workspace contract: a target cannot select both a
  // configured project and an arbitrary directory.
  if (cwd && projectSlug) {
    throw new Error('Use --project or --cwd, not both.');
  }
  const onRequest = resolveOnRequestMode(parsed);
  if (parsed.flags.title !== undefined) {
    throw new Error(
      '--title is not supported by canonical foreground execution yet.',
    );
  }
  const model = optionalValueFlag(parsed, 'model');
  await sendExecutionTargetChat(
    apiBase,
    {
      environment: executionEnvironment(parsed),
      agent: selectedAgent,
      ...(model || modelOptions
        ? {
            model: {
              ...(model ? { override: model } : {}),
              ...(modelOptions ? { options: modelOptions } : {}),
            },
          }
        : {}),
      ...(!sessionFlag && !conversationFlag
        ? projectSlug
          ? {
              workspace: {
                kind: 'project' as const,
                projectSlug,
                cwd: process.cwd(),
              },
            }
          : {
              workspace: {
                kind: 'directory' as const,
                cwd: cwd ?? process.cwd(),
              },
            }
        : {}),
    },
    {
      message: content,
      conversationId: sessionFlag ?? conversationFlag,
      jsonMode: parsed.flags.json === true,
      onRequest,
    },
  );
}

async function runSessionsCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  rejectRetiredExecutionSelectors(parsed);
  const action = requirePositional(parsed, 0, 'session action');
  const agentSlug = agentId(requirePositional(parsed, 1, 'agent'));

  if (action === 'inspect') {
    const sessionId = requirePositional(parsed, 2, 'session id');
    const eventId = requirePositional(parsed, 3, 'tool result event id');
    const validation = validateTaskReferenceInput({
      kind: 'tool-result',
      sessionId,
      eventId,
      sourceSurface: 'cli',
    });
    if (validation.length > 0) {
      throw new Error(
        `inspect has invalid tool result reference: ${validation.join('; ')}`,
      );
    }
    printJsonMode(
      await getSessionToolResult(apiBase, sessionId, eventId),
      parsed.flags.json === true,
    );
    return;
  }

  const client = await createSessionClient(apiBase, { agentSlug });

  if (action === 'list') {
    printJson(await client.listSessions());
    return;
  }

  if (action === 'read') {
    const id = requirePositional(parsed, 2, 'session id');
    printJson(await client.readSession(id));
    return;
  }

  if (action === 'interrupt') {
    const id = requirePositional(parsed, 2, 'session id');
    const turnId =
      typeof parsed.flags.turn === 'string' ? parsed.flags.turn : undefined;
    await client.interruptSession(id, turnId);
    printJson({ success: true, interrupted: id });
    return;
  }

  throw new Error(
    "Unknown sessions action. Use 'list', 'read', 'inspect', or 'interrupt'.",
  );
}

export async function runCoreCommand(
  command: string,
  args: string[],
): Promise<void> {
  const parsed = parseCoreArgs(normalizeTaskCreateArgs(command, args));
  const apiBase = resolveApiBase(parsed);
  configureApiCredential(parsed, apiBase);

  if (command === 'chat') {
    await runChat(parsed, apiBase);
    return;
  }

  if (command === 'sessions') {
    await runSessionsCommand(apiBase, parsed);
    return;
  }

  if (command === 'conversation') {
    const { runConversationCommand } = await import('./conversation.js');
    await runConversationCommand(apiBase, parsed);
    return;
  }

  if (command === 'approvals') {
    await runApprovalsCommand(apiBase, parsed);
    return;
  }

  if (command === 'operate') {
    await runOperateCommand(apiBase, parsed);
    return;
  }

  if (command === 'delegate') {
    await runDelegateCommand(apiBase, parsed);
    return;
  }

  const spec = resourceSpecs[command];
  if (!spec) {
    throw new Error(`Unknown core command: ${command}`);
  }

  const action = parsed.positionals[0];
  if (!action) {
    throw new Error(
      `Missing action for ${command}. ${describeValidActions(command)}`,
    );
  }

  if (spec.customActions?.[action]) {
    await spec.customActions[action](apiBase, parsed);
    return;
  }

  const handled = await runStandardCrud(apiBase, parsed, spec);
  if (handled) {
    return;
  }

  throw new Error(
    `Unknown ${command} action: ${action}. ${didYouMean(action, actionsFor(command) ?? [])}${describeValidActions(command)}`,
  );
}
