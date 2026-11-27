import {
  APPEARANCE_MODES,
  APPEARANCE_ROLE_PROPERTIES,
  type AppearanceMode,
  type AppearanceRoleProperty,
  type CustomAppearance,
  type CustomAppearanceDocument,
  type CustomAppearanceRenderReport,
  customCssTextViolations,
  isAppearanceHex,
  parseCustomAppearance,
} from '@kontourai/station-contracts/custom-appearance';
import {
  customAppearanceKey,
  useCustomAppearanceMutation,
  useCustomAppearanceQuery,
} from '@kontourai/station-sdk';
import {
  getCustomAppearance,
  saveCustomAppearance,
} from '@kontourai/station-sdk/client';
import { Field } from '@kontourai/ui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, useSyncExternalStore } from 'react';
import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import { DisclosureToggle } from '../components/DisclosureToggle';
import { PageCallout } from '../components/PageCallout';
import { PageRow } from '../components/PageRow';
import { PageSection } from '../components/PageSection';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import {
  getCustomAppearanceSnapshot,
  leaveCustomAppearanceSafeMode,
  setActiveCustomAppearance,
  subscribeCustomAppearance,
} from '../lib/custom-appearance/controller';
import { previewCustomAppearance } from '../lib/custom-appearance/preview';
import {
  dismissAppearanceProposal,
  previewAppearanceProposal,
} from '../lib/custom-appearance/proposal-actions';
import {
  AppearanceLibrary,
  AppearanceVisualControls,
  SaveAppearanceToLibrary,
} from './AppearanceStudio';

