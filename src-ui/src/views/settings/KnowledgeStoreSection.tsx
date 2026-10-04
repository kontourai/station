/**
 * Settings card for the first registered personal Knowledge root.
 * The scope tag also includes read-only conversation roots; this UI selection
 * is not a server-enforced one-writable-store invariant. Obsidian connection
 * still requires validation of the exact currently entered path.
 */
import {
  useCreateKnowledgeRootMutation,
  useKnowledgeAdaptersQuery,
  useKnowledgeRootsQuery,
  useValidateKnowledgeRootMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { ArchiveGlyph, BrainGlyph } from '../../components/icons/Glyph';
import { PathAutocomplete } from '../../components/PathAutocomplete';
import { Empty, ErrorState, Skeleton } from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';
import { userFacingErrorMessage } from '../../utils/errorText';
import './KnowledgeStoreSection.css';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

const PERSONAL_DEFAULT_ADAPTER_ID = 'kit-default-store';
const OBSIDIAN_ADAPTER_ID = 'kit-obsidian-store';

/** The connection form appears only while this UI's first-personal-root lookup is empty. */
function ConnectObsidianVault() {
  const createRoot = useCreateKnowledgeRootMutation();
  const validateRoot = useValidateKnowledgeRootMutation();
  const [open, setOpen] = useState(false);
  const [vaultPath, setVaultPath] = useState('');
  const [validated, setValidated] = useState<{
    forPath: string;
    ok: boolean;
    reason?: string;
  } | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        className="button button--link knowledge-store-section__obsidian-toggle"
        onClick={() => setOpen(true)}
      >
        Connect an existing Obsidian vault instead
      </button>
    );
  }

  const canConnect =
    validated?.ok === true &&
    validated.forPath === vaultPath &&
    !createRoot.isPending;

  return (
    <div className="knowledge-store-section__obsidian">
      <span className="settings__field-label">Obsidian vault path</span>
      <PathAutocomplete
        value={vaultPath}
        onChange={(value) => {
          setVaultPath(value);
          setValidated(null);
          validateRoot.reset();
        }}
        placeholder="/path/to/vault"
        className="editor-input knowledge-store-section__obsidian-input"
      />
      <span className="settings__field-hint">
        Validate the vault path before connecting — the vault must already
        contain an Obsidian <code>.obsidian/</code> folder.
      </span>
      <div className="knowledge-store-section__obsidian-actions">
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={!vaultPath.trim() || validateRoot.isPending}
          onClick={() => {
            const forPath = vaultPath;
            setValidated(null);
            validateRoot.mutate(
              { adapterId: OBSIDIAN_ADAPTER_ID, storeRoot: forPath },
              { onSuccess: (result) => setValidated({ forPath, ...result }) },
            );
          }}
        >
          {validateRoot.isPending ? 'Validating…' : 'Validate'}
        </button>
        <button
          type="button"
          className="button button--primary button--small"
          disabled={!canConnect}
          onClick={() =>
            createRoot.mutate({
              scope: { kind: 'personal' },
              adapterId: OBSIDIAN_ADAPTER_ID,
              storeRoot: vaultPath,
            })
          }
        >
          Connect
        </button>
        <button
          type="button"
          className="button button--link"
          onClick={() => {
            setOpen(false);
            setVaultPath('');
            setValidated(null);
          }}
        >
          Cancel
        </button>
      </div>
      {validated?.ok === false && validated.forPath === vaultPath && (
        <ErrorState
          className="knowledge-store-section__obsidian-error"
          variant="default"
          title="Vault validation failed"
          description={validated.reason}
        />
      )}
      {validateRoot.isError && (
        <ErrorState
          className="knowledge-store-section__obsidian-error"
          title="Vault validation could not be completed"
          description={userFacingErrorMessage(validateRoot.error)}
        />
      )}
      {createRoot.isError && (
        <ErrorState
          className="knowledge-store-section__obsidian-error"
          variant="default"
          title="Couldn't connect that vault"
          description={userFacingErrorMessage(createRoot.error)}
        />
      )}
    </div>
  );
}

