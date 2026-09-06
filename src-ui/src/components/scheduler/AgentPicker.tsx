import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type AgentData,
  useAgentCatalogRead,
  useAgents,
} from '../../contexts/AgentsContext';
import { agentRunnability } from '../agent-runnability';
import { AgentIcon } from '../icons/AgentIcon';
import { ArrowDownGlyph, CheckGlyph } from '../icons/Glyph';
import { Empty, SkeletonList } from '../state';
import {
  schedulerAgentOptions,
  schedulerAgentRunnability,
} from './schedulerAgentOptions';

export function AgentPicker({
  value,
  onChange,
  catalogErrorId,
}: {
  value: string;
  onChange: (slug: string) => void;
  /**
   * #1536 S1: the id of the host's catalog-failure message, when the host is
   * showing one. Passed in rather than hardcoded — the previous version named
   * an element that exists only beside the non-monitor Agent field, so a
   * monitor job's trigger described itself by an id that was not on the page.
   * A dangling `aria-describedby` announces nothing, which is worse than
   * silence because it reads as covered.
   */
  catalogErrorId?: string;
}) {
  const agents = useAgents();
  const { loaded: agentsLoaded, settled: agentsSettled } =
    useAgentCatalogRead();
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
  // waits for the answer.
  //
  // #1536 D2: and it waits on SETTLED, not on loaded. Gating the skeleton on
  // `isSuccess` meant a FAILED read kept it spinning forever — beside the
  // field's own "could not load the Agent catalog / Try again", which is the
  // sentence that actually explains it. Three states, three renderings.
  if (!agentsSettled && !eligible.length) {
    // Still arriving. The control itself is what is waiting, so the shared
    // placeholder stands in for it — labelled rather than spelled out in a
    // bespoke sentence (SHELL-13; enforced by `check-prepush-static-gates`).
    return <SkeletonList count={1} label="Loading agents" />;
  }

  if (!agentsLoaded && !eligible.length) {
    // The read ANSWERED, with a failure. The trigger says nothing about agents
    // — there is nothing to say — and the field's error carries the reason and
    // the retry. A verdict here would be a second, weaker account of the same
    // failure.
    return (
      <button
        type="button"
        // `choice-trigger` is #1546's shared picker vocabulary. This render
        // path is newer than that change, so the merge could not carry the
        // class onto it — every trigger in this picker wears it.
        className="choice-trigger agent-picker__trigger"
        disabled
        // #1536 R5: "Agent unavailable" overclaimed — no Agent has been found
        // unavailable; the CATALOG did not load, which is a different fact and
        // the one the host's message explains. Pointing at that message rather
        // than restating it keeps one account of the failure.
        aria-label="Agent catalog unavailable"
        {...(catalogErrorId ? { 'aria-describedby': catalogErrorId } : {})}
      />
    );
  }

  // Nothing the runner could resolve even in principle. The trigger stays
  // disabled because there is no list to open, and the form beside it — not a
  // dead row here — carries the reason (`SCHEDULER_ENGINE_AGENT_NOTE`).
  if (!eligible.length) {
    return (
      <button
        type="button"
        className="choice-trigger agent-picker__trigger"
        disabled
      >
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
        className="choice-trigger agent-picker__trigger"
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
        <ArrowDownGlyph className="choice-caret" />
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
