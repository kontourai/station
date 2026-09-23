import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { copyToClipboard } from '../../lib/clipboard';
import {
  PluginPublishError,
  type PluginPublishInspection,
  type PluginPublishResult,
  pluginPublishInspectionKey,
  publishProjectPlugin,
} from './pluginPublishClient';
import './PluginPublishDialog.css';

type PluginInspection = Extract<
  PluginPublishInspection,
  { plugin: { name: string } }
>;

const NEW_REMOTE = '\u0000new';
const MAX_LISTED_CHANGES = 50;

const REMOTE_REFUSALS: Record<string, string> = {
  'credentials-in-url': 'its address holds a password or token',
  'unsupported-transport': 'it is not an https or SSH address',
  malformed: 'Station does not recognise its address',
  'local-host': 'it points at this computer or a local-only address',
  empty: 'it has no address',
};

function statusLabel(status: string): string {
  if (status === '??' || status.includes('A')) return 'new';
  if (status.includes('D')) return 'deleted';
  if (status.includes('R')) return 'renamed';
  return 'changed';
}

function CopyField({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="plugin-publish__copy">
      <label className="editor-label" htmlFor={id}>
        {label}
      </label>
      <div className="plugin-publish__copy-row">
        <input
          id={id}
          className="editor-input plugin-publish__mono"
          readOnly
          value={value}
        />
        <Button
          variant="secondary"
          onClick={async () =>
            setCopy((await copyToClipboard(value)) ? 'copied' : 'failed')
          }
        >
          Copy
        </Button>
      </div>
      {copy !== 'idle' && (
        <p className="editor-hint" role="status">
          {copy === 'copied'
            ? 'Copied.'
            : "Couldn't copy. Select the text and copy it."}
        </p>
      )}
    </div>
  );
}

function Published({ result }: { result: PluginPublishResult }) {
  return (
    <div className="plugin-publish">
      <p>
        Published <strong>{result.plugin.name}</strong> {result.plugin.version}{' '}
        to <code className="plugin-publish__mono">{result.remote.url}</code> (
        {result.branch}).
        {result.commit === null && ' There were no new changes to commit.'}
      </p>
      <CopyField label="Install source" value={result.installSource} />
      {result.installSourceDerived && (
        <p className="editor-hint">
          This https address is worked out from the SSH remote. It works if the
          host also serves the repository over https.
        </p>
      )}
      <CopyField label="Install with the CLI" value={result.installCommand} />
      <p className="editor-hint">
        In Station, use Plugins → Install plugin with the install source.
        Installs from it update by pulling new commits.
      </p>
    </div>
  );
}

function refusedRepositoryMessage(repository: {
  code: string;
  keys?: string[];
}): string {
  if (repository.code === 'repository-config-refused') {
    const keys = repository.keys ?? [];
    return `This folder's .git/config sets options Station will not run git with, because others can write to this folder and publishing uses this computer's credentials${keys.length > 0 ? `: ${keys.join(', ')}` : ''}. Remove them, then check again.`;
  }
  if (repository.code === 'git-dir-not-directory') {
    return "This folder's .git is a file or link, or redirects to another git directory. Station only publishes a folder that is its own repository.";
  }
  return 'git could not read this folder as a repository. Check it with git from this computer.';
}

