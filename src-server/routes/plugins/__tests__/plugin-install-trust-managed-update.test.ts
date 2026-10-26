/**
 * #2998: the managed (journal-selected) update path of
 * `POST /api/plugins/:name/update` answers install trust refusals with the
 * same status and code as the direct install route, not its generic 409.
 *
 * The installation journal's selection and the install transaction are
 * replaced so each case reaches the route's own catch with exactly the
 * error the transaction throws; the route composition is real.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PluginInstallTrustRefused } from '../../../services/plugins/plugin-install-trust-recording.js';
import {
  PluginTrustRecordNewerError,
  PluginTrustRecordsUnavailableError,
} from '../../../services/plugins/plugin-install-trust-store.js';
import { PluginVisibilityService } from '../../../services/plugins/plugin-visibility-service.js';
import type { Logger } from '../../../utils/logger.js';
import { createPluginRoutes } from '../plugins.js';
import { TEST_OPERATOR_PRINCIPAL } from './plugin-visibility-test-support.js';

const installPluginFromSource = vi.hoisted(() => vi.fn());
vi.mock(
  '../../../services/plugins/plugin-install-transaction.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../services/plugins/plugin-install-transaction.js')
    >()),
    installPluginFromSource,
  }),
);
// The managed selection the journal would return for `demo`.
const selection = vi.hoisted(() => ({ packageRoot: '' }));
vi.mock(
  '../../../services/plugins/plugin-installation-local.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../services/plugins/plugin-installation-local.js')
    >()),
    captureLocalPluginInstallation: () => ({
      root: { kind: 'incarnation', packageRoot: selection.packageRoot },
      installation: {
        journalId: 'journal',
        pluginId: 'demo',
        incarnation: 'generation-1',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        materialization: 'materialization',
        dataScope: 'data-scope',
      },
    }),
  }),
);
vi.mock('../../../utils/git-exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/git-exec.js')>()),
  execGit: vi.fn(async () => ({ stdout: 'file:///origin/demo\n', stderr: '' })),
}));
vi.mock('../../../services/plugins/plugin-install-trust-migration.js', () => ({
  ensurePluginInstallTrustMigration: vi.fn(async () => undefined),
  migratePluginInstallTrustAtStartup: vi.fn(async () => undefined),
}));

const tempDir = trackTempDirs();

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  } as unknown as Logger;
}

function routes() {
  const home = tempDir('station-trust-managed-update-');
  const packageRoot = join(home, 'plugins', 'demo');
  mkdirSync(join(packageRoot, '.git'), { recursive: true });
  mkdirSync(join(home, 'agents'));
  writeFileSync(
    join(packageRoot, 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  );
  selection.packageRoot = packageRoot;
  return withOperatorPrincipal(
    createPluginRoutes(home, makeLogger(), undefined, {
      visibility: {
        service: new PluginVisibilityService(home),
        resolvePrincipal: () => TEST_OPERATOR_PRINCIPAL,
        listKnownPrincipals: () => [],
      },
      packageMcpJournal: {} as never,
      applyConfigurationMutation: undefined as never,
      settleProviderAdapterRetirements: async () => {},
    }),
  );
}

describe('managed update and install trust refusals', () => {
  test.each([
    [
      'a refused bundle',
      new PluginInstallTrustRefused('missing-inclusion-proof'),
      409,
      'plugin-install-trust-refused',
    ],
    [
      "a newer build's record",
      new PluginTrustRecordNewerError('demo'),
      409,
      'plugin-trust-record-newer',
    ],
    [
      'unreadable trust records',
      new PluginTrustRecordsUnavailableError(
        '/private/home/plugin-trust.json',
        'unreadable',
      ),
      503,
      'plugin-trust-records-unavailable',
    ],
  ])('%s keeps its status and code', async (_name, error, status, code) => {
    const app = routes();
    installPluginFromSource.mockReset();
    installPluginFromSource.mockRejectedValueOnce(error);
    const response = await app.request('/demo/update', { method: 'POST' });
    const body = (await response.json()) as Record<string, unknown>;
    // The managed path was the one taken: the transaction received the
    // journal selection as the expected installation.
    expect(installPluginFromSource).toHaveBeenCalledWith(
      'file:///origin/demo',
      [],
      expect.anything(),
      expect.objectContaining({
        dataPolicy: 'preserve',
        expectedPluginName: 'demo',
      }),
    );
    expect({ status: response.status, code: body.code }).toEqual({
      status,
      code,
    });
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toContain('/private/home');
  });
});
