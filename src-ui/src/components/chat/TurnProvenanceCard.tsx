import {
  isSupportedTurnProvenanceEnvelope,
  type TurnProvenanceEnvelope,
  type TurnProvenanceRefSlot,
  type TurnProvenanceSlot,
  type TurnProvenanceTrustReportRef,
  type TurnProvenanceUnavailableReason,
  type TurnProvenanceUsage,
} from '@kontourai/station-contracts/turn-provenance';
import type { TurnProvenanceContextInjection } from '@kontourai/station-contracts/turn-provenance-context';
import {
  cacheInclusiveTotalTokens,
  providerPromptCacheInclusivity,
} from '@kontourai/station-shared/usage-fold';
import { useId, useState } from 'react';
import {
  exactTokenCount,
  formatTokenCount,
} from '../../utils/formatTokenCount';
import { displayModelIdentifier } from '../../utils/modelDisplay';
import { engineLabelForProvider } from '../../utils/sessionDisplay';
import './TurnProvenanceCard.css';

/**
 * Collapsed per-answer provenance card (archive#1410, redesigned archive#1802
 * off the owner's "what am I supposed to take away from that?" complaint) —
 * the render half of the turn provenance envelope.
 *
 * The card's whole job is to be *checkable*: it says what Station observed
 * for this turn and, for everything else, that it observed nothing and why.
 * Three rules it holds to, each of which is a defect if broken:
 *
 * - **No zeroes for absence.** A missing token count renders as a named gap,
 *   never `0`; a turn with no observed tool events renders as a named gap,
 *   never "0 tools". `0` is a measurement, and Station rarely has one.
 * - **No omission.** Every field of the envelope gets a row, including the
 *   ones that are always gaps today (routing receipt, sources). A field the
 *   card silently skipped would read as "nothing to report here."
 * - **No partial decoding.** An envelope whose version this build does not
 *   understand renders as one honest unavailable row rather than a
 * best-effort read of the fields that happen to look familiar. The
 *   surrounding transcript is unaffected either way.
 *
 * archive#1802 adds a fourth rule, about presentation rather than data:
 *
 * - **Four kinds of row read as four different things.** An *earned claim*
 *   (this turn's engine, model, cost) is the product's whole point and leads
 *   the collapsed line. A *meaningful absence* ("Tools: not reported by this
 *   engine") is a real property of the engine and stays in the checkable
 *   list, visually distinct from an earned claim but not styled as a defect.
 *   Station's OWN gaps ("not captured by Station yet") read identically
 *   under every answer forever — that is not per-answer information, so it
 *   is demoted to its own "Not yet captured" block, kept (not deleted, see
 *   the no-omission rule above) but out of the badge and out of the
 *   checkable list. Correlation ids (the turn UUID) are metadata, not a
 *   claim — they live in their own block with a copy control, not mixed in
 *   with the facts a reader is meant to check.
 *
 * Kontour-facing surface, so it consumes Console Kit `--k-*` tokens like the
 * trust panel, readiness panel, and gate verdict cards (see the scoping rule
 * at the top of `src-ui/src/index.css`).
 */

const UNAVAILABLE_TEXT: Record<TurnProvenanceUnavailableReason, string> = {
  'not-reported-by-engine': 'Not reported by this engine',
  'not-captured-by-station': 'Not captured by Station yet',
  'reported-only-at-session-scope':
    'This engine reports it per session, not per answer',
  'usage-scope-undeclared':
    'This engine has not declared whether its figures are per answer',
  // archive#1423. Says who is restricted and that the record exists — a
  // share viewer must not read this as "Station has nothing", which is what
  // every other reason here means.
  'restricted-for-this-viewer':
    'Recorded, but this share does not authorize opening it',
};

/**
 * A reason string this build has never heard of still has to say something.
 * The lookup is a closed `Record`, so an envelope written by a newer Station
 * would otherwise render an EMPTY value cell — a blank that reads as "fine,
 * nothing to report" when it actually means "we don't know what this says".
 */
