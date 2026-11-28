import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RegistryItem } from '@kontourai/station-contracts/catalog';
import { afterEach, describe, expect, test } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { registerManifestRegistryProvider } from '../../../providers/registries/register-manifest-registry.js';
import { clearAll } from '../../../providers/registries/registry.js';
import { SkillService } from '../../../services/agents/skill-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { createLogger } from '../../../utils/logger.js';
import { createRegistryRoutes } from '../registry.js';

const temporary = trackTempDirs();
const logger = createLogger({ name: 'registry-app-facts-test' });
afterEach(clearAll);

function setup() {
  clearAll();
  const home = temporary('registry-app-facts-home-');
  const config = new ConfigLoader({ projectHomeDir: home });
  const app = withOperatorPrincipal(
    createRegistryRoutes(
      config,
      async () => {},
      undefined,
      new SkillService(config, logger),
      {
        logger,
        canSeePlugin: () => true,
        visibility: {
          resolvePrincipal: () => ({
            id: LOCAL_OPERATOR_PRINCIPAL_ID,
            kind: 'human',
            display: 'Operator',
          }),
        },
      },
    ),
  );
  registerManifestRegistryProvider(
    new JsonManifestRegistryProvider(
      resolve(process.cwd(), 'examples/registry/default.json'),
      home,
      undefined,
      undefined,
      { bundled: true },
    ),
  );
  return { home, app };
}

describe('GET /plugins carries app facts', () => {
  test('the bundled catalog lists what each entry is, and its stored snapshot keeps it', async () => {
    const { home, app } = setup();
    const response = await app.request('/plugins');
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: RegistryItem[] };
    const byItem = new Map(
      data.map((item) => [item.catalog?.itemId, item.app]),
    );

    expect(byItem.get('knowledge-docs-starter')).toMatchObject({
      kind: 'app',
      screens: ['Library', 'Ask', 'Sources'],
      worksWith: ['chats-and-agents', 'knowledge'],
    });
    expect(byItem.get('getting-started-starter')).toMatchObject({
      kind: 'app',
      opensAs: ['screen', 'project-view'],
    });
    expect(byItem.get('smart-routing')).toEqual({ kind: 'none' });
    expect(byItem.get('matt-pocock-engineering')).toEqual({ kind: 'none' });

    // The offline snapshot written for this catalog keeps the facts.
    const stored = JSON.parse(
      await readFile(join(home, 'config/registry-sources.json'), 'utf8'),
    ) as { snapshots: Record<string, { data: RegistryItem[] }> };
    const storedItems = Object.values(stored.snapshots).flatMap(
      (snapshot) => snapshot.data,
    );
    expect(
      storedItems.find(
        (item) => item.catalog?.itemId === 'knowledge-docs-starter',
      )?.app,
    ).toMatchObject({ kind: 'app', screens: ['Library', 'Ask', 'Sources'] });
  });
});
