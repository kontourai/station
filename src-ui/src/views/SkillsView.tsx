import type {
  Skill,
  SkillWriteRefusal,
  SkillWriteRefusalReason,
} from '@kontourai/station-contracts/catalog';
import { skillCommandNameError } from '@kontourai/station-contracts/skill-command';
import { serializeSkillMarkdown } from '@kontourai/station-contracts/skill-markdown';
import {
  type SkillImportFile,
  type SkillImportResultRow,
  useCreateLocalSkillMutation,
  useImportSkills,
  useRunSkill,
  useSkillQuery,
  useSkillsQuery,
  useUninstallSkillMutation,
  useUpdateLocalSkillMutation,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../components/Button';
import { DetailHeader } from '../components/DetailHeader';
import { EngineGlyph } from '../components/icons/Glyph';
import { ImportSkillsModal } from '../components/modals/ImportSkillsModal';
import { SkillRunModal } from '../components/modals/SkillRunModal';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useAgents } from '../contexts/AgentsContext';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useToast } from '../contexts/ToastContext';
import {
  useCreateChatSession,
  useSendMessage,
} from '../hooks/useActiveChatSessions';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useUrlSelection } from '../hooks/useUrlSelection';
import { errorText } from '../utils/errorText';
import { SkillCommandSection } from './skills/SkillCommandSection';
import {
  buildSkillFilename,
  buildSkillListItems,
  buildSkillPayload,
  EMPTY_SKILL_FORM,
  filterSkills,
  formatSkillStatsSummary,
  formCommandWord,
  formVariables,
  SKILLS_SUBTITLE,
  type SkillForm,
  skillDetailToForm,
  skillSourceLabel,
} from './skills/skill-view-utils';
import './editor-layout.css';
import './page-layout.css';
import './skills-view.css';

/**
 * What to DO about each refusal — keyed by the server's reason code, because the
 * remedies are not the same sentence. A plugin-served prompt has no registry
 * entry to install; a name that cannot be a directory name needs a rename, not
 * an install. Appending one fixed remedy to every reason made the closed union
 * real in the type and unrealised in the product (review medium).
 *
 * A `Record` over the union rather than a lookup with a default, so adding a
 * reason code fails to COMPILE until someone decides what to say about it.
 */
const SKILL_WRITE_REMEDY: Record<SkillWriteRefusalReason, string> = {
  'served-in-place': 'The plugin that provides it is what to change.',
  'canonical-package': 'Install it into your workspace to author it here.',
  'outside-writable-root': 'Install it into your workspace to author it here.',
  'unresolvable-name': 'Rename it to author it here.',
};

/**
 * The refusal sentence: WHAT is wrong, in Station's own words, then WHAT TO DO,
 * chosen by the reason code.
 *
 * `reason` arrives over HTTP from a server that may be NEWER than this build —
 * this change itself adds a fourth reason code, so a desktop app on the
 * previous build meeting this server is the live case, not a hypothetical. Two
 * ways an unrecognised code used to reach the reader as prose, both closed
 * here: a plain lookup rendered `undefined`, and a lookup for an INHERITED key
 * (`constructor`, `toString`) rendered JavaScript source — native-code strings
 * and an object constructor, straight into a paragraph the reader takes for
 * Station's explanation. `Object.hasOwn` is what makes the table's own keys the
 * only ones that answer; the `Record` type keeps the union exhaustive at
 * COMPILE time, and neither guard weakens that.
 *
 * An unrecognised code drops the remedy and keeps the description. Save is
 * withheld either way — `editableLocal` reads `writable === true` and never
 * this text.
 */
function skillWriteRefusalNote(refusal: SkillWriteRefusal): string {
  const remedy = Object.hasOwn(SKILL_WRITE_REMEDY, refusal.reason)
    ? SKILL_WRITE_REMEDY[refusal.reason]
    : undefined;
  return remedy
    ? `Read-only. ${refusal.detail} ${remedy}`
    : `Read-only. ${refusal.detail}`;
}

