import { randomUUID } from 'node:crypto';

const vendorPrefix = /^(?:anthropic|openai|google|meta|mistral|amazon)[/.]/;
// A snapshot qualifier is allowed; semantic model versions and tiers are not.
function withoutSnapshot(model) {
  return model.replace(
    /(?:-(?:20\d{2}-\d{2}-\d{2}|20\d{6})(?:-v\d+(?::\d+)?)?)$/,
    '',
  );
}

export function checkServedModel(requested, reported) {
  if (!reported) return 'unverified';
  const a = requested.replace(vendorPrefix, '');
  const b = reported.replace(vendorPrefix, '');
  return a === b || a === withoutSnapshot(b) || b === withoutSnapshot(a)
    ? 'pass'
    : 'fail';
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
        `Create ${ctx.artifactName} containing exactly STATION_MATRIX_ARTIFACT then call Station's declare_output tool with {"file":{"path":"${ctx.artifactName}"}} so it is declared as a session output. Reply with exactly STATION_SMOKE_OK.`,
        ctx.model,
        'STATION_SMOKE_OK',
        ctx.artifactName,
      );
    },
  },
  {
    id: 'recycle',
    async run(ctx) {
      await ctx.command({ type: 'stopSession', threadId: ctx.sessionId });
      await ctx.recall(ctx.model);
    },
  },
];

async function waitForTurn(api, sessionId, turnId, deadline) {
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
      (event) => event.turnId === turnId && event.method === 'runtime.error',
    );
    if (error) throw new Error(error.message);
    if (
      events.some(
        (event) => event.turnId === turnId && event.method === 'turn.completed',
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (Date.now() >= deadline)
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
    stored.push(
      ...page.items
        .filter((item) => item.turnId === turnId)
        .map((item) =>
          item.descriptor.kind === 'workspace-file'
            ? item.descriptor.relativePath
            : item.descriptor.ref,
        ),
    );
    cursor = page.cursor;
    if (cursor && seenCursors.has(cursor))
      throw new Error('Output cursor did not advance');
    seenCursors.add(cursor);
  } while (cursor);
  return stored;
}

/** Additional scenarios use the same send/recall verdict path; #3824 can register here. */
export async function runMatrix({
  api,
  connectionId,
  cwd,
  timeoutMs = 60_000,
  observeOutputs,
  additionalScenarios = [],
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
  const models = [...new Set(catalog.map((model) => model.id))];
  if (
    !models.length ||
    models.some((model) => typeof model !== 'string' || !model)
  )
    throw new Error('No usable advertised models');
  const registered = [...scenarios, ...additionalScenarios];
  if (
    new Set(registered.map((scenario) => scenario.id)).size !==
    registered.length
  )
    throw new Error('Duplicate scenario id');
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    evidence: observeOutputs
      ? 'Station API with caller-supplied output observer; inspect per-turn checks'
      : 'Station API only; rendered UI NOT_VERIFIED',
    rows: [],
  };
  const command = (value) =>
    api('/api/orchestration/commands', value).then((body) => body.data);
  for (const model of models) {
    const sessionId = `station-matrix-${randomUUID()}`;
    const nonce = randomUUID();
    const base = { engine, connectionId, model, sessionId };
    let started = false;
    try {
      // A start may take effect even if its HTTP acknowledgement is lost.
      started = true;
      await command({
        type: 'startSession',
        input: {
          threadId: sessionId,
          provider: engine,
          modelId: model,
          cwd,
          metadata: { connectionId },
        },
      });
      let priorFailed = false;
      for (const scenario of registered) {
        const row = {
          ...base,
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
          sessionId,
          nonce,
          model,
          switchModel: models.find((candidate) => candidate !== model),
          artifactName: `station-matrix-${randomUUID()}.txt`,
          command,
          api,
          recall: (requested) =>
            ctx.send(
              'Reply with exactly the secret from the first message. Do not use tools.',
              requested,
              nonce,
            ),
          async send(input, requestedModel, expectedText, artifactName) {
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
            await waitForTurn(api, sessionId, ack.turnId, deadline);
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
            const stored = await readStoredOutputs(
              api,
              sessionId,
              ack.turnId,
              deadline,
            );
            turn.storedOutputs = stored;
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
              response: text === expectedText ? 'pass' : 'fail',
              servedModel: checkServedModel(requestedModel, turn.reportedModel),
              servedConnection: checkServedConnection(
                connectionId,
                turn.servedEngine,
                current.data,
              ),
              outputs: checkOutputs(stored, turn.renderedOutputs),
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
                        .map(([name]) => name),
                    ),
                  ),
                ].join(', ')}`
              : 'Scenario produced no verified turns';
        } catch (error) {
          row.status = 'fail';
          row.failure = String(error.message ?? error).slice(0, 500);
          priorFailed = true;
        }
      }
    } catch (error) {
      for (const scenario of registered)
        result.rows.push({
          ...base,
          scenario: scenario.id,
          status: 'fail',
          turns: [],
          failure: `Start failed: ${String(error.message ?? error).slice(0, 500)}`,
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
    }
  }
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
    '| Engine | Connection | Requested model | Scenario | Verdict | Served by | Served as | Failure |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...result.rows.map(
      (row) =>
        `| ${[row.engine, row.connectionId, row.model, row.scenario, row.status, row.turns.map((turn) => turn.servedBy ?? 'unverified').join(', '), row.turns.map((turn) => turn.reportedModel ?? 'unverified').join(', '), row.failure ?? ''].map(cell).join(' | ')} |`,
    ),
    '',
  ].join('\n');
}
