import {
  isSafeToolServerCredentialKey,
  type UntrustedContentPermission,
} from '@kontourai/station-contracts/tool';
import type { IntegrationViewModel } from '@kontourai/station-sdk';
import { StatusBadge } from '@kontourai/ui/react';

const ENGINE_LABEL = {
  claude: 'Claude Code',
  codex: 'Codex',
  acp: 'ACP agents',
} as const;

const COVERAGE = {
  'station-gated': { label: 'Station applies these', tone: 'positive' },
  'engine-direct': { label: 'Direct connection', tone: 'caution' },
  'not-delivered': { label: 'Not offered', tone: 'neutral' },
} as const;

export function IntegrationTrustSection({
  form,
  locked,
  onUpdate,
}: {
  form: IntegrationViewModel;
  locked: boolean;
  onUpdate: (
    updater: (form: IntegrationViewModel) => IntegrationViewModel,
  ) => void;
}) {
  const names = [
    ...new Set([
      ...(form.probe?.tools?.map((tool) => tool.name) ??
        form.probe?.toolNames ??
        []),
      ...Object.keys(form.untrustedContentPermissions?.tools ?? {}),
      ...(form.builtinPolicy?.name === 'station_bash' ? ['bash'] : []),
      ...(form.builtinPolicy?.name === 'station_file_editor'
        ? ['fileEditor']
        : []),
      ...(form.builtinPolicy?.name === 'station_http_request'
        ? ['http_request']
        : []),
    ]),
  ].sort();
  return (
    <section
      className="agent-editor__section"
      aria-labelledby="integration-trust-heading"
    >
      <div className="agent-editor__section-header">
        <h3
          id="integration-trust-heading"
          className="agent-editor__section-title"
        >
          Content and tool permissions
        </h3>
        <p className="agent-editor__section-desc">
          Choose how Station treats content and later tool calls.
        </p>
      </div>
      <div className="editor-field">
        <label className="editor-label" htmlFor="integration-content-trust">
          Content classification
        </label>
        <select
          id="integration-content-trust"
          className="editor-select"
          disabled={locked}
          value={form.contentTrust ?? 'trusted'}
          onChange={(event) => {
            const choice = event.currentTarget.value as 'trusted' | 'untrusted';
            onUpdate((current) => ({ ...current, contentTrust: choice }));
          }}
        >
          <option value="trusted">Trusted</option>
          <option value="untrusted">Untrusted</option>
        </select>
        <p className="editor-field-hint">
          Choose untrusted for content written by others, such as email.
        </p>
      </div>
      <div className="editor-field">
        <label className="editor-label" htmlFor="integration-untrusted-default">
          Default after untrusted content
        </label>
        <select
          id="integration-untrusted-default"
          className="editor-select"
          disabled={locked}
          value={form.untrustedContentPermissions?.default ?? ''}
          onChange={(event) => {
            const choice = event.currentTarget.value;
            onUpdate((current) => {
              const permissions = { ...current.untrustedContentPermissions };
              if (choice)
                permissions.default = choice as UntrustedContentPermission;
              else delete permissions.default;
              return { ...current, untrustedContentPermissions: permissions };
            });
          }}
        >
          <option value="">Use Station default</option>
          <option value="ask">Ask</option>
          <option value="allow">Allow</option>
          <option value="deny">Deny</option>
        </select>
        <p className="editor-field-hint">
          The Station default asks, except for trusted read-only hints.
        </p>
      </div>
      {names.map((name, index) => (
        <div className="editor-field" key={name}>
          <label
            className="editor-label"
            htmlFor={`integration-untrusted-tool-${index}`}
          >
            {name} after untrusted content
          </label>
          <select
            id={`integration-untrusted-tool-${index}`}
            className="editor-select"
            disabled={locked || !isSafeToolServerCredentialKey(name)}
            value={form.untrustedContentPermissions?.tools?.[name] ?? ''}
            onChange={(event) => {
              const choice = event.currentTarget.value;
              onUpdate((current) => {
                const tools = { ...current.untrustedContentPermissions?.tools };
                if (choice) tools[name] = choice as UntrustedContentPermission;
                else delete tools[name];
                return {
                  ...current,
                  untrustedContentPermissions: {
                    ...current.untrustedContentPermissions,
                    tools,
                  },
                };
              });
            }}
          >
            <option value="">Use default</option>
            <option value="ask">Ask</option>
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
          {!isSafeToolServerCredentialKey(name) && (
            <p className="editor-field-hint">
              This tool name cannot be configured individually.
            </p>
          )}
        </div>
      ))}
      <label className="integration-trust-hints">
        <input
          type="checkbox"
          disabled={locked}
          checked={form.trustReadOnlyHints === true}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            onUpdate((current) => ({
              ...current,
              trustReadOnlyHints: checked,
            }));
          }}
        />
        Trust read-only hints
      </label>
      <p className="agent-editor__section-desc">
        {form.contentTrust === 'untrusted'
          ? 'A server supplies its own read-only hints. Trust them only if you trust the server.'
          : 'Hints are already trusted when content is trusted.'}
      </p>
      {form.engineCoverage && form.engineCoverage.length > 0 && (
        <div className="editor-field">
          <h4 className="editor-label" id="integration-engine-coverage">
            Other engines
          </h4>
          <dl
            className="integration-engine-coverage"
            aria-labelledby="integration-engine-coverage"
          >
            {form.engineCoverage.map((entry) => (
              <div key={entry.engine}>
                <dt>{ENGINE_LABEL[entry.engine]}</dt>
                <dd>
                  <StatusBadge
                    tone={COVERAGE[entry.coverage].tone}
                    status={COVERAGE[entry.coverage].label}
                  />
                </dd>
              </div>
            ))}
          </dl>
          {form.engineCoverage.some(
            (entry) => entry.coverage === 'engine-direct',
          ) && (
            <p className="editor-field-hint">
              Direct connection: the engine reaches this server itself, so
              Station can&rsquo;t gate its calls.
            </p>
          )}
        </div>
      )}
      <details className="editor-disclosure">
        <summary>
          Change history ({form.untrustedContentChanges?.length ?? 0})
        </summary>
        {form.untrustedContentChanges?.length ? (
          <ol className="integration-trust-history">
            {form.untrustedContentChanges
              .slice()
              .reverse()
              .map((change, index) => (
                <li key={`${change.at}-${index}`}>
                  <time dateTime={change.at}>
                    {Number.isNaN(Date.parse(change.at))
                      ? change.at
                      : new Date(change.at).toLocaleString()}
                  </time>{' '}
                  · {change.by ?? (change.source ? 'Local import' : 'Station')}
                  <ul>
                    {change.contentTrust && (
                      <li>Content: {change.contentTrust}</li>
                    )}
                    {change.permissions?.default && (
                      <li>Default: {change.permissions.default}</li>
                    )}
                    {Object.entries(change.permissions?.tools ?? {}).map(
                      ([name, value]) => (
                        <li key={name}>
                          {name}: {value}
                        </li>
                      ),
                    )}
                    {change.permissions &&
                      !change.permissions.default &&
                      !Object.keys(change.permissions.tools ?? {}).length && (
                        <li>Permissions reset to default</li>
                      )}
                    {change.trustReadOnlyHints !== undefined && (
                      <li>
                        Read-only hints:{' '}
                        {change.trustReadOnlyHints ? 'trusted' : 'not trusted'}
                      </li>
                    )}
                  </ul>
                </li>
              ))}
          </ol>
        ) : null}
      </details>
    </section>
  );
}
