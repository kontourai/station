import type {
  AccountSharingApplyResult,
  AccountSharingChoice,
  AccountSharingOriginOption,
  AccountSharingSettingView,
} from '@kontourai/station-contracts/local-accounts';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import type { HandoffRequestOutcome } from '../../runtime/bootstrap/supervisor-link.js';
import {
  FeaturePreviewDisabledError,
  requireFeaturePreview,
} from '../../services/feature-previews/feature-preview-refusal.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import { offeredAccountSharingOrigin } from '../../services/identity/account-sharing-origins.js';
import {
  AccountSharingPublishedWriteError,
  armStagedAccountSharingChange,
  readAccountSharingRecord,
  stageAccountSharingChange,
  withdrawStagedAccountSharingChange,
} from '../../services/identity/account-sharing-setting.js';

/** What the running Station adopted at startup, and who decided it. */
export interface AccountSharingRuntimeState {
  /** Process configuration that decides instead of the stored setting. */
  lockedBy: readonly string[];
  active: AccountSharingSettingView['active'];
  startupFailure?: string;
}

export interface AccountSharingRouteDependencies {
  homeDirectory: string;
  /** The existing operator check (`projectMembershipAuthority(...).operator()`). */
  requireOperator: (request: Request) => Promise<void>;
  state: () => AccountSharingRuntimeState;
  /** The `project-sharing-setting` Feature Preview; off refuses both routes. */
  preview: FeaturePreviewSelector;
  origins: () => Promise<AccountSharingOriginOption[]>;
  supervised: () => boolean;
  requestHandoff: () => Promise<HandoffRequestOutcome>;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export const ACCOUNT_SHARING_PREVIEW_ID = 'project-sharing-setting';
const MAX_BODY_BYTES = 4096;
const choiceSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({ enabled: z.literal(true), publicOrigin: z.string().max(2048) })
    .strict(),
]);

function refuse(
  c: Context,
  status: 400 | 403 | 409 | 503 | 504,
  code: string,
  error: string,
) {
  return c.json({ success: false, code, error }, status);
}

function activeMatches(
  active: AccountSharingRuntimeState['active'],
  choice: AccountSharingChoice,
): boolean {
  return choice.enabled
    ? active.projectSharing &&
        active.localAccounts &&
        active.publicOrigin === choice.publicOrigin
    : !active.projectSharing && !active.localAccounts;
}

/**
 * #4305: Settings → System → Project sharing with local accounts. Operator
 * only. A change is validated here, staged in the Station home, and adopted
 * by the next generation the process supervisor hands off to; that
 * generation commits it or the one after rolls it back
 * (`account-sharing-setting.ts`).
 */