const ROLE_LABELS: Record<AppearanceRoleProperty, string> = {
  '--k-bg': 'Page',
  '--k-panel': 'Panel',
  '--k-panel-raised': 'Raised panel',
  '--k-line': 'Line',
  '--k-line-strong': 'Strong line',
  '--k-text': 'Text',
  '--k-text-muted': 'Muted text',
  '--k-text-faint': 'Faint text',
  '--k-status-contrast': 'Text on status',
  '--k-positive': 'Positive',
  '--k-caution': 'Caution',
  '--k-negative': 'Negative',
  '--k-active': 'Active',
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Station did not save this.';

function useCustomAppearanceSnapshot() {
  return useSyncExternalStore(
    subscribeCustomAppearance,
    getCustomAppearanceSnapshot,
  );
}

function ReportSummary({ report }: { report: CustomAppearanceRenderReport }) {
  const failing = report.contrast.filter((r) => !r.pass);
  const unmatched = report.hooks.filter((h) => h.matched === 0);
  return (
    <p className="appearance-custom__report">
      Last preview ({report.mode}): {failing.length} contrast failure
      {failing.length === 1 ? '' : 's'}, {report.stripped.length} CSS removal
      {report.stripped.length === 1 ? '' : 's'}, {unmatched.length} hook
      {unmatched.length === 1 ? '' : 's'} not on screen.
    </p>
  );
}

interface Draft {
  name: string;
  css: string;
  visual: CustomAppearance['visual'];
  palette: Record<AppearanceMode, Partial<Record<string, string>>>;
}

function draftFrom(appearance: CustomAppearance | null): Draft {
  const palette = { dark: {}, light: {} } as Draft['palette'];
  for (const mode of APPEARANCE_MODES) {
    const entry = appearance?.palette[mode];
    palette[mode] = { ...entry?.roles, accent: entry?.accent };
  }
  return {
    name: appearance?.name ?? 'My appearance',
    css: appearance?.css ?? '',
    visual: appearance?.visual,
    palette,
  };
}

function appearanceFrom(draft: Draft): CustomAppearance {
  const palette: CustomAppearance['palette'] = {};
  for (const mode of APPEARANCE_MODES) {
    const values = draft.palette[mode];
    const roles: Partial<Record<AppearanceRoleProperty, string>> = {};
    for (const role of APPEARANCE_ROLE_PROPERTIES) {
      const value = values[role]?.trim();
      if (value) roles[role] = value;
    }
    const accent = values.accent?.trim();
    if (Object.keys(roles).length > 0 || accent)
      palette[mode] = {
        ...(Object.keys(roles).length > 0 ? { roles } : {}),
        ...(accent ? { accent } : {}),
      };
  }
  return {
    version: 1,
    name: draft.name.trim(),
    palette,
    css: draft.css,
    ...(draft.visual ? { visual: draft.visual } : {}),
  };
}

function ColorField({
  label,
  value,
  onChange,
  visual = false,
}: {
  visual?: boolean;
  label: string;
  value: string | undefined;
  onChange(value: string): void;
}) {
  const id = useId();
  const valid = !value || isAppearanceHex(value);
  return (
    <div className="appearance-custom__color">
      <label htmlFor={id}>{label}</label>
      <div className="appearance-custom__color-input">
        {visual && (
          <input
            className="appearance-studio__color-picker"
            type="color"
            aria-label={`${label} color picker`}
            value={value && isAppearanceHex(value) ? value : '#808080'}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        <span
          className="appearance-custom__swatch"
          aria-hidden="true"
          style={{ background: valid && value ? value : 'transparent' }}
        />
        <input
          id={id}
          className="control control--input"
          type="text"
          inputMode="text"
          spellCheck={false}
          placeholder="Theme"
          value={value ?? ''}
          aria-invalid={!valid || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

function useManualAppearancePreview(
  document: CustomAppearanceDocument,
  onSaved: () => void,
  onFailed: (message: string) => void,
) {
  const scope = useHostRequestAuthorityScope();
  const client = useQueryClient();
  return (appearance: CustomAppearance) =>
    previewCustomAppearance(appearance, {
      fromAgent: false,
      onKeep: () => {
        if (!scope?.isCurrent()) return;
        // Shown at once so nothing flashes. The save is a plain client call,
        // not this component's mutation, so its outcome lands even if the
        // person has left the page; a refused save re-reads the server's copy.
        setActiveCustomAppearance(appearance);
        saveCustomAppearance(
          scope.apiBase,
          { revision: document.revision, appearance },
          { requestScope: scope },
        ).then(
          (next) => {
            client.setQueryData(customAppearanceKey(scope), next);
            if (scope.isCurrent()) {
              setActiveCustomAppearance(next.active);
              onSaved();
            }
          },
          (error) => {
            if (!scope.isCurrent()) return;
            onFailed(errorText(error));
            getCustomAppearance(scope.apiBase, { requestScope: scope }).then(
              (current) => {
                client.setQueryData(customAppearanceKey(scope), current);
                if (scope.isCurrent())
                  setActiveCustomAppearance(current.active);
              },
              () => {
                if (scope.isCurrent())
                  setActiveCustomAppearance(document.active);
              },
            );
          },
        );
      },
      onDiscard: () => undefined,
    });
}

function Editor({
  document,
  onSaved,
  onFailed,
  studioEnabled,
  initialAppearance,
  imported,
  onCancel,
  savedThemeId,
}: {
  document: CustomAppearanceDocument;
  onSaved(): void;
  onFailed(message: string): void;
  studioEnabled: boolean;
  initialAppearance: CustomAppearance | null;
  imported: boolean;
  onCancel(): void;
  savedThemeId?: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const mutation = useCustomAppearanceMutation(scope ?? undefined);
  const [draft, setDraft] = useState(() => draftFrom(initialAppearance));
  const [advanced, setAdvanced] = useState(false);
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(draftFrom(initialAppearance)),
  );
  const [libraryId, setLibraryId] = useState(savedThemeId);
  const [preparingImage, setPreparingImage] = useState(false);
  const dirty = preparingImage || JSON.stringify(draft) !== baseline;
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  const advancedId = useId();
  const [mode, setMode] = useState<AppearanceMode>('dark');
  const nameId = useId();
  const cssId = useId();
  const { safe } = useCustomAppearanceSnapshot();
  const textProblems = customCssTextViolations(draft.css);
  const appearance = appearanceFrom(draft);
  const invalid =
    preparingImage ||
    textProblems.length > 0 ||
    !draft.name.trim() ||
    !parseCustomAppearance(appearance).ok;
  const setColor = (key: string, value: string) =>
    setDraft((d) => ({
      ...d,
      palette: { ...d.palette, [mode]: { ...d.palette[mode], [key]: value } },
    }));
  const save = (onError?: () => void) =>
    mutation.mutate(
      { kind: 'save', revision: document.revision, appearance },
      {
        onSuccess: (data) => {
          if (!scope?.isCurrent()) return;
          setActiveCustomAppearance(data.active);
          onSaved();
        },
        onError,
      },
    );
  const preview = useManualAppearancePreview(document, onSaved, onFailed);
  return (
    <div className="appearance-custom__editor content-stack">
      {imported && (
        <p role="status" className="appearance-custom__note">
          Imported theme draft. Preview it before applying.
        </p>
      )}
      <Field label="Name" htmlFor={nameId}>
        <input
          id={nameId}
          className="control control--input"
          type="text"
          maxLength={80}
          value={draft.name}
          onChange={(event) =>
            setDraft((d) => ({ ...d, name: event.target.value }))
          }
        />
      </Field>
      {studioEnabled && (
        <AppearanceVisualControls
          visual={draft.visual}
          onPreparing={setPreparingImage}
          onChange={(visual) => setDraft((d) => ({ ...d, visual }))}
        />
      )}
      <fieldset className="appearance-custom__palette">
        <legend>Palette</legend>
        <div
          className="appearance-custom__modes"
          role="radiogroup"
          aria-label="Palette mode"
        >
          {APPEARANCE_MODES.map((m) => (
            <label key={m}>
              <input
                type="radio"
                name="appearance-custom-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              {m === 'dark' ? 'Dark' : 'Light'}
            </label>
          ))}
        </div>
        <div className="appearance-custom__colors">
          <ColorField
            label="Accent"
            visual={studioEnabled}
            value={draft.palette[mode].accent}
            onChange={(value) => setColor('accent', value)}
          />
          {APPEARANCE_ROLE_PROPERTIES.map((role) => (
            <ColorField
              key={role}
              label={ROLE_LABELS[role]}
              visual={studioEnabled}
              value={draft.palette[mode][role]}
              onChange={(value) => setColor(role, value)}
            />
          ))}
        </div>
      </fieldset>
      {studioEnabled && (
        <DisclosureToggle
          expanded={advanced}
          onToggle={() => setAdvanced((v) => !v)}
          controls={advancedId}
        >
          Advanced CSS
        </DisclosureToggle>
      )}
      {(!studioEnabled || advanced) && (
        <div id={advancedId}>
          <Field
            label="CSS"
            htmlFor={cssId}
            hint="Use the hook selectors. No remote images, fonts or imports."
          >
            <textarea
              id={cssId}
              className="control control--textarea appearance-custom__css"
              rows={10}
              spellCheck={false}
              maxLength={50_000}
              value={draft.css}
              onChange={(event) =>
                setDraft((d) => ({ ...d, css: event.target.value }))
              }
            />
          </Field>
          {textProblems.length > 0 && (
            <ul className="appearance-custom__problems">
              {textProblems.map((p) => (
                <li key={p.kind + p.message}>{p.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {studioEnabled && (
        <SaveAppearanceToLibrary
          appearance={appearance}
          disabled={invalid}
          savedThemeId={libraryId}
          onSaved={(id) => {
            setLibraryId(id);
            setBaseline(JSON.stringify(draft));
          }}
        />
      )}
      {mutation.isError && (
        <ErrorState
          variant="compact"
          title="Not saved"
          description={errorText(mutation.error)}
        />
      )}
      <ActionRow
        overflowLabel="More appearance actions"
        secondary={
          <Button
            onClick={() => preview(appearance)}
            disabled={invalid || safe}
          >
            Preview
          </Button>
        }
        primary={
          !imported && !savedThemeId ? (
            <Button
              variant="primary"
              onClick={() => save()}
              disabled={invalid}
              pending={mutation.isPending}
            >
              Save
            </Button>
          ) : undefined
        }
        overflow={[
          {
            key: 'cancel',
            label: 'Cancel editing',
            onSelect: () => guard(onCancel),
          },
        ]}
      />
      <DiscardModal />
    </div>
  );
}

export function CustomAppearanceSection({
  studioEnabled = false,
}: {
  studioEnabled?: boolean;
}) {
  const scope = useHostRequestAuthorityScope();
  return (
    <ScopedCustomAppearanceSection
      key={`${scope?.authorityKey ?? 'unavailable'}:${studioEnabled}`}
      studioEnabled={studioEnabled}
    />
  );
}

function ScopedCustomAppearanceSection({
  studioEnabled,
}: {
  studioEnabled: boolean;
}) {
  const scope = useHostRequestAuthorityScope();
  const client = useQueryClient();
  const query = useCustomAppearanceQuery(scope ?? undefined, {
    refetchInterval: 5000,
  });
  const mutation = useCustomAppearanceMutation(scope ?? undefined);
  const snapshot = useCustomAppearanceSnapshot();
  const [editing, setEditing] = useState(false);
  const [initialAppearance, setInitialAppearance] =
    useState<CustomAppearance | null>(null);
  const [imported, setImported] = useState(false);
  const [savedThemeId, setSavedThemeId] = useState<string | undefined>();
  const [editorKey, setEditorKey] = useState(0);
  const [keepError, setKeepError] = useState<string | null>(null);
  const document = query.data;
  const manualPreview = useManualAppearancePreview(
    document ?? {
      revision: '',
      active: null,
      proposal: null,
      renderReport: null,
    },
    () => setEditing(false),
    setKeepError,
  );

  const status = (query.error as { status?: number } | null)?.status;
  if (status === 404 || status === 403) return null;

  const proposalAction = (
    doc: CustomAppearanceDocument,
    action: 'preview' | 'dismiss',
  ) => {
    if (!doc.proposal || !scope) return;
    setKeepError(null);
    const target = {
      scope,
      client,
      proposalId: doc.proposal.id,
      isCurrent: () => scope.isCurrent(),
      onError: (error: unknown) => {
        if (scope.isCurrent()) setKeepError(errorText(error));
      },
    };
    void (
      action === 'preview'
        ? previewAppearanceProposal(target)
        : dismissAppearanceProposal(target)
    ).catch(target.onError);
  };

  return (
    <PageSection
      className="appearance__section appearance-custom"
      title="Custom"
      description={
        studioEnabled
          ? 'Create a visual theme, save it, and take it to another Station.'
          : 'Your own palette and CSS. Agents can propose one; only you keep it.'
      }
    >
      {snapshot.safe && (
        <PageCallout
          calloutId="custom-appearance-safe-mode"
          ariaLabel="Custom appearance is off in this tab"
          tone="warning"
          title="Custom appearance is off in this tab"
          action={
            <Button onClick={leaveCustomAppearanceSafeMode}>
              Turn back on
            </Button>
          }
        />
      )}
      {snapshot.suspendedForDecision && (
        <p className="appearance-custom__note">
          Custom CSS is paused while an approval is on screen.
        </p>
      )}
      {query.isPending && !document ? (
        <SkeletonBlock label="Loading custom appearance" />
      ) : query.isError && !document ? (
        <ErrorState
          variant="compact"
          title="Custom appearance did not load"
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        />
      ) : document ? (
        <>
          {query.isError && (
            <ErrorState
              variant="compact"
              title="Custom appearance did not refresh"
              action={
                <Button onClick={() => void query.refetch()}>Retry</Button>
              }
            />
          )}
          <PageRow
            title="In use"
            description={
              document.active
                ? `“${document.active.name}” is applied on top of your theme.`
                : 'None. Station uses your theme as it is.'
            }
            control={
              document.active ? (
                <Button
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate(
                      {
                        kind: 'save',
                        revision: document.revision,
                        appearance: null,
                      },
                      {
                        onSuccess: (data) => {
                          if (scope?.isCurrent())
                            setActiveCustomAppearance(data.active);
                        },
                      },
                    )
                  }
                >
                  Turn off custom appearance
                </Button>
              ) : undefined
            }
          />
          {document.proposal && (
            <PageRow
              title="Proposed"
              description={`“${document.proposal.appearance.name}” from an agent. Preview it before keeping it.`}
              control={
                <ActionRow
                  overflowLabel="More proposal actions"
                  primary={
                    <Button
                      variant="primary"
                      onClick={() => proposalAction(document, 'preview')}
                      disabled={!!snapshot.previewing || snapshot.safe}
                    >
                      Preview
                    </Button>
                  }
                  secondary={
                    <Button
                      disabled={mutation.isPending}
                      onClick={() => proposalAction(document, 'dismiss')}
                    >
                      Dismiss
                    </Button>
                  }
                />
              }
            >
              {document.renderReport && (
                <ReportSummary report={document.renderReport} />
              )}
            </PageRow>
          )}
          {(keepError || (mutation.isError && !editing)) && (
            <ErrorState
              variant="compact"
              title="Not saved"
              description={keepError ?? errorText(mutation.error)}
              action={
                <Button
                  onClick={() => {
                    setKeepError(null);
                    mutation.reset();
                    void query.refetch();
                  }}
                >
                  Retry
                </Button>
              }
            />
          )}
          {studioEnabled && !editing && (
            <AppearanceLibrary
              document={document}
              disabled={!!snapshot.previewing || snapshot.safe}
              onApply={manualPreview}
              onEdit={(appearance, fromImport = false, id) => {
                setSavedThemeId(id);
                setInitialAppearance(appearance);
                setImported(fromImport);
                setEditorKey((v) => v + 1);
                setEditing(true);
              }}
            />
          )}
          {editing ? (
            <Editor
              key={editorKey}
              document={document}
              studioEnabled={studioEnabled}
              initialAppearance={initialAppearance}
              imported={imported}
              savedThemeId={savedThemeId}
              onCancel={() => setEditing(false)}
              onSaved={() => setEditing(false)}
              onFailed={setKeepError}
            />
          ) : !studioEnabled ? (
            <ActionRow
              overflowLabel="More custom appearance actions"
              secondary={
                <Button
                  onClick={() => {
                    setInitialAppearance(document.active);
                    setImported(false);
                    setEditing(true);
                  }}
                >
                  {document.active ? 'Edit' : 'Create'}
                </Button>
              }
            />
          ) : null}
        </>
      ) : null}
    </PageSection>
  );
}
