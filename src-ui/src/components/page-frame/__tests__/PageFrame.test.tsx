/**
 * @vitest-environment jsdom
 *
 * The page-header contract (station ): one component renders
 * every page header, the route table decides which routes get one, and a view
 * may only publish the TEXT of a title it alone can know — never where it
 * sits, how big it is, or whether it exists.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { PageFrame, PageFrameActions, PageHeaderScope } from '../PageFrame';
import {
  usePageFrameMobileDetailSlot,
  usePageHeader,
  useRegisterPageFrameMobileDetailSheet,
} from '../page-frame-context';

afterEach(cleanup);

function Publisher({
  title,
  subtitle,
  eyebrow,
}: {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
}) {
  usePageHeader({ title, subtitle, eyebrow });
  return <p>body</p>;
}

function MobileDetailPublisher({ name }: { name: string }) {
  const slot = usePageFrameMobileDetailSlot();
  const portaled = Boolean(slot);
  useRegisterPageFrameMobileDetailSheet(portaled);
  return portaled && slot
    ? createPortal(<button type="button">{name}</button>, slot)
    : null;
}

describe('PageFrame', () => {
  it('is transparent for a route with no spec', () => {
    const { container } = render(
      <PageFrame spec={null} routeIdentity="alpha">
        <p>bare</p>
      </PageFrame>,
    );

    expect(container.querySelector('.page-frame')).toBeNull();
    expect(container.querySelector('.page__header')).toBeNull();
    expect(container.firstElementChild?.tagName).toBe('P');
  });

  it('renders eyebrow, title and subtitle at page level', () => {
    const { container } = render(
      <PageFrame
        routeIdentity="alpha"
        spec={{
          eyebrow: 'Schedule',
          title: 'Schedule',
          subtitle: 'Manage scheduled jobs and automation',
        }}
      >
        <p>body</p>
      </PageFrame>,
    );

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Schedule');
    expect(heading.classList.contains('page__title')).toBe(true);
    expect(container.querySelector('.page__label')?.textContent).toBe(
      'Schedule',
    );
    expect(container.querySelector('.page__subtitle')?.textContent).toBe(
      'Manage scheduled jobs and automation',
    );
  });

  it('maps width, body and flush onto the frame root, defaulting to full/flow', () => {
    const { container, unmount } = render(
      <PageFrame spec={{ title: 'A' }} routeIdentity="alpha">
        <p>body</p>
      </PageFrame>,
    );
    expect(container.querySelector('.page-frame')?.className).toBe(
      'page-frame page-frame--full page-frame--flow',
    );
    unmount();

    const split = render(
      <PageFrame
        routeIdentity="alpha"
        spec={{ title: 'B', width: 'narrow', body: 'fill', flush: true }}
      >
        <p>body</p>
      </PageFrame>,
    );
    expect(split.container.querySelector('.page-frame')?.className).toBe(
      'page-frame page-frame--narrow page-frame--fill page-frame--flush',
    );
  });

  it('portals route-owned mobile detail outside the frame and makes the page inert', () => {
    const { container } = render(
      <PageFrame spec={{ title: 'Models' }} routeIdentity="models-new">
        <MobileDetailPublisher name="Back to models" />
      </PageFrame>,
    );

    const frame = container.querySelector('.page-frame');
    const slot = container.querySelector('.page-frame__mobile-detail-slot');
    const detail = screen.getByRole('button', { name: 'Back to models' });
    expect(frame?.hasAttribute('inert')).toBe(true);
    expect(slot?.contains(detail)).toBe(true);
    expect(frame?.contains(detail)).toBe(false);
  });

  it('keeps the frame inert until every mobile detail portal unregisters', () => {
    function Host({ count }: { count: number }) {
      return (
        <PageFrame spec={{ title: 'Models' }} routeIdentity="models-new">
          {count > 0 ? <MobileDetailPublisher name="first sheet" /> : null}
          {count > 1 ? <MobileDetailPublisher name="second sheet" /> : null}
        </PageFrame>
      );
    }
    const { container, rerender } = render(<Host count={2} />);
    const frame = () => container.querySelector('.page-frame');
    expect(frame()?.hasAttribute('inert')).toBe(true);

    rerender(<Host count={1} />);
    expect(frame()?.hasAttribute('inert')).toBe(true);

    rerender(<Host count={0} />);
    expect(frame()?.hasAttribute('inert')).toBe(false);
  });

  it('suppresses a retained old route’s mobile detail portal', () => {
    const child = <MobileDetailPublisher name="old route sheet" />;
    const { container, rerender } = render(
      <PageFrame spec={{ title: 'Models' }} routeIdentity="models-new">
        {child}
      </PageFrame>,
    );
    expect(
      screen.getByRole('button', { name: 'old route sheet' }),
    ).toBeTruthy();

    rerender(
      <PageFrame spec={{ title: 'Engines' }} routeIdentity="engines-new">
        {child}
      </PageFrame>,
    );

    expect(
      screen.queryByRole('button', { name: 'old route sheet' }),
    ).toBeNull();
    expect(container.querySelector('.page-frame')?.hasAttribute('inert')).toBe(
      false,
    );
  });

  it('renders the route table’s first-run anchor on the frame root', () => {
    // The coachmark the first-run tour points at. It moved off the view with
    // the rest of the page shell, so the frame is the only thing
    // that renders it now — `tour-steps.test.ts` reads the same declaration
    // from the route table and this is the half that proves it reaches DOM.
    const { container } = render(
      <PageFrame
        spec={{ title: 'Schedule', firstRunAnchor: 'schedule' }}
        routeIdentity="schedule"
      >
        <p>body</p>
      </PageFrame>,
    );

    expect(
      container
        .querySelector('.page-frame')
        ?.getAttribute('data-first-run-anchor'),
    ).toBe('schedule');
  });

  it('lets a view publish a slot the route table cannot know, per slot', () => {
    const { container } = render(
      <PageFrame
        spec={{ eyebrow: 'Registry', title: 'Registry' }}
        routeIdentity="alpha"
      >
        <Publisher subtitle="Discover agent definitions." />
      </PageFrame>,
    );

    // Published subtitle, table-supplied title and eyebrow — the view did not
    // have to restate what the table already knows.
    expect(container.querySelector('.page__subtitle')?.textContent).toBe(
      'Discover agent definitions.',
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Registry',
    );
    expect(container.querySelector('.page__label')?.textContent).toBe(
      'Registry',
    );
  });

  it('lets a published title win over the route table default', () => {
    render(
      <PageFrame spec={{ title: 'Developer' }} routeIdentity="alpha">
        <Publisher title="Telemetry" />
      </PageFrame>,
    );

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Telemetry',
    );
  });

  it('falls back to the route table when the publisher unmounts', () => {
    function Host() {
      const [mounted, setMounted] = useState(true);
      return (
        <PageFrame spec={{ title: 'Developer' }} routeIdentity="alpha">
          {mounted ? <Publisher title="Telemetry" /> : <p>gone</p>}
          <button type="button" onClick={() => setMounted(false)}>
            unmount
          </button>
        </PageFrame>
      );
    }
    render(<Host />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Telemetry',
    );

    fireEvent.click(screen.getByRole('button', { name: 'unmount' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Developer',
    );
  });

  describe('a title belongs to the route that published it', () => {
    /** A route chunk that never arrives — the whole of a cold load. */
    const NeverArrives = lazy(() => new Promise<never>(() => {}));

    it('renders the route table title while the route chunk is still loading', () => {
      // The frame is ABOVE Suspense so the page keeps its header while its
      // chunk downloads. That is only worth doing if the header says
      // something: an `<h1>` rendered with nothing in it is a blank line
      // where the page name goes.
      render(
        <PageFrame spec={{ title: 'Agents' }} routeIdentity="agents">
          <Suspense fallback={<p>loading</p>}>
            <NeverArrives />
          </Suspense>
        </PageFrame>,
      );

      expect(screen.getByText('loading')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Agents',
      );
    });

    it('drops a published title when the route changes, while the publisher is still mounted', () => {
      // The publisher's own unmount cleanup is NOT what is under test: this
      // child stays mounted across the route change, which is what really
      // happens when the next route's chunk is slow — React keeps the
      // departing view committed for the whole load (measured live at 1.5s).
      // What stops it naming the new route is that a title belongs to the
      // route its publisher mounted for.
      const child = <Publisher title="Agents · alpha" />;
      const { rerender } = render(
        <PageFrame spec={{ title: 'Agents' }} routeIdentity="agents">
          {child}
        </PageFrame>,
      );
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Agents · alpha',
      );

      rerender(
        <PageFrame spec={{ title: 'Plugins' }} routeIdentity="plugins">
          {child}
        </PageFrame>,
      );

      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).not.toBe('Agents · alpha');
      expect(heading.textContent).toBe('Plugins');
    });

    it('takes the departing route’s actions out of the header with its title', () => {
      // The same still-mounted case as above, for the OTHER half of the
      // header, under the same rule. An action belonging to the page the user
      // has left is worse than a stale title: it is clickable. Measured live
      // before this: 1.5s of "Review" beside Plugins' "+ Install Plugin".
      const child = (
        <PageFrameActions>
          <button type="button">+ Install Plugin</button>
        </PageFrameActions>
      );
      const { container, rerender } = render(
        <PageFrame spec={{ title: 'Plugins' }} routeIdentity="plugins">
          {child}
        </PageFrame>,
      );
      expect(
        container.querySelector('.page__actions button')?.textContent,
      ).toBe('+ Install Plugin');

      rerender(
        <PageFrame spec={{ title: 'Review' }} routeIdentity="review-queue">
          {child}
        </PageFrame>,
      );

      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Review',
      );
      expect(container.querySelectorAll('.page__actions').length).toBe(1);
      expect(container.querySelector('.page__actions')?.textContent).toBe('');
      expect(screen.queryByRole('button', { name: '+ Install Plugin' })).toBe(
        null,
      );
    });

    it('replaces the action cell itself, so a portal nobody re-renders goes with it', () => {
      // The case the contributor-side rule cannot reach. When the next
      // route's chunk is slow React keeps the departing view mounted but
      // HIDDEN: its effects are destroyed and it never renders again, so it
      // can never withdraw its own portal — and the portal's children are not
      // inside the hidden subtree, they are in the header. The stand-in for
      // that here is a child appended straight to the cell's DOM node, which
      // React will not re-render either.
      const { container, rerender } = render(
        <PageFrame spec={{ title: 'Plugins' }} routeIdentity="plugins">
          <p>body</p>
        </PageFrame>,
      );
      const cell = container.querySelector('.page__actions');
      const stranded = document.createElement('button');
      stranded.textContent = '+ Install Plugin';
      cell?.appendChild(stranded);
      expect(container.textContent).toContain('+ Install Plugin');

      rerender(
        <PageFrame spec={{ title: 'Review' }} routeIdentity="review-queue">
          <p>body</p>
        </PageFrame>,
      );

      const nextCell = container.querySelector('.page__actions');
      expect(nextCell).not.toBe(cell);
      expect(nextCell?.textContent).toBe('');
      expect(container.textContent).not.toContain('+ Install Plugin');
    });

    it('shows the next route’s own title while that route suspends, never the previous one’s', () => {
      const { rerender } = render(
        <PageFrame spec={{ title: 'Agents' }} routeIdentity="agents">
          <Publisher title="Agents · alpha" />
        </PageFrame>,
      );
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Agents · alpha',
      );

      rerender(
        <PageFrame spec={{ title: 'Plugins' }} routeIdentity="plugins">
          <Suspense fallback={<p>loading</p>}>
            <NeverArrives />
          </Suspense>
        </PageFrame>,
      );

      expect(screen.getByText('loading')).toBeTruthy();
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toBe('Plugins');
    });
  });

  it('settles rather than looping when a publisher re-renders', () => {
    // `usePageHeader` writes on every render; the store bails out on equal
    // slots. A regression here is an infinite render loop, not a wrong title.
    let renders = 0;
    function Counting() {
      renders += 1;
      usePageHeader({ title: 'Stable' });
      return null;
    }
    render(
      <PageFrame spec={{ title: 'Table' }} routeIdentity="alpha">
        <Counting />
      </PageFrame>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Stable',
    );
    expect(renders).toBeLessThan(5);
  });

  it('portals actions into the header action cell', () => {
    const { container } = render(
      <PageFrame spec={{ title: 'Schedule' }} routeIdentity="alpha">
        <PageFrameActions>
          <button type="button">+ Add Job</button>
        </PageFrameActions>
      </PageFrame>,
    );

    const action = container.querySelector('.page__actions button');
    expect(action?.textContent).toBe('+ Add Job');
    // and nothing left behind in the body
    expect(container.querySelectorAll('.page-frame__body button').length).toBe(
      0,
    );

    // The action cell is a SIBLING of the header text block, which is the
    // structure `page-frame.css`'s <=768px rule stacks into a column (the
    // responsive-action-surfaces entry for this file cites exactly this).
    const header = container.querySelector('.page__header');
    expect(header?.children.length).toBe(2);
    expect(header?.children[0]?.className).toBe('page__header-text');
    expect(header?.children[1]?.className).toBe('page__actions');
  });

  it('renders actions in place when there is no frame to portal into', () => {
    const { container } = render(
      <PageFrameActions>
        <button type="button">+ Add Job</button>
      </PageFrameActions>,
    );

    expect(container.querySelector('button')?.textContent).toBe('+ Add Job');
  });

  describe('PageHeaderScope', () => {
    it('stops a nested view publishing over the host page title', () => {
      render(
        <PageFrame spec={{ title: 'System' }} routeIdentity="alpha">
          <Publisher title="Skills" />
          <PageHeaderScope>
            <Publisher title="Installed Skills" />
          </PageHeaderScope>
        </PageFrame>,
      );

      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Skills',
      );
    });

    it('still passes the action slot through to the nested view', () => {
      const { container } = render(
        <PageFrame spec={{ title: 'System' }} routeIdentity="alpha">
          <PageHeaderScope>
            <PageFrameActions>
              <button type="button">+ New Skill</button>
            </PageFrameActions>
          </PageHeaderScope>
        </PageFrame>,
      );

      expect(
        container.querySelector('.page__actions button')?.textContent,
      ).toBe('+ New Skill');
    });
  });
});
