import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import '@kontourai/surface/trust-panel/element';
import { parseStationTaskBasisMcpPage } from '@kontourai/station-contracts/task-basis-mcp';
import type { StationTaskBasisCollectionGateEvaluationView } from './task-basis-collection-view';
import { buildStationTaskBasisCollectionView } from './task-basis-collection-view';

type Result = { structuredContent?: unknown; _meta?: unknown };
type State = {
  page: NonNullable<ReturnType<typeof parseStationTaskBasisMcpPage>>;
  continuationToken?: string;
};

const root = document.querySelector<HTMLElement>('#task-basis-app');
let app: App | null = null;
let current: State | null = null;
let loading = false;

function applyHostAppearance() {
  const context = app?.getHostContext();
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

function pageFrom(result: unknown): State | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as Result;
  const page = parseStationTaskBasisMcpPage(value.structuredContent);
  if (page?.status !== 'available') return null;
  const meta = value._meta;
  const appMeta =
    meta && typeof meta === 'object'
      ? (meta as Record<string, unknown>)['station.task-basis-app/v1']
      : null;
  const capability = readCapability(appMeta);
  if (page.continuation && !capability?.continuationToken) return null;
  return capability
    ? { page, continuationToken: capability.continuationToken }
    : { page };
}

function readCapability(
  value: unknown,
): { occurrenceId: string; continuationToken?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.occurrenceId !== 'string' ||
    record.occurrenceId.length < 16 ||
    record.occurrenceId.length > 256
  )
    return null;
  const token = record.continuationToken;
  return token === undefined
    ? { occurrenceId: record.occurrenceId }
    : typeof token === 'string' && token.length >= 16 && token.length <= 256
      ? { occurrenceId: record.occurrenceId, continuationToken: token }
      : null;
}

const PROCESS_PAGE_SIZE = 20;

function fact(list: HTMLElement, label: string, value: string) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  const isolated = document.createElement('bdi');
  isolated.textContent = value;
  description.append(isolated);
  list.append(term, description);
}

function evaluationRef(
  list: HTMLElement,
  label: string,
  ref: { runId: string; gateId: string; evaluationId: string },
) {
  fact(list, `${label} run`, ref.runId);
  fact(list, `${label} gate`, ref.gateId);
  fact(list, `${label} evaluation`, ref.evaluationId);
}

function appendGateEvaluation(
  root: HTMLElement,
  item: StationTaskBasisCollectionGateEvaluationView,
) {
  const row = document.createElement('article');
  row.className = 'task-basis__gate-evaluation';
  const summary = document.createElement('p');
  const gate = document.createElement('strong');
  gate.append('Gate ');
  const gateId = document.createElement('bdi');
  gateId.textContent = item.gateId;
  gate.append(gateId);
  summary.append(
    gate,
    document.createTextNode(
      ` — original verdict ${item.originalVerdict}. At last check: ${item.currentStanding}; valid `,
    ),
  );
  const validity = document.createElement('time');
  validity.dateTime = item.validityAsOf;
  validity.textContent = item.validityAsOfLabel;
  summary.append(validity, document.createTextNode('.'));
  const details = document.createElement('details');
  const detailsSummary = document.createElement('summary');
  detailsSummary.className = 'task-basis__summary';
  detailsSummary.textContent = 'Process receipt details';
  const content = document.createElement('div');
  const populate = () => {
    content.replaceChildren();
    if (!details.open) return;
    const facts = document.createElement('dl');
    facts.className = 'task-basis__facts';
    fact(facts, 'Evaluated', item.evaluatedAt);
    const validityAsOf = document.createElement('dt');
    validityAsOf.textContent = 'Validity as of';
    const validityValue = document.createElement('dd');
    const validityTime = document.createElement('time');
    validityTime.dateTime = item.validityAsOf;
    validityTime.textContent = item.validityAsOfLabel;
    validityValue.append(validityTime);
    facts.append(validityAsOf, validityValue);
    fact(facts, 'Validity scope', 'Retained immutable bundle');
    fact(facts, 'External revocation', 'Not observed');
    evaluationRef(facts, 'Original', item.ref);
    if (item.previousRef) evaluationRef(facts, 'Previous', item.previousRef);
    if (item.currentPersistedGateRef)
      evaluationRef(facts, 'Current persisted', item.currentPersistedGateRef);
    if (item.exceptionId) fact(facts, 'Exception', item.exceptionId);
    if (item.routeBack) {
      fact(facts, 'Route-back', item.routeBack.reason ?? 'Recorded by Flow');
      if (item.routeBack.selectedRoute)
        fact(facts, 'Selected route', item.routeBack.selectedRoute);
      if (item.routeBack.attempt !== undefined)
        fact(
          facts,
          'Route-back attempt',
          `${item.routeBack.attempt}${item.routeBack.maxAttempts ? ` of ${item.routeBack.maxAttempts}` : ''}`,
        );
    }
    content.append(facts);
    const evidence = document.createElement('section');
    evidence.setAttribute(
      'aria-label',
      `Selected evidence for gate ${item.gateId}`,
    );
    const heading = document.createElement('h4');
    heading.textContent = 'Selected evidence';
    evidence.append(heading);
    if (!item.selectedEvidence.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No selected evidence was recorded.';
      evidence.append(empty);
      content.append(evidence);
      return;
    }
    let visible = PROCESS_PAGE_SIZE;
    let more: HTMLButtonElement | null = null;
    const renderEvidence = (restoreFocus = false) => {
      const list = document.createElement('ul');
      for (const value of item.selectedEvidence.slice(0, visible)) {
        const line = document.createElement('li');
        const isolated = document.createElement('bdi');
        isolated.textContent = `${value.evidenceId} — ${value.standing}; freshness ${value.freshness}; authority ${value.authority}${value.sha256 ? `; sha256 ${value.sha256}` : ''}${value.revocationCodes.length ? `; recorded revocation codes: ${value.revocationCodes.join(', ')}` : ''}`;
        line.append(isolated);
        list.append(line);
      }
      evidence.replaceChildren(heading, list);
      if (item.selectedEvidence.length > PROCESS_PAGE_SIZE) {
        more = document.createElement('button');
        more.type = 'button';
        const hasMore = visible < item.selectedEvidence.length;
        more.textContent = hasMore
          ? 'Show more selected evidence'
          : 'All selected evidence shown';
        more.setAttribute('aria-disabled', String(!hasMore));
        more.addEventListener('click', () => {
          if (!hasMore) return;
          visible = Math.min(
            visible + PROCESS_PAGE_SIZE,
            item.selectedEvidence.length,
          );
          renderEvidence(true);
        });
        evidence.append(more);
      }
      if (restoreFocus) more?.focus();
    };
    renderEvidence();
    content.append(evidence);
  };
  details.addEventListener('toggle', populate);
  details.append(detailsSummary, content);
  row.append(summary, details);
  root.append(row);
}

