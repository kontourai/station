/**
* the SSH computer creator 
 *
 * Before this, "Add computer → Run work on another computer over SSH" opened
 * `SshEnvironmentSetupModal`, which in a browser was a dead end ("available
 * in the Station desktop app") and on desktop created a *saved connection*
 * with an SSH forward — never an SSH environment profile. `GET
 * /api/environments/ssh` therefore stayed empty on every platform, so the
 * only way to populate a first-class Connections section was an agent tool
 * or curl. This is the missing creator.
 *
 * Three rules it keeps:
 *
 * - **Nothing is claimed that the server did not observe.** "Test connection"
*   calls `POST /api/environments/ssh/probe`, and the sentence rendered on
*   success or failure is the server's own `summary`/`action` from the
* readiness-evidence shape — not a string composed here. defect
*   was a free-text action line that named neither cause nor next step.
 * - **Save follows a real observation.** The primary action stays disabled
*   until a probe actually reached the computer, and says why.
 * - **One dialog chrome.** The shared `Dialog` (backdrop, centring, focus
* containment, Escape, mobile sheet geometry) — was this flow
*   floating uncentred with no scrim while its own chooser dimmed the page.
 *
 * Field scope, deliberately (deviation from the lane design's "host · user ·
 * auth · port", disclosed): a saved SSH environment carries a host, a remote
 * project path and the remote Station port — and nothing else. User, port
 * and authentication come from the operator's resolvable SSH config, which
 * is what OpenSSH itself will use at connect time. Collecting them here
 * would be collecting values Station discards. Instead the probe REPORTS
 * them (`resolved`), so the user still sees the user/port/auth this computer
 * will connect as — derived, not typed.
 */

import {
  type SshReachabilityEvidence,
  useCreateSshEnvironmentMutation,
  useOpenSshHostsQuery,
  useProbeSshEnvironmentMutation,
} from '@kontourai/station-sdk';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { HostAction } from '../../components/host-action/HostAction';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { copyToClipboard } from '../../lib/clipboard';
import './SshComputerCreatorDialog.css';

const AUTH_LABEL: Record<
  NonNullable<SshReachabilityEvidence['resolved']>['identityAgent'],
  string
> = {
  default: 'key from your SSH agent',
  configured: 'key from the agent named in your SSH config',
  disabled: 'key file from your SSH config',
};

export interface SshComputerCreatorDialogProps {
  onClose: () => void;
/** Focus returns here when the dialog closes (the chooser's entry button). */
  returnFocusTarget?: HTMLElement | null;
}

