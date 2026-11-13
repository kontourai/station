import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { AnthropicSealedPreparation } from '../../../../runtime/conversation/anthropic-sealed-preparation.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../../security/runtime-request-security.js';
import { createLogger } from '../../../../utils/logger.js';
import { AgentService } from '../../../agents/agent-service.js';
import { FileDelegationAttemptClaimStore } from '../../delegation-attempt-claim-store.js';
import { StationDelegationPersistence } from '../../delegation-group-persistence.js';
import { StationReportGroupCustody } from '../../station-report-group-custody.js';
import { StationReportGroupPreparation } from '../../station-report-group-preparation.js';
import { fixture } from './source.js';
import { controlledTextStream } from './streamed-text.js';
export const NOW = Date.parse('2026-11-13T20:31:00Z');
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
export async function setup(
  kind: 'local-grant' | 'ui-bootstrap' = 'local-grant',
  now = NOW,
  signal?: AbortSignal,
) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const f = await fixture(kind, undefined, signal);
  const delegationAttemptClaimStore = new FileDelegationAttemptClaimStore(
    f.home,
  );
  await f.loader.loadAppConfig();
  await f.storage.saveProviderConnection({
    id: 'anthropic-1',
    name: 'Controlled connection',
    type: 'anthropic',
    enabled: true,
    capabilities: ['llm'],
    config: {
      apiKey: 'synthetic-not-a-live-key',
      baseUrl: 'https://api.anthropic.com/v1',
    },
  });
  await f.loader.saveAgent('reviewer', {
    name: 'Reviewer',
    prompt: 'Configured report-only instructions',
    execution: {
      modelConnectionId: 'anthropic-1',
      modelId: 'claude-sonnet-4-6',
    },
  });
  const agentService = new AgentService(
    f.loader,
    f.storage,
    new Map(),
    new Map(),
    new Map(),
    createLogger({ name: 'report-group-fixture', level: 'error' }),
  );
  const rawFetch = vi.fn<typeof fetch>(async () =>
    controlledTextStream(
      'anthropic',
      'claude-sonnet-4-6',
      'Controlled report',
      {
        input_tokens: 4,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ),
  );
  const preparationOwners: ConstructorParameters<
    typeof StationReportGroupPreparation
  >[0] = {
    delegationAttemptClaimStore,
    runtime: {
      configLoader: f.loader,
      storageAdapter: f.storage,
      environmentSecurityService: f.environment,
      requestSecurity: f.environment,
      canonicalLocalGrantOrigin: f.environment.canonicalLocalGrantOrigin(),
      agentService,
      runtime: {
        getAgentConfigurationRevision: () => 2,
        commitAgentConfigurationRead: async (_revision, work) => work(),
      },
    },
    sources: f.owner,
    qualification: await AnthropicSealedPreparation.create(),
    rawFetch,
  };
  const owner = new StationReportGroupPreparation(preparationOwners);
  const reportRoot = join(f.home, 'report-groups');
  mkdirSync(reportRoot, { mode: 0o700, recursive: true });
  const persistence = new StationDelegationPersistence(reportRoot);
  const custodyOwners = {
    persistence,
    environment: f.environment,
    security: f.environment,
  };
  const custody = new StationReportGroupCustody(custodyOwners);
  const input = {
    operationId: 'prepare-1',
    projectSlug: 'source',
    resourceId: 'local:source',
    deadlineAt: now + 120000,
    maxConcurrent: 2,
    budget: {
      inputTokens: 2 * 1048576,
      outputTokens: 20,
      costMicros: 2 * 3145878,
    },
    members: [
      {
        seatId: 'left',
        agentId: 'reviewer',
        brief: 'Review correctness',
        maxOutputTokens: 10,
      },
      {
        seatId: 'right',
        agentId: 'reviewer',
        brief: 'Review failure paths',
        maxOutputTokens: 10,
      },
    ],
  };
  return {
    f,
    delegationAttemptClaimStore,
    owner,
    input,
    rawFetch,
    preparationOwners,
    custody,
    custodyOwners,
  };
}

export function requestFor(
  h: Awaited<ReturnType<typeof setup>>,
  method: 'GET' | 'POST' = 'GET',
  credential?: string,
) {
  const request = new Request(h.f.req.url, { method, signal: h.f.req.signal });
  const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
  if (!principal || principal.kind === 'internal')
    throw Error('controlled credential stamp missing');
  setRuntimeAuthenticatedRequestPrincipal(request, {
    ...principal,
    credential: credential ?? principal.credential,
  });
  bindRuntimeLocalOperator(request);
  return request;
}
export function newGrant(h: Awaited<ReturnType<typeof setup>>) {
  const offer = h.f.environment.devicePairing.createOffer({
    endpoint: new URL(h.f.req.url).origin,
  });
  const request = h.f.environment.devicePairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Current operator reader',
    requesterPosition: 'unproven',
  });
  h.f.environment.devicePairing.confirmRequest(request.requestId, {
    kind: 'presented-credential',
  });
  const exchanged = h.f.environment.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  return {
    credential: exchanged.credential,
    device: { id: exchanged.device.id },
  };
}

export function installControl(
  h: Awaited<ReturnType<typeof setup>>,
  environmentId = h.f.record.environmentId,
) {
  vi.stubEnv('STATION_API_BASE', 'http://report-control.test');
  vi.stubEnv('STATION_INTERNAL_API_TOKEN', 'synthetic-control-token');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === 'http://report-control.test/.well-known/station/v1')
        return new Response(JSON.stringify({ environmentId }));
      const agent =
        /^http:\/\/report-control\.test\/api\/agents\/([a-z0-9][a-z0-9-]*)$/.exec(
          url,
        )?.[1];
      if (agent)
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              slug: agent,
              ...(await h.f.loader.loadAgent(agent)),
            },
          }),
        );
      throw Error('Unexpected control-plane request');
    }),
  );
}
