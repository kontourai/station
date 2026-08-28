/**
 * first-run-gate — the one derivation that decides whether the guided first
 * run is offered, and how.
 *
 * WHAT IT REPLACED. The run used to activate from `sawSetupLauncher`: "only a
 * session that actually SAW the connect launcher is a first run". The
 * launcher's own visibility comes from `/api/system/status`, whose external
 * engines report `ready` the moment `claude`/`codex` are on PATH — so on a
 * developer machine the launcher never appeared and the guided run never ran
 * at all (proved twice at runtime on fresh homes). And because that probe
 * FLAPS between `cannot_verify` and `ready`, a page load that landed in the
 * `cannot_verify` window did start the run — ten seconds in, on whatever route
 * the user happened to be on. A readiness probe is not a fact about a home.
 *
 * WHAT IT READS INSTEAD. `AppConfig.firstRun.status`, persisted in the home's
 * `config/app.json`. Written `pending` exactly once, by the code path that
 * creates a brand-new home (`config-loader-app.ts`), and rewritten only by the
 * chapter itself when the person completes or defers it. Nothing here consults
 * a probe, an engine, an agent count, or a device setting, so nothing about
 * this offer can change between two renders of the same home.
 *
 * ABSENT IS NOT `pending`. A home whose config predates the field has already
 * been used; offering a first run there is the ambush the launcher rule was
 * reaching for. Absent therefore reads as "not offered", the same as
 * `completed`.
 */

import type {
  FirstRunState,
  FirstRunStatus,
  FirstRunTransitionRequest,
} from '@kontourai/station-contracts/config';

export interface FirstRunOffer {
  /**
   * Open the chapter without being asked. True only for a home that has never
   * answered — a deferral is a decision, and re-opening over it is how a
   * first-run experience gets resented.
   */
  autoOpen: boolean;
  /**
   * Home shows its "Set up Station" card. True while the run is unanswered OR
   * deferred: the card is the durable way back in, which is what makes "Not
   * now" safe to click.
   */
  offered: boolean;
}

const CLOSED: FirstRunOffer = { autoOpen: false, offered: false };

/**
 * The single read. Every surface that wants to know whether first run is on
 * the table calls this, so two surfaces cannot answer differently.
 *
 * Unknown values (a status written by a newer Station, a hand-edited config)
 * fail CLOSED rather than defaulting to `pending`: opening a guided run
 * because we could not read our own record would be the ambush again, and the
 * Home card stays reachable through an explicitly `skipped` record only.
 */
export function resolveFirstRunOffer(
  firstRun: FirstRunState | null | undefined,
): FirstRunOffer {
  switch (firstRun?.status) {
    case 'pending':
      return { autoOpen: true, offered: true };
    case 'skipped':
      return { autoOpen: false, offered: true };
    default:
      return CLOSED;
  }
}

/** Whether a status string is one this build knows how to act on. */
export function isKnownFirstRunStatus(
  status: string | undefined,
): status is FirstRunStatus {
  return status === 'pending' || status === 'skipped' || status === 'completed';
}

/**
 * What the chapter asks the server to record.
 *
 * A STATUS AND NOTHING ELSE  These used to build the whole record,
 * timestamp included, and hand it to the generic config write — which meant
 * the moment a decision was said to have happened came from the browser, and
 * any other caller of that route could say the same thing about a run that
 * never ran. `POST /config/first-run` refuses a request carrying a timestamp
 * and stamps its own observation; `describeFirstRunTransitionViolation`
 * (contracts) is the rule both ends read.
 */
export const FIRST_RUN_DEFERRED: FirstRunTransitionRequest = {
  status: 'skipped',
};

export const FIRST_RUN_COMPLETED: FirstRunTransitionRequest = {
  status: 'completed',
};
