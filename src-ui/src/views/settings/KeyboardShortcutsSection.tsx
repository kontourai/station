import { useMemo, useState } from 'react';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { Empty } from '../../components/state';
import {
  effectiveChordSignature,
  formatShortcutChord,
  type KeyboardShortcut,
  type ShortcutContextKey,
  type ShortcutWhen,
  useShortcutRegistry,
} from '../../contexts/KeyboardShortcutsContext';
import { listedShortcuts } from '../../contexts/listedShortcuts';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  browserReservedReason,
  normalizeShortcutKey,
  readSkillShortcuts,
  type ShortcutBinding,
  type ShortcutModifier,
} from '../../settings/shortcutPreferences';
import { settingsRow } from './settings-catalog';
import './KeyboardShortcutsSection.css';

const conditionLabels: Record<ShortcutContextKey, string> = {
  composerFocused: 'Composer focused',
  terminalFocused: 'Terminal focused',
  browserFocused: 'Browser focused',
  dialogOpen: 'Dialog open',
  dockFocused: 'Chat dock focused',
};

function describeCondition(when: ShortcutWhen): string {
  if (typeof when === 'string') {
    if (when.startsWith('scope:')) return `Scope ${when.slice(6)} active`;
    return conditionLabels[when as ShortcutContextKey];
  }
  if ('not' in when) return `Not (${describeCondition(when.not)})`;
  if ('and' in when)
    return when.and.length
      ? `All of (${when.and.map(describeCondition).join(', ')})`
      : 'Always matches';
  return when.or.length
    ? `Any of (${when.or.map(describeCondition).join(', ')})`
    : 'Never matches';
}

function capturedBinding(
  event: React.KeyboardEvent,
  isMac: boolean,
): ShortcutBinding | null {
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return null;
  const modifiers: ShortcutModifier[] = [];
  if (event.metaKey) modifiers.push('cmd');
  if (event.ctrlKey) modifiers.push(isMac ? 'ctrl' : 'cmd');
  if (event.shiftKey) modifiers.push('shift');
  if (event.altKey) modifiers.push('alt');
  const normalizedKey = normalizeShortcutKey(event.key);
  return {
    key:
      normalizedKey === 'space'
        ? 'Space'
        : event.key.length === 1
          ? normalizedKey
          : event.key,
    modifiers: Array.from(new Set(modifiers)),
  };
}

