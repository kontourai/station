#!/usr/bin/env node
// A generic engine stand-in driven by a per-engine profile
// (`acp-engine-profiles/<engine>.json`; field provenance is in that
// directory's README). The agent side is the real ACP SDK, so every frame on
// the wire is the SDK's own serialization of the profile's shapes.
//
//   fake-acp-agent.mjs --engine-profile <path> [--fail <mode>]
//     [--initialize-delay-ms <ms>] [--record <path>]
//
// Failure modes for onboarding tests:
//   exit-on-start             exit 3 before reading any frame
//   auth-required-on-session-new, auth-required-on-prompt
//                             answer that request with the SDK's
//                             auth_required error (-32000)
// `--record` appends one JSON line per request received and per permission
// outcome, so a test can see what reached the engine. The initialize line
// carries any announced `clientCapabilities._meta` (`clientMeta`) and
// `elicitation` (`clientElicitation`); a session/new line carries the
// request's `_meta` (`meta`).
//
// Scripted engine-to-client requests (the profile's, so a recorded engine's
// own order is kept). Each is recorded as `{ clientRequest, phase, result }`
// or `{ clientRequest, phase, error: { code, message } }`, and a `"$sessionId"`
// string in its params is replaced by the session's id:
//   initializeRequests   sent before the initialize answer, as an engine
//                        asking for its token does
//   sessionNewRequests   sent before the session/new answer (Kiro's
//                        `_kiro/terminal/shell_type`)
//   lateModelOptionMs    the session/new answer leaves out the `model`
//                        config option, which arrives that many ms later in
//                        a `config_option_update` (an engine whose model list
//                        loads after it answers)
//   --prompt-steps <path>  a JSON step list replacing the default turn. Extra
//                        step kinds: `client-request` {method, params},
//                        `user-message-id` (a Kiro `user_message_id_assigned`
//                        session_info_update, ids `msg-1`, `msg-2`, ...),
//                        `wait-ms` {ms}, `session-update` {update} (one
//                        `session/update` sent as given)
// Client-to-engine extension requests are answered from the profile's
// `extMethodAnswers` ({ "<method>": { result } | { error } }) and recorded as
// `{ extMethod, params }`; any other is refused -32601. `session/load`,
// `session/fork` and `session/delete` are answered and recorded too.
//
// Sign-in:
//   --record-env <NAME>          record NAME's value in this process's
//                                environment at start (what Station spawned it with)
//   --authenticate-stderr <text> write text to stderr while authenticating
//   --authenticate-delay-ms <ms> take that long to authenticate
//   --authenticate-fail          refuse authenticate with an internal error
import { appendFileSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk/unstable';

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fail = flag('fail');
if (fail === 'exit-on-start') {
  process.stderr.write('fake-acp-agent: exiting on start\n');
  process.exit(3);
}
const profilePath = flag('engine-profile');
if (!profilePath) {
  process.stderr.write('fake-acp-agent: --engine-profile is required\n');
  process.exit(2);
}
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const initializeDelayMs = Number(flag('initialize-delay-ms') ?? 0);
const recordPath = flag('record');
const record = (entry) => {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify(entry)}\n`);
};
const recordEnv = flag('record-env');
if (recordEnv)
  record({ env: recordEnv, value: process.env[recordEnv] ?? null });
const promptStepsPath = flag('prompt-steps');
const promptSteps = promptStepsPath
  ? JSON.parse(readFileSync(promptStepsPath, 'utf8'))
  : undefined;
const authenticateStderr = flag('authenticate-stderr');
const authenticateDelayMs = Number(flag('authenticate-delay-ms') ?? 0);

const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
];

/** Every turn: text, a plan, a permission-gated tool call, the profile's
 * vendor notifications, then closing text. */
function defaultSteps() {
  return [
    { kind: 'text', text: 'Working on it. ' },
    {
      kind: 'plan',
      entries: [
        {
          content: 'Run the probe command',
          priority: 'high',
          status: 'in_progress',
        },
        { content: 'Report the result', priority: 'medium', status: 'pending' },
      ],
    },
    {
      kind: 'tool',
      toolCall: {
        title: 'echo STATION_PROBE',
        kind: 'execute',
        rawInput: { command: 'echo STATION_PROBE' },
      },
      options: profile.permissionOptions ?? DEFAULT_PERMISSION_OPTIONS,
    },
    ...(profile.vendorNotifications ?? []).map((notification) => ({
      kind: 'notification',
      ...notification,
    })),
    { kind: 'text', text: 'STATION_SMOKE_OK' },
  ];
}

const state = {
  sessions: 0,
  toolCalls: 0,
  userMessages: 0,
  modes: new Map(),
  config: new Map(),
};

function sessionShape(sessionId) {
  const shape = structuredClone(profile.sessionNew ?? {});
  if (shape.modes && state.modes.has(sessionId))
    shape.modes.currentModeId = state.modes.get(sessionId);
  for (const option of shape.configOptions ?? []) {
    const value = state.config.get(`${sessionId}\0${option.id}`);
    if (value !== undefined) option.currentValue = value;
  }
  return shape;
}

function withSessionId(value, sessionId) {
  if (value === '$sessionId') return sessionId;
  if (Array.isArray(value))
    return value.map((item) => withSessionId(item, sessionId));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        withSessionId(item, sessionId),
      ]),
    );
  return value;
}

async function clientRequest(client, phase, request, sessionId) {
  try {
    const result = await client.request(
      request.method,
      withSessionId(request.params ?? {}, sessionId),
    );
    record({ clientRequest: request.method, phase, result });
  } catch (error) {
    record({
      clientRequest: request.method,
      phase,
      error: { code: error?.code, message: error?.message },
    });
  }
}

async function runStep(step, sessionId, client) {
  const update = (payload) =>
    client.notify(acp.methods.client.session.update, {
      sessionId,
      update: payload,
    });
  switch (step.kind) {
    case 'text':
      return update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: step.text },
      });
    case 'plan':
      return update({ sessionUpdate: 'plan', entries: step.entries });
    case 'notification':
      return client.notify(step.method, step.params ?? {});
    case 'client-request':
      return clientRequest(client, 'prompt', step, sessionId);
    case 'user-message-id':
      return update({
        sessionUpdate: 'session_info_update',
        _meta: {
          kiro: {
            userMessageId: `msg-${++state.userMessages}`,
            kind: 'user_message_id_assigned',
          },
        },
      });
    case 'wait-ms':
      return new Promise((resolve) => setTimeout(resolve, step.ms));
    case 'session-update':
      return update(step.update);
    case 'tool': {
      const toolCallId = `call_fake_${++state.toolCalls}`;
      await update({
        sessionUpdate: 'tool_call',
        toolCallId,
        status: 'pending',
        ...step.toolCall,
      });
      const response = await client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: { toolCallId, status: 'pending', ...step.toolCall },
          options: step.options,
        },
      );
      const optionId =
        response.outcome.outcome === 'selected'
          ? response.outcome.optionId
          : undefined;
      const chosen = step.options.find(
        (option) => option.optionId === optionId,
      );
      const allowed = chosen?.kind?.startsWith('allow') === true;
      record({ permission: response.outcome, allowed });
      return update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: allowed ? 'completed' : 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: allowed ? 'STATION_PROBE' : 'Permission denied',
            },
          },
        ],
      });
    }
    default:
      throw new Error(`Unknown profile step kind: ${step.kind}`);
  }
}

const authRequired = () =>
  acp.RequestError.authRequired(
    undefined,
    `Sign in to ${profile.initialize?.agentInfo?.title ?? profile.engine} first`,
  );

const app = acp
  .agent({ name: `fake-${profile.engine}` })
  .onRequest('initialize', async ({ params, client }) => {
    record({
      method: 'initialize',
      ...(params?.clientCapabilities?.auth
        ? { clientAuth: params.clientCapabilities.auth }
        : {}),
      ...(params?.clientCapabilities?._meta
        ? { clientMeta: params.clientCapabilities._meta }
        : {}),
      ...(params?.clientCapabilities?.elicitation
        ? { clientElicitation: params.clientCapabilities.elicitation }
        : {}),
    });
    for (const request of profile.initializeRequests ?? [])
      await clientRequest(client, 'initialize', request, undefined);
    if (initializeDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, initializeDelayMs));
    return profile.initialize;
  })
  // set_mode and set_config_option are not driven by the qualification
  // test yet; they are kept for the mode/model lanes.
  .onRequest('authenticate', async ({ params }) => {
    record({ method: 'authenticate', methodId: params.methodId });
    if (authenticateStderr) process.stderr.write(`${authenticateStderr}\n`);
    if (authenticateDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, authenticateDelayMs));
    if (process.argv.includes('--authenticate-fail'))
      throw acp.RequestError.internalError(undefined, 'Pairing was declined');
    return {};
  })
  .onRequest('session/new', async ({ params, client }) => {
    record({
      method: 'session/new',
      ...(params?._meta ? { meta: params._meta } : {}),
    });
    if (fail === 'auth-required-on-session-new') throw authRequired();
    const sessionId = `fake-${profile.engine}-${process.pid}-${++state.sessions}`;
    for (const request of profile.sessionNewRequests ?? [])
      await clientRequest(client, 'session/new', request, sessionId);
    const modeId = params?._meta?.kiro?.modeId;
    const shape = sessionShape(sessionId);
    // Kiro's agent service registers `_meta.kiro.customAgents` as modes of
    // client origin and starts in `_meta.kiro.modeId`.
    for (const agent of params?._meta?.kiro?.customAgents ?? []) {
      shape.modes?.availableModes?.push({
        id: agent.id,
        name: agent.id,
        description: agent.description,
        _meta: {
          kiro: {
            source: 'bundled',
            resource: { resourceType: 'agent', source: { origin: 'client' } },
          },
        },
      });
    }
    const modeOption = shape.configOptions?.find(
      (option) => option.category === 'mode',
    );
    for (const agent of params?._meta?.kiro?.customAgents ?? [])
      modeOption?.options?.push({
        value: agent.id,
        name: agent.id,
        description: agent.description,
      });
    if (typeof modeId === 'string') {
      if (shape.modes) shape.modes.currentModeId = modeId;
      if (modeOption) modeOption.currentValue = modeId;
    }
    if (typeof profile.lateModelOptionMs === 'number') {
      const full = structuredClone(shape.configOptions ?? []);
      setTimeout(() => {
        client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: full,
          },
        });
      }, profile.lateModelOptionMs);
      shape.configOptions = (shape.configOptions ?? []).filter(
        (option) => option.category !== 'model',
      );
    }
    return { sessionId, ...shape };
  })
  .onRequest('session/load', ({ params }) => {
    record({
      method: 'session/load',
      sessionId: params.sessionId,
      ...(params?._meta ? { meta: params._meta } : {}),
    });
    return sessionShape(params.sessionId);
  })
  .onRequest('session/fork', ({ params }) => {
    record({
      method: 'session/fork',
      sessionId: params.sessionId,
      ...(params?._meta ? { meta: params._meta } : {}),
    });
    return { sessionId: `${params.sessionId}-fork` };
  })
  .onRequest('session/delete', ({ params }) => {
    record({ method: 'session/delete', sessionId: params.sessionId });
    return {};
  })
  .onRequest('session/set_mode', ({ params }) => {
    record({ method: 'session/set_mode', modeId: params.modeId });
    state.modes.set(params.sessionId, params.modeId);
    return {};
  })
  .onRequest('session/set_config_option', ({ params }) => {
    record({ method: 'session/set_config_option', configId: params.configId });
    state.config.set(`${params.sessionId}\0${params.configId}`, params.value);
    return {
      configOptions: sessionShape(params.sessionId).configOptions ?? [],
    };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    record({ method: 'session/prompt', prompt: params.prompt });
    if (fail === 'auth-required-on-prompt') throw authRequired();
    for (const step of promptSteps ?? defaultSteps())
      await runStep(step, params.sessionId, client);
    return { stopReason: 'end_turn' };
  })
  .onRequest('*', ({ method, params }) => {
    record({ extMethod: method, params });
    const answer = profile.extMethodAnswers?.[method];
    if (!answer) throw acp.RequestError.methodNotFound(method);
    if (answer.error)
      throw new acp.RequestError(
        answer.error.code,
        answer.error.message,
        answer.error.data,
      );
    return answer.result;
  });

app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);
process.stdin.on('end', () => process.exit(0));
