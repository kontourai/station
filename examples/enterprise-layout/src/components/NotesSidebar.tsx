import { useState } from 'react';
import type { KnowledgeTreeNode } from '../types/knowledge';

interface NotesSidebarProps {
  tree: KnowledgeTreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  loading?: boolean;
}

interface TreeItemProps {
  node: KnowledgeTreeNode;
  selectedPath: string | null;
  filter: string;
  onSelect: (path: string) => void;
  depth: number;
}

function nodeMatchesFilter(node: KnowledgeTreeNode, filter: string): boolean {
  if (!filter) return true;
  const q = filter.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.children?.some((c) => nodeMatchesFilter(c, filter))) return true;
  return false;
}

function TreeItem({
  node,
  selectedPath,
  filter,
  onSelect,
  depth,
}: TreeItemProps) {
  const [expanded, setExpanded] = useState(true);

  if (!nodeMatchesFilter(node, filter)) return null;

  if (node.type === 'directory') {
    return (
      <div
        className="notes-tree-dir"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        <button
          type="button"
          className="notes-tree-dir-btn"
          onClick={() => setExpanded((x) => !x)}
        >
          <span className="notes-tree-chevron">{expanded ? '▾' : '▸'}</span>
          <span className="notes-tree-dir-name">{node.name}</span>
          {node.fileCount != null && (
            <span className="notes-tree-count">{node.fileCount}</span>
          )}
        </button>
        {expanded &&
          node.children?.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              filter={filter}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
      </div>
    );
  }

  const isSelected = node.path === selectedPath;
  return (
    <button
      type="button"
      className={`notes-tree-file ${isSelected ? 'notes-tree-file--active' : ''}`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onClick={() => onSelect(node.path)}
      title={node.path}
    >
      <span className="notes-tree-file-icon">📄</span>
      <span className="notes-tree-file-name">{node.name}</span>
    </button>
  );
}

export function NotesSidebar({
  tree,
  selectedPath,
  onSelect,
  loading = false,
}: NotesSidebarProps) {
  const [filter, setFilter] = useState('');

  return (
    <div className="notes-sidebar">
      <div className="notes-sidebar-header">
        <input
          type="text"
          className="notes-sidebar-search"
          placeholder="Filter notes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="notes-sidebar-tree">
        {loading && <div className="notes-sidebar-loading">Loading…</div>}
        {!loading && tree.length === 0 && (
          <div className="notes-sidebar-empty">No notes yet</div>
        )}
        {tree.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            selectedPath={selectedPath}
            filter={filter}
            onSelect={onSelect}
            depth={0}
          />
        ))}
      </div>
    </div>
  );
}
