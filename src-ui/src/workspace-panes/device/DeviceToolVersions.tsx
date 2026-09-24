import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';
import { useDeviceToolVersions } from './deviceToolchainApi';

const TOOL_LABEL = {
  'expo-device-hub': 'Device hub',
  'agent-device': 'Agent device tools',
} as const;

/**
 * Running / required / installed versions of the managed device tools
 * (#1970), fetched only when opened. The check is read-only on the server:
 * it starts and installs nothing. Adapted from t3code's
 * `DeviceToolVersions.tsx` (MIT, © 2026 T3 Tools Inc.).
 */
export function DeviceToolVersions({
  requestScope,
}: {
  requestScope: ApiRequestScope;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const versions = useDeviceToolVersions(requestScope, open);
  return (
    <div className="device-setup__versions">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        Versions
      </Button>
      {open ? (
        <section
          id={panelId}
          className="device-setup__versions-panel"
          aria-label="Device tool versions"
        >
          <p className="device-setup__muted">Managed by Station</p>
          {versions.isPending ? (
            <SkeletonBlock count={1} label="Checking versions" />
          ) : versions.isError ? (
            <p role="alert">The versions could not be read.</p>
          ) : (
            <table className="device-setup__versions-table">
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Running</th>
                  <th scope="col">Required</th>
                  <th scope="col">Installed</th>
                </tr>
              </thead>
              <tbody>
                {versions.data.tools.map((tool) => (
                  <tr key={tool.tool}>
                    <th scope="row">{TOOL_LABEL[tool.tool]}</th>
                    <td>{tool.running ?? 'Not running'}</td>
                    <td>{tool.required}</td>
                    <td>
                      {tool.installed.length > 0
                        ? tool.installed.join(', ')
                        : 'None'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </div>
  );
}
