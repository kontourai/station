import {
  agentId,
  type ClientRequestOptions,
  delegateTask,
  type ExecutionTarget,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
} from '@kontourai/station-sdk/agent';

const [apiBase, agent, projectSlug, prompt] = process.argv.slice(2);
if (!apiBase || !agent || !projectSlug || !prompt) {
  throw new Error(
    'Usage: headless-agent <Station URL> <Agent ID> <Project slug> <prompt>',
  );
}
const credential = process.env.STATION_AGENT_TOKEN;
if (!credential)
  throw new Error(
    'Set STATION_AGENT_TOKEN to an authorized Station bearer credential.',
  );

const options: ClientRequestOptions = {
  credential,
  credentialOrigin: new URL(apiBase).origin,
  requireCredential: true,
  timeoutMs: 30_000,
};
const target: ExecutionTarget = {
  environment: { kind: 'current' },
  agent: agentId(agent),
  workspace: { kind: 'project', projectSlug },
};

// A create receipt means accepted work, not a completed turn or verified result.
const handle = await delegateTask(apiBase, { target, prompt }, options);
console.log(JSON.stringify(handle, null, 2));
const reference = { environmentId: handle.environment.id };
const snapshot = await observeDelegatedTask(
  apiBase,
  handle.conversationId,
  reference,
  options,
);
const page = await observeDelegatedTaskEvents(
  apiBase,
  handle.conversationId,
  {
    ...reference,
    limit: 20,
  },
  options,
);
console.log(
  JSON.stringify(
    { snapshot, events: page.events, nextCursor: page.nextCursor },
    null,
    2,
  ),
);
