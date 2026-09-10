// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

/**
 * station#1815 (review LOW-3). `/api/system/status`'s discovery refresh owns
 * an `AbortController` and threads it into every probe it makes except the
 * three CLI-presence ones, which it abandoned through `raceWithSignal` while
 * their `which` children kept running. The wiring is one argument per call
 * and exactly the kind of thing that regresses silently, so this file asserts
 * the binding rather than the mechanism: `detectCliOnPath`'s own handling of
 * a signal is proven in `src-server/utils/__tests__/cli-detection.test.ts`.
 *
 * NO ceiling is passed, deliberately, and that is asserted too — bounding how
 * long this cache waits and declaring a CLI absent are different decisions,
 * and only the first belongs to the refresh.
 */
const cliDetection = vi.hoisted(() => ({
  calls: [] as Array<[string, { signal?: AbortSignal; timeoutMs?: number }?]>,
}));
vi.mock('../../../utils/cli-detection.js', () => ({
  detectCliOnPath: (
    command: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => {
    cliDetection.calls.push([command, options]);
    return Promise.resolve(false);
  },
}));

const prerequisites = vi.hoisted(() => ({
  signals: [] as Array<AbortSignal | undefined>,
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  getAllPrerequisites: (options?: { signal?: AbortSignal }) => {
    prerequisites.signals.push(options?.signal);
    return Promise.resolve([]);
  },
  getProviderAdapters: () => [],
}));
vi.mock('../../../telemetry/metrics.js', () => ({
  onboardingRecommendations: { add: vi.fn() },
  systemOps: { add: vi.fn() },
  adapterReadiness: { add: vi.fn() },
}));
vi.mock('../../../providers/llm/bedrock.js', () => ({
  checkBedrockCredentials: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../services/agents/skill-service.js', () => ({
  SkillService: vi.fn(),
}));

const { createSystemStatusRoutes } = await import('../system-status-routes.js');

function deps() {
  return {
    getACPStatus: () => ({ connected: false, connections: [] }),
    listProviderConnections: () => [],
    checkOllamaAvailability: async () => false,
    getAppConfig: () => ({
      region: 'us-east-1',
      defaultModel: 'claude-3',
      runtime: 'voltagent',
    }),
    appConfig: { runtime: 'voltagent' },
    port: 3141,
    skillService: { listSkills: () => [] },
  } as never;
}

describe('/status CLI-presence probes (station#1815)', () => {
  test('carries the refresh controller into every probe, and no ceiling', async () => {
    const app = createSystemStatusRoutes(deps());
    // The refresh is fired by the request and reported through the body, so
    // the discovery having COMPLETED is the observable, not a delay.
    await vi.waitFor(
      async () => {
        const body: any = await json(await app.request('/status'));
        expect(body.prerequisitesState).toBe('ready');
      },
      { timeout: 3_000, interval: 5 },
    );

    expect(cliDetection.calls.map(([command]) => command)).toEqual([
      'kiro-cli',
      'codex',
      'claude',
    ]);
    // The refresh's OWN controller, not a detached one: the same instance
    // `getAllPrerequisites` beside it was given. That equality is what makes
    // this a binding to the refresh rather than to some signal.
    const refreshSignal = prerequisites.signals.at(0);
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    for (const [, options] of cliDetection.calls) {
      expect(options?.signal).toBe(refreshSignal);
      expect(options?.timeoutMs).toBeUndefined();
    }
  });
});
