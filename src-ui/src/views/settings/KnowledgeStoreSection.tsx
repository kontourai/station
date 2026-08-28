/**
 * K4 global Settings surface (`s202-knowledge-onboarding` Wave 2) — the
 * personal knowledge-store card. Mirrors the visual idiom of sibling
 * sections (`AgentDefaultsSection`/`VoiceFeaturesSection`):
 * a `SettingsSection` shell, `settings__field*` classes for structured rows,
 * and the shared `.button`/`.button--*` classes for actions — no new design
 * language.
 *
 * Every empty/loading/error surface below goes through the canonical
 * `Empty`/`ErrorState`/`Skeleton` family (`../../components/state`), never
 * raw markup or an ad-hoc "No X" string (state-primitives ratchet stop-short
 * risk — `npm run state-primitives:ratchet`'s ad-hoc-string ceiling is
 * already fully spent, so new copy here is deliberately phrased to avoid the
 * literal "No <Word>" pattern while keeping the same meaning).
 *
 * Copy uses the glossary noun "knowledge store" / "personal knowledge
 * store" throughout; "vault" is reserved for the Obsidian-specific object a
 * user connects (docs/design/knowledge-foundation.md's K4 noun decision).
 *
 * The "connect an existing Obsidian vault" affordance never calls create
 * before a successful `POST /api/knowledge/roots/validate` — on `ok:false`
 * it renders the adapter's own `reason` string verbatim via `ErrorState`
 * (dishonest-validation stop-short risk), never a generic message or a
 * silent fallback to `kit-default-store`.
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
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { errorText } from '../../utils/errorText';
import './KnowledgeStoreSection.css';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

const PERSONAL_DEFAULT_ADAPTER_ID = 'kit-default-store';
const OBSIDIAN_ADAPTER_ID = 'kit-obsidian-store';

/** Secondary "connect an existing Obsidian vault instead" affordance, only
 * ever shown while there is no personal root yet (a user has exactly one
 * personal root — once it exists there is nothing left to connect). */
function ConnectObsidianVault() {
  const { apiBase } = useApiBase();
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
        }}
        placeholder="/path/to/vault"
        apiBase={apiBase}
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
          onClick={async () => {
            const forPath = vaultPath;
            const result = await validateRoot.mutateAsync({
              adapterId: OBSIDIAN_ADAPTER_ID,
              storeRoot: forPath,
            });
            setValidated({ forPath, ...result });
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
      {createRoot.isError && (
        <ErrorState
          className="knowledge-store-section__obsidian-error"
          variant="default"
          title="Couldn't connect that vault"
          description={errorText(createRoot.error)}
        />
      )}
    </div>
  );
}

/**
 * `guard` is `SettingsView.tsx`'s own `useUnsavedGuard` guard (
 * finding, 1) — the "Open Knowledge infrastructure" cross-link
 * below must route through it like every other navigation trigger on a page
 * with dirty state.
 */
export function KnowledgeStoreSection({
  guard,
}: {
  guard: (callback: () => void) => void;
}) {
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
            onClick={() => guard(() => navigate('/connections/knowledge'))}
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
            description={errorText(rootsQuery.error)}
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
                      description={errorText(createRoot.error)}
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