const UNRECOGNIZED_REASON_TEXT =
  "Reported unavailable for a reason this version doesn't recognize";

function unavailableText(reason: TurnProvenanceUnavailableReason): string {
  // `Object.hasOwn`, not `??`: a reason of `toString` or `constructor` finds a
  // truthy value on the prototype chain, so `??` never fires and the cell
  // renders a stringified function (or, after coercion, nothing useful).
  // Attacker-supplied or not, an envelope field must only ever match a key
  // this object actually declares.
  return Object.hasOwn(UNAVAILABLE_TEXT, reason)
    ? UNAVAILABLE_TEXT[reason]
    : UNRECOGNIZED_REASON_TEXT;
}

/**
 * Station's own backlog, not a per-answer fact (archive#1802). Every other
 * reason in {@link UNAVAILABLE_TEXT} says something about THIS turn or THIS
 * engine; this one says the same thing about every turn until the feature
 * ships. Rows carrying it are kept — see the no-omission rule in the module
 * docblock — but demoted to their own block and excluded from the badge.
 */
const STATION_BACKLOG_REASON: TurnProvenanceUnavailableReason =
  'not-captured-by-station';

interface ProvenanceRow {
  label: string;
  /** Rendered value when observed/referenced; `null` means "show the gap". */
  value: string | null;
  gap: TurnProvenanceUnavailableReason | null;
  trustReportRef?: TurnProvenanceTrustReportRef;
  /**
   * archive#2649: an informational line that is neither an earned claim nor
   * a gap — today only the Context row's "Managed by <engine>", derived from
   * the observed engine binding rather than from a context observation.
   * Rendered in the absence style: it reports what Station did NOT do.
   */
  note?: string;
}

function slotRow<TValue>(
  label: string,
  slot: TurnProvenanceSlot<TValue>,
  render: (value: TValue) => string | null,
): ProvenanceRow {
  if (slot.state === 'unavailable') {
    return { label, value: null, gap: slot.reason };
  }
  const value = render(slot.value);
  // A slot that claimed to be observed but renders to nothing is reported as
  // a gap rather than an empty row — an empty row reads like a zero.
  return value
    ? { label, value, gap: null }
    : { label, value: null, gap: 'not-reported-by-engine' };
}

function refRow<TRef>(
  label: string,
  slot: TurnProvenanceRefSlot<TRef>,
  render: (ref: TRef) => string,
): ProvenanceRow {
  if (slot.state === 'unavailable') {
    return { label, value: null, gap: slot.reason };
  }
  return { label, value: render(slot.ref), gap: null };
}

/**
 * The detail row's full usage sentence — every field the engine reported,
 * named in full. Only fields the engine actually reported are named. An
 * absent field is left out of the sentence entirely rather than printed as
 * `0 in`.
 */
function usageText(
  usage: TurnProvenanceUsage,
  provider?: string,
): string | null {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
  if (usage.totalTokens !== undefined) {
    // archive#4196: for a provider DECLARED 'disjoint', its reported total is
    // input + output and excludes the cache fields named beside it — calling
    // that figure "total" in the same sentence contradicts the collapsed
    // line's cache-inclusive figure. Name it what the declaration says it is.
    parts.push(
      providerPromptCacheInclusivity(provider) === 'disjoint'
        ? `${usage.totalTokens} in+out`
        : `${usage.totalTokens} total`,
    );
  }
  if (usage.cacheReadTokens !== undefined) {
    parts.push(`${usage.cacheReadTokens} cache read`);
  }
  if (usage.cacheWriteTokens !== undefined) {
    parts.push(`${usage.cacheWriteTokens} cache write`);
  }
  return parts.length > 0 ? `${parts.join(' · ')} tokens` : null;
}

