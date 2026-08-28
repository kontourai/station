import type { BasisGap } from '@kontourai/surface/basis';
import type {
  BasisPanelFact,
  BasisPanelViewModel,
} from '@kontourai/surface/basis/view';

const MAX_WEAK_EDGES = 64;
const MAX_WEAK_EDGE_SCALAR_LENGTH = 512;

/**
 * The portable app consumes Surface's public, already-decided view model. It
 * deliberately renders ordinary DOM instead of importing Surface's custom
 * element: the full element is useful in Station's native surface but far too
 * large for this bounded MCP resource.
 */
export function renderBasisPanel(
  root: HTMLElement,
  panel: BasisPanelViewModel,
): void {
  root.replaceChildren();
  root.className = 'task-basis__panel';
  root.setAttribute('aria-label', panel.title);

  const heading = document.createElement('h2');
  heading.textContent = panel.title;
  const standing = document.createElement('p');
  standing.setAttribute('role', 'status');
  standing.className = `task-basis__standing task-basis__standing--${panel.standing.tone}`;
  standing.textContent = `${panel.standing.label}. ${panel.standing.description}`;
  root.append(heading, standing);

  appendGaps(root, panel.gaps);
  appendAssessment(root, panel);
  appendContext(root, panel);
  appendRelationships(root, panel);
  appendTechnical(root, panel);
  const footer = document.createElement('p');
  footer.className = 'task-basis__footer';
  footer.textContent = panel.footer;
  root.append(footer);
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  const isolated = document.createElement('bdi');
  isolated.textContent = value;
  element.append(isolated);
  return element;
}

function disclosure(label: string, open = false): HTMLElement {
  const details = document.createElement('details');
  details.open = open;
  const summary = document.createElement('summary');
  summary.className = 'task-basis__summary';
  summary.textContent = label;
  details.append(summary);
  return details;
}

function appendFacts(
  root: HTMLElement,
  facts: readonly BasisPanelFact[],
): void {
  const list = document.createElement('dl');
  list.className = 'task-basis__facts';
  for (const fact of facts) {
    const term = document.createElement('dt');
    term.textContent = fact.label;
    const description = document.createElement('dd');
    description.append(textElement('bdi', fact.value));
    list.append(term, description);
  }
  root.append(list);
}

function appendGaps(root: HTMLElement, gaps: readonly BasisGap[]): void {
  const section = document.createElement('section');
  const heading = document.createElement('h3');
  heading.textContent = 'Gaps';
  const list = document.createElement('ul');
  if (gaps.length) {
    for (const gap of gaps) {
      const item = document.createElement('li');
      item.append(textElement('bdi', `${gap.code}: ${gap.message}`));
      const weakEdges = weakEdgeSummary(gap);
      if (weakEdges) item.append(textElement('bdi', ` ${weakEdges}`));
      list.append(item);
    }
  } else {
    list.append(textElement('li', 'No Surface gaps were recorded.'));
  }
  section.append(heading, list);
  root.append(section);
}

function weakEdgeSummary(gap: BasisGap): string | null {
  const metadata = gap.metadata;
  if (metadata?.source !== 'derivation.weak' || !metadata.weakEdges.length)
    return null;
  const edges = metadata.weakEdges.slice(0, MAX_WEAK_EDGES);
  const text = edges
    .map(
      (edge) =>
        `${boundedWeakEdgeScalar(edge.claimId)} → ${boundedWeakEdgeScalar(edge.inputClaimId)}`,
    )
    .join(', ');
  const noun = edges.length === 1 ? 'edge' : 'edges';
  const omitted = metadata.weakEdges.length - edges.length;
  return `Weak ${noun}: ${text}.${omitted ? ` Showing ${edges.length} of ${metadata.weakEdges.length}.` : ''}`;
}

function boundedWeakEdgeScalar(value: string): string {
  return value.length <= MAX_WEAK_EDGE_SCALAR_LENGTH
    ? value
    : `${value.slice(0, MAX_WEAK_EDGE_SCALAR_LENGTH)}…`;
}

