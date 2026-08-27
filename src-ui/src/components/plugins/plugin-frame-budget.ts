/**
 * Per-plugin token buckets for the frame bridge (station#3308, station#3323).
 *
 * A plugin frame asks the shell to do things — show a toast, move the shell —
 * and nothing about `postMessage` bounds how often it asks. Each capability
 * gets its own bucket so exhausting one never silences the other.
 *
 * Rate is the only thing policed here. Name policing (a frame claiming another
 * plugin's identity) belongs to the registry that issues `plugin.name`, not to
 * this renderer.
 */

export type PluginBudget = {
  /** Spend one token. False means the caller is over its rate. */
  claim: (pluginName: string, now: number) => boolean;
  /**
   * True at most once per refill interval per plugin, so a refusal can be
   * reported without a looping plugin turning the report into the flood.
   */
  shouldReport: (pluginName: string, now: number) => boolean;
  /** Test seam: the buckets are module state and outlive a render. */
  reset: () => void;
};

export function createPluginBudget({
  burst,
  refillMs,
}: {
  burst: number;
  refillMs: number;
}): PluginBudget {
  const buckets = new Map<
    string,
    { tokens: number; refilledAt: number; reportedAt: number }
  >();

  return {
    claim(pluginName, now) {
      const bucket = buckets.get(pluginName) ?? {
        tokens: burst,
        refilledAt: now,
        reportedAt: Number.NEGATIVE_INFINITY,
      };
      const earned = Math.floor((now - bucket.refilledAt) / refillMs);
      const tokens = Math.min(burst, bucket.tokens + earned);
      // Advance the clock only by whole tokens granted, so a partial interval
      // is not silently discarded; a full bucket still advances so idle time
      // cannot accumulate into a larger burst later.
      const refilledAt =
        earned > 0
          ? Math.min(now, bucket.refilledAt + earned * refillMs)
          : bucket.refilledAt;
      if (tokens <= 0) {
        buckets.set(pluginName, { ...bucket, tokens, refilledAt });
        return false;
      }
      buckets.set(pluginName, { ...bucket, tokens: tokens - 1, refilledAt });
      return true;
    },

    shouldReport(pluginName, now) {
      const bucket = buckets.get(pluginName);
      if (!bucket) return false;
      if (now - bucket.reportedAt < refillMs) return false;
      buckets.set(pluginName, { ...bucket, reportedAt: now });
      return true;
    },

    reset() {
      buckets.clear();
    },
  };
}

/**
 * Toasts. `toastStore.show` collapses byte-identical repeats only, so a frame
 * looping a message with a varying suffix inserted unbounded live toasts.
 * Three is the burst a plugin can spend at once; one token comes back every
 * ten seconds, which is longer than a toast's own 5s auto-dismiss — a
 * well-behaved plugin never notices the ceiling, and a looping one settles at
 * roughly one toast on screen.
 */
export const pluginToastBudget = createPluginBudget({
  burst: 3,
  refillMs: 10_000,
});

/**
 * Navigation. Tighter than toasts by an order of magnitude, because the
 * failure is worse: a toast pile-up is noise the user can dismiss, while a
 * navigation loop moves the shell out from under them and can pin them off a
 * route they are trying to reach. `navigation.dock` is an auto-granted
 * `passive` permission (`plugin-permissions.ts`), so this bound is the only
 * thing standing between an installed plugin and that loop — see the note at
 * the call site about the permission tier itself.
 *
 * Two is the burst (a plugin acting on one user click never needs more), and
 * one token every thirty seconds leaves a loop unable to hold the shell.
 */
export const pluginNavigationBudget = createPluginBudget({
  burst: 2,
  refillMs: 30_000,
});

/**
 * Confirmations (station#4201 step 3). The frame adapter lets a pane raise
 * the contract's `confirm` intent, and the SHELL renders its own modal in
 * response — a full-viewport overlay the user must answer.
 *
 * That is the most expensive attention a pane can spend, so it is the
 * tightest bound here. The shell's confirm chrome already collapses to ONE
 * dialog (a superseded request settles `cancelled`), which stops a frame
 * stacking modals but not a frame keeping one permanently on screen: answer
 * it and the next appears. Two, then one every thirty seconds, is generous
 * for a confirmation that follows a user's own click and useless for holding
 * the screen. A refused confirm resolves `cancelled` — the contract promises
 * the promise always settles with a decision, and nothing was confirmed.
 */
export const pluginConfirmBudget = createPluginBudget({
  burst: 2,
  refillMs: 30_000,
});