/**
 * The COLLAPSED-LINE usage figure (archive#1802) — short enough to sit next
 * to the engine and model in one line. Prefers the engine's own total; a
 * reported total is the single number closest to "what this cost", and
 * naming every cache/read/write field the way the detail row does would bury
 * the one-line takeaway in a token ledger. Falls back to in/out only when no
 * total was reported.
 *
 * #765 A8: the figure is compact ("50.9k tokens") and, on the total paths,
 * carries the "incl. context" qualifier — the total counts the prompt and
 * conversation context, and an unqualified 50k beside a one-line answer read
 * as a cost bomb. Both total paths include prompt/context by construction:
 * `cacheInclusiveTotalTokens` sums input + output + cache, and a reported
 * `totalTokens` includes `inputTokens` (the prompt and its context). The
 * in/out fallback already names its components, so it takes no qualifier.
 * `exactTitle` preserves the exact figure for the summary tooltip.
 */
function headlineUsage(
  usage: TurnProvenanceUsage,
  provider: string | undefined,
): { text: string; exactTitle: string } | null {
  // archive#4196: when the provider's declared cache-inclusivity backs the
  // sum ('disjoint' — Claude, whose totalTokens is input + output and
  // excludes cache), the one-line figure includes cache read/write, because
  // "N tokens" beside a detail row listing thousands of cache tokens was a
  // cache-exclusive figure under a cache-inclusive label. For an
  // 'unverified'/'subset'/undeclared provider the derivation returns
  // `undefined` and the provider's own total stands, unsummed.
  const inclusiveTotal = cacheInclusiveTotalTokens(provider, usage);
  const total = inclusiveTotal ?? usage.totalTokens;
  if (total !== undefined) {
    return {
      text: `${formatTokenCount(total)} tokens · incl. context`,
      exactTitle: `${exactTokenCount(total)} tokens`,
    };
  }
  const parts: string[] = [];
  const exactParts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`${formatTokenCount(usage.inputTokens)} in`);
    exactParts.push(`${exactTokenCount(usage.inputTokens)} in`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`${formatTokenCount(usage.outputTokens)} out`);
    exactParts.push(`${exactTokenCount(usage.outputTokens)} out`);
  }
  return parts.length > 0
    ? {
        text: parts.join(' · '),
        exactTitle: `${exactParts.join(' · ')} tokens`,
      }
    : null;
}

/**
 * The engine's product name, with its raw provider slug kept alongside.
 * Users know this thing as "Claude Code"; `claude` is Station's internal
 * identifier and belongs in the checkable detail, not as the headline. When
 * the slug has no product name yet, the slug IS the honest answer — better a
 * raw identifier than an invented label.
 */
function engineDisplay(provider: string): { label: string; slug: string } {
  return {
    label: engineLabelForProvider(provider) ?? provider,
    slug: provider,
  };
}

/**
 * The Context row's rendered sentence (archive#2649). Token figures carry a
 * `~` because they ARE approximate — byte-derived estimates of the real
 * injected strings (see the contract's `TurnProvenanceContextInjection`
 * docblock) — and rendering them unqualified would present an estimate as a
 * measurement.
 */
function contextInjectionText(record: TurnProvenanceContextInjection): string {
  const parts: string[] = [];
  if (record.knowledge) {
    const { chunkCount, sources, omittedSources, approxTokens } =
      record.knowledge;
    const named = sources.join(', ');
    const sourceText =
      omittedSources > 0 ? `${named} — and ${omittedSources} more` : named;
    parts.push(
      `Knowledge: ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} from ${sourceText} (~${approxTokens} tokens)`,
    );
  }
  if (record.projectRules) {
    parts.push(`Project rules (~${record.projectRules.approxTokens} tokens)`);
  }
  if (record.guidelines) {
    const { reinforce, avoid, approxTokens } = record.guidelines;
    parts.push(
      `Guidelines: ${reinforce} reinforce / ${avoid} avoid (~${approxTokens} tokens)`,
    );
  }
  if (record.workflowSteering) {
    parts.push(
      `Workflow steering (~${record.workflowSteering.approxTokens} tokens)`,
    );
  }
  if (record.conversationFeedback) {
    const { flaggedMessages, approxTokens } = record.conversationFeedback;
    parts.push(
      `Conversation feedback: ${flaggedMessages} flagged (~${approxTokens} tokens)`,
    );
  }
  if (record.ambient) {
    parts.push(`Ambient (~${record.ambient.approxTokens} tokens)`);
  }
  // An observed EMPTY record is an earned fact, not a gap: Station's engine
  // ran this turn and nothing it composed reached the model (archive#2649
  // honesty rule). Distinct from an unavailable slot, which says Station
  // recorded nothing either way. The wording names the record's actual
  // scope — Station-composed context — because the system prompt, tool
  // schemas, and prior history are assembled elsewhere and are never
  // counted here.
  return parts.length > 0 ? parts.join(' · ') : 'No Station-composed context';
}

