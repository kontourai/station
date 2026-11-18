import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { copyToClipboard } from '../lib/clipboard';
import { useDockProject } from '../workspace-panes/useDockProject';
import { ActionRow } from './ActionRow';
import { Button } from './Button';
import { requestProjectShell } from './coding-layout/terminalShellRequest';

export function TerminalCommandAction({
  command,
  authority,
  stationName,
}: {
  command: string;
  authority: ApiRequestScope;
  stationName: string;
}) {
  const host = useHostRequestAuthorityScope();
  const { projectSlug } = useDockProject();
  const show = useShowSurface();
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>();
  const canOpen =
    projectSlug &&
    host?.apiBase === authority.apiBase &&
    host.authorityKey === authority.authorityKey &&
    host.isCurrent();

  return (
    <div className="content-stack">
      <p>Run on {stationName}:</p>
      <code>{command}</code>
      <ActionRow
        overflowLabel="More terminal actions"
        secondary={
          <Button
            variant="secondary"
            onClick={async () => {
              setCopyStatus(
                (await copyToClipboard(command)) ? 'copied' : 'failed',
              );
            }}
          >
            Copy command
          </Button>
        }
        primary={
          canOpen ? (
            <Button
              variant="secondary"
              onClick={() => {
                if (!host.isCurrent()) return;
                requestProjectShell(projectSlug);
                show('coding:terminal', undefined, { region: 'bottom' });
              }}
            >
              Open terminal
            </Button>
          ) : undefined
        }
      />
      {copyStatus && (
        <p role="status">
          {copyStatus === 'copied'
            ? 'Copied. Paste it into the terminal.'
            : 'Select and copy the command above.'}
        </p>
      )}
    </div>
  );
}
