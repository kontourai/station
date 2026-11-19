import type { RepositoryProvider } from '@kontourai/station-contracts/project';
import { REPOSITORY_SIGN_IN_COMMANDS } from '@kontourai/station-contracts/terminal-transport';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { copyToClipboard } from '../lib/clipboard';
import { useDockProject } from '../workspace-panes/useDockProject';
import { ActionRow } from './ActionRow';
import { Button } from './Button';
import { TerminalPanel } from './coding-layout/TerminalPanel';
import { CopyGlyph, PlayGlyph, TerminalGlyph } from './icons/Glyph';
import './TerminalCommandAction.css';

export function TerminalCommandAction({
  provider,
  authority,
  stationName,
}: {
  provider: RepositoryProvider;
  authority: ApiRequestScope;
  stationName: string;
}) {
  const host = useHostRequestAuthorityScope();
  const { projectId, projectSlug } = useDockProject();
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>();
  const [runTarget, setRunTarget] = useState<{
    projectId: string;
    projectSlug: string;
  }>();
  const [terminalId, setTerminalId] = useState<string>();
  const command = REPOSITORY_SIGN_IN_COMMANDS[provider].join(' ');
  const targetMatches = Boolean(
    host?.apiBase === authority.apiBase &&
      host.authorityKey === authority.authorityKey &&
      host.isCurrent(),
  );
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
              onClick={async () =>
                setCopyStatus(
                  (await copyToClipboard(command)) ? 'copied' : 'failed',
                )
              }
            >
              <CopyGlyph />
            </Button>
          }
          primary={
            targetMatches && projectSlug && projectId ? (
              <Button
                variant="ghost"
                aria-label="Run in terminal"
                title="Run in terminal"
                disabled={Boolean(runTarget)}
                onClick={() => {
                  if (host?.isCurrent())
                    setRunTarget({ projectId, projectSlug });
                }}
              >
                <PlayGlyph />
              </Button>
            ) : undefined
          }
        />
      </div>
      <pre>
        <code>{command}</code>
      </pre>
      {copyStatus && (
        <p role="status">
          {copyStatus === 'copied'
            ? 'Copied.'
            : 'Select and copy the command above.'}
        </p>
      )}
      {runTarget && targetMatches && (
        <div className="terminal-command__session">
          <TerminalPanel
            projectSlug={runTarget.projectSlug}
            workingDir=""
            viewKey="repository-sign-in"
            terminalId={terminalId}
            onOpened={setTerminalId}
            target={{ projectId: runTarget.projectId, bindingKey: 'project' }}
            launch={{ kind: 'repository-sign-in', provider }}
            ended={{
              message:
                'Sign-in command ended. Retry repositories to check access.',
            }}
            isActive
          />
        </div>
      )}
    </section>
  );
}