export function KeyboardShortcutsSection() {
  const {
    getAllShortcuts,
    getDefaultBinding,
    getDisplay,
    isMac,
    restoreBinding,
    setBinding,
  } = useShortcutRegistry();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    target: KeyboardShortcut;
    existing: KeyboardShortcut;
    binding: ShortcutBinding;
    restoreDefault: boolean;
  } | null>(null);
  const shortcuts = getAllShortcuts();
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const listed = listedShortcuts(shortcuts);
    if (!query) return listed;
    return listed.filter((shortcut) => {
      const context = shortcut.when ? describeCondition(shortcut.when) : '';
      return `${shortcut.description} ${shortcut.id} ${context}`
        .toLowerCase()
        .includes(query);
    });
  }, [search, shortcuts]);
  const registeredIds = new Set(shortcuts.map((shortcut) => shortcut.id));
  const savedUnavailable = Object.entries(readSkillShortcuts()).filter(
    ([name]) => !registeredIds.has(`skill.${name}.run`),
  );
  const skills = filtered.filter((shortcut) =>
    shortcut.id.startsWith('skill.'),
  );
  const commands = filtered.filter(
    (shortcut) => !shortcut.id.startsWith('skill.'),
  );

  function applyCapture(
    shortcut: KeyboardShortcut,
    binding: ShortcutBinding,
    restoreDefault = false,
  ) {
    const signature = effectiveChordSignature(binding, isMac);
    const existing = shortcuts.find(
      (candidate) =>
        candidate.id !== shortcut.id &&
        !candidate.disabled &&
        effectiveChordSignature(candidate, isMac) === signature,
    );
    if (existing) {
      setConflict({ target: shortcut, existing, binding, restoreDefault });
      return;
    }
    if (restoreDefault) restoreBinding(shortcut.id);
    else setBinding(shortcut.id, binding);
  }

  const renderShortcut = (shortcut: KeyboardShortcut) => {
    const condition = shortcut.when;
    const warning = shortcut.disabled ? null : browserReservedReason(shortcut);
    const isCapturing = capturingId === shortcut.id;
    return (
      <article key={shortcut.id} className="shortcut-editor__row">
        <div className="shortcut-editor__command">
          <strong>{shortcut.description}</strong>
          <span>
            {condition ? describeCondition(condition) : 'No extra condition'}
          </span>
          {warning && (
            <span className="shortcut-editor__warning">{warning}</span>
          )}
          <details>
            <summary>Advanced</summary>
            {condition ? (
              <code>{JSON.stringify(condition)}</code>
            ) : (
              <span>Condition unset</span>
            )}
            <span>
              Open dialogs pause shortcuts. A focused control may own the key.
            </span>
          </details>
        </div>
        <div className="shortcut-editor__controls">
          <button
            type="button"
            className={`shortcut-editor__capture${
              isCapturing ? ' shortcut-editor__capture--active' : ''
            }`}
            disabled={isMobile}
            aria-label={`Shortcut for ${shortcut.description}`}
            onClick={() =>
              setCapturingId((current) =>
                current === shortcut.id ? null : shortcut.id,
              )
            }
            onKeyDown={(event) => {
              if (!isCapturing) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === 'Escape') {
                setCapturingId(null);
                return;
              }
              const binding = capturedBinding(event, isMac);
              if (!binding) return;
              setCapturingId(null);
              applyCapture(shortcut, binding);
            }}
          >
            {isCapturing ? 'Press keys…' : getDisplay(shortcut.id)}
          </button>
          {!isMobile && (
            <div className="shortcut-editor__actions">
              <button
                type="button"
                onClick={() => setBinding(shortcut.id, null)}
                disabled={shortcut.disabled}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => {
                  const binding = getDefaultBinding(shortcut.id);
                  if (binding) applyCapture(shortcut, binding, true);
                  else restoreBinding(shortcut.id);
                }}
              >
                Restore default
              </button>
            </div>
          )}
        </div>
      </article>
    );
  };

  return (
    <div {...settingsRow('keyboard-shortcuts')} tabIndex={-1}>
      <div className="shortcut-editor">
        <div className="shortcut-editor__intro">
          <p>
            Search a command, then select its shortcut and press the keys you
            want. The list shows commands registered in this view.
          </p>
          {isMobile && (
            <p className="shortcut-editor__notice" role="note">
              Shortcuts are shown here for reference. Edit them from Station on
              a computer.
            </p>
          )}
          {!isMobile && (
            <p className="shortcut-editor__notice" role="note">
              Browser shortcuts may run before Station sees them. The desktop
              app supports more combinations.
            </p>
          )}
        </div>
        <input
          className="shortcut-editor__search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search commands and shortcuts…"
          aria-label="Search keyboard shortcuts"
        />
        <div className="shortcut-editor__list">
          <h3>Commands</h3>
          {commands.map(renderShortcut)}
          <section {...settingsRow('skill-shortcuts')} tabIndex={-1}>
            <h3>Skill shortcuts</h3>
            <p>
              Skills on this device run from the keys assigned to them here.
            </p>
            {skills.map(renderShortcut)}
            {skills.length === 0 && (
              <Empty
                variant="compact"
                label="Open a view that makes the skill available to edit its shortcut."
              />
            )}
            {savedUnavailable.length > 0 && (
              <ul aria-label="Saved shortcuts for unavailable skills">
                {savedUnavailable.map(([skill, binding]) => (
                  <li key={skill}>
                    {skill}:{' '}
                    {binding
                      ? formatShortcutChord(binding.modifiers, binding.key)
                      : 'Not set'}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {filtered.length === 0 && (
            <Empty
              variant="compact"
              label="Try a different search or open the view that registers the command."
            />
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={!!conflict}
        title="Shortcut already in use"
        message={
          conflict
            ? `${getDisplay(conflict.existing.id)} is assigned to “${conflict.existing.description}.” Replace it with “${conflict.target.description}”?`
            : ''
        }
        confirmLabel="Replace"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => {
          if (!conflict) return;
          setBinding(conflict.existing.id, null);
          if (conflict.restoreDefault) restoreBinding(conflict.target.id);
          else setBinding(conflict.target.id, conflict.binding);
          setConflict(null);
        }}
        onCancel={() => setConflict(null)}
      />
    </div>
  );
}
