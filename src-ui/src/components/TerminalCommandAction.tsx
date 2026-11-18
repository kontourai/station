import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { copyToClipboard } from '../lib/clipboard';
import { useDockProject } from '../workspace-panes/useDockProject';
import { ActionRow } from './ActionRow';
import { Button } from './Button';
import { requestProjectShell } from './coding-layout/terminalShellRequest';
import { CopyGlyph, TerminalGlyph } from './icons/Glyph';
import './TerminalCommandAction.css';

function OpenStationTerminalButton({
  authority,
  onOpen,
}: {
  authority: ApiRequestScope;
  onOpen: () => void;
}) {
  const host = useHostRequestAuthorityScope();
  const { projectSlug } = useDockProject();
  const show = useShowSurface();
  if (
    !projectSlug ||
    host?.apiBase !== authority.apiBase ||
    host.authorityKey !== authority.authorityKey ||
    !host.isCurrent()
  )
    return null;
  return (
    <Button
      variant="ghost"
      onClick={() => {
        if (!host.isCurrent()) return;
        onOpen();
        requestProjectShell(projectSlug);
        show('coding:terminal', undefined, { region: 'bottom' });
      }}
    >
      <TerminalGlyph /> Copy and open terminal
    </Button>
  );
}

export function TerminalCommandAction({
  command,
  authority,
  stationName,
}: {
  command: string;
  authority: ApiRequestScope;
  stationName: string;
}) {
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>();

  const copy = async () => {
    setCopyStatus((await copyToClipboard(command)) ? 'copied' : 'failed');
  };
  return (
    <section className="terminal-command" aria-label="Terminal command">
      <div className="terminal-command__header">
        <span>
          <TerminalGlyph /> {stationName}
        </span>
        <ActionRow
          overflowLabel="More command actions"
          secondary={
            <Button
              variant="ghost"
              aria-label="Copy command"
              title="Copy command"
              onClick={() => void copy()}
            >
              <CopyGlyph />
            </Button>
          }
          primary={
            <OpenStationTerminalButton
              authority={authority}
              onOpen={() => void copy()}
            />
          }
        />
      </div>
      <pre>
        <code>{command}</code>
      </pre>
      {copyStatus && (
        <p role="status">
          {copyStatus === 'copied'
            ? 'Copied. Paste it into the terminal.'
            : 'Select and copy the command above.'}
        </p>
      )}
    </section>
  );
}
