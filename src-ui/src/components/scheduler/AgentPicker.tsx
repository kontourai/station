import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type AgentData,
  useAgents,
  useAgentsLoaded,
} from '../../contexts/AgentsContext';
import { agentRunnability } from '../agent-runnability';
import { AgentIcon } from '../icons/AgentIcon';
import { CheckGlyph } from '../icons/Glyph';
import { Empty, SkeletonList } from '../state';
import {
  schedulerAgentOptions,
  schedulerAgentRunnability,
} from './schedulerAgentOptions';

export function AgentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (slug: string) => void;
}) {
  const agents = useAgents();
  const agentsLoaded = useAgentsLoaded();
  const { eligible } = useMemo(() => schedulerAgentOptions(agents), [agents]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const selected = agents.find((a) => a.slug === value);
  const selectedRunnability = schedulerAgentRunnability(agents, value);

  const filtered = useMemo(() => {
    if (!filter) return eligible;
    const q = filter.toLowerCase();
    return eligible.filter(
      (a) =>
        a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q),
    );
  }, [eligible, filter]);

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

  // #1536 H1-2: an unanswered catalog is `[]`, which is indistinguishable from
  // one that genuinely holds nothing. "No runnable agents" is a verdict, so it
  // waits for the answer; until then the trigger says only that it is waiting.
  if (!agentsLoaded && !eligible.length) {
    // The control itself is what is waiting, so the shared placeholder stands in
    // for it — labelled rather than spelled out in a bespoke sentence
    // (SHELL-13; enforced by `check-prepush-static-gates`).
    return <SkeletonList count={1} label="Loading agents" />;
  }

  // Nothing the runner could resolve even in principle. The trigger stays
  // disabled because there is no list to open, and the form beside it — not a
  // dead row here — carries the reason (`SCHEDULER_ENGINE_AGENT_NOTE`).
  if (!eligible.length) {
    return (
      <button type="button" className="agent-picker__trigger" disabled>
        {selected ? (
          <>
            <AgentIcon agent={selected} size="small" />
            <span className="agent-picker__trigger-name">{selected.name}</span>
            <span className="agent-picker__trigger-model">
              Not runnable here
            </span>
          </>
        ) : (
          'No runnable agents'
        )}
      </button>
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
            {selectedRunnability.runnable
              ? selected.model || 'default model'
              : 'Not runnable here'}
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
            {eligible.length > 1 && (
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
            {filtered.map((a) => {
              const runnability = agentRunnability(a);
              return (
                <button
                  type="button"
                  key={a.slug}
                  disabled={!runnability.runnable}
                  onClick={() => select(a.slug)}
                  className={`agent-picker__option ${a.slug === value ? 'agent-picker__option--selected' : ''}`}
                >
                  <AgentIcon agent={a} size={28} />
                  <div className="agent-picker__option-info">
                    <div className="agent-picker__option-name">
                      {a.name}
                      <span className="agent-picker__option-slug">
                        {a.slug}
                      </span>
                    </div>
                    <div className="agent-picker__option-meta">
                      {runnability.runnable ? (
                        <>
                          {a.model || 'default model'}
                          {toolCount(a) > 0 ? ` · ${toolCount(a)} tools` : ''}
                        </>
                      ) : (
                        <span className="agent-picker__option-reason">
                          Not runnable here — {runnability.reason}
                        </span>
                      )}
                    </div>
                  </div>
                  {a.slug === value && (
                    <span className="agent-picker__check">
                      <CheckGlyph />
                    </span>
                  )}
                </button>
              );
            })}
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