function render(state: State | null) {
  if (!root) return;
  root.replaceChildren();
  const page = state?.page;
  if (page?.status !== 'available') {
    root.textContent = 'Whole Task Basis is unavailable.';
    return;
  }
  const view = buildStationTaskBasisCollectionView({
    kind: 'bounded-page',
    page,
  });
  if (view.status !== 'available') return render(null);
  const chrome = document.createElement('section');
  chrome.className = 'task-basis__chrome';
  const heading = document.createElement('h1');
  heading.tabIndex = -1;
  heading.textContent = 'Whole Task Basis';
  const notice = document.createElement('p');
  notice.textContent = view.chrome.noAggregateStandingNotice;
  chrome.append(heading, notice);
  root.append(chrome);
  if (view.chrome.availability.length) {
    const availability = document.createElement('section');
    availability.setAttribute('aria-label', 'Task Basis availability');
    const heading = document.createElement('h2');
    heading.textContent = view.chrome.availabilityHeading;
    availability.append(heading);
    for (const gap of view.chrome.availability) {
      const row = document.createElement('p');
      row.textContent = gap.message;
      availability.append(row);
    }
    root.append(availability);
  }
  const answers = document.createElement('div');
  answers.className = 'task-basis__answers';
  answers.setAttribute('aria-label', 'Kept answers');
  const panel = document.createElement('surface-trust-panel') as HTMLElement & {
    basisProjection?: unknown;
  };
  panel.setAttribute('mode', 'basis');
  const select = (answer: {
    answerReferenceId: string;
    projection: unknown;
  }) => {
    for (const button of Array.from(answers.querySelectorAll('button')))
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.answer === answer.answerReferenceId),
      );
    panel.basisProjection = answer.projection;
  };
  for (const answer of page.answers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.answer = answer.answerReferenceId;
    button.textContent = answer.answerReferenceId;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => select(answer));
    answers.append(button);
  }
  if (!page.answers.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No kept answers are on this page.';
    answers.append(empty);
  }
  if (page.answers[0]) select(page.answers[0]);
  root.append(answers, panel);
  if (view.unassociated.length) {
    const unassociated = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = view.chrome.unassociatedHeading;
    const list = document.createElement('ul');
    for (const item of view.chrome.unassociatedItems) {
      const row = document.createElement('li');
      row.textContent = item.label;
      list.append(row);
    }
    unassociated.append(heading, list);
    root.append(unassociated);
  }
  const process = document.createElement('section');
  process.className = 'task-basis__process';
  process.setAttribute('aria-label', 'Process kept gate evaluations');
  const processHeading = document.createElement('h2');
  processHeading.textContent = view.chrome.keptGateEvaluationsHeading;
  process.append(processHeading);
  if (view.keptGateEvaluations.length) {
    for (const item of view.keptGateEvaluations)
      appendGateEvaluation(process, item);
  } else {
    const empty = document.createElement('p');
    empty.textContent = view.chrome.noKeptGateEvaluationsMessage;
    process.append(empty);
  }
  root.append(process);
  if (view.keptToolResults.length) {
    const keptResults = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = view.chrome.keptToolResultsHeading;
    const list = document.createElement('ul');
    for (const item of view.chrome.keptToolResultItems) {
      const row = document.createElement('li');
      row.textContent = item.associationMessage
        ? `${item.label}: ${item.associationMessage}`
        : item.label;
      list.append(row);
    }
    keptResults.append(heading, list);
    root.append(keptResults);
  }
  if (page.continuation && state?.continuationToken) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'task-basis__more';
    more.textContent = 'Next page';
    more.addEventListener('click', async () => {
      if (loading || !app || !page.taskId || !state.continuationToken) return;
      loading = true;
      more.disabled = true;
      try {
        const result = await app.callServerTool({
          name: 'get_task_basis',
          arguments: {
            taskId: page.taskId,
            continuationToken: state.continuationToken,
          },
        });
        current = pageFrom(result);
        render(current);
        root.querySelector<HTMLElement>('h1')?.focus();
      } catch {
        current = null;
        render(null);
      } finally {
        loading = false;
      }
    });
    root.append(more);
  }
}

void (async () => {
  root?.replaceChildren('Loading Whole Task Basis…');
  app = new App(
    { name: 'Station Task Basis', version: '1.0.0' },
    {},
    { autoResize: true, strict: true },
  );
  app.onhostcontextchanged = () => applyHostAppearance();
  app.ontoolresult = (result) => {
    current = pageFrom(result);
    render(current);
  };
  try {
    await app.connect();
    applyHostAppearance();
  } catch {
    render(null);
  }
})();
