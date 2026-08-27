/**
 * @vitest-environment jsdom
 */
// station#1502 slice 4 — §3.6's resolution states and §4.1's not-backing path,
// as rendered. The two traps this suite exists to hold shut:
//
//   1. `missing` and `unbound` must NOT render alike. They were ONE state
//      until station#1594/#1603 split them, precisely because "nothing was
//      ever declared" and "the declared directory is gone" owe opposite
//      behaviour (#1023's `$HOME` terminus vs #791's fail-closed throw).
//      Collapsing them in the UI reintroduces the defect one layer up.
//   2. The three path SLOTS are three different claims — an answer, an
//      observation, and a declaration — and no label may be reused across
//      them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refetch = vi.fn();
const bindMutate = vi.fn();
let queryState: Record<string, unknown> = {};
let bindPending = false;

/**
 * The options the component hands the mutation hook, CAPTURED.
 *
 * The original mock discarded this argument, so `onSuccess`/`onError` never
 * ran and the whole refusal path — the point of the slice — was untested: the
 * `refusal` state, the "That checkout was not recorded" block, its reset, and
 * the pending label would every one of them still have passed this suite if
 * deleted (station#1502 fix round, MEDIUM-4).
 */
interface CapturedBindOptions {
  onSuccess?: (outcome: unknown, path: string) => void;
  onError?: (error: Error, path: string) => void;
}
let bindOptions: CapturedBindOptions | undefined;

vi.mock('@kontourai/station-sdk', () => ({
  useProjectResolutionQuery: () => ({
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch,
    ...queryState,
  }),
  useBindProjectResourceMutation: (
    _slug: string,
    options?: CapturedBindOptions,
  ) => {
    bindOptions = options;
    return { mutate: bindMutate, isPending: bindPending };
  },
}));

import type {
  ProjectPrimaryResourceSelection,
  ProjectResolutionView,
  ResourceResolutionResult,
} from '@kontourai/station-contracts/project-identity';
import { RESOURCE_SLOT_LABELS, ResourcesSection } from '../ResourcesSection';

beforeEach(() => {
  refetch.mockClear();
  bindMutate.mockClear();
  queryState = {};
  bindPending = false;
  bindOptions = undefined;
});

function renderView(view: ProjectResolutionView) {
  queryState = { data: view };
  return render(<ResourcesSection slug="acme" />);
}

/**
 * station#1503 slice 5 — the view carries a LIST and a primary selection. This
 * helper keeps every slice-4 assertion pointed at the single-resource case it
 * was written for; the multi-resource cases are their own describe block.
 */
function backing(
  resources: ResourceResolutionResult[],
  primary?: ProjectPrimaryResourceSelection,
): ProjectResolutionView {
  const first = resources[0];
  return {
    posture: 'backing',
    resources,
    primary:
      primary ??
      // `ambiguous` names no resource, so a primary cannot name it either.
      (first === undefined || first.resourceId.length === 0
        ? { named: false, reason: 'no single resource is the primary' }
        : { named: true, resourceId: first.resourceId }),
  };
}

function renderResource(resource: ResourceResolutionResult) {
  return renderView(backing([resource]));
}

/**
 * A token that begins with `/` or `~/` — i.e. a filesystem path, as distinct
 * from a remote-shaped resource id like `github.com/acme/api`, which contains
 * a slash and is NOT a path. §3.6 rule 3 forbids the first, not the second.
 */
