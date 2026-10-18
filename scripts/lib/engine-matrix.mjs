import { randomUUID } from 'node:crypto';

function modelVendor(model) {
  if (/^deepseek-/.test(model)) return 'deepseek';
  if (/^grok-/.test(model)) return 'x-ai';
  if (/^kimi-/.test(model)) return 'moonshot';
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^(?:gpt-|chatgpt-|codex-|o[134](?:-|$))/.test(model)) return 'openai';
  if (/^(?:gemini|gemma)-/.test(model)) return 'google';
  if (/^llama/i.test(model)) return 'meta';
  if (/^(?:mistral|mixtral|codestral|ministral|pixtral)-/.test(model))
    return 'mistral';
  if (/^(?:nova|titan)-/.test(model)) return 'amazon';
}

function modelIdentity(value) {
  const qualified = value.replace(/^openrouter\//, '');
  const regional =
    /^(?:us|eu|apac|global|jp|au|us-gov)\.([a-z][a-z0-9-]*)\.(.+)$/.exec(
      qualified,
    );
  const explicit = /^([a-z][a-z0-9-]*)\/(.+)$/.exec(qualified);
  const dotted = /^(anthropic|amazon|meta|mistral|cohere|ai21)\.(.+)$/.exec(
    qualified,
  );
  const prefix = regional ?? explicit ?? dotted;
  const vendorAliases = new Map([
    ['moonshotai', 'moonshot'],
    ['xai', 'x-ai'],
    ['deepseek-ai', 'deepseek'],
  ]);
  return {
    model: prefix?.[2] ?? qualified,
    vendor: vendorAliases.get(prefix?.[1]) ?? prefix?.[1],
    bedrock: Boolean(regional ?? dotted),
  };
}

function modelSnapshot(model, bedrock) {
  const match =
    /^(.*?)[-@](20\d{2}-\d{2}-\d{2}|20\d{6})(?:-v(\d+(?::\d+)?))?$/.exec(model);
  return match
    ? { base: match[1], date: match[2].replaceAll('-', ''), version: match[3] }
    : bedrock && /^(.*?)-v(\d+:\d+)$/.test(model)
      ? {
          base: model.replace(/-v\d+:\d+$/, ''),
          version: /-v(\d+:\d+)$/.exec(model)[1],
        }
      : { base: model };
}

export function checkServedModel(requested, reported) {
  if (!requested || !reported) return 'unverified';
  const a = modelIdentity(requested);
  const b = modelIdentity(reported);
  const familyVendor = modelVendor(a.model);
  const requestedVendor = familyVendor ?? a.vendor;
  if (
    (familyVendor && a.vendor && a.vendor !== familyVendor) ||
    (requestedVendor && b.vendor && b.vendor !== requestedVendor)
  )
    return 'fail';
  const left = modelSnapshot(a.model, a.bedrock);
  const right = modelSnapshot(b.model, b.bedrock);
  if (
    left.base !== right.base ||
    (left.date && right.date && left.date !== right.date) ||
    (left.version && right.version && left.version !== right.version)
  )
    return 'fail';
  return b.vendor && !requestedVendor ? 'unverified' : 'pass';
}

function comparisonModel(engine, entry) {
  if (typeof entry.resolvedModel === 'string' && entry.resolvedModel.trim())
    return entry.resolvedModel;
  // Claude's launch selectors include SDK aliases such as sonnet and default.
  if (
    engine === 'claude' &&
    !modelIdentity(entry.id).model.startsWith('claude-')
  )
    return null;
  return entry.id;
}

export function checkServedConnection(expected, observedEngine, connections) {
  if (!observedEngine) return 'unverified';
  const matches = connections.filter(
    (connection) =>
      connection.enabled && engineFor(connection) === observedEngine,
  );
  return matches.length === 1 && matches[0].id === expected ? 'pass' : 'fail';
}

export function checkOutputs(stored, rendered) {
  if (!stored || !rendered) return 'unverified';
  if (
    !Array.isArray(stored) ||
    !Array.isArray(rendered) ||
    ![...stored, ...rendered].every((name) => typeof name === 'string')
  )
    return 'fail';
  const a = [...stored].sort();
  const b = [...rendered].sort();
  return a.length === b.length && a.every((name, index) => name === b[index])
    ? 'pass'
    : 'fail';
}

function engineFor(connection) {
  return connection.type === 'acp' ? 'acp' : connection.config.provider;
}

function observed(slot) {
  return slot?.state === 'observed' ? slot.value : undefined;
}

function aggregate(checks) {
  if (checks.includes('fail')) return 'fail';
  return checks.length > 0 && checks.every((check) => check === 'pass')
    ? 'pass'
    : 'unverified';
}

const scenarios = [
  {
    id: 'first',
    async run(ctx) {
      await ctx.send(
        `Remember this secret for this conversation: ${ctx.nonce}. Reply with exactly STATION_SMOKE_OK. Do not use tools.`,
        ctx.model,
        'STATION_SMOKE_OK',
      );
    },
  },
  {
    id: 'follow-up',
    async run(ctx) {
      await ctx.recall(ctx.model);
    },
  },
  {
    id: 'model-switch',
    async run(ctx) {
      if (!ctx.switchModel) return 'unverified: no second advertised model';
      await ctx.recall(ctx.switchModel);
      await ctx.recall(ctx.model);
    },
  },
  {
    id: 'artifact',
    async run(ctx) {
      await ctx.send(
        `Create ${ctx.artifactName} containing exactly ${ctx.artifactContent} then call Station's declare_output tool with {"file":{"path":"${ctx.artifactName}"}} so it is declared as a session output. Reply with exactly STATION_SMOKE_OK.`,
        ctx.model,
        'STATION_SMOKE_OK',
        ctx.artifactName,
        ctx.artifactContent,
      );
    },
  },
  {
    id: 'recycle',
    async run(ctx) {
      const loaded = async () => {
        try {
          const body = await ctx.api('/api/orchestration/sessions/loaded');
          if (!Array.isArray(body.data)) return null;
          return body.data.some(
            (session) =>
              session.threadId === ctx.sessionId && session.isLoaded === true,
          );
        } catch {
          return null;
        }
      };
      ctx.recycleEvidence = { loadedBefore: await loaded() };
      await ctx.command({ type: 'stopSession', threadId: ctx.sessionId });
      ctx.recycleEvidence.loadedAfterStop = await loaded();
      if (
        ctx.recycleEvidence.loadedBefore !== true ||
        ctx.recycleEvidence.loadedAfterStop !== false
      )
        return 'unverified: API unload transition was not observed';
      await ctx.recall(ctx.model);
      ctx.recycleEvidence.loadedAfterRecall = await loaded();
      if (ctx.recycleEvidence.loadedAfterRecall !== true)
        return 'unverified: API resumed activation was not observed';
    },
  },
];

async function waitForTurn(api, sessionId, turnId, deadline, priorEventIds) {
  while (Date.now() < deadline) {
    const events = (
      await api(`/api/orchestration/sessions/${sessionId}/events`)
    ).data;
    const aborted = events.find(
      (event) => event.turnId === turnId && event.method === 'turn.aborted',
    );
    if (aborted)
      throw new Error(`Turn aborted: ${aborted.reason ?? 'unknown'}`);
    const error = events.find(
      (event) =>
        event.method === 'runtime.error' &&
        (event.turnId === turnId ||
          (!event.turnId && !priorEventIds.has(event.eventId))),
    );
    if (error) throw new Error(error.message);
    const terminalIndex = events.findIndex(
      (event) => event.turnId === turnId && event.method === 'turn.completed',
    );
    if (terminalIndex >= 0)
      return new Set(
        events.slice(0, terminalIndex + 1).map((event) => event.eventId),
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    'Turn completion timed out; provider termination is not confirmed',
  );
}

async function readStoredOutputs(api, sessionId, turnId, deadline) {
  const stored = [];
  let cursor;
  const seenCursors = new Set();
  do {
    if (Date.now() >= deadline) throw new Error('Stored-output read timed out');
    const page = (
      await api(
        `/api/orchestration/sessions/${sessionId}/outputs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
    ).data;
    if (page.partial) throw new Error('Stored outputs are partial');
    stored.push(...page.items.filter((item) => item.turnId === turnId));
    cursor = page.cursor;
    if (cursor && seenCursors.has(cursor))
      throw new Error('Output cursor did not advance');
    seenCursors.add(cursor);
  } while (cursor);
  return stored;
}

function planRun(catalog, modelIds, additionalScenarios, maxTurns) {
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const models = [
    ...new Set(modelIds.length ? modelIds : catalog.map((entry) => entry.id)),
  ];
  if (
    !models.length ||
    models.some(
      (model) => typeof model !== 'string' || !model || !catalogById.has(model),
    )
  )
    throw new Error(
      'No usable advertised models, or --model is not advertised',
    );
  const registered = [...scenarios, ...additionalScenarios];
  if (
    new Set(registered.map((scenario) => scenario.id)).size !==
    registered.length
  )
    throw new Error('Duplicate scenario id');
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000)
    throw new Error('max-turns must be an integer between 1 and 1000');
  const builtInTurns = models.length * (models.length > 1 ? 6 : 4);
  for (const scenario of additionalScenarios) {
    if (
      scenario.maxTurns !== undefined &&
      (!Number.isSafeInteger(scenario.maxTurns) || scenario.maxTurns < 1)
    )
      throw new Error('Scenario maxTurns must be a positive integer');
  }
  const minimumPlannedTurns =
    builtInTurns +
    models.length *
      additionalScenarios.reduce(
        (sum, scenario) => sum + (scenario.maxTurns ?? 1),
        0,
      );
  if (minimumPlannedTurns > maxTurns)
    throw new Error(
      `Planned ${minimumPlannedTurns} turns exceeds --max-turns=${maxTurns}; refusing the entire run. Select fewer models with --model=ID (repeatable). You may explicitly raise --max-turns up to 1000; this plan requires ${minimumPlannedTurns}.`,
    );
  const plan = {
    modelIds: models,
    builtInTurns,
    plannedTurnCount: additionalScenarios.some(
      (scenario) => scenario.maxTurns === undefined,
    )
      ? maxTurns
      : minimumPlannedTurns,
    maxTurns,
    extensionBudget: additionalScenarios.some(
      (scenario) => scenario.maxTurns === undefined,
    )
      ? 'reserved-remaining-ceiling'
      : 'declared',
  };
  return { catalogById, models, registered, plan };
}

async function inspectArtifact(
  api,
  sessionId,
  turnId,
  storedItems,
  artifactName,
  artifactContent,
) {
  let contentCheck = 'pass';
  if (artifactContent !== undefined) {
    const item = storedItems.find(
      (candidate) =>
        candidate.descriptor.kind === 'workspace-file' &&
        candidate.descriptor.relativePath === artifactName,
    );
    contentCheck = 'unverified';
    if (item?.ref?.eventId) {
      const inspection = (
        await api(
          `/api/orchestration/sessions/${sessionId}/outputs/${encodeURIComponent(item.ref.eventId)}/inspect`,
          {},
        )
      ).data;
      if (
        inspection.item?.ref?.sessionId === sessionId &&
        inspection.item?.ref?.eventId === item.ref.eventId &&
        inspection.item?.turnId === turnId &&
        inspection.kind === 'text'
      )
        contentCheck = inspection.text === artifactContent ? 'pass' : 'fail';
    }
  }
  return contentCheck;
}

/** Additional scenarios use the same send/recall verdict path; #3824 can register here. */
export async function runMatrix({
  api,
  connectionId,
  cwd,
  timeoutMs = 60_000,
  observeOutputs,
  additionalScenarios = [],
  modelIds = [],
  maxTurns = 24,
  onPlan = () => {},
  agentId = '',
}) {
  const inventory = await api('/api/connections/agents');
  if (inventory.failures?.length)
    throw new Error('Connection inventory is incomplete');
  const enabled = inventory.data.filter((connection) => connection.enabled);
  if (enabled.length !== 1 || enabled[0].id !== connectionId) {
    throw new Error(
      'Use an isolated Station with only the selected engine connection enabled; remove other engine connections before running',
    );
  }
  const connection = enabled[0];
  const engine = engineFor(connection);
  if (!engine) throw new Error('Connection has no engine identity');
  const catalog = (
    await api(
      `/api/orchestration/providers/${encodeURIComponent(engine)}/models`,
    )
  ).data;
  const { catalogById, models, registered, plan } = planRun(
    catalog,
    modelIds,
    additionalScenarios,
    maxTurns,
  );
  await onPlan(plan);
  const agents = (await api('/api/agents')).data;
  const matchesConnection = (agent) =>
    agent.execution?.agentConnectionId === connectionId ||
    (engine === 'station-agent' && !agent.execution?.agentConnectionId);
  const agent = agentId
    ? agents.find((entry) => entry.slug === agentId)
    : agents.find(
        (entry) =>
          entry.executionDefault === true &&
          matchesConnection(entry) &&
          entry.available !== false,
      );
  if (!agent || !matchesConnection(agent) || agent.available === false)
    throw new Error('Select --agent=ID bound to the connection under test');
  let sentTurns = 0;
  const checkedApi = async (path, body, ...rest) => {
    const pathname = new URL(path, 'http://station.invalid').pathname.replace(
      /\/+$/,
      '',
    );
    const method = String(rest[0] ?? (body ? 'POST' : 'GET')).toUpperCase();
    const nonBillable =
      (pathname === '/api/orchestration/commands' &&
        [
          'stopSession',
          'interruptTurn',
          'inspectSteerInput',
          'setApprovalMode',
          'discardDraft',
        ].includes(body?.type)) ||
      /^\/api\/orchestration\/sessions\/[^/]+\/outputs\/[^/]+\/inspect$/.test(
        pathname,
      );
    // Unknown POST routes reserve a turn too: extensions must not bypass the ceiling.
    const billable = !nonBillable;
    if (method === 'POST' && billable) {
      if (sentTurns >= Math.min(maxTurns, plan.plannedTurnCount))
        throw new Error('Hard turn ceiling reached; refusing another send');
      sentTurns++;
    }
    return api(path, body, ...rest);
  };
  /** @type {{scenario: string, status: string, failure: string | null, turns: object[]}[]} */
  const rows = [];
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    evidence: observeOutputs
      ? 'Station API with caller-supplied output observer; inspect per-turn checks'
      : 'Station API only; rendered UI NOT_VERIFIED',
    plan,
    rows,
    sentTurns: 0,
  };
  const command = (value) =>
    checkedApi('/api/orchestration/commands', value).then((body) => body.data);
  for (const model of models) {
    const conversationId = `station-matrix-${randomUUID()}`;
    let activeSessionId;
    const nonce = randomUUID();
    const base = { engine, connectionId, model, conversationId };
    let started = false;
    let completedEventIds = new Set();
    try {
      let priorFailed = false;
      for (const scenario of registered) {
        const row = {
          ...base,
          sessionId: activeSessionId ?? conversationId,
          scenario: scenario.id,
          status: 'unverified',
          turns: [],
          failure: null,
        };
        result.rows.push(row);
        if (priorFailed) {
          row.failure = 'Not run: prior scenario failed';
          continue;
        }
        const ctx = {
          get sessionId() {
            return activeSessionId ?? conversationId;
          },
          conversationId,
          nonce,
          model,
          switchModel: models.find((candidate) => candidate !== model),
          artifactName: `station-matrix-${randomUUID()}.txt`,
          artifactContent: `STATION_MATRIX_ARTIFACT:${randomUUID()}`,
          command,
          api: checkedApi,
          recall: (requested) =>
            ctx.send(
              'Reply with exactly the secret from the first message. Do not use tools.',
              requested,
              nonce,
            ),
          async send(
            input,
            requestedModel,
            expectedText,
            artifactName,
            artifactContent,
          ) {
            // Recheck isolation before every billable turn, including switches.
            const current = await api('/api/connections/agents');
            if (
              current.failures?.length ||
              current.data.filter((entry) => entry.enabled).length !== 1 ||
              !current.data.some(
                (entry) =>
                  entry.enabled &&
                  entry.id === connectionId &&
                  engineFor(entry) === engine,
              )
            )
              throw new Error('Connection isolation changed');
            const turn = { requestedModel, status: 'fail' };
            row.turns.push(turn);
            const priorEvents = activeSessionId
              ? (
                  await api(
                    `/api/orchestration/sessions/${activeSessionId}/events`,
                  )
                ).data
              : [];
            const pendingError = priorEvents.find(
              (event) =>
                event.method === 'runtime.error' &&
                !event.turnId &&
                !completedEventIds.has(event.eventId),
            );
            if (pendingError) throw new Error(pendingError.message);
            const first = !started;
            started = true;
            const ack = (
              await checkedApi(
                first
                  ? '/api/orchestration/chat'
                  : `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
                first
                  ? {
                      conversationId,
                      target: {
                        environment: { kind: 'current' },
                        agent: agent.slug,
                        expectedEngine: agent.execution?.agentConnectionId
                          ? { kind: 'connection', connectionId }
                          : { kind: 'station' },
                        workspace: { kind: 'directory', cwd },
                        model: { override: requestedModel },
                      },
                      message: input,
                      clientTurnId: randomUUID(),
                    }
                  : {
                      message: input,
                      model: { override: requestedModel },
                      clientTurnId: randomUUID(),
                    },
              )
            ).data;
            if (
              !ack?.providerTurnId ||
              !ack.sessionId ||
              ack.conversationId !== conversationId
            )
              throw new Error(
                'Foreground turn identity was not acknowledged; no automatic retry',
              );
            if (activeSessionId !== ack.sessionId)
              completedEventIds = new Set();
            activeSessionId = ack.sessionId;
            const sessionId = activeSessionId;
            row.sessionId = sessionId;
            turn.sessionId = sessionId;
            turn.turnId = ack.providerTurnId;
            const deadline = Date.now() + timeoutMs;
            completedEventIds = await waitForTurn(
              api,
              sessionId,
              ack.providerTurnId,
              deadline,
              completedEventIds,
            );
            const messages = (
              await api(`/api/orchestration/sessions/${sessionId}/messages`)
            ).data;
            const assistant = messages.filter(
              (message) =>
                message.role === 'assistant' &&
                message.metadata?.turnId === ack.providerTurnId,
            );
            const provenance = assistant.find(
              (message) =>
                message.metadata?.provenance?.sessionId === sessionId &&
                message.metadata?.provenance?.turnId === ack.providerTurnId,
            )?.metadata?.provenance;
            turn.reportedModel = observed(provenance?.reportedModel) ?? null;
            turn.servedEngine = observed(provenance?.engine)?.provider ?? null;
            // Connection identity is resolved from observed engine + isolated inventory, never request metadata.
            turn.servedBy =
              current.data.find(
                (entry) =>
                  engineFor(entry) === turn.servedEngine && entry.enabled,
              )?.id ?? null;
            const storedItems = await readStoredOutputs(
              api,
              sessionId,
              ack.providerTurnId,
              deadline,
            );
            const stored = storedItems.map((item) =>
              item.descriptor.kind === 'workspace-file'
                ? item.descriptor.relativePath
                : item.descriptor.ref,
            );
            turn.storedOutputs = stored;
            const contentCheck = await inspectArtifact(
              api,
              sessionId,
              ack.providerTurnId,
              storedItems,
              artifactName,
              artifactContent,
            );
            turn.comparisonModel = comparisonModel(
              engine,
              catalogById.get(requestedModel) ?? { id: requestedModel },
            );
            if (turn.comparisonModel === null)
              turn.modelResolutionReason = 'alias without resolution';
            const observation = await observeOutputs?.({
              sessionId,
              turnId: ack.providerTurnId,
            });
            turn.renderedOutputs =
              observation?.sessionId === sessionId &&
              observation?.turnId === ack.providerTurnId
                ? observation.names
                : null;
            const text = assistant
              .flatMap((message) => message.parts)
              .filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('')
              .trim();
            turn.checks = {
              response: text === expectedText ? 'pass' : 'fail',
              servedModel: checkServedModel(
                turn.comparisonModel,
                turn.reportedModel,
              ),
              servedConnection: checkServedConnection(
                connectionId,
                turn.servedEngine,
                current.data,
              ),
              outputs: checkOutputs(stored, turn.renderedOutputs),
              artifactContent: contentCheck,
              artifact:
                !artifactName ||
                (stored.length === 1 && stored[0] === artifactName)
                  ? 'pass'
                  : 'fail',
            };
            turn.status = aggregate(Object.values(turn.checks));
            if (turn.status === 'fail')
              throw new Error(
                `Turn checks failed: ${Object.entries(turn.checks)
                  .filter(([, status]) => status === 'fail')
                  .map(([name]) => name)
                  .join(', ')}`,
              );
            return turn;
          },
        };
        try {
          row.failure = (await scenario.run(ctx)) ?? null;
          const turnStatus = aggregate(row.turns.map((turn) => turn.status));
          row.status =
            turnStatus === 'fail'
              ? 'fail'
              : row.failure
                ? 'unverified'
                : turnStatus;
          if (row.status === 'fail') priorFailed = true;
          if (row.status === 'unverified' && !row.failure)
            row.failure = row.turns.length
              ? `Unverified checks: ${[
                  ...new Set(
                    row.turns.flatMap((turn) =>
                      Object.entries(turn.checks ?? {})
                        .filter(([, status]) => status === 'unverified')
                        .map(([name]) =>
                          name === 'servedModel' && turn.modelResolutionReason
                            ? `${name} (${turn.modelResolutionReason})`
                            : name,
                        ),
                    ),
                  ),
                ].join(', ')}`
              : 'Scenario produced no verified turns';
        } catch (error) {
          row.status = 'fail';
          row.failure = String(error.message ?? error).slice(0, 500);
          priorFailed = true;
        } finally {
          if (ctx.recycleEvidence) row.recycleEvidence = ctx.recycleEvidence;
        }
      }
    } catch (error) {
      for (const scenario of registered)
        result.rows.push({
          ...base,
          sessionId: activeSessionId ?? conversationId,
          scenario: scenario.id,
          status: 'fail',
          turns: [],
          failure: `Start failed: ${String(error.message ?? error).slice(0, 500)}`,
        });
    } finally {
      if (started) {
        try {
          await command({
            type: 'stopSession',
            threadId: activeSessionId ?? conversationId,
          });
        } catch {
          result.rows.push({
            ...base,
            sessionId: activeSessionId ?? conversationId,
            scenario: 'cleanup',
            status: 'fail',
            turns: [],
            failure: 'Cleanup not confirmed; session retained for recovery',
          });
        }
      }
    }
  }
  result.sentTurns = sentTurns;
  return result;
}

export function renderMatrix(result) {
  const cell = (value) =>
    String(value ?? 'unverified')
      .replaceAll('|', '\\|')
      .replaceAll('\n', ' ');
  return [
    `# Engine verification matrix — ${result.generatedAt.slice(0, 10)}`,
    '',
    `Generated: ${result.generatedAt}. Evidence: ${result.evidence}.`,
    'A missing model or rendered-output observation is unverified. This report does not alter the catalog.',
    '',
    '| Engine | Connection | Requested model | Scenario | Verdict | Engine-inferred connection | Served as | Failure |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...result.rows.map(
      (row) =>
        `| ${[row.engine, row.connectionId, row.model, row.scenario, row.status, row.turns.map((turn) => turn.servedBy ?? 'unverified').join(', '), row.turns.map((turn) => turn.reportedModel ?? 'unverified').join(', '), row.failure ?? ''].map(cell).join(' | ')} |`,
    ),
    '',
  ].join('\n');
}
