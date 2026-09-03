import { Empty } from '../../components/state';
import type { Plugin, PluginMessage, PluginUpdateSummary } from './types';

export function PluginEmptyState({
  updates,
  filteredPlugins,
  message,
  onUpdateAll,
}: {
  updates: PluginUpdateSummary[];
  filteredPlugins: Plugin[];
  message: PluginMessage | null;
  onUpdateAll: () => void;
}) {
  return (
    <div className="detail-panel">
      {updates.length > 0 && (
        <div className="plugins__update-banner">
          <span className="plugins__update-banner-text">
            {updates.length} update{updates.length > 1 ? 's' : ''} available
          </span>
          <button
            type="button"
            className="plugins__update-all-btn"
            onClick={onUpdateAll}
          >
            Update All
          </button>
        </div>
      )}
      {message && (
        <div className={`plugins__message plugins__message--${message.type}`}>
          <span>{message.text}</span>
          {message.action && (
            <button
              type="button"
              className="editor-btn"
              onClick={message.action.invoke}
            >
              {message.action.label}
            </button>
          )}
        </div>
      )}
      {/*
        station#4463 slice 2: SHELL-09's own fix for the double-empty here was
        itself inverted. `SplitPaneLayout`'s list panel already renders one
        message whenever the (filtered) list is empty — `Empty` for a truly
        empty collection, `FilteredEmpty` for a search with no matches — and
        this pane is passed unconditionally as `emptyContent`, bypassing the
        layout's own double-empty guard. So the fix has to live here: only
        add "Nothing selected" when there is a currently-visible list to
        select FROM. When the visible list is empty, this pane says nothing
        beyond the update banner / message above, and the list's own empty
        state stands alone.
      */}
      {filteredPlugins.length > 0 && (
        <Empty
          variant="prominent"
          label="Nothing selected"
          description="Select a plugin from the list to see what it adds."
        />
      )}
    </div>
  );
}