export function SshComputerCreatorDialog({
  onClose,
}: SshComputerCreatorDialogProps) {
  const fieldId = useId();
  const devicePresentation = useDevicePresentation();
  const hosts = useOpenSshHostsQuery();
  const probe = useProbeSshEnvironmentMutation();
  const create = useCreateSshEnvironmentMutation();
  const [host, setHost] = useState('');
  const [projectPath, setProjectPath] = useState('~');
  const [stationPort, setStationPort] = useState('');
  const [name, setName] = useState('');
  const [evidence, setEvidence] = useState<SshReachabilityEvidence | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const trimmedHost = host.trim();
// A probe is bound to the host it observed: editing the host retires it
// (`editHost` clears `evidence`), so Save can never ride a receipt for a
// different computer.
  const reachable = evidence?.reachable === true;

  async function test() {
    setFailure(null);
    setEvidence(null);
    try {
      setEvidence(await probe.mutateAsync(trimmedHost));
    } catch (cause) {
      setFailure(
        cause instanceof Error
          ? cause.message
          : 'The connection test could not run.',
      );
    }
  }

  async function save() {
    setFailure(null);
    const port = stationPort.trim();
    try {
      await create.mutateAsync({
        hostAlias: trimmedHost,
        remoteProjectPath: projectPath.trim() || '~',
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(port ? { remotePort: Number(port) } : {}),
      });
      onClose();
    } catch (cause) {
      setFailure(
        cause instanceof Error
          ? cause.message
          : 'This computer could not be saved.',
      );
    }
  }

  function editHost(value: string) {
    setHost(value);
    setEvidence(null);
    setFailure(null);
    setCopied(false);
    setCopyFailed(false);
  }

  async function copyTrustCommand(command: string) {
    const ok = await copyToClipboard(command);
    setCopied(ok);
    setCopyFailed(!ok);
  }

  return (
    <Dialog
      eyebrow="Add a computer"
      title="Run work on another computer over SSH"
      subtitle="Station signs in over SSH and runs delegated tasks there, using that computer's own agents and files."
      closeLabel="Close SSH computer setup"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => void test()}
            disabled={!trimmedHost || probe.isPending}
            pending={probe.isPending}
            pendingLabel="Testing…"
          >
            Test connection
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={!reachable || create.isPending}
            pending={create.isPending}
            pendingLabel="Saving…"
          >
            Save computer
          </Button>
        </>
      }
    >
      <div className="ssh-computer-creator">
        <label className="editor-field" htmlFor={`${fieldId}-host`}>
          <span className="editor-label">Computer</span>
          <input
            id={`${fieldId}-host`}
            className="editor-input"
            value={host}
            list={`${fieldId}-hosts`}
            placeholder="box-b, or 192.168.1.20"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => editHost(event.target.value)}
          />
          <span className="editor-hint">
            A host from this computer's SSH config, or an address Station can
            reach. The user, port and key come from that SSH config — the test
            below reports which ones it used.
          </span>
        </label>
        <datalist id={`${fieldId}-hosts`}>
          {(hosts.data?.hosts ?? []).map((entry) => (
            <option key={entry.alias} value={entry.alias}>
              {entry.user}@{entry.hostname}
            </option>
          ))}
        </datalist>

        <label className="editor-field" htmlFor={`${fieldId}-path`}>
          <span className="editor-label">Project folder on that computer</span>
          <input
            id={`${fieldId}-path`}
            className="editor-input"
            value={projectPath}
            placeholder="~/code/my-project"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setProjectPath(event.target.value)}
          />
        </label>

        <label className="editor-field" htmlFor={`${fieldId}-name`}>
          <span className="editor-label">
            Name <span className="editor-hint">optional</span>
          </span>
          <input
            id={`${fieldId}-name`}
            className="editor-input"
            value={name}
            placeholder="Build box"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="editor-field" htmlFor={`${fieldId}-port`}>
          <span className="editor-label">
            Station port on that computer{' '}
            <span className="editor-hint">optional · defaults to 3141</span>
          </span>
          <input
            id={`${fieldId}-port`}
            className="editor-input"
            value={stationPort}
            inputMode="numeric"
            placeholder="3141"
            onChange={(event) =>
              setStationPort(event.target.value.replace(/[^0-9]/g, ''))
            }
          />
        </label>

        {evidence && (
          <div
            className={`ssh-computer-creator__result ssh-computer-creator__result--${
              evidence.reachable ? 'ready' : 'error'
            }`}
            role={evidence.reachable ? 'status' : 'alert'}
          >
            <strong>{evidence.reachable ? 'Reached' : 'Not reached'}</strong>
{/* The server's own sentence, never a state word composed here. */}
            <span>{evidence.summary}</span>
            {evidence.action && <span>{evidence.action}</span>}
            {evidence.resolved && (
              <span className="ssh-computer-creator__resolved">
                Signing in as {evidence.resolved.user} on port{' '}
                {evidence.resolved.port} ·{' '}
                {AUTH_LABEL[evidence.resolved.identityAgent]}
              </span>
            )}
{/*
              Station will not record this key, so the dialog hands over the
              two things the operator needs to decide for themselves: the
              fingerprint to read out to whoever owns that computer, and the
              exact command that records it. Both come from the server's
              `unknownHost` — the sentence above and this button cannot
              disagree, because `action` is composed from `trustCommand`.
*/}
            {evidence.unknownHost && (
              <div className="ssh-computer-creator__host-key">
{/*
                  #3843 T1: the fingerprint sits OUTSIDE the HostAction on
                  purpose. Verifying it is something a person does by voice
                  with whoever owns that computer, and that works from a
                  phone in another room exactly as well as from the host —
                  so it stays visible in both device classes. Only the
                  command changes: it appends a line to a known_hosts file on
                  the machine `ssh` runs from, which nothing a paired browser
                  can do will reach.
*/}
                <code className="ssh-computer-creator__fingerprint">
                  {evidence.unknownHost.keyType}{' '}
                  {evidence.unknownHost.fingerprint}
                </code>
                <HostAction
                  id="ssh-trust-command"
                  presentation={devicePresentation}
                  command={evidence.unknownHost.trustCommand}
                >
                  <Button
                    size="sm"
                    className={
                      copyFailed ? 'copy-affordance--failed' : undefined
                    }
                    onClick={() =>
                      void copyTrustCommand(
                        evidence.unknownHost?.trustCommand ?? '',
                      )
                    }
                  >
                    {copied
                      ? 'Copied'
                      : copyFailed
                        ? "Can't copy"
                        : 'Copy command'}
                  </Button>
                </HostAction>
              </div>
            )}
          </div>
        )}
        {!evidence && (
          <p className="editor-hint" role="status">
            Test the connection before saving — Station only saves a computer it
            has reached.
          </p>
        )}
        {failure && (
          <p className="ssh-computer-creator__failure" role="alert">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