/**
 * The Context row (archive#2649): what Station itself put into this turn's
 * model input. Three honest shapes, never a fourth:
 *
 * - **Observed record** → the itemized blocks (or "No retrieved context"
 *   for an observed-empty record).
 * - **No record, external engine** → "Managed by <engine>", derived from
 *   the OBSERVED engine slot, not from a fabricated context observation —
 *   Claude Code/Codex/ACP runtimes own their context end-to-end and a
 *   Station context section here would claim an injection Station never
 *   performed.
 * - **No record, Station engine (or engine unknown)** → the slot's own gap
 *   reason; an envelope persisted before this slice has no slot at all and
 *   reads as `not-captured-by-station`, which is exactly true.
 */
function contextRow(envelope: TurnProvenanceEnvelope): ProvenanceRow {
  const slot = envelope.contextInjection;
  if (slot && slot.state === 'observed') {
    return {
      label: 'Context',
      value: contextInjectionText(slot.value),
      gap: null,
    };
  }
  const provider =
    envelope.engine.state === 'observed'
      ? envelope.engine.value.provider
      : undefined;
  if (provider && provider !== 'station-agent') {
    return {
      label: 'Context',
      value: null,
      gap: null,
      note: `Managed by ${engineDisplay(provider).label}`,
    };
  }
  return {
    label: 'Context',
    value: null,
    gap: slot?.reason ?? 'not-captured-by-station',
  };
}

function contextBoundaryRow(
  envelope: TurnProvenanceEnvelope,
): ProvenanceRow | undefined {
  const slot = envelope.contextBoundary;
  if (slot?.state !== 'observed') return undefined;
  return {
    label: 'Conversation boundary',
    value: slot.value.priorTranscriptInjected
      ? 'Prior transcript re-anchored into this engine context'
      : 'Prior transcript omitted from this engine context',
    gap: null,
  };
}

function buildRows(envelope: TurnProvenanceEnvelope): ProvenanceRow[] {
  const rows: ProvenanceRow[] = [
    slotRow('Engine', envelope.engine, (engine) => {
      const { label, slug } = engineDisplay(engine.provider);
      return label === slug ? slug : `${label} (${slug})`;
    }),
    slotRow('Model requested', envelope.requestedModel, (model) => model),
    slotRow('Model reported by engine', envelope.reportedModel, (m) => m),
    slotRow('Tools', envelope.tools, (tools) => {
      if (tools.uses.length === 0) return null;
      const named = tools.uses
        .map((use) => {
          const failures = use.failed + use.cancelled;
          return failures > 0 ? `${use.name} (${failures} failed)` : use.name;
        })
        .join(', ');
      return tools.omittedNames > 0
        ? `${named} — and ${tools.omittedNames} more`
        : named;
    }),
    slotRow('Usage', envelope.usage, (usage) =>
      usageText(
        usage,
        envelope.engine.state === 'observed'
          ? envelope.engine.value.provider
          : undefined,
      ),
    ),
    contextRow(envelope),
    refRow('Routing receipt', envelope.routingReceipt, (ref) => ref.receiptId),
    refRow('Sources', envelope.sources, (ref) => ref.snapshotId),
    {
      // archive#1558: `referenced` is unreachable in production today —
      // nothing writes `metadata.trustReport`. The row stays because the
      // contract keeps the slot defined-and-unimplemented rather than
      // deleted, so a producer landing later needs no UI change; every real
      // turn renders the honest gap. See `TURN_PROVENANCE_REF_SLOTS`.
      ...refRow(
        'Trust report',
        envelope.trustReport,
        (ref) => `${ref.projectSlug} / ${ref.bundleId}`,
      ),
      trustReportRef:
        envelope.trustReport.state === 'referenced'
          ? envelope.trustReport.ref
          : undefined,
    },
  ];
  const contextBoundary = contextBoundaryRow(envelope);
  if (contextBoundary) rows.push(contextBoundary);
  return rows;
}

