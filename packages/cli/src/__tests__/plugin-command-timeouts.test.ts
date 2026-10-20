import {
  setClientCredentialResolver,
  setClientRequestTimeout,
} from '@kontourai/station-sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeCliError } from '../cli.js';
import type { ParsedCoreArgs } from '../commands/core-api.js';
import {
  install,
  installRegistryPlugin,
  list,
  preview,
  update,
} from '../commands/install.js';

/**
 * #369: the plugin commands caught every transport failure, a deadline miss
 * included, and rethrew "Station at … is not reachable". The rethrown error
 * hid the timeout from `explainRequestFailure`, so a Station that answered the
 * connection and was still working was reported as down, and a write that may
 * already have landed invited a blind retry.
 *
 * These run each command the way the CLI does: the real SDK
 * `authenticatedFetch`/`listPlugins`, a real `AbortSignal.timeout` deadline
 * against a `fetch` that never answers, and the top-level `describeCliError`
 * that turns the thrown error into the printed line.
 */

const API_BASE = 'http://127.0.0.1:3141';
const DEADLINE_MS = 20;
const GIT_SOURCE = 'https://example.invalid/demo-plugin.git';

const parsed: ParsedCoreArgs = {
  flags: { 'api-base': API_BASE, yes: true },
  positionals: [],
  repeatedFlags: {},
};

const WHERE = `${API_BASE} (from --api-base)`;
const READ_TIMEOUT = `Station at ${WHERE} did not respond within 0s.`;
const WRITE_TIMEOUT = `Gave up waiting for Station at ${WHERE} after 0s. The request was a write and may still have been applied`;

const PREVIEW = {
  valid: true,
  manifest: { name: 'demo', version: '1.0.0' },
  components: [],
  conflicts: [],
  contentDigest: 'sha256:reviewed',
  registryTrustRevision: `sha256:${'d'.repeat(64)}`,
  grantRevision: 'parent-reviewed-revision',
  permissions: { required: [], autoGranted: [], pendingConsent: [] },
};

/**
 * A Station that accepted the connection and never answered, except for the
 * paths in `answers`, which it answers at once.
 */
function stationThatHangs(answers: Record<string, unknown> = {}) {
  return vi.fn((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname in answers) {
      return Promise.resolve(Response.json(answers[url.pathname]));
    }
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? (input as Request | undefined)?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  });
}

async function printedFailure(command: () => Promise<unknown>) {
  const error = await command().then(
    () => {
      throw new Error('expected the command to fail');
    },
    (caught: unknown) => caught,
  );
  return describeCliError(error);
}

describe('plugin commands report a deadline miss as a timeout (#369)', () => {
  beforeEach(() => {
    vi.stubEnv('STATION_API_CREDENTIAL', '');
    setClientRequestTimeout(DEADLINE_MS);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    setClientRequestTimeout(undefined);
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('plugins list: a slow Station did not respond, it was not unreachable', async () => {
    vi.stubGlobal('fetch', stationThatHangs());
    const printed = await printedFailure(() => list(parsed));
    expect(printed).toContain(READ_TIMEOUT);
    expect(printed).not.toContain('not reachable');
  });

  it('plugins preview: a read-only POST reports the read-style timeout', async () => {
    vi.stubGlobal('fetch', stationThatHangs());
    const printed = await printedFailure(() => preview(GIT_SOURCE, parsed));
    expect(printed).toContain(READ_TIMEOUT);
    expect(printed).not.toContain('not reachable');
  });

  it('plugins install: a timed-out install may have been applied', async () => {
    const fetch = stationThatHangs({ '/api/plugins/preview': PREVIEW });
    vi.stubGlobal('fetch', fetch);
    const printed = await printedFailure(() =>
      install(GIT_SOURCE, [], parsed, null),
    );
    // The preview answered; the deadline expired on the install itself.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(printed).toContain(WRITE_TIMEOUT);
    expect(printed).not.toContain('not reachable');
  });

  it('plugins update: a timed-out update may have been applied', async () => {
    vi.stubGlobal('fetch', stationThatHangs());
    const printed = await printedFailure(() => update('demo', parsed));
    expect(printed).toContain(WRITE_TIMEOUT);
    expect(printed).not.toContain('not reachable');
  });

  it('plugins registry install: a timed-out install may have been applied', async () => {
    vi.stubGlobal('fetch', stationThatHangs());
    const printed = await printedFailure(() =>
      installRegistryPlugin('demo', parsed),
    );
    expect(printed).toContain(WRITE_TIMEOUT);
    expect(printed).not.toContain('not reachable');
  });

  it('still reports a refused connection as unreachable, not as a timeout', async () => {
    const refused = new TypeError('fetch failed');
    (refused as { cause?: unknown }).cause = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:3141'),
      { code: 'ECONNREFUSED' },
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused));
    for (const command of [
      () => list(parsed),
      () => update('demo', parsed),
      () => installRegistryPlugin('demo', parsed),
    ]) {
      const printed = await printedFailure(command);
      expect(printed).toContain(`Can't reach Station at ${WHERE}`);
      expect(printed).not.toContain('did not respond');
      expect(printed).not.toContain('may still have been applied');
    }
  });
});