export function createAccountSharingRoutes(
  deps: AccountSharingRouteDependencies,
) {
  const app = new Hono();
  let applyInFlight = false;

  const authorize = async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    try {
      await deps.requireOperator(c.req.raw);
      return true;
    } catch {
      return false;
    }
  };
  /** The preview refusal, or undefined when the preview is on. */
  const previewRefusal = (c: Context) => {
    try {
      requireFeaturePreview(
        deps.preview,
        ACCOUNT_SHARING_PREVIEW_ID,
        'Project sharing setting',
      );
      return undefined;
    } catch (error) {
      if (error instanceof FeaturePreviewDisabledError)
        return c.json(error.refusal, 404);
      throw error;
    }
  };
  const operatorRequired = (c: Context) =>
    refuse(
      c,
      403,
      'operator_required',
      'Only the Station operator can change Project sharing.',
    );

  app.get('/', async (c) => {
    if (!(await authorize(c))) return operatorRequired(c);
    const refused = previewRefusal(c);
    if (refused) return refused;
    const state = deps.state();
    const locked = state.lockedBy.length > 0;
    const view: AccountSharingSettingView = {
      source: locked ? 'deployment' : 'setting',
      lockedBy: [...state.lockedBy],
      active: state.active,
      origins: locked ? [] : await deps.origins(),
      restart: deps.supervised() ? 'supervised' : 'unavailable',
      ...(state.startupFailure ? { startupFailure: state.startupFailure } : {}),
    };
    if (!locked) {
      const read = readAccountSharingRecord(deps.homeDirectory);
      view.stored = read.record.committed;
      if (read.kind === 'unreadable') view.storedUnreadable = true;
      if (read.record.lastApply) view.lastApply = read.record.lastApply;
      if (read.record.pending)
        view.pending = {
          choice: read.record.pending.choice,
          ready: read.record.pending.ready === true,
        };
    }
    return c.json({ success: true, data: view });
  });

  app.put('/', async (c) => {
    if (!(await authorize(c))) return operatorRequired(c);
    const refused = previewRefusal(c);
    if (refused) return refused;
    let choice: AccountSharingChoice;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
        throw new z.ZodError([]);
      choice = choiceSchema.parse(JSON.parse(text));
    } catch {
      return refuse(c, 400, 'invalid_request', 'The setting is not valid.');
    }
    const state = deps.state();
    if (state.lockedBy.length > 0)
      return refuse(
        c,
        409,
        'set_by_deployment',
        `This Station's deployment sets Project sharing (${state.lockedBy.join(', ')}).`,
      );
    if (choice.enabled) {
      const origin = offeredAccountSharingOrigin(
        await deps.origins(),
        choice.publicOrigin,
      );
      if (!origin)
        return refuse(
          c,
          400,
          'origin_not_offered',
          'Choose one of the sign-in addresses this Station offers.',
        );
      choice = { enabled: true, publicOrigin: origin };
    }
    // Before the no-op check: while a change is restarting this Station,
    // "matches what is active" says nothing about what comes next.
    if (applyInFlight)
      return refuse(
        c,
        409,
        'apply_in_flight',
        'A change to Project sharing is already restarting this Station.',
      );
    const pending = readAccountSharingRecord(deps.homeDirectory).record.pending;
    if (pending) {
      if (pending.ready || pending.attempted)
        return refuse(
          c,
          409,
          'pending_recovery',
          'A previous change is still pending and needs reconciliation.',
        );
      try {
        withdrawStagedAccountSharingChange(
          deps.homeDirectory,
          'A new change replaced an unarmed request.',
        );
      } catch {
        return refuse(
          c,
          503,
          'pending_recovery',
          'The previous pending change could not be withdrawn.',
        );
      }
    }
    if (activeMatches(state.active, choice)) {
      const result: AccountSharingApplyResult = { changed: false };
      return c.json({ success: true, data: result });
    }
    if (!deps.supervised())
      return refuse(
        c,
        409,
        'restart_unavailable',
        'This Station was not started by the process supervisor, so it cannot restart itself to apply this.',
      );
    applyInFlight = true;
    let handedOff = false;
    try {
      // Re-check just before the write, as account administration does.
      if (!(await authorize(c))) return operatorRequired(c);
      try {
        stageAccountSharingChange(deps.homeDirectory, choice);
      } catch {
        let withdrawn = true;
        try {
          withdrawStagedAccountSharingChange(
            deps.homeDirectory,
            'Saving the change failed.',
          );
        } catch {
          withdrawn = false;
        }
        return refuse(
          c,
          503,
          'setting_unavailable',
          withdrawn
            ? 'Station could not save the setting.'
            : 'Station could not save the setting; its pending state needs reconciliation.',
        );
      }
      const outcome = await deps
        .requestHandoff()
        .catch(() => ({ status: 'unanswered' as const }));
      if (outcome.status === 'draining') {
        handedOff = true;
        let durabilityUncertain = false;
        try {
          armStagedAccountSharingChange(deps.homeDirectory);
        } catch (error) {
          if (!(error instanceof AccountSharingPublishedWriteError)) {
            try {
              withdrawStagedAccountSharingChange(
                deps.homeDirectory,
                'The change could not be armed.',
              );
            } catch {}
            return refuse(
              c,
              503,
              'setting_unavailable',
              'Station could not prepare the setting for restart.',
            );
          }
          // Published bytes may be adopted. Do not report this request as failed.
          durabilityUncertain = true;
          deps.logger?.warn?.(
            'Project sharing publication durability is uncertain',
          );
        }
        deps.logger?.info?.('Project sharing: restarting to apply setting', {
          enabled: choice.enabled,
        });
        const result: AccountSharingApplyResult = {
          changed: true,
          restarting: true,
          ...(durabilityUncertain ? { durabilityUncertain: true } : {}),
        };
        return c.json({ success: true, data: result });
      }
      const detail =
        outcome.status === 'refused'
          ? `the supervisor refused the restart (${outcome.reason})`
          : outcome.status === 'rolled-back'
            ? 'the new Station process failed to start'
            : outcome.status === 'unanswered'
              ? 'the supervisor did not answer'
              : 'no supervisor runs this Station';
      let withdrawn = true;
      try {
        withdrawStagedAccountSharingChange(deps.homeDirectory, detail);
      } catch {
        withdrawn = false;
      }
      deps.logger?.warn?.('Project sharing: restart did not start', {
        status: outcome.status,
      });
      return refuse(
        c,
        outcome.status === 'unanswered' ? 504 : 409,
        'restart_failed',
        withdrawn
          ? `Nothing changed: ${detail}.`
          : `The restart did not start and the pending change needs reconciliation: ${detail}.`,
      );
    } finally {
      // This generation is draining after a handoff; it accepts no second apply.
      if (!handedOff) applyInFlight = false;
    }
  });
  return app;
}
