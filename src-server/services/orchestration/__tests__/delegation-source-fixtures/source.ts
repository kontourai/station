import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { trackTempDirs } from '../../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../../domain/file-storage-adapter.js';
import {
  type ObservedSdkProviderCredential,
  readObservedSdkProviderCredential,
} from '../../../../runtime/conversation/provider-credential-observation.js';
import { RuntimeFencedCredentialObservationOwner } from '../../../../runtime/conversation/runtime-fenced-credential-observation.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../../security/runtime-request-security.js';
import { execGit } from '../../../../utils/git-exec.js';
import { createLogger } from '../../../../utils/logger.js';
import { AgentService } from '../../../agents/agent-service.js';
import { EnvironmentSecurityService } from '../../../ssh/environment-security-service.js';
import {
  LocalSourceAdmissionOwner,
  SourceRefusal,
} from '../../delegation-group-source-admission.js';

const makeTempDir = trackTempDirs();
export const subject = {
  groupId: 'group-actual-owner-test',
  workItemId: 'child-1',
};
export const selection = { projectSlug: 'source', resourceId: 'local:source' };
export async function fixture(
  kind: 'local-grant' | 'ui-bootstrap' = 'local-grant',
  scope?: string,
  signal?: AbortSignal,
) {
  const root = realpathSync(makeTempDir('station-delegation-source-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const store = join(root, 'private-receipts');
  for (const path of [home, repo, store]) mkdirSync(path, { mode: 0o700 });
  const git = async (...args: string[]) => {
    const startedAt = performance.now();
    try {
      return (
        await execGit(args, {
          cwd: repo,
          timeout: 5000,
          maxBuffer: 128 * 1024,
          windowsHide: true,
          assertCurrent: () => signal?.throwIfAborted(),
        })
      ).stdout;
    } catch (error) {
      if (error instanceof Error) {
        const elapsedMs = Math.round(performance.now() - startedAt);
        error.message = `Fixture git ${args[0]} failed after ${elapsedMs}ms (killed=${Reflect.get(error, 'killed') === true}, signal=${Reflect.get(error, 'signal') ?? 'none'}, code=${Reflect.get(error, 'code') ?? 'none'}, requestAborted=${signal?.aborted ?? false}): ${error.message}`;
      }
      throw error;
    }
  };
  await git('init', '-q');
  await git('config', 'user.name', 'Owned temporary fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'source.txt'), 'original source\n');
  await git('add', '--', 'source.txt');
  await git('commit', '-qm', 'fixture');
  const loader = new ConfigLoader({
    projectHomeDir: home,
    enforceHomeSchema: true,
  });
  await loader.ensureHomeSchema();
  const environment = new EnvironmentSecurityService({ homeDir: home });
  const record = await environment.initialize();
  const offer = environment.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1:43979',
    ...(scope ? { scope } : {}),
  });
  const pairing = environment.devicePairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'owned-source-fixture',
    requesterPosition: 'unproven',
  });
  environment.devicePairing.confirmRequest(pairing.requestId, {
    kind: 'presented-credential',
  });
  // Fixture server stamps exercise existing owners, not actual local-grant ingress/mint consent.
  const paired: ReturnType<
    EnvironmentSecurityService['devicePairing']['exchange']
  > = environment.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: pairing.requestId,
    locality: 'home-possession',
    mintKind: kind,
  });
  function request(path = '/api/orchestration/chat', init?: RequestInit) {
    const req = new Request(`http://127.0.0.1:43979${path}`, {
      ...init,
      signal: signal
        ? init?.signal
          ? AbortSignal.any([signal, init.signal])
          : signal
        : init?.signal,
      method: 'POST',
    });
    setRuntimeAuthenticatedRequestPrincipal(req, {
      kind: 'credential',
      authority: 'device-credential',
      credential: paired.credential,
      source: 'bearer',
      locality: 'home-possession',
      mintKind: kind,
    });
    bindRuntimeLocalOperator(req);
    return req;
  }
  const storage = new FileStorageAdapter(home);
  await storage.createProject({
    id: 'persistent-local-project',
    name: 'Source',
    slug: 'source',
    workingDirectory: repo,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  });
  const manifestPath = join(home, 'projects/source/manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      id: 'prj_persistent',
      repos: [{ kind: 'local-only', id: 'local:source' }],
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    }),
  );
  const owner = new LocalSourceAdmissionOwner(home, environment, store);
  const req = request();
  const context = (raw = req) => ({
    env: undefined,
    req: { raw, header: (name: string) => raw.headers.get(name) ?? undefined },
  });
  return {
    root,
    home,
    repo,
    store,
    git,
    environment,
    record,
    paired: { credential: paired.credential, device: { id: paired.device.id } },
    request,
    storage,
    loader,
    manifestPath,
    owner,
    req,
    context,
  };
}
export function code(expected: string) {
  return (error: unknown) =>
    error instanceof SourceRefusal && error.code === expected;
}

export async function sdkCredentialFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  provider: 'anthropic' | 'google',
): Promise<{
  credential: ObservedSdkProviderCredential;
  observed: ReturnType<typeof readObservedSdkProviderCredential>;
  owner: RuntimeFencedCredentialObservationOwner;
  selection: Awaited<
    ReturnType<
      RuntimeFencedCredentialObservationOwner['captureAgentSdkCredential']
    >
  >;
}> {
  await f.storage.saveProviderConnection({
    id: 'connection-1',
    name: 'Synthetic SDK fixture',
    type: provider,
    enabled: true,
    capabilities: ['llm'],
    config: {
      apiKey: ['synthetic', 'not', 'credential'].join('-'),
      baseUrl:
        provider === 'anthropic'
          ? 'https://api.anthropic.com/v1'
          : 'https://generativelanguage.googleapis.com/v1beta',
    },
  });
  await f.loader.loadAppConfig();
  await f.loader.saveAgent('worker', {
    name: 'SDK report worker',
    prompt: 'Use the configured report-only instructions',
    execution: {
      modelConnectionId: 'connection-1',
      modelId: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'fixture-model',
    },
  });
  const agentService = new AgentService(
    f.loader,
    f.storage,
    new Map(),
    new Map(),
    new Map(),
    createLogger({ name: 'sdk-credential-fixture', level: 'error' }),
  );
  const owner = new RuntimeFencedCredentialObservationOwner({
    configLoader: f.loader,
    storageAdapter: f.storage,
    environmentSecurityService: f.environment,
    requestSecurity: f.environment,
    agentService,
    // Controlled read scheduling; the separate owner tests exercise StationRuntime's real queue.
    runtime: {
      getAgentConfigurationRevision: () => 2,
      commitAgentConfigurationRead: async (_expected, callback) => callback(),
    },
  });
  const selection = await owner.captureAgentSdkCredential(f.req, 'worker');
  const credential = selection.credential;
  const observed = readObservedSdkProviderCredential(credential, provider);
  return { credential, observed, selection, owner };
}
