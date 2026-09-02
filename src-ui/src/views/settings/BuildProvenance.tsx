import type { SystemStatus } from '@kontourai/station-sdk';
import { formatArtifactBuildTimestamp } from '@kontourai/station-shared/build-provenance';
import type { NativeClientBuildProvenance } from '../../platform/native/types';

type Build = NonNullable<SystemStatus['build']>;

function BuildTimestamp({
  builtAt,
  ageSeconds,
  development = false,
}: {
  builtAt: unknown;
  ageSeconds?: number;
  development?: boolean;
}) {
  const nowMs =
    typeof builtAt === 'string' &&
    typeof ageSeconds === 'number' &&
    Number.isFinite(Date.parse(builtAt))
      ? Date.parse(builtAt) + Math.max(0, ageSeconds) * 1_000
      : undefined;
  const presentation = formatArtifactBuildTimestamp(builtAt, {
    development,
    ...(nowMs === undefined ? {} : { nowMs }),
  });
  return presentation.state === 'available' ? (
    <dd title={presentation.description}>
      <span aria-hidden="true">
        {presentation.date} · {presentation.age}
      </span>
      <span className="sr-only">{presentation.description}</span>
    </dd>
  ) : (
    <dd className="settings__field-hint">{presentation.description}</dd>
  );
}

/** Local native-app build identity; it never reads the connected backend. */
export function InstalledAppBuildProvenance({
  build,
  development,
}: {
  build?: NativeClientBuildProvenance;
  development: boolean;
}) {
  const hasIdentity = Boolean(
    build?.fullSha || build?.branch || build?.builtAt,
  );
  return (
    <div className="settings__field settings__provenance">
      <div className="settings__field-label">Installed app build</div>
      {hasIdentity ? (
        <fieldset
          aria-label="Installed app build provenance"
          className="settings__provenance-group"
        >
          <dl className="settings__provenance-list">
            {build?.fullSha ? (
              <div>
                <dt>Revision</dt>
                <dd>
                  <code title={build.fullSha}>{build.fullSha.slice(0, 7)}</code>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Built</dt>
              <BuildTimestamp
                builtAt={build?.builtAt}
                development={development}
              />
            </div>
            {build?.branch ? (
              <div>
                <dt>Branch</dt>
                <dd>{build.branch}</dd>
              </div>
            ) : null}
          </dl>
        </fieldset>
      ) : (
        <span className="settings__field-hint">
          {formatArtifactBuildTimestamp(undefined, { development }).description}
        </span>
      )}
      <span className="settings__field-hint">
        This identifies the app on this device. Store upload and install dates
        are provider/device events, not build provenance.
      </span>
    </div>
  );
}

/** Provenance reported by the Station backend currently connected. */
export function BuildProvenance({ build }: { build?: Build }) {
  const hasAny = Boolean(
    build?.shortSha || build?.builtAt || build?.branch || build?.instanceId,
  );
  return (
    <div className="settings__field settings__provenance">
      <div className="settings__field-label">Connected Station build</div>
      {build && hasAny ? (
        <fieldset
          aria-label="Connected Station build provenance"
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
            {build.builtAt ? (
              <div>
                <dt>Built</dt>
                <BuildTimestamp
                  builtAt={build.builtAt}
                  ageSeconds={build.ageSeconds}
                />
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
          Connected Station build provenance is unavailable.
        </span>
      )}
      <span className="settings__field-hint">
        This identifies the Station backend currently connected, which can
        differ from the installed app.
      </span>
    </div>
  );
}

/** @deprecated import from the shared build-provenance subpath instead. */
export { formatBuildAge } from '@kontourai/station-shared/build-provenance';
