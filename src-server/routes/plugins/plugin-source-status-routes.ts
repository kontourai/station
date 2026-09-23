/**
 * `/api/plugin-sources` — whether a Project's folder still holds the code an
 * installed local-folder plugin was installed from (#2323 S4).
 *
 * `GET /` lists, for every Project whose working directory is the source of
 * an installed plugin, `unchanged | changed | unknown`
 * (`observeLocalPluginSourceStatuses`). The Plugins view offers "Reinstall
 * from source" on `changed`, and that reinstall is the ordinary
 * `POST /api/plugins/preview` → consent → `POST /api/plugins/install`: this
 * route decides nothing and changes nothing.
 *
 * Its own family, not a `/api/plugins` leaf: the `/:name/*` public-route
 * catch-all and `DELETE /:name` own every segment under `/api/plugins`, and a
 * new literal there would take a name away from plugins.
 *
 * Who may read it: the operator, and not Station's internal agent caller.
 * Reinstalling is the operator's consent, so the offer is the operator's; a
 * paired person gets the same 404 whether or not anything matched, so the
 * route cannot be used to probe which plugins are installed from which
 * Project. The internal caller is refused because nothing it could do with
 * the answer is its to do: the reinstall it would lead to is person-only
 * (`personOnly`), and each read walks folders on the host.
 */
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import {
  observeLocalPluginSourceStatuses,
  PluginInstallationsUnavailableError,
} from '../../services/plugins/plugin-local-source-status.js';
import type { Logger } from '../../utils/logger.js';
import { errorMessage } from '../schemas/schemas.js';
import { isInternalControlCaller } from './plugin-person-approval.js';

interface PluginSourceStatusRouteDeps {
  projectHomeDir: string;
  /** Absent when Station has no installation journal (no event store). */
  journal: Pick<
    PackageMcpAdmissionJournal,
    'selectedInstallations' | 'activationPlan'
  > | null;
  listProjects(): ReadonlyArray<{ slug: string; workingDirectory?: string }>;
  resolvePrincipal(c: Context): PrincipalRef;
  logger: Pick<Logger, 'warn'>;
}

const NOT_FOUND = { success: false, error: 'Not found' } as const;

function isOperatorPerson(deps: PluginSourceStatusRouteDeps, c: Context) {
  if (isInternalControlCaller(c.req.raw)) return false;
  try {
    return deps.resolvePrincipal(c).id === LOCAL_OPERATOR_PRINCIPAL_ID;
  } catch {
    return false;
  }
}

export function createPluginSourceStatusRoutes(
  deps: PluginSourceStatusRouteDeps,
) {
  const app = new Hono();
  app.get('/', async (c) => {
    if (!isOperatorPerson(deps, c)) return c.json(NOT_FOUND, 404);
    if (!deps.journal) return c.json({ sources: [] });
    try {
      const sources = await observeLocalPluginSourceStatuses({
        projectHomeDir: deps.projectHomeDir,
        journal: deps.journal,
        projects: deps.listProjects(),
      });
      return c.json({ sources });
    } catch (error) {
      if (error instanceof PluginInstallationsUnavailableError)
        return c.json(
          {
            success: false,
            error:
              'Plugin installations are unavailable; reload Plugins and retry.',
          },
          503,
        );
      deps.logger.warn('Plugin source status failed', {
        error: errorMessage(error),
      });
      return c.json(
        { success: false, error: 'Plugin source status is unavailable' },
        500,
      );
    }
  });
  return app;
}