export function KnowledgeStoreSection() {
  const { navigate } = useNavigation();
  const rootsQuery = useKnowledgeRootsQuery();
  const adaptersQuery = useKnowledgeAdaptersQuery();
  const createRoot = useCreateKnowledgeRootMutation();

  const adapterDisplayName = (adapterId: string) =>
    adaptersQuery.data?.find((adapter) => adapter.id === adapterId)
      ?.displayName ?? adapterId;

  return (
    <SettingsSection
      icon={<BrainGlyph />}
      title="My knowledge store"
      id="section-knowledge"
    >
      <div {...settingsRow('personal-knowledge-store')} tabIndex={-1}>
        <p className="knowledge-store-section__intro">
          Optional. Add a personal knowledge store when you want agents to keep
          durable context across chats—for example, project decisions, working
          preferences, or notes you ask Station to remember.
        </p>
        <p className="knowledge-store-section__cross-link">
          Looking for a project's own knowledge instead? Open that project's
          Settings. Managing the vector database or embedding model?{' '}
          <button
            type="button"
            className="button button--link"
            onClick={() => navigate('/connections/knowledge')}
          >
            Open Knowledge infrastructure
          </button>
        </p>
        {rootsQuery.isLoading ? (
          <div className="knowledge-store-section__skeleton">
            <Skeleton variant="block" />
            <Skeleton variant="block" />
          </div>
        ) : rootsQuery.isError ? (
          <ErrorState
            title="Couldn't load your knowledge store"
            description={userFacingErrorMessage(rootsQuery.error)}
            action={
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => rootsQuery.refetch()}
              >
                Retry
              </button>
            }
          />
        ) : (
          (() => {
            const personalRoot = (rootsQuery.data ?? []).find(
              (root) => root.scope.kind === 'personal',
            );

            if (!personalRoot) {
              return (
                <>
                  <Empty
                    variant="prominent"
                    icon={
                      <span
                        className="knowledge-store-section__icon"
                        aria-hidden="true"
                      >
                        <ArchiveGlyph />
                      </span>
                    }
                    label="Personal knowledge is off"
                    description="The recommended setup creates a local file-based store in Station's data folder. Nothing is imported automatically."
                    action={
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={createRoot.isPending}
                        onClick={() =>
                          createRoot.mutate({
                            scope: { kind: 'personal' },
                            adapterId: PERSONAL_DEFAULT_ADAPTER_ID,
                          })
                        }
                      >
                        {createRoot.isPending
                          ? 'Creating…'
                          : 'Create recommended store'}
                      </button>
                    }
                  />
                  {createRoot.isError && (
                    <ErrorState
                      className="knowledge-store-section__create-error"
                      variant="default"
                      title="Couldn't create your knowledge store"
                      description={userFacingErrorMessage(createRoot.error)}
                    />
                  )}
                  <ConnectObsidianVault />
                </>
              );
            }

            return (
              <div className="knowledge-store-section__card">
                <div className="knowledge-store-section__status">
                  Personal knowledge is on. Station uses this registered store
                  for durable context; its files remain yours.
                </div>
                <div className="settings__field">
                  <span className="settings__field-label">Location</span>
                  <code className="knowledge-store-section__path">
                    {personalRoot.storeRoot}
                  </code>
                </div>
                <div className="settings__field">
                  <span className="settings__field-label">Name</span>
                  <span>{personalRoot.displayName}</span>
                </div>
                <div className="settings__field">
                  <span className="settings__field-label">Adapter</span>
                  <span>{adapterDisplayName(personalRoot.adapterId)}</span>
                </div>
              </div>
            );
          })()
        )}
      </div>
    </SettingsSection>
  );
}