export function PluginPublishDialog({
  apiBase,
  projectSlug,
  inspection,
  onClose,
}: {
  apiBase: string;
  projectSlug: string;
  inspection: PluginInspection;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { plugin, repository, changes, secrets, tooManyChanges } = inspection;
  const remotes = repository.state === 'root' ? repository.remotes : [];
  const firstUsable = remotes.find((remote) => remote.usable);
  const [remoteChoice, setRemoteChoice] = useState(
    firstUsable?.name ?? NEW_REMOTE,
  );
  const [newRemoteName, setNewRemoteName] = useState(
    remotes.some((remote) => remote.name === 'origin') ? 'publish' : 'origin',
  );
  const [newRemoteUrl, setNewRemoteUrl] = useState('');
  const [message, setMessage] = useState(
    `Publish ${plugin.name} ${plugin.version}`,
  );
  const ids = { message: useId(), name: useId(), url: useId() };

  const publish = useMutation({
    mutationFn: () =>
      publishProjectPlugin(
        apiBase,
        projectSlug,
        remoteChoice === NEW_REMOTE
          ? {
              message,
              remoteName: newRemoteName.trim(),
              remoteUrl: newRemoteUrl.trim(),
            }
          : { message, remoteName: remoteChoice },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: pluginPublishInspectionKey(apiBase, projectSlug),
      }),
  });

  const blocker =
    repository.state === 'refused'
      ? refusedRepositoryMessage(repository)
      : repository.state === 'nested'
        ? 'This folder is inside another git repository. Publishing would push that whole repository, so move the plugin into a folder of its own first.'
        : repository.state === 'root' && repository.branch === null
          ? 'This folder is not on a branch (detached HEAD). Check out a branch, then publish.'
          : tooManyChanges
            ? 'More than 1000 files would be committed. Add build output and dependencies (such as node_modules) to .gitignore.'
            : null;
  const failure =
    publish.error instanceof PluginPublishError ? publish.error : null;
  const flagged = secrets.length > 0 ? secrets : (failure?.secrets ?? []);
  const incomplete =
    message.trim() === '' ||
    (remoteChoice === NEW_REMOTE &&
      (newRemoteName.trim() === '' || newRemoteUrl.trim() === ''));

  if (publish.data) {
    return (
      <Dialog
        title="Plugin published"
        closeLabel="Close publish plugin"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <Published result={publish.data} />
      </Dialog>
    );
  }

  return (
    <Dialog
      eyebrow="Publish to git"
      title={`${plugin.name} ${plugin.version}`}
      subtitle="Commit this folder and push it to a git remote. The remote's address then installs and updates the plugin anywhere."
      closeLabel="Close publish plugin"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              blocker !== null ||
              secrets.length > 0 ||
              incomplete ||
              publish.isPending
            }
            onClick={() => publish.mutate()}
          >
            {publish.isPending ? 'Publishing…' : 'Commit and push'}
          </Button>
        </>
      }
    >
      <div className="plugin-publish">
        {blocker && (
          <p className="plugin-publish__alert" role="alert">
            {blocker}
          </p>
        )}
        {repository.state === 'none' && (
          <p className="editor-hint">
            This folder is not a git repository yet. Publishing runs git init
            (branch main) first.
          </p>
        )}

        {flagged.length > 0 && (
          <div className="plugin-publish__alert" role="alert">
            <p>
              These files look like secrets and would be committed. Add them to
              .gitignore or remove them, then check again.
            </p>
            <ul>
              {flagged.map((secret) => (
                <li key={secret.path}>
                  <code className="plugin-publish__mono">{secret.path}</code> —{' '}
                  {secret.reason}
                </li>
              ))}
            </ul>
            <Button
              variant="secondary"
              onClick={() => {
                publish.reset();
                void queryClient.invalidateQueries({
                  queryKey: pluginPublishInspectionKey(apiBase, projectSlug),
                });
              }}
            >
              Check again
            </Button>
          </div>
        )}

        <section aria-label="What will be committed">
          <p className="editor-label">
            {changes.length === 0
              ? 'Nothing new to commit. Publishing pushes the existing commits.'
              : `${changes.length} file${changes.length === 1 ? '' : 's'} will be committed`}
          </p>
          {changes.length > 0 && (
            <ul className="plugin-publish__changes">
              {changes.slice(0, MAX_LISTED_CHANGES).map((change) => (
                <li key={`${change.status}:${change.path}`}>
                  <span className="plugin-publish__status">
                    {statusLabel(change.status)}
                  </span>
                  <code className="plugin-publish__mono">{change.path}</code>
                </li>
              ))}
              {changes.length > MAX_LISTED_CHANGES && (
                <li>…and {changes.length - MAX_LISTED_CHANGES} more</li>
              )}
            </ul>
          )}
          <p className="editor-hint">
            Station checks file names (.env, keys, credential files) and looks
            for private-key blocks. It is not an exhaustive secret scan: read
            the list above before you publish.
          </p>
        </section>

        <fieldset className="plugin-publish__remotes">
          <legend className="editor-label">Push to</legend>
          {remotes.map((remote) => (
            <label key={remote.name} className="plugin-publish__remote">
              <input
                type="radio"
                name="plugin-publish-remote"
                value={remote.name}
                checked={remoteChoice === remote.name}
                disabled={!remote.usable}
                onChange={() => setRemoteChoice(remote.name)}
              />
              <span>
                {remote.name}{' '}
                <code className="plugin-publish__mono">{remote.url}</code>
                {!remote.usable && (
                  <span className="editor-hint">
                    {' '}
                    Can't publish here:{' '}
                    {REMOTE_REFUSALS[remote.refusal ?? ''] ??
                      'its address is refused'}
                    .
                  </span>
                )}
              </span>
            </label>
          ))}
          <label className="plugin-publish__remote">
            <input
              type="radio"
              name="plugin-publish-remote"
              value={NEW_REMOTE}
              checked={remoteChoice === NEW_REMOTE}
              onChange={() => setRemoteChoice(NEW_REMOTE)}
            />
            <span>A new remote</span>
          </label>
          {remoteChoice === NEW_REMOTE && (
            <div className="plugin-publish__new-remote">
              <label className="editor-label" htmlFor={ids.name}>
                Remote name
              </label>
              <input
                id={ids.name}
                className="editor-input"
                value={newRemoteName}
                onChange={(event) => setNewRemoteName(event.target.value)}
              />
              <label className="editor-label" htmlFor={ids.url}>
                Repository address
              </label>
              <input
                id={ids.url}
                className="editor-input plugin-publish__mono"
                placeholder="https://github.com/you/plugin.git"
                value={newRemoteUrl}
                onChange={(event) => setNewRemoteUrl(event.target.value)}
              />
              <p className="editor-hint">
                An https or SSH address (git@host:owner/repo.git) of an existing
                repository. No passwords or tokens: the push uses this
                computer's git credentials.
              </p>
            </div>
          )}
        </fieldset>

        <label className="editor-label" htmlFor={ids.message}>
          Commit message
        </label>
        <textarea
          id={ids.message}
          className="editor-input"
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <p className="editor-hint">
          Station never force-pushes. If the remote has commits this folder does
          not, publishing stops and asks you to bring them in first.
        </p>

        {publish.error && failure?.code !== 'secrets' && (
          <p className="plugin-publish__alert" role="alert">
            {publish.error.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
