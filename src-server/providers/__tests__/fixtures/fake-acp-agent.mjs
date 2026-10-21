#!/usr/bin/env node
// A generic engine stand-in driven by a per-engine profile
// (`acp-engine-profiles/<engine>.json`; field provenance is in that
// directory's README). The agent side is the real ACP SDK, so every frame on
// the wire is the SDK's own serialization of the profile's shapes.
//
//   fake-acp-agent.mjs --profile <path> [--fail <mode>]
//     [--initialize-delay-ms <ms>] [--record <path>]
//
// Failure modes for onboarding tests:
//   exit-on-start             exit 3 before reading any frame
//   auth-required-on-session-new, auth-required-on-prompt
//                             answer that request with the SDK's
//                             auth_required error (-32000)
// `--record` appends one JSON line per request received and per permission
// outcome, so a test can see what reached the engine.
import { appendFileSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fail = flag('fail');
if (fail === 'exit-on-start') {
  process.stderr.write('fake-acp-agent: exiting on start\n');
  process.exit(3);
}
const profilePath = flag('profile');
if (!profilePath) {
  process.stderr.write('fake-acp-agent: --profile is required\n');
  process.exit(2);
}
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const initializeDelayMs = Number(flag('initialize-delay-ms') ?? 0);
const recordPath = flag('record');
const record = (entry) => {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify(entry)}\n`);
};

const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
];

/** The default turn: text, a plan, a permission-gated tool call, the
 * profile's vendor notifications, then closing text. */
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
  .onRequest('initialize', async () => {
    record({ method: 'initialize' });
    if (initializeDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, initializeDelayMs));
    return profile.initialize;
  })
  .onRequest('authenticate', ({ params }) => {
    record({ method: 'authenticate', methodId: params.methodId });
    return {};
  })
  .onRequest('session/new', () => {
    record({ method: 'session/new' });
    if (fail === 'auth-required-on-session-new') throw authRequired();
    const sessionId = `fake-${profile.engine}-${process.pid}-${++state.sessions}`;
    return { sessionId, ...sessionShape(sessionId) };
  })
  .onRequest('session/load', ({ params }) => {
    record({ method: 'session/load' });
    if (profile.initialize?.agentCapabilities?.loadSession !== true)
      throw acp.RequestError.methodNotFound('session/load');
    return sessionShape(params.sessionId);
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
    record({ method: 'session/prompt' });
    if (fail === 'auth-required-on-prompt') throw authRequired();
    for (const step of profile.prompt?.steps ?? defaultSteps())
      await runStep(step, params.sessionId, client);
    return { stopReason: 'end_turn' };
  })
  .onNotification('session/cancel', () => {
    record({ method: 'session/cancel' });
  });

app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);
process.stdin.on('end', () => process.exit(0));
