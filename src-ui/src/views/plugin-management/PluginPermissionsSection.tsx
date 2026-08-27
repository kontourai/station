import type { PermissionTier } from '@kontourai/station-contracts/plugin';
import { Button } from '../../components/Button';
import { Empty } from '../../components/state';
import {
  describePermission,
  revokeNeedsConfirmation,
  TIER_LABEL,
  TIER_MEANING,
} from '../../core/permission-vocabulary';
import './PluginPermissionsSection.css';

/**
 * What this plugin can do on this Station, and how to take it back
 * (station#3815).
 *
 * Until now the panel showed only what a plugin was still MISSING — the
 * pending ask — so a permission became invisible at the moment it was
 * granted. That inverts what a person wants when they come here: they are
 * auditing what they already live with, not shopping. So held permissions
 * lead, and the unmet ones sit underneath as the outstanding request.
 *
 * Each row leads with the capability in plain words, because "can it run
 * server-side code" is the question being answered; the identifier stays
 * visible underneath for the reader who wants to grep for it.
 */

export interface PluginPermissionEntry {
  permission: string;
  tier: PermissionTier;
}

/** Mirrors the server's `PluginContentBinding`; never derived here. */
export type PluginContentBinding = 'none' | 'bound' | 'unverified' | 'changed';

export function PluginPermissionsSection({
  granted,
  missing,
  revoking,
  contentBinding,
  withheld,
  onRevoke,
  onReviewPermissions,
}: {
  granted: PluginPermissionEntry[];
  missing: PluginPermissionEntry[];
  /** Permissions with a withdrawal in flight — more than one is possible. */
  revoking: ReadonlySet<string>;
  /**
   * The server's derivation of whether this plugin's code still matches the
   * code its permissions were granted against (station#4288). `undefined`
   * means the server did not say — which is rendered as nothing, never as
   * "fine".
   */
  contentBinding?: PluginContentBinding;
  /** Permissions the binding is withholding, by name. */
  withheld?: string[];
  onRevoke: (entry: PluginPermissionEntry) => void;
  onReviewPermissions: () => void;
}) {
  const withheldNames = withheld ?? [];
  return (
    <div className="detail-panel__section">
      <div className="plugins__settings-header">Permissions</div>

      {/* station#4288. A permission that vanishes with no explanation is its
          own defect, so the two states where the recorded grant and the
          installed code disagree say so in words. Both strings restate what
          the server derived; neither invents a verdict.

          There is no "nothing was withheld" branch here on purpose (delta
          review LOW 2): the server derives `changed` only for a plugin that
          HAS recorded permissions, and withholds all of them, so `changed`
          with an empty `withheld` is a state the derivation cannot produce.
          A fallback string for it would be this file inventing the verdict
          the comment above says it must not. */}
      {contentBinding === 'changed' && (
        <p className="plugin-permissions__binding plugin-permissions__binding--changed">
          This plugin's code has changed since these permissions were approved.
          {withheldNames.length > 0 &&
            ` ${withheldNames.map(describePermission).join(', ')} ${withheldNames.length === 1 ? 'is' : 'are'} not in effect until approved again for the new code.`}
        </p>
      )}
      {contentBinding === 'unverified' && (
        <p className="plugin-permissions__binding">
          These permissions were approved before Station recorded which code a
          permission was approved for, so it cannot tell whether this plugin's
          code has changed since. They stay in effect; the next approval or
          update for this plugin records it.
        </p>
      )}

      {granted.length > 0 ? (
        <ul className="plugin-permissions__list">
          {granted.map((entry) => (
            <li className="plugin-permissions__row" key={entry.permission}>
              <span
                className={`plugin-permissions__tier plugin-permissions__tier--${entry.tier}`}
                title={TIER_MEANING[entry.tier]}
              >
                {TIER_LABEL[entry.tier]}
              </span>
              <span className="plugin-permissions__what">
                <span className="plugin-permissions__label">
                  {describePermission(entry.permission)}
                </span>
                <span className="plugin-permissions__id">
                  {entry.permission}
                </span>
              </span>
              <Button
                size="sm"
                onClick={() => onRevoke(entry)}
                pending={revoking.has(entry.permission)}
                pendingLabel="Removing…"
                // Named for the row, so the control is unambiguous to a
                // screen reader reading it out of context.
                aria-label={`Remove ${describePermission(entry.permission)}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty
          variant="compact"
          label="No permissions"
          description="This plugin holds nothing on this Station."
        />
      )}

      {missing.length > 0 && (
        <div className="plugin-permissions__requested">
          <p className="plugin-permissions__requested-header">
            {/* The ask, stated as an ask. It is not a warning: a plugin
                declaring a permission it has not been given is the normal
                state before a decision. */}
            Requested and not granted
          </p>
          <ul className="plugin-permissions__list">
            {missing.map((entry) => (
              <li
                className="plugin-permissions__row plugin-permissions__row--muted"
                key={entry.permission}
              >
                <span
                  className={`plugin-permissions__tier plugin-permissions__tier--${entry.tier}`}
                  title={TIER_MEANING[entry.tier]}
                >
                  {TIER_LABEL[entry.tier]}
                </span>
                <span className="plugin-permissions__what">
                  <span className="plugin-permissions__label">
                    {describePermission(entry.permission)}
                  </span>
                  <span className="plugin-permissions__id">
                    {entry.permission}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <Button size="sm" onClick={onReviewPermissions}>
            Review{' '}
            {missing.length === 1 ? 'request' : `${missing.length} requests`}
          </Button>
        </div>
      )}

      <p className="plugin-permissions__hint">
        {/* Two true things, and no more. "Takes effect immediately" was the
            first version and it was FALSE (review): a provider a plugin
            already registered keeps serving until the plugin reloads, and
            work already running finishes. Overclaiming here would be the
            same defect this surface exists to fix — a sentence nothing
            derives — so it says what withdrawal actually does and names
            what it does not reach (station#3822). */}
        Removing a permission stops new use of it right away. Anything the
        plugin already started, or a provider it already registered, keeps
        running until the plugin reloads. Granting a Trusted permission again
        needs the separate host review page.
      </p>
    </div>
  );
}

export { revokeNeedsConfirmation };
