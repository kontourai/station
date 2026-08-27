import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type AgentData, useAgents } from '../../contexts/AgentsContext';
import { AgentIcon } from '../icons/AgentIcon';
import { CheckGlyph } from '../icons/Glyph';
import { Empty } from '../state';

export function AgentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (slug: string) => void;
}) {
  const agents = useAgents();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const selected = agents.find((a) => a.slug === value);

  const filtered = useMemo(() => {
    if (!filter) return agents;
    const q = filter.toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q),
    );
  }, [agents, filter]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        dropRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 2, left: rect.left, width: rect.width });
  }, [open]);

  const toolCount = (a: AgentData) => {
    const tc = a.toolsConfig;
    if (!tc) return 0;
    return (tc.available?.length || 0) + (tc.mcpServers?.length || 0);
  };

  const select = (slug: string) => {
    onChange(slug);
    setOpen(false);
    setFilter('');
  };

  if (!agents.length) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="agent slug"
      />
    );
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="agent-picker__trigger"
      >
        {selected && <AgentIcon agent={selected} size="small" />}
        <span className="agent-picker__trigger-name">
          {selected ? selected.name : value || 'Select agent…'}
        </span>
        {selected && (
          <span className="agent-picker__trigger-model">
            {selected.model || 'default model'}
          </span>
        )}
        <span className="agent-picker__trigger-caret">▼</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={dropRef}
            className="agent-picker__dropdown"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            {agents.length > 1 && (
              <div className="agent-picker__filter-wrap">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter agents…"
                  onClick={(e) => e.stopPropagation()}
                  className="agent-picker__filter"
                />
              </div>
            )}
            {filtered.map((a) => (
              <button
                type="button"
                key={a.slug}
                onClick={() => select(a.slug)}
                className={`agent-picker__option ${a.slug === value ? 'agent-picker__option--selected' : ''}`}
              >
                <AgentIcon agent={a} size={28} />
                <div className="agent-picker__option-info">
                  <div className="agent-picker__option-name">
                    {a.name}
                    <span className="agent-picker__option-slug">{a.slug}</span>
                  </div>
                  <div className="agent-picker__option-meta">
                    {a.model || 'default model'}
                    {toolCount(a) > 0 ? ` · ${toolCount(a)} tools` : ''}
                  </div>
                </div>
                {a.slug === value && (
                  <span className="agent-picker__check">
                    <CheckGlyph />
                  </span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              /* empty-state action: filter reset is adjacent */
              <Empty variant="compact" label="No matching agents" />
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
