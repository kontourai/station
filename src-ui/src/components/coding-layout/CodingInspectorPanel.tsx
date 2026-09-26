import {
  type ReadinessInitResultVM,
  useFlowDefinitionsQuery,
  useInitFlowMutation,
  useInitReadinessMutation,
  useReadinessQuery,
  useReviewEvidenceQuery,
  useTrustBundlesQuery,
} from '@kontourai/station-sdk';
import { ProductIcon, type ProductIconSlug } from '@kontourai/ui/react';
import { useEffect, useMemo, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import {
  type WorkflowPlanArtifact,
  WorkflowPlanPanel,
} from '../flow/WorkflowPlanPanel';
import { ConfirmModal } from '../modals/ConfirmModal';
import { ReadinessPanel } from '../readiness/ReadinessPanel';
import { Empty } from '../state';
import { TrustPanel } from '../trust/TrustPanel';
import './CodingInspectorPanel.css';
import { IndependentReviewInspectorContent } from './IndependentReviewInspectorContent';

// #2064 (D4): independent-review receipts and the run action live next to the
// Git range they judge, not on the global Review page.
export type InspectorTabId = 'plan' | 'readiness' | 'trust' | 'reviews';

const TAB_LABELS: Record<InspectorTabId, string> = {
  plan: 'Plan',
  readiness: 'Readiness',
  trust: 'Trust',
  reviews: 'Reviews',
};

// Each inspector tab carries its owning Kontour product's mark: Plan → Flow,
// Readiness → Veritas, Trust → Surface. Rendered via @kontourai/ui's
// ProductIcon so the marks tint with the tab's currentColor.
const TAB_PRODUCTS: Record<InspectorTabId, ProductIconSlug> = {
  plan: 'flow',
  readiness: 'veritas',
  trust: 'surface',
  // Independent review evidence is Station's own module
  // (`src-server/services/evidence/review-evidence-module.ts`), not a sibling
  // product's, so the tab wears Station's mark rather than borrowing one.
  reviews: 'station',
};

const FLOW_DOCS_URL = 'https://kontourai.io/flow';
const VERITAS_DOCS_URL = 'https://kontourai.io/veritas';
const TRUST_DOCS_URL = 'https://kontourai.io/surface';

export interface InspectorTabState {
  id: InspectorTabId;
  /** Whether the underlying tool is configured for this project. */
  configured: boolean;
  /** Whether the tab should show an attention badge (e.g. readiness failing). */
  attention: boolean;
}

/**
 * Shared hook so the collapsed strip and the expanded tab bar agree on which
 * tabs exist, which are configured, and which need attention. A tab is shown
 * when its tool is configured OR it has a meaningful setup CTA (plan +
 * readiness always have one; trust always renders guidance) — so no tab is
 * ever a dead end.
 */
export function useInspectorTabs(projectSlug: string): {
  tabs: InspectorTabState[];
  anyConfigured: boolean;
} {
  const flow = useFlowDefinitionsQuery(projectSlug);
  // Opt OUT of the keepPreviousData default (archive#3092). These drive the
  // tab strip's `configured` and `attention` dots, which have nowhere to
  // render a "refreshing" marking — so a held render would show the OUTGOING
  // project's "not ready" dot under the incoming project, silently. The
  // hook-level default is honest only where the consumer marks it; here the
  // honest answer during a switch is no badge at all, which is what
  // undefined already gives.
  const readiness = useReadinessQuery(projectSlug, {
    keepPreviousData: false,
  });
  const { data: bundles } = useTrustBundlesQuery(projectSlug, {
    keepPreviousData: false,
  });
  // #2064: the aggregate is not project-scoped, so the count is filtered here
  // — the same filter the tab's own content applies, for the same reason a
  // project row must not claim another project's receipts.
  const { data: reviewEvidence } = useReviewEvidenceQuery();
  const reviewReceiptCount = (reviewEvidence?.receipts ?? []).filter(
    (receipt) => receipt.target.projectSlug === projectSlug,
  ).length;

  return useMemo(() => {
    const planConfigured = !!flow.data?.initialized;
    const readinessConfigured = !!readiness.data?.configured;
    const trustConfigured = (bundles?.length ?? 0) > 0;

    const readinessAttention =
      readinessConfigured && readiness.data?.overall === 'not-ready';

    const tabs: InspectorTabState[] = [
      { id: 'plan', configured: planConfigured, attention: false },
      {
        id: 'readiness',
        configured: readinessConfigured,
        attention: readinessAttention,
      },
      { id: 'trust', configured: trustConfigured, attention: false },
      {
        id: 'reviews',
        // "Configured" here means this project has produced review evidence.
        // The tab is never a dead end without it: the run action is the
        // setup CTA, which is why it carries no separate one.
        configured: reviewReceiptCount > 0,
        attention: false,
      },
    ];

    return {
      tabs,
      anyConfigured: planConfigured || readinessConfigured || trustConfigured,
    };
  }, [
    flow.data?.initialized,
    readiness.data?.configured,
    readiness.data?.overall,
    bundles?.length,
    reviewReceiptCount,
  ]);
}

function SetupCta({
  label,
  helper,
  onAction,
  pending,
  error,
  docsUrl,
  command,
  commandNote,
}: {
  label: string;
  helper?: string;
  onAction?: () => void;
  pending?: boolean;
  error?: string | null;
  docsUrl: string;
  /** When set, show a copyable command instead of a one-click action. */
  command?: string;
  /**
   * Why the copy-command fallback exists instead of the one-click action, so
   * the bare command does not read as an instruction to leave the app for a
   * terminal the reader may not have open.
   */
  commandNote?: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  useEffect(() => {
    if (copyState === 'idle') return;
    const t = window.setTimeout(() => setCopyState('idle'), 1500);
    return () => window.clearTimeout(t);
  }, [copyState]);

  return (
    <div className="coding-inspector__cta">
      {command ? (
        <>
          {commandNote && (
            <p className="coding-inspector__cta-note">{commandNote}</p>
          )}
          <code className="coding-inspector__cta-command">{command}</code>
          <div className="coding-inspector__cta-row">
            <button
              type="button"
              className={`coding-inspector__cta-action${
                copyState === 'failed' ? ' copy-affordance--failed' : ''
              }`}
              title={
                copyState === 'failed'
                  ? 'This browser refused clipboard access — select the command above to copy it manually.'
                  : undefined
              }
              onClick={() => {
                void copyToClipboard(command).then((copied) => {
                  setCopyState(copied ? 'copied' : 'failed');
                });
              }}
            >
              {copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? "Can't copy"
                  : 'Copy command'}
            </button>
            <a
              className="coding-inspector__cta-link"
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Docs
            </a>
          </div>
        </>
      ) : (
        <>
          {onAction && (
            <button
              type="button"
              className="coding-inspector__cta-action"
              onClick={onAction}
              disabled={pending}
            >
              {pending ? 'Working…' : label}
            </button>
          )}
          <a
            className="coding-inspector__cta-link"
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
          >
            {helper ?? 'Learn more'}
          </a>
        </>
      )}
      {error && (
        <p className="coding-inspector__cta-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function WorkflowPlanInspectorContent({
  projectSlug,
  artifact,
  sessionTitle,
  runtimeState,
  configured,
}: {
  projectSlug: string;
  artifact: WorkflowPlanArtifact | null;
  sessionTitle?: string | null;
  runtimeState?: {
    status?: string | null;
    pendingApprovals?: number;
    isProcessingStep?: boolean;
  };
  configured: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const initFlow = useInitFlowMutation(projectSlug);
  const initError =
    initFlow.error instanceof Error ? initFlow.error.message : null;

  // A plan artifact can still arrive from chat even without a `.flow/` layout;
  // only show the setup CTA when neither a flow layout nor a live artifact
  // exists, so we never hide a real plan behind the empty state.
  if (!configured && !artifact) {
    return (
      <>
        <Empty
          variant="compact"
          label="No delivery flow"
          description="Add a Flow delivery definition to track gated steps, evidence, and route-backs as this project ships."
          action={
            <SetupCta
              label="Add a delivery flow"
              helper="What is Flow?"
              docsUrl={FLOW_DOCS_URL}
              pending={initFlow.isPending}
              error={initError}
              onAction={() => setConfirmOpen(true)}
            />
          }
        />
        <ConfirmModal
          isOpen={confirmOpen}
          title="Add a delivery flow?"
          message="This scaffolds a starter .flow/ layout in the project workspace (it writes files to your project). You can edit or remove it afterwards."
          confirmLabel="Add flow"
          onConfirm={() => {
            setConfirmOpen(false);
            initFlow.mutate();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      </>
    );
  }

  return (
    <WorkflowPlanPanel
      artifact={artifact}
      sessionTitle={sessionTitle}
      runtimeState={runtimeState}
    />
  );
}

export function ReadinessInspectorContent({
  projectSlug,
}: {
  projectSlug: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const initReadiness = useInitReadinessMutation(projectSlug);
  const initError =
    initReadiness.error instanceof Error ? initReadiness.error.message : null;
  const result = initReadiness.data as ReadinessInitResultVM | undefined;
  const noCli = result?.outcome === 'no-cli';

  return (
    <>
      <ReadinessPanel
        projectSlug={projectSlug}
        renderSetup={() =>
          noCli ? (
            <SetupCta
              label="Set up readiness"
              docsUrl={VERITAS_DOCS_URL}
              command={result?.command ?? 'npx veritas init --non-interactive'}
              commandNote="The Veritas CLI is not installed in this workspace yet, so Station cannot run the setup for you. Copy the command below into a terminal in this project — it downloads the CLI and scaffolds a .veritas/ directory (it writes files to your project)."
            />
          ) : (
            <SetupCta
              label="Set up readiness"
              helper="What is Veritas?"
              docsUrl={VERITAS_DOCS_URL}
              pending={initReadiness.isPending}
              error={initError}
              onAction={() => setConfirmOpen(true)}
            />
          )
        }
      />
      <ConfirmModal
        isOpen={confirmOpen}
        title="Set up merge readiness?"
        message="This runs `veritas init` in the project workspace, creating a .veritas/ directory (it writes files to your project). You can edit or remove it afterwards."
        confirmLabel="Set up"
        onConfirm={() => {
          setConfirmOpen(false);
          initReadiness.mutate();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

export function TrustInspectorContent({
  projectSlug,
}: {
  projectSlug: string;
}) {
  return (
    <div className="coding-inspector__trust">
      <TrustPanel projectSlug={projectSlug} />
      <SetupCta
        label="Trust bundles"
        helper="How trust bundles work"
        docsUrl={TRUST_DOCS_URL}
      />
    </div>
  );
}

export function CodingInspectorPanel({
  projectSlug,
  tabs,
  activeTab,
  onSelectTab,
  onCollapse,
  artifact,
  sessionTitle,
  runtimeState,
}: {
  projectSlug: string;
  tabs: InspectorTabState[];
  activeTab: InspectorTabId;
  onSelectTab: (tab: InspectorTabId) => void;
  onCollapse: () => void;
  artifact: WorkflowPlanArtifact | null;
  sessionTitle?: string | null;
  runtimeState?: {
    status?: string | null;
    pendingApprovals?: number;
    isProcessingStep?: boolean;
  };
}) {
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0];

  return (
    <div className="coding-inspector">
      <div className="coding-inspector__bar">
        <div
          className="coding-inspector__tabs"
          role="tablist"
          aria-label="Coding inspector"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`inspector-tab-${tab.id}`}
              aria-selected={tab.id === activeTab}
              aria-controls={`inspector-panel-${tab.id}`}
              aria-label={`${TAB_LABELS[tab.id]}${
                tab.attention ? ', needs attention' : ''
              }`}
              className={`coding-inspector__tab${
                tab.id === activeTab ? ' is-active' : ''
              }`}
              onClick={() => onSelectTab(tab.id)}
            >
              <ProductIcon
                product={TAB_PRODUCTS[tab.id]}
                size={16}
                className="coding-inspector__tab-icon"
                data-product={TAB_PRODUCTS[tab.id]}
              />
              <span className="coding-inspector__tab-label">
                {TAB_LABELS[tab.id]}
              </span>
              {tab.attention && (
                <span
                  className="coding-inspector__tab-badge"
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="coding-inspector__collapse"
          aria-label="Collapse inspector panel"
          onClick={onCollapse}
        >
          ›
        </button>
      </div>

      <div
        className="coding-inspector__body"
        role="tabpanel"
        id={`inspector-panel-${active.id}`}
        aria-labelledby={`inspector-tab-${active.id}`}
      >
        {active.id === 'plan' && (
          <WorkflowPlanInspectorContent
            projectSlug={projectSlug}
            artifact={artifact}
            sessionTitle={sessionTitle}
            runtimeState={runtimeState}
            configured={active.configured}
          />
        )}
        {active.id === 'readiness' && (
          <ReadinessInspectorContent projectSlug={projectSlug} />
        )}
        {active.id === 'trust' && (
          <TrustInspectorContent projectSlug={projectSlug} />
        )}
        {active.id === 'reviews' && (
          <IndependentReviewInspectorContent projectSlug={projectSlug} />
        )}
      </div>
    </div>
  );
}

/** The slim strip shown when the inspector is collapsed. */
export function CodingInspectorStrip({
  tabs,
  onExpand,
}: {
  tabs: InspectorTabState[];
  onExpand: (tab: InspectorTabId) => void;
}) {
  return (
    <section
      className="coding-inspector-strip"
      aria-label="Coding inspector (collapsed)"
    >
      <button
        type="button"
        className="coding-inspector-strip__expand"
        aria-label="Expand inspector panel"
        onClick={() => onExpand(tabs[0]?.id ?? 'plan')}
      >
        ‹
      </button>
      <div className="coding-inspector-strip__icons">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="coding-inspector-strip__icon"
            title={`${TAB_LABELS[tab.id]}${tab.attention ? ' — needs attention' : ''}`}
            aria-label={`Open ${TAB_LABELS[tab.id]}${
              tab.attention ? ', needs attention' : ''
            }`}
            onClick={() => onExpand(tab.id)}
          >
            <ProductIcon
              product={TAB_PRODUCTS[tab.id]}
              size={18}
              className="coding-inspector-strip__icon-mark"
              data-product={TAB_PRODUCTS[tab.id]}
            />
            {tab.attention && (
              <span
                className="coding-inspector-strip__badge"
                aria-hidden="true"
              />
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
