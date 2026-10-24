import { expect, test, vi } from 'vitest';
import { withEngineMcpAccountOwner } from '../../../services/plugins/engine-mcp-oauth.js';
import { StationRuntime } from '../station-runtime.js';

test('the runtime OAuth launch wiring uses recorded acting authority, Project binding and no personal account for hosted sessions', async () => {
  // Exercise the runtime method wired into both engine adapters without starting a host.
  const runtime = Object.create(StationRuntime.prototype);
  const resolve = vi.fn(async () => new Map());
  const recordedOwner = vi.fn((): string | undefined => undefined);
  Object.assign(runtime, {
    configLoader: {
      loadAgent: vi.fn(async () => ({ project: 'agent-project' })),
    },
    orchestrationService: {
      sessionRecordedOwnerId: recordedOwner,
      resolveSessionActingPrincipal: () => ({ id: 'human:local:recorded' }),
    },
    engineMcpOAuth: resolve,
  });
  const input = {
    threadId: 'session',
    agent: {
      slug: 'agent',
      toolServers: [
        {
          id: 't3',
          transport: 'streamable-http',
          endpoint: 'https://example.test/mcp',
        },
      ],
    },
  };
  await withEngineMcpAccountOwner('human:local:dispatch', () =>
    runtime.resolveExternalMcpOAuth(input),
  );
  expect(resolve).toHaveBeenLastCalledWith(
    input.agent.toolServers,
    'human:local:dispatch',
    'agent-project',
    'session',
  );
  recordedOwner.mockReturnValue('recorded');
  await withEngineMcpAccountOwner('human:local:wrong', () =>
    runtime.resolveExternalMcpOAuth({
      ...input,
      metadata: { projectSlug: 'dispatch-project' },
    }),
  );
  expect(resolve).toHaveBeenLastCalledWith(
    input.agent.toolServers,
    'human:local:recorded',
    'dispatch-project',
    'session',
  );
  await runtime.resolveExternalMcpOAuth({
    ...input,
    tenantExecutionContext: { tenantId: 'hosted' },
  });
  expect(resolve).toHaveBeenLastCalledWith(
    input.agent.toolServers,
    undefined,
    'agent-project',
    'session',
  );
});
