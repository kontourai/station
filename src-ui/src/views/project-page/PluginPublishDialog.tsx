import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { copyToClipboard } from '../../lib/clipboard';
import {
  PluginPublishError,
  type PluginPublishInspection,
  type PluginPublishResult,
  type PluginPublishSkip,
  pluginPublishInspectionKey,
  publishProjectPlugin,
} from './pluginPublishClient';
import './PluginPublishDialog.css';

type PluginInspection = Extract<
  PluginPublishInspection,
  { plugin: { name: string } }
>;

const MAX_LISTED_FILES = 50;

const SKIP_REASONS: Record<PluginPublishSkip['reason'], string> = {
  'symbolic-link': 'a link; Station does not follow links',
  'special-file': 'not a regular file',
  'git-metadata': "git's own data, never published",
};

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
        to <code className="plugin-publish__mono">{result.remoteUrl}</code> (
        {result.branch}).
        {result.commit === null
          ? ' The branch already had exactly these files, so nothing new was pushed.'
          : ` Commit ${result.commit.slice(0, 12)} by ${result.committer.name}.`}
      </p>
      <CopyField label="Install source" value={result.installSource} />
      {result.installSourceDerived && (
        <p className="editor-hint">
          This https address is worked out from the SSH address. It works if the
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
  const { plugin, files, skipped, secrets, refusal } = inspection;
  const [remoteUrl, setRemoteUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [message, setMessage] = useState(
    `Publish ${plugin.name} ${plugin.version}`,
  );
  const ids = { url: useId(), branch: useId(), message: useId() };

  const publish = useMutation({
    mutationFn: () =>
      publishProjectPlugin(apiBase, projectSlug, {
        remoteUrl: remoteUrl.trim(),
        branch: branch.trim(),
        message,
      }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: pluginPublishInspectionKey(apiBase, projectSlug),
      }),
  });

  const failure =
    publish.error instanceof PluginPublishError ? publish.error : null;
  const flagged = secrets.length > 0 ? secrets : (failure?.secrets ?? []);
  // A refusal as the folder stands, other than secrets (listed below).
  const blocker = refusal && refusal.code !== 'secrets' ? refusal : null;
  const incomplete =
    remoteUrl.trim() === '' || branch.trim() === '' || message.trim() === '';
  const checkAgain = () => {
    publish.reset();
    void queryClient.invalidateQueries({
      queryKey: pluginPublishInspectionKey(apiBase, projectSlug),
    });
  };

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
      subtitle="Publish this folder's files as one commit to a git repository. Its address then installs and updates the plugin anywhere."
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
              files.length === 0 ||
              incomplete ||
              publish.isPending
            }
            onClick={() => publish.mutate()}
          >
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="plugin-publish">
        {blocker && (
          <div className="plugin-publish__alert" role="alert">
            <p>{blocker.message ?? 'This folder cannot be published.'}</p>
            {(blocker.paths?.length ?? 0) > 0 && (
              <ul>
                {blocker.paths?.map((path) => (
                  <li key={path}>
                    <code className="plugin-publish__mono">{path}</code>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="secondary" onClick={checkAgain}>
              Check again
            </Button>
          </div>
        )}

        {flagged.length > 0 && (
          <div className="plugin-publish__alert" role="alert">
            <p>
              These files look like secrets and would be published. Add them to
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
            <Button variant="secondary" onClick={checkAgain}>
              Check again
            </Button>
          </div>
        )}

        <section aria-label="What will be published">
          <p className="editor-label">
            {files.length === 0
              ? 'No files to publish.'
              : `${files.length} file${files.length === 1 ? '' : 's'} will be published`}
          </p>
          {files.length > 0 && (
            <ul className="plugin-publish__changes">
              {files.slice(0, MAX_LISTED_FILES).map((file) => (
                <li key={file.path}>
                  <code className="plugin-publish__mono">{file.path}</code>
                </li>
              ))}
              {files.length > MAX_LISTED_FILES && (
                <li>…and {files.length - MAX_LISTED_FILES} more</li>
              )}
            </ul>
          )}
          {skipped.length > 0 && (
            <>
              <p className="editor-label">Left out</p>
              <ul className="plugin-publish__changes">
                {skipped.map((skip) => (
                  <li key={skip.path}>
                    <code className="plugin-publish__mono">{skip.path}</code>
                    <span className="plugin-publish__status">
                      {SKIP_REASONS[skip.reason] ?? skip.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="editor-hint">
            Files your .gitignore excludes are left out. Station checks these
            files' names (.env, keys, credential files) and looks for
            private-key blocks in them. It is not an exhaustive secret scan:
            read the list above before you publish.
          </p>
        </section>

        <label className="editor-label" htmlFor={ids.url}>
          Repository address
        </label>
        <input
          id={ids.url}
          className="editor-input plugin-publish__mono"
          placeholder="https://github.com/you/plugin.git"
          value={remoteUrl}
          onChange={(event) => setRemoteUrl(event.target.value)}
        />
        <p className="editor-hint">
          An https or SSH address (git@host:owner/repo.git) of an existing
          repository. No passwords or tokens: the push uses this computer's git
          credentials.
        </p>

        <label className="editor-label" htmlFor={ids.branch}>
          Branch
        </label>
        <input
          id={ids.branch}
          className="editor-input plugin-publish__mono"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
        />

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
          The commit goes on top of the branch as it is on the remote (or starts
          it, if it does not exist yet), with this computer's git name and
          email. Station never force-pushes, and it does not use or change this
          folder's own git history.
        </p>

        {publish.error && failure?.code !== 'secrets' && (
          <div className="plugin-publish__alert" role="alert">
            <p>{publish.error.message}</p>
            {(failure?.paths.length ?? 0) > 0 && (
              <ul>
                {failure?.paths.map((path) => (
                  <li key={path}>
                    <code className="plugin-publish__mono">{path}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
