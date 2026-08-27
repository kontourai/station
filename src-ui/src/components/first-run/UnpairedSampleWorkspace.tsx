/**
 * Unpaired sample workspace — the #2652 first-run tour when there is no
 * Station host (Apple 4.2 / #1772).
 *
 * Lives on the access screen on purpose. `LocalUiSessionGate` must not mount
 * the protected application tree (queries, identity, polling) without a
 * session. This shell reuses the shipped tour copy and the same
 * `data-first-run-anchor` names so Coachmark points at a real sample surface
 * instead of falling back unanchored.
 *
 * The cards are labeled Sample. They do not wear a derived verdict.
 */

import { useCallback, useEffect, useState } from 'react';
import { Coachmark } from './Coachmark';
import { firstRunStore } from './first-run-store';
import { FIRST_RUN_TOUR_STEPS } from './tour-steps';
import {
  sampleSurfaceForAnchor,
  UNPAIRED_SAMPLE_PROJECT,
} from './unpaired-sample';
import './UnpairedSampleWorkspace.css';

export function UnpairedSampleWorkspace({
  onConnect,
}: {
  onConnect: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [tourActive, setTourActive] = useState(true);
  const step = FIRST_RUN_TOUR_STEPS[stepIndex];
  const surface = sampleSurfaceForAnchor(step.anchor);

  useEffect(() => {
    firstRunStore.enterChapter('tour');
    firstRunStore.recordTourStep(step.id);
  }, [step.id]);

  const endTour = useCallback(() => {
    firstRunStore.finish();
    setTourActive(false);
  }, []);

  const advance = useCallback(() => {
    if (stepIndex >= FIRST_RUN_TOUR_STEPS.length - 1) {
      endTour();
      return;
    }
    setStepIndex((current) => current + 1);
  }, [endTour, stepIndex]);

  const back = useCallback(() => {
    setStepIndex((current) => Math.max(0, current - 1));
  }, []);

  return (
    <div className="unpaired-sample" data-testid="unpaired-sample-workspace">
      <header className="unpaired-sample__banner">
        <p className="unpaired-sample__banner-copy">
          Sample workspace for {UNPAIRED_SAMPLE_PROJECT}. This is a fixture so
          the tour has something to point at — not a live Station, and not a
          gate verdict.
        </p>
        <button
          type="button"
          className="unpaired-sample__connect"
          onClick={onConnect}
        >
          Connect your Station
        </button>
      </header>

      <main className="unpaired-sample__stage">
        <article
          className="unpaired-sample__card"
          data-first-run-anchor={step.anchor}
          data-testid={`unpaired-sample-surface-${step.anchor}`}
        >
          <p className="unpaired-sample__eyebrow">
            {surface?.eyebrow ?? 'Sample'}
          </p>
          <h1 className="unpaired-sample__title">
            {surface?.title ?? step.title}
          </h1>
          <p className="unpaired-sample__body">{surface?.body ?? step.body}</p>
        </article>
      </main>

      {tourActive ? (
        <Coachmark
          key={step.id}
          anchor={step.anchor}
          title={step.title}
          body={step.body}
          stepNumber={stepIndex + 1}
          stepCount={FIRST_RUN_TOUR_STEPS.length}
          onNext={advance}
          onBack={back}
          onSkip={endTour}
          isLastStep={stepIndex === FIRST_RUN_TOUR_STEPS.length - 1}
        />
      ) : (
        <div className="unpaired-sample__done">
          <p>The tour is the same one a paired Station shows after setup.</p>
          <button
            type="button"
            className="unpaired-sample__connect"
            onClick={onConnect}
          >
            Connect your Station
          </button>
        </div>
      )}
    </div>
  );
}
