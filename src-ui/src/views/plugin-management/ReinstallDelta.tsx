import { describePermission } from '../../core/permission-vocabulary';
import type { PreviewData, ReinstallFromSource } from './types';
import { type ReinstallPermissionChange, reinstallDelta } from './view-utils';

/**
 * #2323 S4: what "Reinstall from source" changes, shown in the preview
 * before the person confirms. Disclosure only: the consent step that
 * follows asks exactly what it asks for any install.
 */
export function ReinstallDelta({
  reinstall,
  previewData,
}: {
  reinstall: ReinstallFromSource;
  previewData: PreviewData;
}) {
  const delta = reinstallDelta(reinstall, previewData);
  const nextVersion = previewData.manifest?.version;
  return (
    <div
      className="plugins__modal-message plugins__reinstall-delta"
      data-testid="reinstall-delta"
    >
      <p>
        From {reinstall.projectName}&rsquo;s folder. Installed v
        {reinstall.installedVersion}
        {nextVersion ? `; this folder has v${nextVersion}` : ''}.
      </p>
      <p data-testid="reinstall-delta-code">
        {delta.code === 'changed'
          ? 'Code changed since it was installed.'
          : delta.code === 'unchanged'
            ? 'The code is the same as what is installed.'
            : 'Station has no record of the installed code to compare with.'}
      </p>
      {delta.permissions === null ? null : delta.permissions.added.length ===
          0 &&
        delta.permissions.removed.length === 0 &&
        delta.permissions.unknownDependencies.length === 0 ? (
        <p data-testid="reinstall-delta-permissions-unchanged">
          No permission changes.
        </p>
      ) : (
        <>
          <PermissionList
            title="Requests permissions it does not hold now"
            permissions={delta.permissions.added}
            testId="reinstall-delta-added"
          />
          <PermissionList
            title="No longer requests"
            permissions={delta.permissions.removed}
            testId="reinstall-delta-removed"
          />
          {delta.permissions.unknownDependencies.map((id) => (
            <p key={id} data-testid="reinstall-delta-dependency-unknown">
              Dependency {id} will be installed, and Station did not report its
              permissions, so this list cannot say what it will be allowed to
              do.
            </p>
          ))}
        </>
      )}
    </div>
  );
}

function PermissionList({
  title,
  permissions,
  testId,
}: {
  title: string;
  permissions: ReinstallPermissionChange[];
  testId: string;
}) {
  if (permissions.length === 0) return null;
  return (
    <div data-testid={testId}>
      <div className="plugins__preview-deps-label">{title}</div>
      <ul className="plugins__reinstall-permissions">
        {permissions.map((entry) => (
          <li key={`${entry.dependency ?? ''}:${entry.permission}`}>
            {entry.dependency ? `Dependency ${entry.dependency}: ` : ''}
            {describePermission(entry.permission)}{' '}
            <code>{entry.permission}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