/**
 * Identity facts the surrounding row already states for this same turn
 * (archive#1434). The row and this card read ONE authority — the envelope —
 * so a fact the row has already put on screen must not be repeated in the
 * collapsed headline: two renderings of one fact read as two claims, and
 * the reader then has to work out whether they agree.
 *
 * This only ever suppresses the COLLAPSED headline. The expanded detail
 * list is the checkable record and always carries every field, including
 * the raw provider slug behind the row's engine chip.
 */
export interface TurnProvenanceStatedInRow {
  engine?: boolean;
  model?: boolean;
}

const NOTHING_STATED_IN_ROW: TurnProvenanceStatedInRow = {};

/**
 * The collapsed-state headline (archive#1802): the takeaway itself, not a
 * teaser for it. Names whichever of engine/model the surrounding row has not
 * already stated, plus what this turn cost when the engine reported one —
 * the three earned facts the card exists to surface. A reader who never
 * expands the card still learns them.
 *
 * The model named here is ALWAYS `reportedModel` — never `requestedModel`
 * (archive#1802). `requestedModel` is what Station asked
 * for, not a confirmation of what ran; the expanded detail already states
 * both, honestly labelled and kept separate, because a disagreement between
 * them is itself the finding (see the "names the model the runtime
 * reported" test). Collapsing that distinction into one unqualified
 * headline value would let a requested-but-unconfirmed model read as an
 * earned claim — the exact failure this card exists to prevent, and
 * elevating this headline to "the takeaway" is what made the old
 * requested-model fallback load-bearing. So when the engine never echoed
 * what it used, the headline simply omits the model rather than guessing
 * from what was asked — matching the no-invented-values discipline already
 * applied to usage (a missing total is omitted, never zero).
 *
 * Falls back to a bare "Provenance" only in the narrow case where the row
 * above has already stated both engine and model AND the engine reported no
 * usage AND no confirmed model exists — there is genuinely nothing left for
 * this line to add, so it names itself rather than repeating the row or
 * inventing a number.
 */