const PATH_LIKE = /(^|[\s"'(>])(~\/|\/)[A-Za-z0-9._-]/;

const BOUND: ResourceResolutionResult = {
  state: 'bound',
  resourceId: 'github.com/acme/api',
  path: '/Users/dev/code/api',
};
const UNBOUND: ResourceResolutionResult = {
  state: 'unbound',
  resourceId: 'github.com/acme/api',
  reason: 'It has no binding on this Station and the project has no directory.',
};
const MISSING: ResourceResolutionResult = {
  state: 'missing',
  resourceId: 'github.com/acme/api',
  record: 'binding',
  declaredPath: '~/code/api',
  reason: 'The place it was recorded is gone.',
};
const DRIFTED: ResourceResolutionResult = {
  state: 'drifted',
  resourceId: 'github.com/acme/api',
  unverifiedPath: '/Users/dev/code/other',
  reason: 'The checkout advertises a set that does not intersect.',
};
const STALE: ResourceResolutionResult = {
  state: 'stale',
  resourceId: 'github.com/acme/api',
  unverifiedPath: '/Users/dev/code/api',
  reason: 'git could not be run on this host.',
};
const AMBIGUOUS: ResourceResolutionResult = {
  state: 'ambiguous',
  resourceId: '',
  reason: 'Two resources declare role primary: alpha, beta.',
};
// Hand-built: NOTHING in Station produces these today, by design. §3.6 scopes
// `unresolvable` to an attempt that was DENIED, and this slice performs no
// authenticated operation that can be denied; `not-portable` waits on
// membership. The renderer must still handle them for contract completeness.
const UNRESOLVABLE: ResourceResolutionResult = {
  state: 'unresolvable',
  resourceId: 'github.com/acme/api',
  reason: 'The request to read it was denied.',
};
const NOT_PORTABLE: ResourceResolutionResult = {
  state: 'not-portable',
  resourceId: 'local:acme',
  reason: 'It is a local-only resource authored elsewhere.',
};

describe('ResourcesSection — one arm per state (§3.6)', () => {
  it('bound: renders the path under the ANSWER slot and offers no repair', () => {
    const { container } = renderResource(BOUND);

    expect(screen.getByText('Resolved')).toBeTruthy();
    expect(screen.getByText(RESOURCE_SLOT_LABELS.answer)).toBeTruthy();
    expect(screen.getByText('/Users/dev/code/api')).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('unbound: names the resource and the reason, offers the point-at-a-checkout form, and names NO path', () => {
    const { container } = renderResource(UNBOUND);

    expect(screen.getByText('Not set up on this Station')).toBeTruthy();
    expect(screen.getByText(/has no binding on this Station/)).toBeTruthy();
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    // Nothing to pre-fill: `unbound` carries no record and no path.
    expect(input.value).toBe('');
    expect(
      screen.getByRole('button', { name: 'Point at checkout' }),
    ).toBeTruthy();
    // No slot of any kind renders — there is no path to put in one.
    for (const label of Object.values(RESOURCE_SLOT_LABELS)) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('missing: names the RECORD and the DECLARED path, under the declared slot, and pre-fills the repair', () => {
    const { container } = renderResource(MISSING);

    expect(screen.getByText('The recorded location is gone')).toBeTruthy();
    // Which record — "re-point or re-clone" is unactionable without it.
    expect(screen.getByText(/the recorded binding/)).toBeTruthy();
    expect(screen.getByText(RESOURCE_SLOT_LABELS.declared)).toBeTruthy();
    expect(screen.getByText('~/code/api')).toBeTruthy();
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('~/code/api');
    expect(screen.getByRole('button', { name: 'Re-point' })).toBeTruthy();
  });

  it('missing with record `working-directory` names THAT record instead', () => {
    renderResource({
      ...MISSING,
      record: 'working-directory',
      declaredPath: '~/code/elsewhere',
    });

    expect(screen.getByText(/the project's working directory/)).toBeTruthy();
    expect(screen.queryByText(/the recorded binding/)).toBeNull();
  });

  it('drifted: renders unverifiedPath under the OBSERVATION slot and offers re-point only', () => {
    renderResource(DRIFTED);

    expect(
      screen.getByText('A different repository is at that path'),
    ).toBeTruthy();
    expect(screen.getByText(RESOURCE_SLOT_LABELS.observation)).toBeTruthy();
    expect(screen.getByText('/Users/dev/code/other')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-point' })).toBeTruthy();
    // §3.6 says "confirm the new identity or re-point"; confirming would
    // rewrite the manifest's canonicalRemote and no such verb exists, so the
    // operator is never told to confirm anything.
    expect(screen.queryByText(/confirm/i)).toBeNull();
  });

  it('stale: renders unverifiedPath under the OBSERVATION slot with its own wording, and Re-verify re-runs the resolution', () => {
    renderResource(STALE);

    expect(screen.getByText('Could not be verified just now')).toBeTruthy();
    expect(screen.getByText(RESOURCE_SLOT_LABELS.observation)).toBeTruthy();
    expect(screen.getByText('/Users/dev/code/api')).toBeTruthy();
    // Its wording differs from `drifted`'s even though the slot is the same.
    expect(
      screen.getByText(/Station could not confirm which repository is in it/),
    ).toBeTruthy();
    // NOT "the check did not run": the resolver emits `stale` when
    // `readCheckoutRemotes` answers `ok: false`, i.e. the check ran and
    // FAILED, which is the common case (station#1502 fix round, LOW-3).
    expect(screen.queryByText(/did not run/)).toBeNull();

    const reverify = screen.getByRole('button', { name: 'Re-verify' });
    fireEvent.click(reverify);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('ambiguous: surfaces the reason, names no resource, and offers no repair', () => {
    const { container } = renderResource(AMBIGUOUS);

    expect(screen.getByText(/Two resources declare role primary/)).toBeTruthy();
    // Its resourceId is required EMPTY by contract; nothing renders an id.
    expect(container.querySelector('code')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('unresolvable: names the resource, discloses NO path, and offers no repair', () => {
    const { container } = renderResource(UNRESOLVABLE);

    expect(screen.getByText('Access was denied')).toBeTruthy();
    expect(screen.getByText(/github\.com\/acme\/api/)).toBeTruthy();
    expect(screen.getByText(/was denied\./)).toBeTruthy();
    // §3.6 rule 3: no path, branch, or content is disclosed.
    expect(container.textContent ?? '').not.toMatch(PATH_LIKE);
    for (const label of Object.values(RESOURCE_SLOT_LABELS)) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // "Nothing local; the gap is upstream" — so no local action is offered.
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('not-portable: names the resource and offers no repair', () => {
    const { container } = renderResource(NOT_PORTABLE);

    expect(screen.getByText('Never shareable to begin with')).toBeTruthy();
    expect(screen.getByText(/local:acme/)).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('trap 1 — `missing` and `unbound` must not render alike', () => {
  it('their rendered text differs', () => {
    const unbound = render(<ResourcesSection slug="acme" />);
    queryState = { data: backing([UNBOUND]) };
    unbound.rerender(<ResourcesSection slug="acme" />);
    const unboundText = unbound.container.textContent ?? '';
    unbound.unmount();

    queryState = { data: backing([MISSING]) };
    const missing = render(<ResourcesSection slug="acme" />);
    const missingText = missing.container.textContent ?? '';

    expect(missingText).not.toBe(unboundText);
    // Different HEADLINE.
    expect(unboundText).toContain('Not set up on this Station');
    expect(missingText).toContain('The recorded location is gone');
    expect(missingText).not.toContain('Not set up on this Station');
    expect(unboundText).not.toContain('The recorded location is gone');
  });

  it('`missing` names its record kind and its declaredPath; `unbound` names neither', () => {
    const missing = render(<ResourcesSection slug="acme" />);
    queryState = { data: backing([MISSING]) };
    missing.rerender(<ResourcesSection slug="acme" />);
    const missingText = missing.container.textContent ?? '';
    expect(missingText).toContain('the recorded binding');
    expect(missingText).toContain('~/code/api');
    expect(missingText).toContain(RESOURCE_SLOT_LABELS.declared);
    missing.unmount();

    queryState = { data: backing([UNBOUND]) };
    const unbound = render(<ResourcesSection slug="acme" />);
    const unboundText = unbound.container.textContent ?? '';
    expect(unboundText).not.toContain('the recorded binding');
    expect(unboundText).not.toContain("the project's working directory");
    expect(unboundText).not.toContain(RESOURCE_SLOT_LABELS.declared);
    // No path of any kind: `unbound` has nothing recorded to name.
    expect(unboundText).not.toMatch(PATH_LIKE);
  });
});

describe('trap 2 — slot discipline: an answer is not an observation', () => {
  it('the three slot labels are three distinct strings', () => {
    const labels = Object.values(RESOURCE_SLOT_LABELS);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(3);
  });

  it('the ANSWER label renders for `bound` and for no other state', () => {
    for (const resource of [
      UNBOUND,
      MISSING,
      DRIFTED,
      STALE,
      AMBIGUOUS,
      UNRESOLVABLE,
      NOT_PORTABLE,
    ] as ResourceResolutionResult[]) {
      const view = render(<ResourcesSection slug="acme" />);
      queryState = { data: backing([resource]) };
      view.rerender(<ResourcesSection slug="acme" />);
      expect(view.container.textContent).not.toContain(
        RESOURCE_SLOT_LABELS.answer,
      );
      view.unmount();
    }

    queryState = { data: backing([BOUND]) };
    const bound = render(<ResourcesSection slug="acme" />);
    expect(bound.container.textContent).toContain(RESOURCE_SLOT_LABELS.answer);
  });

  it('the OBSERVATION and DECLARED labels never appear on `bound`', () => {
    const { container } = renderResource(BOUND);
    expect(container.textContent).not.toContain(
      RESOURCE_SLOT_LABELS.observation,
    );
    expect(container.textContent).not.toContain(RESOURCE_SLOT_LABELS.declared);
  });

  it('a slot carries its own kind in the DOM, so an observation cannot be styled as an answer', () => {
    const { container } = renderResource(DRIFTED);
    expect(
      container.querySelector('.resources-section__slot--observation'),
    ).toBeTruthy();
    expect(
      container.querySelector('.resources-section__slot--answer'),
    ).toBeNull();
  });
});

describe('§4.1 — the not-backing path shows none of the five forbidden things', () => {
  it('renders one unremarkable statement and nothing else', () => {
    const { container } = renderView({ posture: 'not-backing' });

    const text = container.textContent ?? '';
    expect(text).toContain("This Station isn't backing this project");

    // 1. no repair prompt
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    // 2. no "unresolvable for you" badge
    expect(text.toLowerCase()).not.toContain('unresolvable');
    expect(text.toLowerCase()).not.toContain('denied');
    // 3. no per-resource row / state table
    expect(container.querySelector('.resources-section__row')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    for (const label of Object.values(RESOURCE_SLOT_LABELS)) {
      expect(text).not.toContain(label);
    }
    // 4. no clone call-to-action — and nothing that names an action the
    //    surface cannot perform (the contract carries no remote to clone).
    expect(text.toLowerCase()).not.toContain('clone');
    // 5. nothing that reads as an incomplete setup
    expect(text.toLowerCase()).not.toContain('incomplete');
    expect(text.toLowerCase()).not.toContain('finish setting up');
    expect(text).not.toMatch(PATH_LIKE);
  });
});

describe('unreadable is never rendered as not-backing', () => {
  it('surfaces the reason in an error state', () => {
    const { container } = renderView({
      posture: 'unreadable',
      reason: 'Project "acme"\'s manifest could not be read: it is zero-length',
    });

    expect(
      screen.getByText("This project's resource record could not be read"),
    ).toBeTruthy();
    expect(screen.getByText(/zero-length/)).toBeTruthy();
    expect(container.textContent).not.toContain(
      "This Station isn't backing this project",
    );
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });
});

describe('the repair action is an explicit operator act', () => {
  it('submits the path the operator typed, and never derives one', () => {
    const { container } = renderResource(UNBOUND);
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '  /Users/dev/code/api  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Point at checkout' }));

    expect(bindMutate).toHaveBeenCalledTimes(1);
    // station#1503: the mutation carries WHICH resource it repairs, so a
    // multi-repo project's third row cannot write the primary's binding.
    expect(bindMutate).toHaveBeenCalledWith({
      path: '/Users/dev/code/api',
      resourceId: 'github.com/acme/api',
    });
  });

  it('submits nothing while the field is empty', () => {
    const { container } = renderResource(UNBOUND);
    const button = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    expect(bindMutate).not.toHaveBeenCalled();
  });

  it('tells the operator that Station checks before it records', () => {
    renderResource(MISSING);
    expect(
      screen.getByText(/checks the directory before it records anything/),
    ).toBeTruthy();
    // "never silently re-bind" — the copy must not promise Station will fix it.
    const form = screen
      .getByRole('button', { name: 'Re-point' })
      .closest('form') as HTMLFormElement;
    expect(within(form).queryByText(/we'll find it/i)).toBeNull();
  });
});

describe('loading and error states use the canonical primitives', () => {
  it('renders a skeleton while loading', () => {
    queryState = { isLoading: true };
    const { container } = render(<ResourcesSection slug="acme" />);
    expect(container.querySelector('.skeleton-list')).toBeTruthy();
  });

  it('renders an ErrorState with a retry when the read fails', () => {
    queryState = { isError: true, error: new Error('the server said no') };
    render(<ResourcesSection slug="acme" />);

    expect(
      screen.getByText("Could not read this project's resources"),
    ).toBeTruthy();
    expect(screen.getByText('the server said no')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

// ── station#1502 fix round ────────────────────────────────────────────────

describe('MEDIUM-4 — the refusal path, driven through the real callbacks', () => {
  it("shows the server's reason VERBATIM under its own title", () => {
    const { container } = renderResource(UNBOUND);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/Users/dev/code/api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Point at checkout' }));

    const reason =
      'The checkout at "/Users/dev/code/api" advertises no remotes, so this Station could not establish which repository it is.';
    act(() => bindOptions?.onError?.(new Error(reason), '/Users/dev/code/api'));

    expect(screen.getByText('That checkout was not recorded')).toBeTruthy();
    // Verbatim: a refusal reason is the whole value of an honest unavailable,
    // so it is never summarized, retried, or replaced.
    expect(screen.getByText(reason)).toBeTruthy();
  });

  it('clears a previous refusal when the operator submits again', () => {
    const { container } = renderResource(UNBOUND);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Point at checkout' }));
    act(() => bindOptions?.onError?.(new Error('first refusal'), '/one'));
    expect(screen.getByText('first refusal')).toBeTruthy();

    fireEvent.change(input, { target: { value: '/two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Point at checkout' }));

    expect(screen.queryByText('first refusal')).toBeNull();
    expect(screen.queryByText('That checkout was not recorded')).toBeNull();
  });

  it('clears a refusal on a subsequent SUCCESS', () => {
    const { container } = renderResource(UNBOUND);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Point at checkout' }));
    act(() => bindOptions?.onError?.(new Error('a refusal'), '/one'));

    act(() =>
      bindOptions?.onSuccess?.(
        { recorded: true, view: backing([BOUND]) },
        '/one',
      ),
    );

    expect(screen.queryByText('a refusal')).toBeNull();
  });

  it('labels the submit button while the bind is in flight', () => {
    bindPending = true;
    renderResource(UNBOUND);

    const button = screen.getByRole('button', {
      name: 'Checking…',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Point at checkout' })).toBe(
      null,
    );
  });

  it('a RECORDED bind whose re-read failed is NOT reported as a failed bind (MEDIUM-3)', () => {
    const { container } = renderResource(UNBOUND);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/Users/dev/code/api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Point at checkout' }));

    const gap =
      'The binding was recorded. This Station could not then re-read what it can now say about this project: the disk caught fire';
    act(() =>
      bindOptions?.onSuccess?.({ recorded: true, gap }, '/Users/dev/code/api'),
    );

    expect(screen.getByText(gap)).toBeTruthy();
    // The false negative this exists to prevent.
    expect(screen.queryByText('That checkout was not recorded')).toBeNull();
  });
});

describe('HIGH-3 — the `missing` repair is branched on the RECORD', () => {
  it('a `working-directory` record points at the workspace section, and offers NO bind form', () => {
    const { container } = renderResource({
      ...MISSING,
      record: 'working-directory',
      declaredPath: '~/code/elsewhere',
    });

    // `bindProjectResource` writes a BINDING row keyed by the manifest's
    // resource. For a manifest-less project it is refused 409 every time, so
    // the form was a guaranteed dead end — and it named the working directory
    // while writing something else.
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    const link = container.querySelector('a') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('#section-workspace');
    // The path the record declares is still named — the repair is unactionable
    // without it.
    expect(screen.getByText('~/code/elsewhere')).toBeTruthy();
  });

  it('a `binding` record keeps the bind form, pre-filled', () => {
    const { container } = renderResource(MISSING);

    expect(container.querySelector('form')).toBeTruthy();
    expect((container.querySelector('input') as HTMLInputElement).value).toBe(
      '~/code/api',
    );
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('LOW-1 — a state transition remounts the repair form', () => {
  it('does not carry the old state’s pre-filled path into the new one', () => {
    queryState = { data: backing([MISSING]) };
    const view = render(<ResourcesSection slug="acme" />);
    expect(
      (view.container.querySelector('input') as HTMLInputElement).value,
    ).toBe('~/code/api');

    // `missing` → `drifted`: both render a `PointAtCheckoutForm`, so without a
    // key they reconcile POSITIONALLY and the mounted form keeps its
    // `useState(initialPath)` — showing the previous state's declaredPath as
    // though it belonged to this one.
    queryState = { data: backing([DRIFTED]) };
    view.rerender(<ResourcesSection slug="acme" />);

    expect(
      (view.container.querySelector('input') as HTMLInputElement).value,
    ).toBe('');
  });

  it('does not carry stale refusal text across the transition', () => {
    queryState = { data: backing([MISSING]) };
    const view = render(<ResourcesSection slug="acme" />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-point' }));
    act(() => bindOptions?.onError?.(new Error('stale refusal'), '~/code/api'));
    expect(screen.getByText('stale refusal')).toBeTruthy();

    queryState = { data: backing([DRIFTED]) };
    view.rerender(<ResourcesSection slug="acme" />);

    expect(screen.queryByText('stale refusal')).toBeNull();
  });
});

describe('LOW-2 — the three slots are visually distinct, not just textually', () => {
  // The CSS comment CLAIMS this; `--observation` and `--declared` shared one
  // identical rule block, so the claim was unpinned and false. Pinned here so
  // it cannot become false again silently.
  // `process.cwd()` and not `import.meta.url`: this file runs under jsdom,
  // where `import.meta.url` is an http URL that `readFileSync` refuses.
  const css = readFileSync(
    join(process.cwd(), 'src-ui/src/views/ProjectSettingsView.css'),
    'utf-8',
  );

  function declarationsFor(slot: string): string {
    const match = new RegExp(
      `\\.resources-section__slot--${slot}\\s*\\{([^}]*)\\}`,
    ).exec(css);
    if (!match) throw new Error(`no rule block for slot --${slot}`);
    return match[1].replace(/\s+/g, ' ').trim();
  }

  it('each slot kind has its own rule block with its own declarations', () => {
    const treatments = ['answer', 'observation', 'declared'].map(
      declarationsFor,
    );
    for (const treatment of treatments)
      expect(treatment.length).toBeGreaterThan(0);
    expect(new Set(treatments).size).toBe(3);
  });

  it('no rule block groups two slot kinds under one selector', () => {
    // The exact shape of the defect: `--observation, --declared { … }`.
    expect(css).not.toMatch(
      /\.resources-section__slot--\w+\s*,\s*\n?\s*\.resources-section__slot--\w+\s*\{/,
    );
  });
});

describe('LOW-3 — Re-verify has a pending affordance', () => {
  it('labels and disables itself while the resolution is refetching', () => {
    queryState = {
      data: backing([STALE]),
      isFetching: true,
    };
    render(<ResourcesSection slug="acme" />);

    const button = screen.getByRole('button', {
      name: 'Checking…',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Re-verify' })).toBeNull();
  });
});

describe('LOW-4 — the `unreadable` posture carries the repair its split exists for', () => {
  it('offers a Retry that re-reads', () => {
    renderView({
      posture: 'unreadable',
      reason: 'Project "acme"\'s manifest could not be read: it is zero-length',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('LOW-5 — the transient compat id is never shown as the thing that resolves', () => {
  it('a manifest-less project describes its working directory instead of printing `local:acme`', () => {
    const { container } = renderResource({
      state: 'bound',
      resourceId: 'local:acme',
      path: '/Users/dev/code/acme',
    });

    expect(container.textContent).not.toContain('local:acme');
    // The body names no resource id at all; the only `code` left is the
    // ANSWER slot's path.
    expect(container.querySelector('.resources-section__body code')).toBeNull();
    expect(
      screen.getByText(/This project's working directory resolves here/),
    ).toBeTruthy();
    // The ANSWER slot still carries the verified path — nothing is suppressed
    // except the id.
    expect(screen.getByText('/Users/dev/code/acme')).toBeTruthy();
  });

  it('a real resource id IS named', () => {
    const { container } = renderResource(BOUND);
    expect(container.textContent).toContain('github.com/acme/api');
    expect(
      container.querySelector('.resources-section__body code')?.textContent,
    ).toBe('github.com/acme/api');
  });
});

describe('AC5 stand-in — the local-only vocabulary guard', () => {
  // The unit-level substitute for `tests/first-run-live.spec.ts`'s §4.6 pin,
  // which this slice does not run (no e2e this pass). It asserts the same
  // property that pin exists for: a purely local Station never sees
  // collaboration vocabulary on a resolving project.
  it('a bound project renders no member/manifest/contribution vocabulary', () => {
    const { container } = renderResource(BOUND);
    expect(container.textContent ?? '').not.toMatch(
      /member|manifest|contribution|backing project/i,
    );
  });
});

// ── station#1503 slice 5 — a partially-bound multi-repo project ────────────

describe('a partially-bound multi-repo project is LEGIBLE', () => {
  const API_BOUND: ResourceResolutionResult = {
    state: 'bound',
    resourceId: 'github.com/acme/api',
    path: '/Users/dev/code/api',
  };
  const WEB_BOUND: ResourceResolutionResult = {
    state: 'bound',
    resourceId: 'github.com/acme/web',
    path: '/Users/dev/code/web',
  };
  const DOCS_UNBOUND: ResourceResolutionResult = {
    state: 'unbound',
    resourceId: 'github.com/acme/docs',
    reason: 'Nothing here records a location for it.',
  };

  it('renders 2 of 3 — not "bound", and not "unbound"', () => {
    const { container } = renderView(
      backing([API_BOUND, WEB_BOUND, DOCS_UNBOUND]),
    );
    const text = container.textContent ?? '';

    // The tally is DERIVED from the rows, so it cannot disagree with them.
    expect(text).toContain('2 of 3');
    expect(text).toContain('resources resolve');
    // Every resource is named, and the unbound one keeps its own repair form.
    for (const id of [
      'github.com/acme/api',
      'github.com/acme/web',
      'github.com/acme/docs',
    ]) {
      expect(text).toContain(id);
    }
    expect(container.querySelectorAll('.resources-section__row')).toHaveLength(
      3,
    );
    expect(
      screen.getAllByRole('button', { name: 'Point at checkout' }),
    ).toHaveLength(1);
  });

  it('each repair form writes ITS OWN resource', () => {
    const { container } = renderView(
      backing([
        API_BOUND,
        DOCS_UNBOUND,
        {
          state: 'missing',
          resourceId: 'github.com/acme/web',
          record: 'binding',
          declaredPath: '~/code/web',
          reason: 'The place it was recorded is gone.',
        },
      ]),
    );
    const inputs = container.querySelectorAll('input');
    expect(inputs).toHaveLength(2);

    // The `missing` row is pre-filled with what ITS record declares.
    fireEvent.click(screen.getByRole('button', { name: 'Re-point' }));
    expect(bindMutate).toHaveBeenCalledWith({
      path: '~/code/web',
      resourceId: 'github.com/acme/web',
    });

    bindMutate.mockClear();
    fireEvent.change(inputs[0], { target: { value: '/Users/dev/code/docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Point at checkout' }));
    expect(bindMutate).toHaveBeenCalledWith({
      path: '/Users/dev/code/docs',
      resourceId: 'github.com/acme/docs',
    });
  });

  it('gives every repair input a DISTINCT id, so each label points at its own field', () => {
    const { container } = renderView(
      backing([
        DOCS_UNBOUND,
        {
          state: 'unbound',
          resourceId: 'github.com/acme/web',
          reason: 'Nothing here records a location for it.',
        },
      ]),
    );
    const ids = [...container.querySelectorAll('input')].map(
      (input) => input.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says nothing about a tally for a single-resource project', () => {
    // "1 of 1" above one row is noise that trains a reader to skip the place
    // the real count will one day appear.
    const { container } = renderView(backing([API_BOUND]));
    expect(container.textContent ?? '').not.toContain('1 of 1');
  });

  it('renders the PRIMARY gap — the fact per-resource rows would otherwise silence', () => {
    // Every row can read healthy while nothing can be started in the project:
    // the session cwd, the knowledge scan and the task workspace all ask
    // WITHOUT a resource id, and that question has no answer here.
    const { container } = renderView(
      backing([API_BOUND, WEB_BOUND], {
        named: false,
        reason:
          'Project "acme" names 2 resources and 2 of them declare role "primary".',
      }),
    );
    const text = container.textContent ?? '';

    expect(text).toContain("No single resource is this project's primary");
    expect(text).toContain('declare role "primary"');
    // The rows are still there — the project is not reported as broken wholesale.
    expect(text).toContain('github.com/acme/api');
  });

  it('renders NOTHING extra when the primary is named', () => {
    const { container } = renderView(backing([API_BOUND, WEB_BOUND]));
    expect(container.textContent ?? '').not.toContain('primary');
  });
});
