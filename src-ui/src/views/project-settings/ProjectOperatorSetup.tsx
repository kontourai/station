import type { OperatorSetupReceipt } from '@kontourai/station-contracts/project';
import {
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { errorText } from '../../utils/errorText';

type Intent = {
  id: string;
  expectedProjectId: string;
  command: string;
  inputPaths: string[];
};

export function ProjectOperatorSetup({
  slug,
  projectId,
  authority,
}: {
  slug: string;
  projectId: string;
  authority: ApiRequestScope & { draftRecoveryKey?: string };
}) {
  const storageKey = JSON.stringify([
    'operator-setup',
    authority.apiBase,
    authority.draftRecoveryKey,
    projectId,
  ]);
  const [intent, setIntent] = useState<Intent | null>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      const value: unknown = stored ? JSON.parse(stored) : null;
      if (
        !value ||
        typeof value !== 'object' ||
        !('id' in value) ||
        typeof value.id !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(value.id) ||
        !('expectedProjectId' in value) ||
        value.expectedProjectId !== projectId ||
        !('command' in value) ||
        typeof value.command !== 'string' ||
        !('inputPaths' in value) ||
        !Array.isArray(value.inputPaths) ||
        !value.inputPaths.every((path: unknown) => typeof path === 'string')
      )
        return null;
      return {
        id: value.id,
        expectedProjectId: projectId,
        command: value.command,
        inputPaths: value.inputPaths,
      };
    } catch {
      return null;
    }
  });
  const [command, setCommand] = useState(intent?.command ?? '');
  const [paths, setPaths] = useState(
    intent?.inputPaths.join('\n') ??
      'package.json\npnpm-lock.yaml\npackage-lock.json\nyarn.lock',
  );
  const [authorized, setAuthorized] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const commandId = useId(),
    pathsId = useId(),
    authorizeId = useId();
  const client = useQueryClient();
  const key = [
    'operator-setup',
    authority.apiBase,
    authority.authorityKey,
    projectId,
    intent?.id,
  ];
  const base = `${authority.apiBase}/api/projects/${encodeURIComponent(slug)}/operator-setup`;
  const preview = useMutation({
    retry: false,
    mutationFn: async (request: Intent) => {
      const response = await mutateJson(
        `${base}/preview`,
        'POST',
        { requestScope: authority },
        request,
      );
      return readEnvelopeOrThrow<OperatorSetupReceipt>(response);
    },
    onSuccess: (data) => client.setQueryData(key, data),
  });
  const status = useQuery({
    queryKey: key,
    enabled: Boolean(intent) && !preview.isPending,
    retry: false,
    queryFn: async () =>
      readEnvelopeOrThrow<OperatorSetupReceipt>(
        await getJson(`${base}/${intent?.id}`, { requestScope: authority }),
      ),
  });
  const execute = useMutation({
    retry: false,
    mutationFn: async () => {
      const response = await mutateJson(
        `${base}/${intent?.id}/run`,
        'POST',
        { requestScope: authority, timeoutMs: 60000 },
        { authorize: true },
      );
      return readEnvelopeOrThrow<OperatorSetupReceipt>(response);
    },
    onSuccess: (data) => client.setQueryData(key, data),
    onSettled: () => {
      setAuthorized(false);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const receipt = status.data;
  const busy = preview.isPending || execute.isPending;
  return (
    <section
      className="project-sources__form"
      aria-label="Reviewed operator setup"
    >
      <h3>Review and run setup</h3>
      <p>
        Optional setup runs as your account on this Station, with its network
        and credentials. Enter a command you trust. It can change files and
        install dependencies. Station does not sandbox it.
      </p>
      <label htmlFor={commandId}>Setup command</label>
      <textarea
        id={commandId}
        value={command}
        disabled={Boolean(intent) || busy}
        onChange={(event) => setCommand(event.target.value)}
      />
      <label htmlFor={pathsId}>
        Input files to track, one repository-relative path per line
      </label>
      <textarea
        id={pathsId}
        value={paths}
        disabled={Boolean(intent) || busy}
        onChange={(event) => setPaths(event.target.value)}
      />
      <p>
        Include every file that affects this command. Only these files, the
        execution root and Git HEAD are checked for freshness. Environment and
        remote dependency changes are not tracked. Commands have a 30-second
        deadline and bounded output; output is not retained. Same-process-group
        background children are stopped when the shell exits. Processes that
        deliberately leave the group are not contained. Another writer can
        change inputs after the check. Reviewed setup currently requires a POSIX
        host.
      </p>
      {!intent && (
        <Button
          disabled={!command.trim() || !paths.trim()}
          onClick={() => {
            const next = {
              id: crypto.randomUUID(),
              expectedProjectId: projectId,
              command: command.trim(),
              inputPaths: paths
                .split('\n')
                .map((p) => p.trim())
                .filter(Boolean),
            };
            try {
              sessionStorage.setItem(storageKey, JSON.stringify(next));
            } catch {
              setStorageError(true);
              return;
            }
            setIntent(next);
            setAuthorized(false);
            preview.mutate(next);
          }}
        >
          Preview setup
        </Button>
      )}
      {storageError && (
        <p role="alert">
          Could not retain the setup ID in this browser. Setup has not started.
        </p>
      )}
      {intent && (
        <>
          <p>Setup operation: {intent.id}</p>
          {receipt && (
            <>
              <p role="status">Setup: {receipt.phase}</p>
              <p>
                Execution root: <code>{receipt.cwd}</code>
              </p>
              <p>
                Commit: <code>{receipt.sourceCommit}</code>
              </p>
              <pre>{receipt.command}</pre>
              <ul>
                {receipt.inputs.map((input) => (
                  <li key={input.path}>
                    {input.path}: {input.sha256 ?? 'absent'}
                  </li>
                ))}
              </ul>
              {receipt.phase === 'previewed' && (
                <>
                  <label htmlFor={authorizeId}>
                    <input
                      id={authorizeId}
                      type="checkbox"
                      checked={authorized}
                      disabled={busy}
                      onChange={(event) => setAuthorized(event.target.checked)}
                    />{' '}
                    I authorize this exact command on this Station.
                  </label>
                  <Button
                    disabled={!authorized || busy}
                    onClick={() => execute.mutate()}
                  >
                    Run reviewed setup
                  </Button>
                </>
              )}
              {(receipt.phase === 'running' ||
                receipt.phase === 'uncertain') && (
                <p>
                  The command may still be running, or its outcome is unknown
                  after interruption. Inspect the workspace before starting a
                  new preview. This operation will not run again.
                </p>
              )}
              {receipt.phase === 'stale' && (
                <p>
                  Tracked inputs or the execution root changed. Review a new
                  preview; existing files are preserved.
                </p>
              )}
              {receipt.phase === 'failed' && (
                <p>
                  Setup failed (exit {receipt.exitCode}). Files may have
                  changed. Inspect the workspace before authorizing another
                  command.
                </p>
              )}
              {receipt.phase === 'succeeded' && (
                <p>
                  The command exited successfully. This does not certify build
                  or test readiness.
                </p>
              )}
            </>
          )}
          {(preview.isError || status.isError || execute.isError) && (
            <p role="alert">
              {errorText(execute.error ?? preview.error ?? status.error)} Check
              the retained outcome before retrying.
            </p>
          )}
          <Button disabled={busy} onClick={() => void status.refetch()}>
            Check setup outcome
          </Button>
          {!receipt && preview.isError && (
            <Button disabled={busy} onClick={() => preview.mutate(intent)}>
              Retry preview
            </Button>
          )}
          <Button
            disabled={busy || receipt?.phase === 'running'}
            onClick={() => {
              try {
                sessionStorage.removeItem(storageKey);
              } catch {
                setStorageError(true);
                return;
              }
              setIntent(null);
              setAuthorized(false);
              preview.reset();
              execute.reset();
            }}
          >
            New setup preview
          </Button>
        </>
      )}
    </section>
  );
}
