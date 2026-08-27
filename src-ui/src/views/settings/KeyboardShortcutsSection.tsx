import { Fragment, useMemo, useState } from 'react';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { Empty } from '../../components/state';
import {
  type KeyboardShortcut,
  useShortcutRegistry,
} from '../../contexts/KeyboardShortcutsContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  bindingSignature,
  browserReservedReason,
  type ShortcutBinding,
  type ShortcutModifier,
} from '../../settings/shortcutPreferences';
import { settingsRow } from './settings-catalog';
import './KeyboardShortcutsSection.css';

function contextDescription(id: string): { label: string; raw: string } {
  if (id.startsWith('dock.')) {
    return { label: 'While chat is available', raw: 'dockAvailable' };
  }
  if (id === 'active-command-launcher') {
    return {
      label: 'While project work is active',
      raw: 'dockOpen && activeProject',
    };
  }
  if (id.startsWith('view.') || id === 'app.escapeUp') {
    return { label: 'While a page can be closed', raw: 'parentViewAvailable' };
  }
  return { label: 'Anywhere in Station', raw: 'always' };
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
  return {
    key:
      event.key === ' '
        ? 'Space'
        : event.key.length === 1
          ? event.key.toLocaleLowerCase()
          : event.key,
    modifiers: Array.from(new Set(modifiers)),
  };
}

function shortcutBinding(shortcut: KeyboardShortcut): ShortcutBinding {
  return { key: shortcut.key, modifiers: shortcut.modifiers };
}

export function KeyboardShortcutsSection() {
  const { getAllShortcuts, getDisplay, isMac, restoreBinding, setBinding } =
    useShortcutRegistry();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    target: KeyboardShortcut;
    existing: KeyboardShortcut;
    binding: ShortcutBinding;
  } | null>(null);
  const shortcuts = getAllShortcuts();
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return shortcuts;
    return shortcuts.filter((shortcut) => {
      const context = contextDescription(shortcut.id).label;
      return `${shortcut.description} ${shortcut.id} ${context}`
        .toLowerCase()
        .includes(query);
    });
  }, [search, shortcuts]);
  const firstSkillIndex = filtered.findIndex((shortcut) =>
    shortcut.id.startsWith('skill.'),
  );

  function applyCapture(shortcut: KeyboardShortcut, binding: ShortcutBinding) {
    const signature = bindingSignature(binding);
    const existing = shortcuts.find(
      (candidate) =>
        candidate.id !== shortcut.id &&
        !candidate.disabled &&
        bindingSignature(shortcutBinding(candidate)) === signature,
    );
    if (existing) {
      setConflict({ target: shortcut, existing, binding });
      return;
    }
    setBinding(shortcut.id, binding);
  }

  return (
    <div {...settingsRow('keyboard-shortcuts')} tabIndex={-1}>
      <div className="shortcut-editor">
        <div className="shortcut-editor__intro">
          <p>
            Search a command, then select its shortcut and press the keys you
            want.
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
          {filtered.map((shortcut, index) => {
            const context = contextDescription(shortcut.id);
            const warning = shortcut.disabled
              ? null
              : browserReservedReason(shortcutBinding(shortcut));
            const isCapturing = capturingId === shortcut.id;
            return (
              <Fragment key={shortcut.id}>
                {index === firstSkillIndex && <h3>Command Skills</h3>}
                <article className="shortcut-editor__row">
                  <div className="shortcut-editor__command">
                    <strong>{shortcut.description}</strong>
                    <span>{context.label}</span>
                    {warning && (
                      <span className="shortcut-editor__warning">
                        {warning}
                      </span>
                    )}
                    <details>
                      <summary>Advanced</summary>
                      <code>{context.raw}</code>
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
                          onClick={() => restoreBinding(shortcut.id)}
                        >
                          Restore default
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              </Fragment>
            );
          })}
          {filtered.length === 0 && (
            <Empty variant="compact" label="Try a different search." />
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
          setBinding(conflict.target.id, conflict.binding);
          setConflict(null);
        }}
        onCancel={() => setConflict(null)}
      />
    </div>
  );
}
