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

import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * Every `.tsx` under `src-ui/src` that renders the marker, as a repo-relative
 * path. This is what makes the adopter list total rather than self-confirming.
 */
function componentsRenderingTheMarker(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(join(SRC_UI, directory))) {
      if (name === 'node_modules' || name === '__tests__') continue;
      const relative = directory ? `${directory}/${name}` : name;
      if (statSync(join(SRC_UI, relative)).isDirectory()) {
        walk(relative);
        continue;
      }
      if (!name.endsWith('.tsx')) continue;
      if (read(relative).includes('copy-affordance--failed'))
        found.push(relative);
    }
  };
  walk('');
  return found.sort();
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

  test('every component that renders the marker is accounted for', () => {
    // DISCOVERED, not restated. The previous form listed the same sources it
    // then asserted contained the marker, so it could only catch an adopter
    // that STOPPED rendering it — never one that started, which is the
    // direction that ships an inert affordance. Scanning found two this list
    // had never named (`HostAction`, `SshComputerCreatorDialog`); both reach
    // the marker through the shared `Button` primitive, whose pairing is the
    // `.button.copy-affordance--failed` rule the ComputersSection row above
    // asserts, so they are covered — they were simply invisible here.
    //
    // Adding a component to this list is therefore a decision about WHICH
    // pairing covers it: its own class (a row above) or the shared `.button`.
    const sharedButtonAdopters = [
      'components/host-action/HostAction.tsx',
      'views/connections-hub/ComputersSection.tsx',
      'views/connections-hub/SshComputerCreatorDialog.tsx',
    ];
    const ownClassAdopters = [
      'components/coding-layout/CodingInspectorPanel.tsx',
      'components/flow/FlowRunConsole.tsx',
      'components/flow/WorkflowPlanPanel.tsx',
      'components/session/SessionConversationItem.tsx',
    ];
    expect(componentsRenderingTheMarker()).toEqual(
      [...sharedButtonAdopters, ...ownClassAdopters].sort(),
    );
    // The own-class adopters are exactly the non-`button` rows above, so a row
    // deleted from ADOPTERS without its component losing the marker reds here.
    expect(
      ADOPTERS.filter((adopter) => adopter.buttonClass !== 'button').length,
    ).toBe(ownClassAdopters.length);
  });
});

/**
 * archive#3341's marker is not the only honest way to report a refused write,
 * and one adopter left the list by taking the other one: #1536 F moved the dock
 * header's "Copy ID" button into a MENU ROW, and a row is gone by the time the
 * write resolves, so there is no button left to colour. Its outcome is the
 * shared copy toast instead.
 *
 * That retirement is only safe if the replacement actually reports failure, so
 * this pins the replacement rather than merely deleting a row from the list
 * above — the failure mode a bare deletion would allow is a copy surface that
 * silently does nothing, which is exactly what archive#3341 was about.
 */
describe('the dock header copy affordance reports failure without the marker', () => {
  test('it routes through the shared toast, whose failure sentence is not optional', () => {
    const hook = read('components/chat-dock/useDockCopyActions.ts');
    expect(hook).toContain('useCopyToClipboardToast');
    const shared = read('hooks/useCopyToClipboardToast.ts');
    expect(shared).toContain('COPY_TOAST_FAILURE');
    // The shared hook shows a toast on BOTH arms — there is no path that copies
    // (or fails to) in silence.
    expect(shared).toMatch(/showToast\(\s*copied \? COPY_TOAST_SUCCESS/);
  });

  test('the row it left renders no unpaired marker', () => {
    // Re-introducing the marker on that surface without a paired rule in the
    // sheet that owns its button is the defect archive#3341 fixed; the discovery
    // assertion above would catch it, and this says so at the site.
    expect(
      read('components/chat-dock/ChatDockActiveIdentity.tsx'),
    ).not.toContain('copy-affordance--failed');
  });
});
