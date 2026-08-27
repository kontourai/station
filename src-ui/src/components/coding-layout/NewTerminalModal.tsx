import { useRef, useState } from 'react';
import type { ACPConnectionInfo } from '../../hooks/useACPConnections';
import {
  getRecentAgentSlugs,
  trackRecentAgent,
} from '../../hooks/useRecentAgents';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { AgentGlyph } from '../icons/Glyph';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';
import { buildNewTerminalItems } from './utils';

export function NewTerminalModal({
  connections,
  onSelect,
  onClose,
}: {
  connections: ACPConnectionInfo[];
  onSelect: (
    type: 'shell' | 'agent',
    slug?: string,
    connectionId?: string,
  ) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = buildNewTerminalItems(
    connections,
    filter,
    getRecentAgentSlugs(),
  );

  const selectItem = (item: (typeof items)[number]) => {
    if (item.type === 'agent' && item.slug) {
      trackRecentAgent(item.slug);
    }
    onSelect(item.type, item.slug, item.connectionId);
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIdx((index) => Math.min(index + 1, items.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIdx((index) => Math.max(index - 1, 0));
      return;
    }
    if (
      event.key === 'Enter' &&
      !isComposingKeyEvent(event) &&
      items[selectedIdx]
    ) {
      selectItem(items[selectedIdx]);
    }
  };

  return (
    <ResponsiveDialogSurface
      ariaLabel="New terminal"
      overlayClassName="coding-layout__new-terminal-overlay"
      panelClassName="coding-layout__new-terminal-modal"
      initialFocusRef={inputRef}
      initialFocusPolicy="desktop"
      onClose={onClose}
    >
      <div className="coding-layout__new-terminal-header">
        <input
          ref={inputRef}
          className="coding-layout__new-terminal-filter"
          placeholder="Select terminal type..."
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setSelectedIdx(0);
          }}
          onKeyDown={onKey}
        />
        <ResponsiveDialogCloseButton
          label="Close new terminal"
          onClick={onClose}
        />
      </div>
      <div className="coding-layout__new-terminal-list">
        {items.map((item, index) => {
          const prevItem = items[index - 1];
          const showRecentHeader =
            item.section === 'recent' && prevItem?.section !== 'recent';
          const showAllHeader =
            !item.section &&
            item.type === 'agent' &&
            prevItem?.section === 'recent';

          return (
            <div key={item.key}>
              {showRecentHeader && (
                <div className="coding-layout__new-terminal-section">
                  Recently Used
                </div>
              )}
              {showAllHeader && (
                <div className="coding-layout__new-terminal-section">
                  All Agents
                </div>
              )}
              <button
                type="button"
                className={`coding-layout__new-terminal-option ${index === selectedIdx ? 'coding-layout__new-terminal-option--selected' : ''}`}
                onClick={() => selectItem(item)}
                onMouseEnter={() => setSelectedIdx(index)}
              >
                <span className="coding-layout__new-terminal-icon">
                  {item.type === 'agent' ? <AgentGlyph /> : '>_'}
                </span>
                <span>{item.label}</span>
                <span className="coding-layout__new-terminal-hint">
                  {item.hint}
                </span>
              </button>
            </div>
          );
        })}
        {items.length === 0 && <Empty variant="compact" label="No matches" />}
      </div>
    </ResponsiveDialogSurface>
  );
}
