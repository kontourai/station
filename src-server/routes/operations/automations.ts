/**
 * Automation routes (epic kontourai/station#3439). Slice S2 adds only the
 * read-only delivery history, `GET /automations/deliveries`, named by
 * `AUTOMATION_OPERATOR_SURFACE.deliveries`. Rows are the ledger's bounded
 * projection: hashed transport keys, closed outcome and reason codes, and
 * identifiers; never a payload, secret or delivery GUID.
 */

import type {
  AutomationDeliveryRecord,
  AutomationPollRecord,
} from '@kontourai/station-contracts/automation';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { AutomationPolicyUnavailableError } from '../../services/automation/automation-store.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { Logger } from '../../utils/logger.js';

const AUTOMATION_DELIVERIES_DEFAULT_LIMIT = 50;
const AUTOMATION_DELIVERIES_MAX_LIMIT = 200;

export interface AutomationRouteDependencies {
  preview: FeaturePreviewSelector | undefined;
  listDeliveries(limit: number): AutomationDeliveryRecord[];
  listPolls(): AutomationPollRecord[];
  /** Runtime composition derives this only from trusted request ingress. */
  readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
}

/** A positive integer within the ceiling; anything else is refused, never clamped. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return AUTOMATION_DELIVERIES_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) return undefined;
  const limit = Number(raw);
  return limit <= AUTOMATION_DELIVERIES_MAX_LIMIT ? limit : undefined;
}

export function createAutomationRoutes(
  deps: AutomationRouteDependencies,
  logger: Logger,
) {
  const app = new Hono();

  // Automation storage has no tenant binding, like the scheduler's: hosted
  // mode sees no Automation surface. Checked per route rather than as a
  // wildcard middleware, which would register every method under
  // `/automations/*` and so need a pairing scope for mutations no slice has
  // classified yet.
  const hidden = (request: Request) => {
    const authority = deps.readAuthorityForRequest?.(request);
    return authority !== undefined && isHostedSessionReadAuthority(authority);
  };

  app.get('/deliveries', (c) => {
    if (hidden(c.req.raw)) {
      return c.json({ success: false, error: 'Automations not found' }, 404);
    }
    if (!deps.preview?.select({ enabled: () => true, disabled: () => false }))
      return c.json(
        {
          success: false,
          error:
            'Enable GitHub automation observations in Settings → Advanced → Feature previews.',
          code: 'feature_preview_disabled',
          previewId: 'github-automation-observations',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
        },
        404,
      );
    const limit = parseLimit(c.req.query('limit'));
    if (limit === undefined) {
      return c.json(
        {
          success: false,
          error: `limit must be an integer from 1 to ${AUTOMATION_DELIVERIES_MAX_LIMIT}`,
        },
        400,
      );
    }
    try {
      return c.json({
        success: true,
        data: {
          deliveries: deps.listDeliveries(limit),
          polls: deps.listPolls(),
        },
      });
    } catch (error) {
      if (error instanceof AutomationPolicyUnavailableError) {
        logger.warn('Automation deliveries unavailable', {
          detail: error.detail,
        });
        return c.json(
          {
            success: false,
            error: 'Automation policy is unavailable.',
            code: error.code,
          },
          503,
        );
      }
      throw error;
    }
  });

  return app;
}