export function SkillsView({
  basePath = '/skills',
  filter,
}: {
  basePath?: string;
  /** `commands` narrows the list to command-enabled skills. */
  filter?: 'commands';
}) {
  const {
    selectedId: rawSelectedId,
    select,
    deselect,
  } = useUrlSelection(basePath);
  const selectedId = rawSelectedId === 'new' ? null : rawSelectedId;
  const [search, setSearch] = useState('');
  const [isCreating, setIsCreating] = useState(rawSelectedId === 'new');
  const [showRunModal, setShowRunModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importResults, setImportResults] = useState<
    SkillImportResultRow[] | null
  >(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const splitPaneSelectedId = isCreating ? '__new__' : selectedId;
  const [form, setForm] = useState<SkillForm>(EMPTY_SKILL_FORM);
  const { navigate, setDockState, setActiveChat } = useNavigation();
  const { showToast } = useToast();
  const { apiBase } = useApiBase();
  const agents = useAgents();
  const createChatSession = useCreateChatSession();
  const sendMessage = useSendMessage(apiBase);

  // SHELL-09: this read `const isLoading = false`, so for the ~2.2s the skills
  // query was in flight the list panel rendered its DEFINITIVE empty state —
  // "No installed skills yet", with a CTA to create one — and then replaced it
  // with 24 installed skills (reproduced 3/3). A loading flag nothing derives
  // is the label-vs-derivation defect in its purest form: the view had the
  // fact and threw it away. `isPending` is the initial-read signal (a
  // background refetch must NOT blank a populated list back to skeletons).
  //
  // The `= []` default is the second half of the same defect: a
  // FAILED read also settles with no data, so `isPending === false` plus an
  // empty array rendered "No installed skills yet" over a 500 — a definitive
  // claim about the user's Guidance that Station had not measured. `error` is
  // read here and handed to the pane, which renders the failure instead.
  const {
    data: localRaw = [],
    error: skillsError,
    isPending: isLoading,
    refetch: refetchSkills,
  } = useSkillsQuery();

  // `source: s.source || 'local'` used to sit here, coercing an unrecorded
  // source into a claim the server had declined to make — and `editableLocal`
  // read exactly that coerced value, so a package with no install record was
  // offered a Save on the strength of the coercion. Editability now derives
  // from the server's `writable` (#1655), and `source` is carried through as
  // sent: nothing in this view reads it any more (the row chip and the detail
  // heading both derive from `origin`).
  const localSkills: Skill[] = localRaw.map((s: any) => ({
    ...s,
    name: s.name || s.id,
    installedVersion: s.version,
    installed: true,
    updateAvailable: false,
  }));

  const skills = localSkills;

  const filtered = useMemo(
    () => filterSkills(skills, search, filter === 'commands'),
    [skills, search, filter],
  );

  // The band header and the row chip say the same derived thing on purpose:
  // the rail is short and the built-in band is long, so a row scrolled away
  // from its header still has to answer "where is this from?" on its own
  // (#1582 D6). Both read the one `source` the builder derived, so they cannot
  // disagree.
  const items = useMemo(
    () =>
      buildSkillListItems(filtered).map(({ source, ...item }) => ({
        ...item,
        section: source,
        badge: <span className="skill-source-chip">{source}</span>,
      })),
    [filtered],
  );

  // the CURRENT TAB's collection with no query
  // applied — so a tab that itself has zero matches (e.g. no skill is a
  // command yet) reads as genuinely empty, never as "your search matched
  // nothing" the moment a stale query also happens to be typed. Search
  // alone emptying a populated tab still routes to FilteredEmpty.
  const tabFiltered = useMemo(
    () => filterSkills(skills, '', filter === 'commands'),
    [skills, filter],
  );

  const selected = skills.find((skill) => skill.name === selectedId);
  const selectedSkillName =
    !isCreating && selected?.installed ? selected.name : undefined;
  // The detail pane's states derive from the DETAIL read, not the list
  // entry: the list only proves the skill exists, while the detail carries
  // the body the form edits. A guard on `!!selectedSkillName` keeps a
  // disabled/absent query (nothing selected, or the create form) from
  // reading as "loading".
  const {
    data: selectedSkillDetail,
    error: detailError,
    isPending: detailPending,
    refetch: refetchSkillDetail,
  } = useSkillQuery(selectedSkillName, {
    enabled: !!selectedSkillName,
  });
  const detailLoading = !!selectedSkillName && detailPending;
  const detailFailed = !!selectedSkillName && !!detailError;
  // No action may operate on a body that is not the selected skill's: while
  // the detail is in flight or failed, Test/Export/Duplicate/Save/Remove are
  // all gated on this
  const detailBusy = detailLoading || detailFailed;

  // A skill created from the commands list — or from Commands' "+ New
  // command" — starts as a command, because that is what the reader asked for.
  // Everywhere else a new skill is a plain skill until someone says otherwise.
  // Memoised because it is an effect dependency: a fresh object every render
  // would re-run that effect every render and wipe the form being typed into.
  const newSkillForm: SkillForm = useMemo(
    () => ({
      ...EMPTY_SKILL_FORM,
      commandEnabled: filter === 'commands',
    }),
    [filter],
  );

  const createLocalMutation = useCreateLocalSkillMutation();
  const uninstallMutation = useUninstallSkillMutation();
  const updateLocalMutation = useUpdateLocalSkillMutation();
  const runSkillMutation = useRunSkill();
  // This view already owns the exact active Station origin. Passing it into
  // the write avoids a second, global SDK-base lookup between the click and
  // request dispatch — the dead path audited in #890 stalled before fetch.
  const importSkillsMutation = useImportSkills(apiBase);
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  useCloseShortcut(() => {
    if (isCreating || selectedId) {
      guard(() => {
        deselect();
        setIsCreating(false);
      });
      return;
    }
    // Escape is a dismissal: return to `/` and whatever occupies `main`, not
    // to Home by name (#1523).
    navigate('/');
  });

  useEffect(() => {
    setIsCreating(rawSelectedId === 'new');
  }, [rawSelectedId]);

  useEffect(() => {
    if (isCreating) {
      setForm(newSkillForm);
      setDirty(false);
      return;
    }
    // No detail for the selected skill yet (in flight or failed): the
    // previously edited skill's form is NOT this skill's form, so it is
    // cleared rather than left standing under the new selection. When the
    // detail resolves (or is already cached), it fills the form.
    setForm(
      selectedSkillDetail
        ? skillDetailToForm(selectedSkillDetail)
        : EMPTY_SKILL_FORM,
    );
    setDirty(false);
  }, [selectedSkillDetail, isCreating, newSkillForm]);

  async function handleSaveLocalSkill() {
    if (!form.name.trim() || !form.body.trim()) {
      showToast('Name and body are required');
      return;
    }
    // archive#3737: the same rule the field shows and the HTTP schema
    // enforces. Pressing Save on a word the server will refuse used to be the
    // only way to find out, and the refusal was silent.
    const commandWord = formCommandWord(form);
    const commandWordError =
      form.commandEnabled && commandWord !== null
        ? skillCommandNameError(commandWord)
        : null;
    if (commandWordError) {
      showToast(commandWordError, 'warning');
      return;
    }
    const payload = buildSkillPayload(form);
    try {
      if (isCreating) {
        await createLocalMutation.mutateAsync(payload);
        setIsCreating(false);
        select(payload.name);
      } else {
        await updateLocalMutation.mutateAsync(payload);
      }
      setDirty(false);
      showToast('Skill saved');
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Failed to save skill',
      );
    }
  }

  async function handleDuplicate() {
    const copy = `${form.name}-copy`;
    try {
      await createLocalMutation.mutateAsync({
        ...buildSkillPayload(form),
        name: copy,
        // Two skills cannot answer to one command word, and the server refuses
        // the clash. A copy is a draft, so it starts as a plain skill rather
        // than failing to save at all.
        command: { enabled: false },
      });
      select(copy);
      showToast('Skill duplicated');
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Failed to duplicate skill',
      );
    }
  }

  function handleExport() {
    const markdown = serializeSkillMarkdown({
      name: form.name,
      description: form.description,
      category: form.category,
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      ...(form.commandEnabled
        ? {
            command: {
              enabled: true,
              ...(form.commandName.trim()
                ? { name: form.commandName.trim() }
                : {}),
              global: form.commandGlobal,
            },
          }
        : {}),
      variables: formVariables(form),
      body: form.body,
    });
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = buildSkillFilename(form.name);
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  async function handleRun(resolvedContent: string, agentSlug: string) {
    const agent = agents.find((entry) => entry.slug === agentSlug);
    if (!agent) return;
    const sessionId = createChatSession(
      agent.slug,
      agent.name,
      form.name || 'Skill test',
    );
    setDockState(true);
    setActiveChat(null);
    setShowRunModal(false);
    await sendMessage(sessionId, agent.slug, undefined, resolvedContent);
    if (selected) {
      await runSkillMutation.mutateAsync(selected.name).catch(() => undefined);
    }
  }

  async function handleImport(files: SkillImportFile[]) {
    setImportError(null);
    try {
      const result = await importSkillsMutation.mutateAsync(files);
      setImportResults(result.results);
      await refetchSkills();
      const failed = result.results.length - result.imported;
      showToast(
        failed > 0
          ? `Imported ${result.imported} of ${result.results.length} — see the per-file results`
          : `Imported ${result.imported} skill${result.imported === 1 ? '' : 's'}`,
      );
    } catch (error) {
      setImportError(errorText(error));
    }
  }

  function updateForm(updates: Partial<SkillForm>) {
    setForm((current) => ({
      ...current,
      ...updates,
    }));
    setDirty(true);
  }

  function handleSelectSkill(id: string) {
    guard(() => {
      select(id);
      setIsCreating(false);
      setDirty(false);
    });
  }

  function handleDeselectSkill() {
    guard(() => {
      deselect();
      setIsCreating(false);
      setDirty(false);
    });
  }

  function handleAddSkill() {
    guard(() => {
      select('new');
      setIsCreating(true);
      setForm(newSkillForm);
      setDirty(false);
    });
  }

  function navigateWithGuard(path: string) {
    guard(() => navigate(path));
  }

  // The SERVER's writability decision, projected onto the listing and read
  // here — never re-derived (#1655). This read `selected.source === 'local'`,
  // which is the install record's statement about where a package CAME FROM
  // and not the question "may Station write it": a registry install in a
  // writable root is writable and read as read-only, while a `source: 'local'`
  // record in a plugin's root is read-only and was offered a Save that the
  // route answers 409. `=== true` and not `!== false` on purpose — a server
  // that did not state the decision has not granted it.
  const editableLocal =
    isCreating || (selected?.installed && selected.writable === true);
  // Same derivation as the list chip. It used to read `source === 'local'` and
  // print "Workspace-authored skill" for anything writable, which called a
  // machine-scoped skill a workspace one — the conflation #1582 D6 names. The
  // editability sentence below is a separate fact and keeps its own predicate.
  const sourceLabel = selected
    ? skillSourceLabel(selected.origin)
    : 'Source unrecorded';
  const statsSummary = selected ? formatSkillStatsSummary(selected) : null;
  const savePending =
    createLocalMutation.isPending || updateLocalMutation.isPending;

  return (
    <div className="pane-host skills-view">
      <SplitPaneLayout
        label="skills"
        title="Installed Skills"
        subtitle={SKILLS_SUBTITLE}
        items={items}
        loading={isLoading}
        error={skillsError}
        onRetry={() => void refetchSkills()}
        listErrorTitle="Unable to load skills"
        selectedId={splitPaneSelectedId}
        onSelect={handleSelectSkill}
        onDeselect={handleDeselectSkill}
        onSearch={setSearch}
        searchValue={search}
        listFilteredEmptyNoun="skills"
        collectionEmpty={tabFiltered.length === 0}
        searchPlaceholder="Search skills..."
        onAdd={handleAddSkill}
        addLabel="New skill"
        listEmptyTitle={
          filter === 'commands'
            ? 'No skills are commands yet'
            : 'No installed skills yet'
        }
        listEmptyDescription={
          filter === 'commands'
            ? 'Open a skill and turn on "Runnable as a slash command" to give it a /command.'
            : 'Create a workspace skill here, or browse Registry to discover skills to install.'
        }
        sidebarActions={
          <>
            <button
              type="button"
              className="split-pane__add-btn split-pane__add-btn--secondary"
              aria-pressed={filter === 'commands'}
              onClick={() =>
                navigate(basePath, {
                  tab: 'skills',
                  filter: filter === 'commands' ? null : 'commands',
                })
              }
            >
              Commands only
            </button>
            <button
              type="button"
              className="split-pane__add-btn split-pane__add-btn--secondary"
              onClick={() => {
                setImportResults(null);
                setShowImportModal(true);
              }}
              disabled={importSkillsMutation.isPending}
            >
              {importSkillsMutation.isPending ? 'Importing…' : 'Import .md'}
            </button>
          </>
        }
        headerActions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigateWithGuard('/registry/skills')}
          >
            Browse Registry Skills
          </Button>
        }
        emptyIcon={<EngineGlyph />}
        emptyDescription="Select a skill to view details"
      >
        {(editableLocal || selected) && (
          <div className="skill-detail">
            <DetailHeader
              title={
                isCreating
                  ? 'New Skill'
                  : form.name || selected?.name || 'Edit Skill'
              }
              badge={
                dirty
                  ? { label: 'unsaved', variant: 'warning' as const }
                  : undefined
              }
            >
              {!isCreating && selected && editableLocal && (
                <Button
                  size="sm"
                  onClick={() => void handleDuplicate()}
                  disabled={savePending || detailBusy}
                >
                  Duplicate
                </Button>
              )}
              {!isCreating && selected && (
                <Button
                  size="sm"
                  onClick={handleExport}
                  disabled={detailBusy || !form.body.trim()}
                >
                  Export .md
                </Button>
              )}
              {!isCreating && selected && (
                <Button
                  size="sm"
                  onClick={() => setShowRunModal(true)}
                  disabled={detailBusy || !form.body.trim()}
                >
                  ▶ Test
                </Button>
              )}
              {!isCreating && selected && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={detailBusy}
                  onClick={() =>
                    uninstallMutation.mutate(selected.name, {
                      onSuccess: () => {
                        showToast('Skill removed');
                        deselect();
                      },
                      onError: () => showToast('Failed to remove skill'),
                    })
                  }
                >
                  Remove
                </Button>
              )}
              {editableLocal && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={handleSaveLocalSkill}
                  disabled={savePending || detailBusy}
                  pending={savePending}
                  pendingLabel="Saving…"
                >
                  {isCreating ? 'Create' : 'Save'}
                </Button>
              )}
            </DetailHeader>

            {detailFailed ? (
              <ErrorState
                title="Unable to load skill"
                description={
                  detailError instanceof Error
                    ? detailError.message
                    : 'The skill detail could not be read.'
                }
                action={
                  <Button size="sm" onClick={() => void refetchSkillDetail()}>
                    Retry
                  </Button>
                }
              />
            ) : detailLoading ? (
              <SkeletonBlock label="Loading skill" />
            ) : (
              <>
                {!isCreating && selected && (
                  <div className="agent-editor__section">
                    <div className="skill-detail__meta">
                      <span>{sourceLabel}</span>
                    </div>
                    {/* WHAT is wrong comes from the server verbatim; WHAT TO
                        DO is chosen by the reason code, because the remedies
                        genuinely differ — a plugin-served prompt has no registry
                        entry to install, and telling its reader to install it is
                        advice that cannot be followed. The fallback covers a
                        server that stated no decision: Save is still withheld,
                        and saying so without a reason beats inventing one. */}
                    {!editableLocal && (
                      <>
                        <p className="skill-detail__source-note">
                          {selected?.writeRefusal
                            ? skillWriteRefusalNote(selected.writeRefusal)
                            : 'This skill is read-only here. Browse Registry to discover or install skills; create a new workspace skill to author one.'}
                        </p>
                        {/* The path is AUTHOR-CONTROLLED — a plugin names its
                            own directories and the last segment is usually the
                            skill's name — so it gets its own element, labelled
                            as a path and set in a monospace face. Spliced into
                            the sentence above it borrowed the grammar of
                            Station's own explanation, and review built one that
                            read as a session-expiry notice pointing the reader
                            at another domain (#1655 review low). React escapes
                            markup; framing was the whole attack. */}
                        {selected?.writeRefusal?.packageDirectory && (
                          <p className="skill-detail__source-path">
                            <span className="skill-detail__source-path-label">
                              Package directory
                            </span>
                            <code>
                              {selected.writeRefusal.packageDirectory}
                            </code>
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                <div className="agent-editor__section">
                  <div className="editor-field">
                    <label className="editor-label" htmlFor="skill-name">
                      Name
                    </label>
                    <input
                      id="skill-name"
                      className="editor-input"
                      value={form.name}
                      disabled={!isCreating}
                      onChange={(e) => updateForm({ name: e.target.value })}
                    />
                  </div>
                  <div className="editor-field">
                    <label className="editor-label" htmlFor="skill-description">
                      Description
                    </label>
                    <input
                      id="skill-description"
                      className="editor-input"
                      value={form.description}
                      disabled={!editableLocal}
                      onChange={(e) =>
                        updateForm({ description: e.target.value })
                      }
                    />
                  </div>
                  <div className="editor-field">
                    <label className="editor-label" htmlFor="skill-body">
                      Body
                    </label>
                    <textarea
                      id="skill-body"
                      className="editor-textarea editor-textarea--tall editor-textarea--mono"
                      value={form.body}
                      disabled={!editableLocal}
                      onChange={(e) => updateForm({ body: e.target.value })}
                    />
                  </div>
                </div>

                <SkillCommandSection
                  form={form}
                  editable={!!editableLocal}
                  commandDiagnostic={(selected as any)?.commandDiagnostic}
                  onChange={updateForm}
                />

                <div className="agent-editor__section">
                  <details className="editor__expandable">
                    <summary className="editor__expandable-header">
                      <span className="editor__section-title">Metadata</span>
                    </summary>
                    <div className="editor__expandable-content">
                      <div className="editor-field">
                        <label
                          className="editor-label"
                          htmlFor="skill-category"
                        >
                          Category
                        </label>
                        <input
                          id="skill-category"
                          className="editor-input"
                          value={form.category}
                          disabled={!editableLocal}
                          onChange={(e) =>
                            updateForm({ category: e.target.value })
                          }
                        />
                      </div>
                      <div className="editor-field">
                        <label className="editor-label" htmlFor="skill-tags">
                          Tags
                        </label>
                        <input
                          id="skill-tags"
                          className="editor-input"
                          value={form.tags}
                          disabled={!editableLocal}
                          onChange={(e) => updateForm({ tags: e.target.value })}
                        />
                      </div>
                    </div>
                  </details>
                </div>

                {!isCreating && selected && (
                  <div className="editor__footer">
                    <div className="skill-detail__stats">
                      {/* Never "0 runs" for a store that could not be read — see
                      `formatSkillStatsSummary`. */}
                      <span>{statsSummary ?? 'No runs recorded'}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </SplitPaneLayout>
      <SkillRunModal
        isOpen={showRunModal}
        skill={{ name: form.name, body: form.body }}
        variables={formVariables(form)}
        agents={agents.map((agent) => ({
          slug: agent.slug,
          name: agent.name,
        }))}
        onRun={handleRun}
        onCancel={() => setShowRunModal(false)}
      />
      <ImportSkillsModal
        isOpen={showImportModal}
        pending={importSkillsMutation.isPending}
        results={importResults}
        error={importError}
        onImport={(files) => void handleImport(files)}
        onCancel={() => {
          setShowImportModal(false);
          setImportResults(null);
          setImportError(null);
        }}
      />
      <DiscardModal />
    </div>
  );
}
