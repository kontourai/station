import type { SystemStatus } from '@kontourai/station-sdk';
import { settingsRow } from './settings-catalog';

type Build = NonNullable<SystemStatus['build']>;

export function formatBuildAge(ageSeconds: number): string {
  const seconds = Math.max(0, Math.floor(ageSeconds));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Renders whichever provenance fields the instance could report.
 *
 * Every field is independently optional (station#1085). A row is rendered only
 * when its value is present, so a missing build timestamp no longer takes the
 * revision, branch and instance down with it; the "unavailable" hint is
 * reserved for an instance that reported no provenance at all.
 */
export function BuildProvenance({ build }: { build?: Build }) {
  const builtAt =
    build?.builtAt !== undefined && build.ageSeconds !== undefined
      ? { at: build.builtAt, age: build.ageSeconds }
      : undefined;
  const hasAny = Boolean(
    build?.shortSha || builtAt || build?.branch || build?.instanceId,
  );
  return (
    <div className="settings__field settings__provenance">
      <div className="settings__field-label">
        {settingsRow('deployed-build').title}
      </div>
      {build && hasAny ? (
        <fieldset
          aria-label="Deployed build provenance"
          className="settings__provenance-group"
        >
          <dl className="settings__provenance-list">
            {build.shortSha ? (
              <div>
                <dt>Revision</dt>
                <dd>
                  <code title={build.fullSha}>{build.shortSha}</code>
                </dd>
              </div>
            ) : null}
            {builtAt ? (
              <div>
                <dt>Built</dt>
                <dd title={builtAt.at}>{formatBuildAge(builtAt.age)}</dd>
              </div>
            ) : null}
            {build.branch ? (
              <div>
                <dt>Branch</dt>
                <dd>{build.branch}</dd>
              </div>
            ) : null}
            {build.instanceId ? (
              <div>
                <dt>Instance</dt>
                <dd>{build.instanceId}</dd>
              </div>
            ) : null}
          </dl>
        </fieldset>
      ) : (
        <span className="settings__field-hint">
          Build provenance is unavailable for this instance.
        </span>
      )}
    </div>
  );
}