function summaryText(
  envelope: TurnProvenanceEnvelope,
  statedInRow: TurnProvenanceStatedInRow,
): string {
  const parts: string[] = [];
  if (!statedInRow.engine) {
    parts.push(
      envelope.engine.state === 'observed'
        ? engineDisplay(envelope.engine.value.provider).label
        : 'Engine unknown',
    );
  }
  if (!statedInRow.model && envelope.reportedModel.state === 'observed') {
    parts.push(displayModelIdentifier(envelope.reportedModel.value));
  }
  if (envelope.usage.state === 'observed') {
    const usage = headlineUsage(
      envelope.usage.value,
      envelope.engine.state === 'observed'
        ? envelope.engine.value.provider
        : undefined,
    );
    if (usage) parts.push(usage.text);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Provenance';
}

/**
 * The summary button's tooltip: the engine slug (the checkable identifier
 * behind the product name) plus the EXACT token figure behind the compact
 * "50.9k" headline (#765 A8). Exactness lives here and in the detail row;
 * the visible line stays magnitude-first.
 */
function summaryTitle(envelope: TurnProvenanceEnvelope): string | undefined {
  const parts: string[] = [];
  if (envelope.engine.state === 'observed') {
    parts.push(`Engine: ${envelope.engine.value.provider}`);
  }
  if (envelope.usage.state === 'observed') {
    const usage = headlineUsage(
      envelope.usage.value,
      envelope.engine.state === 'observed'
        ? envelope.engine.value.provider
        : undefined,
    );
    if (usage) parts.push(usage.exactTitle);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Notable, PER-ANSWER findings for the badge (archive#1802). This replaces
 * the old raw gap count, which mostly counted Station's own unimplemented
 * slots — the same three, every turn, forever, regardless of whether the
 * answer was good. The rule this applies: a signal only belongs in a
 * per-answer badge when it can actually differ between two answers from the
 * same engine. An aborted turn, a turn with failed tool calls, and a turn
 * with a tool call that never resolved all qualify; "this engine never
 * reports tools" and "Station has no routing receipts yet" do not — they
 * are the same on every turn.
 *
 * Empty is a legitimate result: most turns are unremarkable, and a badge
 * that fires on every healthy answer teaches readers to ignore it.
 */
function turnFindings(envelope: TurnProvenanceEnvelope): string[] {
  const findings: string[] = [];
  if (envelope.outcome === 'aborted') {
    findings.push('Aborted');
  }
  if (envelope.tools.state === 'observed') {
    let failed = 0;
    let unresolved = 0;
    for (const use of envelope.tools.value.uses) {
      failed += use.failed + use.cancelled;
      // A `tool.started` with no matching terminal event yet — review
      // finding (archive#1802): a genuine per-answer anomaly (this turn's
      // own tool call never resolved), distinct from `failed`/`cancelled`,
      // which both name an event Station DID observe.
      const resolved = use.succeeded + use.failed + use.cancelled;
      if (use.started > resolved) unresolved += use.started - resolved;
    }
    if (failed > 0) {
      findings.push(failed === 1 ? '1 tool issue' : `${failed} tool issues`);
    }
    if (unresolved > 0) {
      findings.push(
        unresolved === 1
          ? '1 tool call unresolved'
          : `${unresolved} tool calls unresolved`,
      );
    }
  }
  return findings;
}

/** A row's rendered value cell, classed by which of the four kinds it is. */
function RowValue({ row }: { row: ProvenanceRow }) {
  if (row.gap) {
    return (
      <dd className="turn-provenance__value turn-provenance__value--absence">
        {unavailableText(row.gap)}
      </dd>
    );
  }
  if (row.note) {
    // archive#2649: informational, styled as an absence — it reports what
    // Station did NOT do (inject context into an external engine's turn),
    // so it must not read as an earned per-turn observation.
    return (
      <dd className="turn-provenance__value turn-provenance__value--absence">
        {row.note}
      </dd>
    );
  }
  return (
    <dd className="turn-provenance__value turn-provenance__value--earned">
      {row.value}
      {row.trustReportRef && (
        <>
          {' '}
          {/* Names where the link actually goes: the project's Trust
              panel, which hosts this bundle. There is no deep link to a
              single bundle yet, and a label promising one would be the lie
              this card exists to avoid. */}
          <a
            className="turn-provenance__drilldown"
            href={`/projects/${encodeURIComponent(row.trustReportRef.projectSlug)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open project trust panel
          </a>
        </>
      )}
    </dd>
  );
}

/** The turn id, behind the disclosure, with a copy control (archive#1802). */
function TurnIdRow({ turnId }: { turnId: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turnId);
      setCopyState('copied');
    } catch {
      // Never claim a copy that failed — a browser can refuse the
      // clipboard outright (same discipline as ShareAnswerButton).
      setCopyState('failed');
    }
  };

  return (
    <div className="turn-provenance__row">
      <dt className="turn-provenance__label">Turn</dt>
      <dd className="turn-provenance__value turn-provenance__value--id">
        <span>{turnId}</span>
        <button type="button" className="turn-provenance__copy" onClick={copy}>
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy'}
        </button>
      </dd>
    </div>
  );
}

export interface TurnProvenanceCardProps {
  /**
   * The envelope exactly as the server sent it. Deliberately `unknown`: this
   * component owns the decision about whether it is readable at all.
   */
  provenance: unknown;
  /** See `TurnProvenanceStatedInRow`. Omitted means the row states nothing. */
  statedInRow?: TurnProvenanceStatedInRow;
  /** Display name of the human accountable for this Station, if available. */
  accountableHuman?: string | null;
}

export function TurnProvenanceCard({
  provenance,
  statedInRow = NOTHING_STATED_IN_ROW,
  accountableHuman,
}: TurnProvenanceCardProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  if (provenance === undefined || provenance === null) return null;

  if (!isSupportedTurnProvenanceEnvelope(provenance)) {
    // a version this build does not understand is reported as one
    // honest unavailable row. Nothing is parsed out of it, and the
    // transcript around it renders normally.
    return (
      <section
        className="turn-provenance turn-provenance--unreadable"
        aria-label="Answer provenance (unreadable)"
      >
        <p className="turn-provenance__unreadable">
          Provenance was recorded in a format this version of Station cannot
          read. Nothing about this answer is being claimed from it.
        </p>
      </section>
    );
  }

  const rows = buildRows(provenance);
  // archive#1802: Station's own unimplemented slots are demoted out of the
  // checkable list and out of the badge — see STATION_BACKLOG_REASON's
  // docblock. Everything else (earned claims and meaningful absences) stays
  // in the checkable list together; RowValue is what tells them apart.
  const checkableRows = rows.filter(
    (row) => row.gap !== STATION_BACKLOG_REASON,
  );
  const backlogRows = rows.filter((row) => row.gap === STATION_BACKLOG_REASON);
  const findings = turnFindings(provenance);

  return (
    // A transcript holds many of these; an identical label on every one
    // makes them indistinguishable to a screen reader, so each names its turn.
    <section
      className="turn-provenance"
      aria-label={`Answer provenance for turn ${provenance.turnId}`}
    >
      <button
        type="button"
        className="turn-provenance__summary"
        aria-expanded={open}
        aria-controls={detailsId}
        title={summaryTitle(provenance)}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="turn-provenance__headline">
          {summaryText(provenance, statedInRow)}
        </span>
        {findings.length > 0 && (
          // Per-answer standing, not a backlog tally: only findings that can
          // actually differ between two answers from the same engine ever
          // reach here (turnFindings). Muted rather than a warning colour —
          // one flag among many healthy turns is meant to draw the eye, but
          // it is still a fact, not an alarm.
          <span className="turn-provenance__badge">{findings.join(' · ')}</span>
        )}
        <span aria-hidden="true" className="turn-provenance__chevron">
          {open ? '⌄' : '›'}
        </span>
      </button>

      {open && (
        <div className="turn-provenance__detail" id={detailsId}>
          <dl className="turn-provenance__facts">
            {checkableRows.map((row) => (
              <div className="turn-provenance__row" key={row.label}>
                <dt className="turn-provenance__label">{row.label}</dt>
                <RowValue row={row} />
              </div>
            ))}
          </dl>

          {backlogRows.length > 0 && (
            <>
              {/* archive#1802: kept (not deleted — see the module docblock's
                  no-omission rule) but visually demoted into its own block,
                  out of the checkable facts and out of the badge. This is
                  Station's roadmap, not a finding about this answer. */}
              <p className="turn-provenance__section-label">
                Not yet captured by Station
              </p>
              <dl className="turn-provenance__facts turn-provenance__facts--backlog">
                {backlogRows.map((row) => (
                  <div className="turn-provenance__row" key={row.label}>
                    <dt className="turn-provenance__label">{row.label}</dt>
                    <dd className="turn-provenance__value turn-provenance__value--not-captured">
                      {unavailableText(row.gap ?? 'not-captured-by-station')}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          <p className="turn-provenance__section-label">Metadata</p>
          <dl className="turn-provenance__facts turn-provenance__facts--metadata">
            {accountableHuman && (
              <div className="turn-provenance__row">
                <dt className="turn-provenance__label">Accountable human</dt>
                <dd className="turn-provenance__value turn-provenance__value--earned">
                  {accountableHuman}
                </dd>
              </div>
            )}
            <TurnIdRow turnId={provenance.turnId} />
          </dl>
        </div>
      )}
    </section>
  );
}
