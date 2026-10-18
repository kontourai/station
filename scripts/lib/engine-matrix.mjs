import { randomUUID } from 'node:crypto';

function modelVendor(model) {
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
  const region =
    /^(?:us|eu|apac|global|jp|au|us-gov)\.(?=[a-z][a-z0-9-]*[/.])/.exec(
      qualified,
    );
  const unwrapped = region ? qualified.slice(region[0].length) : qualified;
  // Known bare model names may contain dots; those are not vendor separators.
  const prefix = modelVendor(unwrapped)
    ? null
    : /^([a-z][a-z0-9-]*)[/.]/.exec(unwrapped);
  const model = prefix ? unwrapped.slice(prefix[0].length) : unwrapped;
  return { model, vendor: prefix?.[1], valid: !region || Boolean(prefix) };
}

function modelSnapshot(model) {
  const match =
    /^(.*?)[-@](20\d{2}-\d{2}-\d{2}|20\d{6})(?:-v(\d+(?::\d+)?))?$/.exec(model);
  return match
    ? { base: match[1], date: match[2].replaceAll('-', ''), version: match[3] }
    : { base: model };
}

export function checkServedModel(requested, reported) {
  if (!requested || !reported) return 'unverified';
  const a = modelIdentity(requested);
  const b = modelIdentity(reported);
  if (!a.valid || !b.valid) return 'fail';
  const familyVendor = modelVendor(a.model);
  const requestedVendor = familyVendor ?? a.vendor;
  if (
    (familyVendor && a.vendor && a.vendor !== familyVendor) ||
    (requestedVendor && b.vendor && b.vendor !== requestedVendor)
  )
    return 'fail';
  const left = modelSnapshot(a.model);
  const right = modelSnapshot(b.model);
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
    additionalScenarios.reduce(
      (sum, scenario) =>
        sum +
        (scenario.maxTurns ?? 1) *
          (scenario.scope === 'engine' ? 1 : models.length),
      0,
    );
  if (minimumPlannedTurns > maxTurns)
    throw new Error(
      `Planned ${minimumPlannedTurns} turns exceeds --max-turns=${maxTurns}; refusing the entire run. Select fewer models with --model=ID (repeatable). You may explicitly raise --max-turns up to 1000; this plan requires ${minimumPlannedTurns}.`,
    );
  const plan = {
    modelIds: models,
    builtInTurns,
    additionalScenarios: additionalScenarios.map((scenario) => ({
      id: scenario.id,
      scope: scenario.scope ?? 'model',
      maxTurns: scenario.maxTurns ?? null,
      instances: scenario.scope === 'engine' ? 1 : models.length,
      minimumPlannedTurns:
        (scenario.maxTurns ?? 1) *
        (scenario.scope === 'engine' ? 1 : models.length),
    })),
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

/**
 * @typedef {{declared: string, probe?: string, reason?: string, turnId?: string, checks?: string[]}} DeliveryEvidence
 * @typedef {{requestedModel?: string, reportedModel?: string|null, servedBy?: string|null,
 * servedEngine?: string|null, turnId?: string, status?: string,
 * checks?: Record<string,string>, storedOutputs?: string[], renderedOutputs?: string[]|null}} MatrixTurn
 * @typedef {{engine: string, connectionId: string, model: string, sessionId: string,
 * scenario: string, status: string, turns: MatrixTurn[], failure: string|null,
 * delivery?: Record<string,DeliveryEvidence>}} MatrixRow
 * @typedef {{version: number, generatedAt: string, evidence: string, plan: {modelIds: string[], builtInTurns: number, plannedTurnCount: number, maxTurns: number, extensionBudget: string, additionalScenarios: Array<{id: string, scope: string, maxTurns: number|null, instances: number, minimumPlannedTurns: number}>}, sentTurns?: number, rows: MatrixRow[]}} MatrixResult
 */

/**
 * @param {{api: Function, connectionId: string, cwd: string, timeoutMs?: number,
 * observeOutputs?: Function, additionalScenarios?: Array<{id: string, scope?: string, maxTurns?: number, prepare?: Function, run: Function}>,
 * modelIds?: string[], maxTurns?: number, onPlan?: Function}} options
 * @returns {Promise<MatrixResult>}
 */
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
  let sentTurns = 0;
  const checkedApi = async (path, body, ...rest) => {
    if (path === '/api/orchestration/commands' && body?.type === 'sendTurn') {
      if (sentTurns >= Math.min(maxTurns, plan.plannedTurnCount))
        throw new Error('Hard turn ceiling reached; refusing another send');
      sentTurns++;
    }
    return api(path, body, ...rest);
  };
  /** @type {MatrixResult} */
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    evidence: observeOutputs
      ? 'Station API with caller-supplied output observer; inspect per-turn checks'
      : 'Station API only; rendered UI NOT_VERIFIED',
    plan,
    rows: [],
  };
  const command = (value) =>
    checkedApi('/api/orchestration/commands', value).then((body) => body.data);
  const modelScenarios = registered.filter(
    (scenario) => scenario.scope !== 'engine',
  );
  const jobs = [
    ...models.map((model) => ({ model, selected: modelScenarios })),
    ...registered
      .filter((scenario) => scenario.scope === 'engine')
      .map((scenario) => ({
        model: models[0],
        selected: [scenario],
        lifecycle: scenario,
      })),
  ];
  for (const { model, selected, lifecycle } of jobs) {
    const sessionId = `station-matrix-${randomUUID()}`;
    const nonce = randomUUID();
    const base = { engine, connectionId, model, sessionId };
    let started = false;
    let completedEventIds;
    const cleanup = [];
    const delivery = {};
    const setup = {
      api: checkedApi,
      engine,
      connectionId,
      cwd,
      model,
      sessionId,
      delivery,
      deferCleanup: (label, run) => cleanup.push({ label, run }),
    };
    try {
      const prepared = await lifecycle?.prepare?.(setup);
      if (prepared?.skipReason) {
        result.rows.push({
          ...base,
          scenario: lifecycle.id,
          status: 'skipped',
          turns: [],
          failure: prepared.skipReason,
          delivery,
        });
        continue;
      }
      // A start may take effect even if its HTTP acknowledgement is lost.
      started = true;
      await command({
        type: 'startSession',
        input: {
          threadId: sessionId,
          provider: engine,
          modelId: model,
          cwd,
          metadata: { ...prepared?.metadata, connectionId },
        },
      });
      let priorFailed = false;
      for (const scenario of selected) {
        const row = {
          ...base,
          scenario: scenario.id,
          status: 'unverified',
          turns: [],
          failure: null,
          ...(lifecycle ? { delivery } : {}),
        };
        result.rows.push(row);
        if (priorFailed) {
          row.failure = 'Not run: prior scenario failed';
          continue;
        }
        const ctx = {
          ...setup,
          state: prepared?.state,
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
            evaluate,
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
            const priorEvents = (
              await api(`/api/orchestration/sessions/${sessionId}/events`)
            ).data;
            // Baseline once; later reads must retain the gap after the last terminal.
            completedEventIds ??= new Set(
              priorEvents.map((event) => event.eventId),
            );
            const pendingError = priorEvents.find(
              (event) =>
                event.method === 'runtime.error' &&
                !event.turnId &&
                !completedEventIds.has(event.eventId),
            );
            if (pendingError) throw new Error(pendingError.message);
            const ack = await command({
              type: 'sendTurn',
              input: {
                threadId: sessionId,
                modelId: requestedModel,
                input,
                clientTurnId: randomUUID(),
              },
            });
            if (!ack?.turnId)
              throw new Error('Turn was not acknowledged; no automatic retry');
            turn.turnId = ack.turnId;
            const deadline = Date.now() + timeoutMs;
            completedEventIds = await waitForTurn(
              api,
              sessionId,
              ack.turnId,
              deadline,
              completedEventIds,
            );
            const messages = (
              await api(`/api/orchestration/sessions/${sessionId}/messages`)
            ).data;
            const assistant = messages.filter(
              (message) =>
                message.role === 'assistant' && message.turnId === ack.turnId,
            );
            const provenance = assistant.find(
              (message) =>
                message.provenance?.sessionId === sessionId &&
                message.provenance?.turnId === ack.turnId,
            )?.provenance;
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
              ack.turnId,
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
              ack.turnId,
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
              turnId: ack.turnId,
            });
            turn.renderedOutputs =
              observation?.sessionId === sessionId &&
              observation?.turnId === ack.turnId
                ? observation.names
                : null;
            const text = assistant
              .flatMap((message) => message.parts)
              .filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('')
              .trim();
            turn.checks = {
              response:
                expectedText === null || text === expectedText
                  ? 'pass'
                  : 'fail',
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
            if (evaluate) {
              const events = (
                await api(`/api/orchestration/sessions/${sessionId}/events`)
              ).data.filter((event) => event.turnId === ack.turnId);
              const checks = await evaluate({
                text,
                storedOutputs: stored,
                events,
                turnId: ack.turnId,
                identityChecks: {
                  servedModel: turn.checks.servedModel,
                  servedConnection: turn.checks.servedConnection,
                },
              });
              if (
                !checks ||
                Object.keys(checks).length === 0 ||
                Object.values(checks).some(
                  (value) => !['pass', 'fail', 'unverified'].includes(value),
                )
              )
                throw new Error('Scenario returned invalid checks');
              for (const [name, value] of Object.entries(checks)) {
                if (name in turn.checks)
                  throw new Error(`Scenario cannot replace check ${name}`);
                turn.checks[name] = value;
              }
            }
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
      for (const scenario of selected)
        result.rows.push({
          ...base,
          scenario: scenario.id,
          status: 'fail',
          turns: [],
          failure: `Setup/start failed: ${String(error.message ?? error).slice(0, 500)}`,
          ...(lifecycle ? { delivery } : {}),
        });
    } finally {
      if (started) {
        try {
          await command({ type: 'stopSession', threadId: sessionId });
        } catch {
          result.rows.push({
            ...base,
            scenario: 'cleanup',
            status: 'fail',
            turns: [],
            failure: 'Cleanup not confirmed; session retained for recovery',
          });
        }
      }
      for (const obligation of cleanup.reverse()) {
        try {
          await obligation.run();
        } catch (error) {
          result.rows.push({
            ...base,
            scenario: 'cleanup',
            status: 'fail',
            turns: [],
            failure: `Cleanup not confirmed (${obligation.label}): ${String(error.message ?? error).slice(0, 500)}`,
          });
        }
      }
    }
  }
  result.sentTurns = sentTurns;
  return result;
}

function deliveryVerdict(row, evidence) {
  if (evidence.probe === 'unverified') return 'unverified';
  if (evidence.declared === 'unsupported') return 'unsupported';
  if (evidence.probe === 'fail') return 'fail';
  const turn = row.turns.find((entry) => entry.turnId === evidence.turnId);
  return evidence.probe === 'pass' &&
    turn &&
    evidence.checks?.length &&
    evidence.checks.every((name) => turn.checks?.[name] === 'pass')
    ? 'pass'
    : 'unverified';
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
    ...(result.rows.some((row) => row.delivery)
      ? [
          '| Engine | Delivery claim | Declared | Probe | Reason |',
          '| --- | --- | --- | --- | --- |',
          ...result.rows.flatMap((row) =>
            Object.entries(row.delivery ?? {}).map(
              ([claim, evidence]) =>
                `| ${[row.engine, claim, evidence.declared, deliveryVerdict(row, evidence), evidence.reason ?? ''].map(cell).join(' | ')} |`,
            ),
          ),
          '',
        ]
      : []),
  ].join('\n');
}
