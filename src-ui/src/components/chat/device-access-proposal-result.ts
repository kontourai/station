import { stationToolOf } from '@kontourai/station-contracts/station-tool-phrases';

export function isDeviceAccessProposalCall(call: {
  server?: string;
  toolName?: string;
  name?: string;
  originalName?: string;
}): boolean {
  const name = call.toolName ?? call.name ?? call.originalName;
  const identity = stationToolOf(name, call.server);
  // Codex's bound dynamic calls have a bare name. The card still requires
  // a live proposal from the server before it can display a decision.
  if (!call.server && name === 'request_device_agent_access') return true;
  return (
    identity?.server === 'station-control' &&
    identity.tool === 'request_device_agent_access'
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    if (value.length > 4096) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function deviceAccessProposalId(value: unknown): string | undefined {
  const codex =
    Array.isArray(value) && value.length === 1 ? object(value[0]) : undefined;
  let body = object(codex?.type === 'inputText' ? codex.text : value);
  if (body?.isError === true) return undefined;
  if (Array.isArray(body?.content)) {
    if (body.content.length !== 1) return undefined;
    const block = object(body.content[0]);
    if (block?.type !== 'text') return undefined;
    body = object(block.text);
  }
  const proposal = object(body?.proposal);
  return body?.ok === true &&
    proposal?.state === 'pending' &&
    typeof proposal.id === 'string' &&
    /^[a-f0-9-]{36}$/i.test(proposal.id)
    ? proposal.id
    : undefined;
}
