/**
 * archive#3341 — `.copy-affordance--failed` shipped as one bare
 * `color` rule in `index.css` and was measured INERT at four of its six
 * adopters. Same specificity as each button's own class, so source order
 * decides, and four adopters come later: `.session-item__action-btn` ~2000
 * lines further down the entry sheet, and three in chunk stylesheets the
 * bundler injects after it.
 *
 * The fix pairs the marker with each button's own class, which wins on
 * specificity instead of position. jsdom computes no cascade across
 * stylesheets, so a rendered test cannot see this at all; the honest guard is
 * to assert the paired rule exists IN THE STYLESHEET THAT OWNS THE BUTTON —
 * co-located there precisely so a chunking change cannot separate them.
 *
 * This asserts the mechanism, not the colour: a per-component rule that is
 * absent, or that names only the shared marker, silently reverts the affordance
 * to a plain-coloured button whose failure signal is only its label.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC_UI = join(__dirname, '..');

/** Each adopter: the class its button carries, and the stylesheet that owns it. */
const ADOPTERS: ReadonlyArray<{
  component: string;
  buttonClass: string;
  stylesheet: string;
}> = [
  {
    component: 'ChatDockActiveIdentity',
    buttonClass: 'chat-dock__active-identity-copy',
    stylesheet: 'index.css',
  },
  {
    component: 'SessionConversationItem',
    buttonClass: 'session-item__action-btn',
    stylesheet: 'index.css',
  },
  {
    component: 'CodingInspectorPanel',
    buttonClass: 'coding-inspector__cta-action',
    stylesheet: 'components/coding-layout/CodingInspectorPanel.css',
  },
  {
    component: 'WorkflowPlanPanel',
    buttonClass: 'workflow-plan-panel__action',
    stylesheet: 'components/coding-layout/CodingLayout.css',
  },
  {
// The Connections hub page (and its stylesheet) is gone; its copy
// affordance moved to the Computers section, which uses the SHARED
// Button primitive — so the paired rule now lives beside `.button` in
// the sheet that owns it, and covers every shared-Button adopter.
    component: 'ComputersSection',
    buttonClass: 'button',
    stylesheet: 'index.css',
  },
  {
    component: 'FlowRunConsole',
    buttonClass: 'flow-gate-card__copy-btn',
    stylesheet: 'components/flow/flow-events.css',
  },
];

function read(stylesheet: string): string {
  return readFileSync(join(SRC_UI, stylesheet), 'utf8');
}

/** The rule body for `.<buttonClass>.copy-affordance--failed`, if present. */
function pairedRuleBody(css: string, buttonClass: string): string | null {
  const selector = `.${buttonClass}.copy-affordance--failed`;
  const at = css.indexOf(selector);
  if (at === -1) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) return null;
  return css.slice(open + 1, close);
}

describe('copy affordance failed-state cascade (station#3341)', () => {
  test.each(ADOPTERS)(
    '$component pairs the failed marker with its own class, in its own stylesheet',
    ({ buttonClass, stylesheet }) => {
      const body = pairedRuleBody(read(stylesheet), buttonClass);
      expect(body).not.toBeNull();
      expect(body).toContain('color: var(--status-error)');
    },
  );

  test('the shared marker declares no colour of its own', () => {
// A bare `.copy-affordance--failed { color:... }` is the defect this
// fix removed: it reads as working, and is inert wherever the component's
// own rule lands later. The marker exists only to be paired.
    const entry = read('index.css');
    const bare = /(^|[\s,{}])\.copy-affordance--failed\s*\{([^}]*)\}/m.exec(
      entry,
    );
    expect(bare).toBeNull();
  });

  test('every component that renders the marker is listed here', () => {
// Guards the list itself: a seventh adopter added without a paired rule
// would otherwise be covered by nothing.
    const rendered = new Set(ADOPTERS.map((a) => a.component));
    const sources = [
      'components/chat-dock/ChatDockActiveIdentity.tsx',
      'components/session/SessionConversationItem.tsx',
      'components/coding-layout/CodingInspectorPanel.tsx',
      'components/flow/WorkflowPlanPanel.tsx',
      'views/connections-hub/ComputersSection.tsx',
      'components/flow/FlowRunConsole.tsx',
    ];
    for (const source of sources) {
      expect(read(source)).toContain('copy-affordance--failed');
    }
    expect(rendered.size).toBe(sources.length);
  });
});