function appendAssessment(root: HTMLElement, panel: BasisPanelViewModel): void {
  const details = disclosure('Assessment', true);
  if (!panel.assessment) {
    details.append(textElement('p', 'No Surface assessment is available.'));
    root.append(details);
    return;
  }
  appendFacts(details, [
    { label: 'State', value: panel.assessment.state },
    { label: 'Found', value: String(panel.assessment.found) },
    {
      label: 'Claim status',
      value: panel.assessment.claimStatus ?? 'Not captured',
    },
    {
      label: 'Currentness',
      value: panel.assessment.freshness ?? 'Not captured',
    },
  ]);
  if (panel.assessment.policy) {
    const heading = document.createElement('h3');
    heading.textContent = 'Policy';
    details.append(heading);
    appendFacts(details, [
      { label: 'Policy', value: panel.assessment.policy.id },
      { label: 'Outcome', value: panel.assessment.policy.outcome },
      { label: 'Evaluated', value: panel.assessment.policy.evaluatedAt },
    ]);
    appendStringList(
      details,
      panel.assessment.policy.reasons,
      'No policy reasons were recorded.',
    );
  }
  const evidenceHeading = document.createElement('h3');
  evidenceHeading.textContent = 'Evidence';
  details.append(evidenceHeading);
  for (const partition of panel.assessment.evidence) {
    const heading = document.createElement('h4');
    heading.textContent = partition.label;
    details.append(heading);
    if (!partition.items.length) {
      details.append(textElement('p', 'No evidence was recorded.'));
      continue;
    }
    const list = document.createElement('ul');
    for (const item of partition.items) {
      const row = document.createElement('li');
      row.append(
        textElement(
          'bdi',
          `${item.label} — ${item.source}${item.locator ? ` (${item.locator})` : ''}; ${item.result}; observed ${item.observedAt}${item.supportStrength ? `; ${item.supportStrength}` : ''}${item.blocksClaim ? '; blocks claim' : ''}`,
        ),
      );
      list.append(row);
    }
    details.append(list);
  }
  const derivation = document.createElement('h3');
  derivation.textContent = 'Derivation';
  details.append(derivation);
  details.append(
    textElement(
      'p',
      panel.assessment.derivation.available
        ? 'Derivation is available.'
        : 'Derivation is not available.',
    ),
  );
  for (const input of panel.assessment.derivation.directInputs) {
    appendFacts(details, [
      { label: 'Input claim', value: input.claimId },
      { label: 'Status', value: input.status ?? 'Not captured' },
      { label: 'Source', value: input.source },
      { label: 'Method', value: input.method ?? 'Not captured' },
      { label: 'Support', value: input.supportStrength ?? 'Not captured' },
      { label: 'Rationale', value: input.rationale ?? 'Not captured' },
    ]);
  }
  root.append(details);
}

function appendContext(root: HTMLElement, panel: BasisPanelViewModel): void {
  // Surface deliberately keeps this boundary visible even while the context
  // records themselves remain collapsed: it prevents surrounding work from
  // being mistaken for answer support.
  const notice = textElement('p', panel.contextNotice);
  notice.className = 'task-basis__context-notice';
  root.append(notice);
  const details = disclosure('Context');
  for (const group of panel.contextGroups) {
    const heading = document.createElement('h3');
    heading.textContent = group.label;
    details.append(heading);
    if (!group.items.length) {
      details.append(textElement('p', 'No context was recorded.'));
      continue;
    }
    for (const item of group.items) {
      const article = document.createElement('article');
      article.append(
        textElement('h4', item.label),
        textElement('p', item.details),
      );
      appendFacts(article, item.facts);
      appendGaps(article, item.gaps);
      details.append(article);
    }
  }
  root.append(details);
}

function appendRelationships(
  root: HTMLElement,
  panel: BasisPanelViewModel,
): void {
  const details = disclosure('Relationships');
  if (!panel.relationships.length)
    details.append(textElement('p', 'No relationships were recorded.'));
  for (const relationship of panel.relationships) {
    const article = document.createElement('article');
    article.append(
      textElement('h3', relationship.label),
      textElement('p', relationship.prose),
    );
    appendFacts(article, [relationship.from, relationship.to]);
    appendGaps(article, relationship.gaps);
    details.append(article);
  }
  root.append(details);
}

function appendTechnical(root: HTMLElement, panel: BasisPanelViewModel): void {
  const details = disclosure('Technical identity');
  if (panel.technical) {
    appendFacts(details, [
      { label: 'Answer owner', value: panel.technical.answerOwner },
      { label: 'Answer state', value: panel.technical.answerState },
      { label: 'Assessment owner', value: panel.technical.assessmentOwner },
      { label: 'Assessment state', value: panel.technical.assessmentState },
      { label: 'Bundle', value: panel.technical.bundleId ?? 'Not captured' },
      { label: 'Claim', value: panel.technical.claimId ?? 'Not captured' },
    ]);
  } else details.append(textElement('p', 'Technical identity is unavailable.'));
  root.append(details);
}

function appendStringList(
  root: HTMLElement,
  values: readonly string[],
  empty: string,
): void {
  if (!values.length) {
    root.append(textElement('p', empty));
    return;
  }
  const list = document.createElement('ul');
  for (const value of values) list.append(textElement('li', value));
  root.append(list);
}
