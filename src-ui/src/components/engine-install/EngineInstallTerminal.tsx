import { useEngineInstallTerminal } from '@kontourai/station-sdk/engine-setup';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { Button } from '../Button';
import { TerminalPanel } from '../coding-layout/TerminalPanel';
import { ConfirmModal } from '../modals/ConfirmModal';
import { ErrorState, SkeletonBlock } from '../state';

export function EngineInstallTerminal({
  id,
  onFinished,
  installNeeded = true,
  onRunningChange,
}: {
  id: string;
  onFinished: () => void;
  installNeeded?: boolean;
  onRunningChange?: (running: boolean) => void;
}) {
  const scope = useHostRequestAuthorityScope();
  return scope ? (
    <ScopedInstaller
      key={`${scope.apiBase}:${scope.authorityKey}:${id}`}
      id={id}
      scope={scope}
      onFinished={onFinished}
      installNeeded={installNeeded}
      onRunningChange={onRunningChange}
    />
  ) : null;
}
function ScopedInstaller({
  id,
  scope,
  onFinished,
  installNeeded,
  onRunningChange,
}: {
  id: string;
  installNeeded: boolean;
  onRunningChange?: (running: boolean) => void;
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  onFinished: () => void;
}) {
  const { query, start, stop, offered } = useEngineInstallTerminal(id, scope);
  const { navigate } = useNavigationActions();
  const request = useRef<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    command: string;
    operationId: string;
  } | null>(null);
  const activeTerminal = useRef<string | null>(null);
  const view = query.data;
  const terminal = view?.terminal;
  const running =
    terminal?.status === 'running' || terminal?.status === 'starting';
  useEffect(() => {
    onRunningChange?.(query.isPending || running);
    return () => onRunningChange?.(false);
  }, [query.isPending, running, onRunningChange]);
  useEffect(() => {
    if (
      start.error &&
      terminal &&
      terminal.operationId === request.current &&
      (terminal.status === 'running' || terminal.exitCode === 0)
    )
      start.reset();
  }, [terminal, start.error, start.reset]);
  useEffect(() => {
    if (running && terminal) activeTerminal.current = terminal.terminalId;
    if (
      terminal?.status === 'exited' &&
      terminal.exitCode === 0 &&
      (activeTerminal.current === terminal.terminalId ||
        request.current === terminal.operationId)
    ) {
      activeTerminal.current = null;
      request.current = null;
      onFinished();
    }
  }, [terminal, running, onFinished]);
  if ((!offered && !terminal) || (!installNeeded && !running)) return null;
  if (query.isPending) return <SkeletonBlock />;
  if (query.isError)
    return (
      <ErrorState
        title="Couldn't load installer"
        action={<Button onClick={() => void query.refetch()}>Retry</Button>}
      />
    );
  if (!view) return null;

  return (
    <div className="editor-field">
      <ConfirmModal
        isOpen={confirmation !== null}
        title={`Install ${view.name}`}
        message={`Downloads and runs this installer on the Station computer:\n\n${confirmation?.command ?? ''}`}
        confirmLabel="Install"
        cancelLabel="Cancel"
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (confirmation) start.mutate(confirmation);
          setConfirmation(null);
        }}
      />
      {!view.allowed && !terminal ? (
        <p className="editor-help">
          Allow this device to run and view terminals to install here.
          <Button
            size="sm"
            onClick={() => navigate('/settings?view=devices&highlight=pairing')}
          >
            Device access
          </Button>
        </p>
      ) : (
        <>
          <p className="editor-help">
            Review and run this installer on the Station computer.
          </p>
          {running && view.canStop ? (
            <Button
              pending={stop.isPending}
              onClick={() => {
                if (terminal?.operationId)
                  stop.mutate({
                    terminalId: terminal.terminalId,
                    operationId: terminal.operationId,
                  });
              }}
            >
              Stop installation
            </Button>
          ) : view.allowed && !running ? (
            <Button
              pending={start.isPending}
              onClick={() => {
                if (
                  !request.current ||
                  (terminal &&
                    terminal.operationId === request.current &&
                    (terminal.status === 'exited' ||
                      terminal.status === 'failed'))
                )
                  request.current = randomCorrelationId();
                setConfirmation({
                  command: view.command,
                  operationId: request.current,
                });
              }}
            >
              {terminal
                ? 'Retry installation'
                : `Install ${view.name} on Station`}
            </Button>
          ) : null}
          {terminal ? (
            <>
              <p role="status">
                {running
                  ? 'Installing…'
                  : terminal.exitCode === 0
                    ? 'Installer finished.'
                    : 'Installation ended. Review the terminal before retrying.'}
              </p>
              <div className="engine-sign-in__terminal">
                <TerminalPanel
                  projectSlug={terminal.projectSlug}
                  target={{
                    projectId: terminal.projectId,
                    bindingKey: terminal.bindingKey,
                  }}
                  terminalId={terminal.terminalId}
                  workingDir="~"
                  attachOnly
                  isActive
                />
              </div>
            </>
          ) : null}
        </>
      )}
      {start.error || stop.error ? (
        <ErrorState
          title="Check installation status"
          description={(start.error ?? stop.error)?.message}
          action={
            <Button onClick={() => void query.refetch()}>Check status</Button>
          }
        />
      ) : null}
    </div>
  );
}
