import {
  localProjectResourceId,
  type ProjectPrimaryResourceSelection,
  type ProjectResolutionView,
  type ResourceResolutionResult,
} from '@kontourai/station-contracts/project-identity';
import {
  useBindProjectResourceMutation,
  useProjectResolutionQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { PageSection } from '../../components/PageSection';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { errorText } from '../../utils/errorText';

/**
 * station#1502 slice 4 — the resolution states, rendered
 * (`docs/design/portable-project-identity.md` §3.6, §4.1).
 *
 * Mounted from `ProjectSettingsView` only. `ProjectPage.tsx` is deliberately
 * left byte-unchanged: `tests/first-run-live.spec.ts` (the §4.6 local-only
 * invariant pin) drives the first-run journey onto that view, and this slice
 * ships without e2e evidence — so the "the first-run journey is untouched"
 * claim is provable by inspection instead of by a run we did not perform.
 * Settings is also where the working-directory editor and the other repair
 * affordances already live.
 */

/**
 * The THREE path slots, kept apart because they are three different claims —
 * and this table exists so that is testable rather than merely intended.
 *
 * - `answer` — `bound.path`. "This is the verified checkout." Only `bound`
 *   performed the live check, so only `bound` may answer.
 * - `observation` — `stale`/`drifted`'s `unverifiedPath`. "A directory exists
 *   here; Station has NOT verified it is the right one." Its name is the
 *   warning, and reusing the answer's label for it would launder an
 *   observation into an answer at the last layer, after the contract spent
 *   two slices keeping them apart.
 * - `declared` — `missing.declaredPath`. "The string the record STATES, which
 *   an operator edits to repair it." The path does not exist; it is neither an
 *   answer nor an observation of a directory.
 *
 * All three MUST stay distinct strings. See the slot-discipline test.
 */
export const RESOURCE_SLOT_LABELS = {
  answer: 'Resolved path',
  observation: 'Directory found — identity not verified',
  declared: 'Declared path — not found',
} as const;

export type ResourceSlotKind = keyof typeof RESOURCE_SLOT_LABELS;

/**
 * `missing` names WHICH record declared the path that is gone, because
 * "re-point or re-clone" is unactionable without it — the two are edited in
 * different places.
 */
const RECORD_COPY: Record<'binding' | 'working-directory', string> = {
  binding: 'the recorded binding',
  'working-directory': "the project's working directory",
};

function PathSlot({ slot, value }: { slot: ResourceSlotKind; value: string }) {
  return (
    <div className={`resources-section__slot resources-section__slot--${slot}`}>
      <span className="resources-section__slot-label">
        {RESOURCE_SLOT_LABELS[slot]}
      </span>
      <code className="resources-section__slot-value">{value}</code>
    </div>
  );
}

/**
 * The repair form. It takes a path the OPERATOR supplies and never derives
 * one; §3.6's `missing` row is "never silently re-bind", and the server
 * enforces that by verifying before it records. A refusal is shown VERBATIM
 * and is never retried or replaced with a friendlier message — the reason is
 * the whole value of an honest unavailable.
 */
function PointAtCheckoutForm({
  slug,
  resourceId,
  initialPath,
  submitLabel,
}: {
  slug: string;
  /**
   * WHICH resource this form repairs (station#1503 slice 5). A multi-repo
   * project renders one of these per row, and a form that omitted it would
   * write the PRIMARY's binding whatever row it was captioned with — the
   * "the copy would name the working directory while the button wrote a
   * different record" defect, one resource over.
   */
  resourceId: string;
  initialPath: string;
  submitLabel: string;
}) {
  const [path, setPath] = useState(initialPath);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The write succeeded and the follow-up re-read did not. NOT a refusal:
  // the binding IS recorded, and titling this "that checkout was not
  // recorded" would be a false negative about durable state (the route's
  // phase boundary exists for the same reason).
  const [gap, setGap] = useState<string | null>(null);
  const bind = useBindProjectResourceMutation(slug, {
    onSuccess: (outcome) => {
      setRefusal(null);
      setGap('gap' in outcome ? outcome.gap : null);
    },
    onError: (error: Error) => {
      setGap(null);
      setRefusal(errorText(error));
    },
  });
  // Unique per resource: a multi-repo project renders several of these at once,
  // and a duplicated id would point every `<label>` at the first input.
  const inputId = `project-resource-bind-${slug}-${resourceId}`;

  /*
   * DELIBERATE GAP — there is no "Clone it" action below, and none is named.
   * §10 promises slice 4 "the single-repo bind/clone convenience"; this ships
   * the bind half only, as an accepted gap with the reason recorded here
   * (station#1502 review round 2).
   *
   * CORRECTION to the reason this comment first gave. It claimed the canonical
   * remote "is NOT in the answer". It is: `ProjectGitRepoResource.id` is
   * documented and validator-enforced as ALWAYS EQUAL to `canonicalRemote`, so
   * an `unbound` git resource's `resourceId` already IS the remote. Reaching
   * for `manifest.repos` is not required and the selection-ambiguity trap is
   * not what blocks this. Leaving a wrong reason in place would send the next
   * reader down the wrong path with a correct conclusion attached to it.
   *
   * THE ACTUAL REASON — a canonical remote is not a clone URL, and the
   * difference is a false claim waiting to happen. `normalizeGitOrigin` strips
   * the scheme, the credentials, and the SSH form, so `github.com/acme/api`
   * has to be turned back into a URL by GUESSING one (`https://…` by
   * convention). When that guessed URL is refused for a private repo the
   * member reaches over SSH, Station would be holding an authorization failure
   * against a URL IT chose — and §3.6's `unresolvable` says "Nothing local;
   * the gap is upstream (permissions)", which would be false: the local
   * repairs (use the SSH remote, point at an existing checkout) both exist.
   * Manufacturing `unresolvable` out of a guess is the exact dishonesty §3.6
   * rule 2 ("asserted, never inferred") exists to prevent, and it would arrive
   * through the one state #1425 says it cares most about.
   *
   * So this offers the half it can perform truthfully and says nothing about
   * the half it cannot. A clone action needs a resource-level clone SOURCE
   * (an un-canonicalized URL the manifest author actually wrote, or a
   * per-member preferred protocol) — a contract addition, not a UI one.
   * Filed for slice 5, where a resource's remote becomes legible here anyway.
   */
  return (
    <form
      className="resources-section__repair"
      onSubmit={(event) => {
        event.preventDefault();
        if (!path.trim()) return;
        setRefusal(null);
        setGap(null);
        bind.mutate({ path: path.trim(), resourceId });
      }}
    >
      <label className="editor-label" htmlFor={inputId}>
        Point at an existing checkout
      </label>
      <div className="resources-section__repair-row">
        <input
          id={inputId}
          className="editor-input resources-section__repair-input"
          type="text"
          value={path}
          placeholder="/path/to/checkout"
          onChange={(event) => setPath(event.target.value)}
        />
        <button
          type="submit"
          className="editor-btn editor-btn--primary"
          disabled={bind.isPending || !path.trim()}
        >
          {bind.isPending ? 'Checking…' : submitLabel}
        </button>
      </div>
      <span className="editor-hint">
        Station checks the directory before it records anything. It is never
        re-pointed for you.
      </span>
      {refusal && (
        <ErrorState
          variant="compact"
          title="That checkout was not recorded"
          description={refusal}
        />
      )}
      {gap && (
        <p className="resources-section__gap" role="status">
          {gap}
        </p>
      )}
    </form>
  );
}

/**
 * The `missing` repair for a `working-directory` record. It is NOT a bind
 * form: `bindProjectResource` writes a BINDING row keyed by the manifest's
 * resource, and a project with no manifest — every project created before
 * slice 2, plus any whose resources could not be derived — is refused
 * `no-resources-declared` 409 EVERY time. Offering the form there is a
 * guaranteed dead end, and worse, the copy would name the working directory
 * while the button wrote a different record.
 *
 * The record that declared this path IS the project's working directory, so
 * the repair is that field, which is already on this page.
 */
function EditWorkingDirectoryPrompt() {
  return (
    <div className="resources-section__repair">
      <span className="editor-hint">
        That path comes from this project's working directory, so it is edited
        in the Workspace section on this page. Station re-points nothing for
        you.
      </span>
      <a className="editor-btn" href="#section-workspace">
        Go to Workspace
      </a>
    </div>
  );
}

interface ResourceRowProps {
  slug: string;
  resource: ResourceResolutionResult;
  onReverify: () => void;
  /** True while the resolution query is refetching — see the `stale` arm. */
  reverifying: boolean;
}

/**
 * ONE resource row (slice 4 is single-repo), rendered by state.
 *
 * The `switch` is exhaustive with NO `default:` — a `default` is how a
 * renderer invents a state. `unresolvable` and `not-portable` have no producer
 * anywhere in Station today (§3.6 scopes `unresolvable` to an attempt that was
 * DENIED, and this slice performs no authenticated operation that can be
 * denied), so their arms are reachable only from a server that asserted them.
 * Nothing here constructs, defaults to, or falls back to either.
 */
function ResourceRow({
  slug,
  resource,
  onReverify,
  reverifying,
}: ResourceRowProps) {
  switch (resource.state) {
    case 'bound':
      return (
        <div className="resources-section__row resources-section__row--ready">
          <div className="resources-section__headline">Resolved</div>
          <p className="resources-section__body">
            {/*
              The COMPAT id is deliberately not shown. On a manifest-less
              project the resolver reports the working directory under
              `localProjectResourceId(slug)` — `local:acme` — and flags it as a
              DISCLOSED GAP: "an id observed in that window is not the id the
              manifest will settle on" (`project-resource-resolver.ts`). It
              becomes the canonical remote the moment the project's resources
              are declared, so printing it names a transient internal string
              as the thing that resolves. The sentence says what it IS instead.
            */}
            {resource.resourceId === localProjectResourceId(slug) ? (
              "This project's working directory resolves here, checked just now."
            ) : (
              <>
                <code>{resource.resourceId}</code> resolves here, checked just
                now.
              </>
            )}
          </p>
          <PathSlot slot="answer" value={resource.path} />
        </div>
      );

    // `unbound` and `missing` are ADJACENT ARMS ON PURPOSE, so the difference
    // between them is visible in one screen. station#1594/#1603 split them
    // because "nothing was ever declared" and "the declared directory is gone"
    // owe opposite behaviour (#1023's `$HOME` terminus vs #791's fail-closed
    // throw). Rendering them alike would reintroduce that defect one layer up,
    // so: different headline, different body, and different things NAMED.
    case 'unbound':
      return (
        <div className="resources-section__row resources-section__row--repairable">
          <div className="resources-section__headline">
            Not set up on this Station
          </div>
          <p className="resources-section__body">
            Nothing here records a location for{' '}
            <code>{resource.resourceId}</code>. {resource.reason}
          </p>
          {/* Nothing is named, because nothing is recorded: `unbound` carries
              no record and no path of any kind. */}
          <PointAtCheckoutForm
            slug={slug}
            resourceId={resource.resourceId}
            initialPath=""
            submitLabel="Point at checkout"
          />
        </div>
      );

    case 'missing':
      return (
        <div className="resources-section__row resources-section__row--repairable">
          <div className="resources-section__headline">
            The recorded location is gone
          </div>
          <p className="resources-section__body">
            {RECORD_COPY[resource.record]} declares a directory for{' '}
            <code>{resource.resourceId}</code> that is not there any more.{' '}
            {resource.reason}
          </p>
          <PathSlot slot="declared" value={resource.declaredPath} />
          {/*
            BRANCHED ON THE RECORD, because the repair writes a different
            thing in each case and the bind form can only write one of them.
            A `working-directory` record has no binding to re-point — see
            `EditWorkingDirectoryPrompt`. A `binding` record does, and it is
            pre-filled with what the record declares, because that is the
            string an operator edits. Submitting is still an explicit act —
            Station re-points nothing on its own.
          */}
          {resource.record === 'working-directory' ? (
            <EditWorkingDirectoryPrompt />
          ) : (
            <PointAtCheckoutForm
              slug={slug}
              resourceId={resource.resourceId}
              initialPath={resource.declaredPath}
              submitLabel="Re-point"
            />
          )}
        </div>
      );

    case 'drifted':
      return (
        <div className="resources-section__row resources-section__row--repairable">
          <div className="resources-section__headline">
            A different repository is at that path
          </div>
          <p className="resources-section__body">{resource.reason}</p>
          <PathSlot slot="observation" value={resource.unverifiedPath} />
          {/*
            §3.6's repair reads "confirm the new identity or re-point", and
            only the second half is offered. Confirming a new identity would
            rewrite the resource's `canonicalRemote` in the manifest, and no
            such verb exists on any surface — so the operator is not told to
            confirm anything. Re-point is real; the other half is not, yet.
          */}
          <PointAtCheckoutForm
            slug={slug}
            resourceId={resource.resourceId}
            initialPath=""
            submitLabel="Re-point"
          />
        </div>
      );

    case 'stale':
      return (
        <div className="resources-section__row resources-section__row--repairable">
          <div className="resources-section__headline">
            Could not be verified just now
          </div>
          <p className="resources-section__body">
            {/*
              NOT "the check did not run". The resolver emits `stale` when
              `readCheckoutRemotes` answers `ok: false` — which is usually the
              check running and FAILING (a wedged mount, a git that refused,
              a timeout). Saying it never ran misdescribes the common case and
              points the operator at the wrong thing to look at.
            */}
            The directory is there. Station could not confirm which repository
            is in it. {resource.reason}
          </p>
          <PathSlot slot="observation" value={resource.unverifiedPath} />
          {/*
            Re-verify needs the same pending affordance the bind form has: if
            the result is still `stale` the DOM is byte-identical, and without
            it the operator cannot tell whether anything ran at all.
          */}
          <button
            type="button"
            className="editor-btn resources-section__reverify"
            onClick={onReverify}
            disabled={reverifying}
          >
            {reverifying ? 'Checking…' : 'Re-verify'}
          </button>
        </div>
      );

    case 'ambiguous':
      // The one state that NAMES NO RESOURCE — its `resourceId` is required
      // empty by contract, and rendering an empty id would show a name for
      // something the state says does not exist. The candidates are in the
      // reason, which also carries the repair.
      //
      // Since station#1503 this arm has no producer in Station: the view
      // resolves per declared resource id, and the resolver's `ambiguous` is a
      // whole-manifest answer that now lands on `view.primary` instead. It is
      // KEPT rather than deleted because the arm must exist for a server that
      // asserts the state — the same reason `unresolvable` and `not-portable`
      // are kept — and removing it would put a `default:` back in this switch.
      return (
        <div className="resources-section__row resources-section__row--repairable">
          <div className="resources-section__headline">
            Several resources, and none is the primary
          </div>
          <p className="resources-section__body">{resource.reason}</p>
        </div>
      );

    case 'unresolvable':
      // §3.6 rule 3: the resource is NAMED, and no path, branch, or content is
      // disclosed. The gap is upstream (permissions), so there is no local
      // repair and none is offered.
      return (
        <div className="resources-section__row resources-section__row--not-for-you">
          <div className="resources-section__headline">Access was denied</div>
          <p className="resources-section__body">
            <code>{resource.resourceId}</code> — {resource.reason}
          </p>
        </div>
      );

    case 'not-portable':
      return (
        <div className="resources-section__row resources-section__row--not-for-you">
          <div className="resources-section__headline">
            Never shareable to begin with
          </div>
          <p className="resources-section__body">
            <code>{resource.resourceId}</code> — {resource.reason}
          </p>
        </div>
      );
  }
}

function ResolutionBody({
  slug,
  view,
  onReverify,
  reverifying,
}: {
  slug: string;
  view: ProjectResolutionView;
  onReverify: () => void;
  reverifying: boolean;
}) {
  switch (view.posture) {
    case 'not-backing':
      // §4.1, and this arm renders NOTHING ELSE. A member whose Stations back
      // nothing must never see a repair prompt, an "unresolvable for you"
      // badge, a per-resource state table, a clone call-to-action, or any UI
      // that reads as an incomplete setup. So: one unremarkable statement of
      // fact about this Station, `Empty` with no `action`, and no row.
      return (
        <Empty
          variant="compact"
          label="This Station isn't backing this project"
          description="Nothing here names code for it, and it has no working directory on this Station. That is a complete, ordinary state — there is nothing to set up."
        />
      );

    case 'unreadable':
      // NEVER rendered as `not-backing`: that would describe a repairable
      // local fault as a settled state, and the `not-backing` rendering above
      // is guaranteed to carry no repair prompt. That is the WHOLE reason this
      // posture was split out — so it must actually carry the affordance the
      // split exists to preserve. A re-read is the one action that applies: a
      // half-written sidecar or a transient read failure resolves on retry,
      // and everything else needs the reason, which is right here.
      return (
        <ErrorState
          title="This project's resource record could not be read"
          description={view.reason}
          action={
            <button
              type="button"
              className="editor-btn"
              onClick={onReverify}
              disabled={reverifying}
            >
              {reverifying ? 'Checking…' : 'Retry'}
            </button>
          }
        />
      );

    case 'backing':
      return (
        <>
          <ResourceTally resources={view.resources} />
          <PrimarySelection primary={view.primary} />
          {view.resources.map((resource) => (
            <ResourceRow
              // Remount on a state transition. The arms reconcile POSITIONALLY,
              // so `missing` → `drifted` kept the mounted repair form — and with
              // it the `useState(initialPath)` seeded from the OLD state's
              // declaredPath, plus any stale refusal text, presented as though it
              // belonged to the new one. Keyed by resource FIRST (station#1503):
              // with several rows, a state-only key collides the moment two
              // resources share a state, and React reuses one row's form for
              // another resource.
              key={`${resource.resourceId}:${resource.state}`}
              slug={slug}
              resource={resource}
              onReverify={onReverify}
              reverifying={reverifying}
            />
          ))}
        </>
      );
  }
}

/**
 * "2 of 3 resolve here" — station#1503 slice 5's whole point, and a DERIVATION:
 * both numbers are counted from the results on screen, so the sentence cannot
 * disagree with the rows under it.
 *
 * Rendered only for a multi-resource project. With one resource the row already
 * says everything this would, and a "1 of 1" line above it is noise that trains
 * a reader to skip the place the real count will one day appear.
 */
function ResourceTally({
  resources,
}: {
  resources: ResourceResolutionResult[];
}) {
  if (resources.length < 2) return null;
  const resolved = resources.filter(
    (resource) => resource.state === 'bound',
  ).length;
  return (
    <p className="resources-section__tally">
      <strong>
        {resolved} of {resources.length}
      </strong>{' '}
      {/* Always plural: this renders only for two or more. */}
      resources resolve on this Station.{' '}
      {resolved === resources.length
        ? 'Every repository this project names is set up here.'
        : 'The rest are named below with what each one needs.'}
    </p>
  );
}

/**
 * The fact per-resource resolution would otherwise SILENCE (station#1503).
 *
 * Every row can read healthy while the project cannot be started in at all:
 * `resolveStartSessionCwd`, the knowledge scan, and the task workspace all ask
 * WITHOUT a resource id, and that question is answered by the primary — which a
 * manifest declaring two primaries, or several resources and none, cannot name.
 * Rendering the rows and not this would be a surface reporting clean over the
 * scope it can see.
 *
 * A NAMED primary renders nothing: it is the ordinary case, and a badge saying
 * "this one is the primary" on every single-repo project is vocabulary the §4.6
 * local-only invariant keeps off the screen.
 */
function PrimarySelection({
  primary,
}: {
  primary: ProjectPrimaryResourceSelection;
}) {
  if (primary.named) return null;
  return (
    <div className="resources-section__row resources-section__row--repairable">
      <div className="resources-section__headline">
        No single resource is this project's primary
      </div>
      <p className="resources-section__body">
        {primary.reason} Until then, anything that asks this project where to
        work — a chat, a knowledge scan, a task — has no resource to be pointed
        at.
      </p>
    </div>
  );
}

export function ResourcesSection({ slug }: { slug: string }) {
  const { data, isLoading, isError, error, isFetching, refetch } =
    useProjectResolutionQuery(slug);

  return (
    <PageSection
      id="section-resources"
      className="project-settings__section resources-section"
      eyebrow="Project code"
      title="Resources"
      description="Where this Station finds the code this project points at, and what it can do about it when that changes."
    >
      {isLoading ? (
        <SkeletonList count={2} />
      ) : isError ? (
        <ErrorState
          title="Could not read this project's resources"
          description={errorText(error)}
          action={
            <button
              type="button"
              className="editor-btn"
              onClick={() => refetch()}
            >
              Retry
            </button>
          }
        />
      ) : data ? (
        <ResolutionBody
          slug={slug}
          view={data}
          onReverify={() => refetch()}
          reverifying={Boolean(isFetching)}
        />
      ) : (
        <SkeletonList count={2} />
      )}
    </PageSection>
  );
}
