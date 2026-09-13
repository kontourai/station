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
import { Button } from '../Button';
import { MessageContent } from '../chat/message-bubble/MessageContent';
import { AgentIcon } from '../icons/AgentIcon';
import { Coachmark } from './Coachmark';
import '../chat/chat.css';
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
  const [approved, setApproved] = useState(false);
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
          Explore {UNPAIRED_SAMPLE_PROJECT} with sample data. Nothing here runs
          agents or changes your files.
        </p>
        <Button variant="primary" onClick={onConnect}>
          Connect your Station
        </Button>
      </header>

      <div className="unpaired-sample__workspace">
        <nav
          className="unpaired-sample__nav"
          aria-label="Sample workspace navigation"
        >
          <strong>Station</strong>
          <span>Sample project</span>
          <h2>Weekly research</h2>
          {FIRST_RUN_TOUR_STEPS.map((item, index) => (
            <Button
              key={item.id}
              active={index === stepIndex}
              onClick={() => {
                setStepIndex(index);
                setTourActive(true);
              }}
            >
              {
                {
                  'review-queue': 'Review',
                  activity: 'Activity',
                  schedule: 'Schedule',
                  'command-palette': 'Find anything',
                }[item.id]
              }
            </Button>
          ))}
        </nav>
        <main
          className="unpaired-sample__conversation"
          aria-label="Sample conversation"
        >
          <header>
            <AgentIcon
              agent={{ name: 'Claude Code', slug: 'claude' }}
              size={24}
            />
            <div>
              <strong>Prepare my weekly research digest</strong>
              <p>Claude Code · Sample conversation</p>
            </div>
          </header>
          <div className="unpaired-sample__messages">
            <div className="unpaired-sample__user">
              Review this week’s research notes and prepare a short digest. Let
              me review it before sharing.
            </div>
            <div className="unpaired-sample__answer">
              <MessageContent
                textContent=""
                chatFontSize={15}
                showReasoning={false}
                showToolDetails={true}
                isStreamingMessage={false}
                contentParts={[
                  {
                    type: 'text',
                    content:
                      'I checked the notes and drafted a digest with three findings.',
                  },
                  ...[
                    'notes/monday.md',
                    'notes/wednesday.md',
                    'notes/friday.md',
                    'drafts/digest.md',
                  ].map((path, index) => ({
                    type: 'tool-invocation' as const,
                    toolCallId: `sample-read-${index}`,
                    toolName: 'Read',
                    args: { file_path: path },
                    state: 'result' as const,
                    result:
                      'Sample note: participants asked for clearer setup, readable activity, and a single conversation experience.',
                  })),
                  {
                    type: 'text',
                    content:
                      '### This week’s findings\n- Make setup explain the next step.\n- Keep conversations together.\n- Show the work behind each answer.\n\nThe draft is ready for your review.',
                  },
                ]}
              />
            </div>
          </div>
          <div className="unpaired-sample__composer">
            <textarea
              aria-label="Sample message"
              placeholder="Connect a Station to start your own conversation"
              disabled
            />
            <span>Sample only — no messages are sent</span>
          </div>
        </main>
        <aside
          className="unpaired-sample__inspector"
          data-first-run-anchor={step.anchor}
          data-testid={`unpaired-sample-surface-${step.anchor}`}
        >
          <p className="unpaired-sample__eyebrow">
            {surface?.eyebrow ?? 'Sample'}
          </p>
          <h2>
            {step.anchor === 'review-queue'
              ? 'Review the draft'
              : step.anchor === 'activity'
                ? 'Conversation details'
                : step.anchor === 'schedule'
                  ? 'Weekly digest'
                  : 'Find anything'}
          </h2>
          {step.anchor === 'review-queue' && (
            <>
              <p>
                The agent has prepared the digest. You decide whether it is
                ready to share.
              </p>
              <div className="unpaired-sample__fact">
                <strong>Research digest.md</strong>
                <span>3 findings · Draft ready</span>
              </div>
              <Button
                variant="primary"
                disabled={approved}
                onClick={() => setApproved(true)}
              >
                {approved ? 'Approved in sample' : 'Approve sample draft'}
              </Button>
              <p role="status">
                {approved
                  ? 'Sample decision recorded. Nothing was shared.'
                  : 'This button changes the sample only.'}
              </p>
            </>
          )}
          {step.anchor === 'activity' && (
            <>
              <p>
                Inspect the work behind the answer. Open the tool calls in the
                conversation to see what was read.
              </p>
              <dl>
                <dt>Started in</dt>
                <dd>Claude Code</dd>
                <dt>Status</dt>
                <dd>Waiting for review</dd>
                <dt>Files read</dt>
                <dd>4 sample files</dd>
                <dt>Output</dt>
                <dd>Research digest.md</dd>
              </dl>
            </>
          )}
          {step.anchor === 'schedule' && (
            <>
              <p>
                Repeat a useful task without starting it manually each time.
              </p>
              <div className="unpaired-sample__fact">
                <strong>Every Monday · 9:00 AM</strong>
                <span>Prepare a digest from the latest research notes.</span>
              </div>
              <p>
                Each run appears in Activity. This sample schedule is not
                enabled.
              </p>
            </>
          )}
          {step.anchor === 'command-palette' && (
            <>
              <p>Jump to a conversation or workspace tool.</p>
              <div className="unpaired-sample__fact">
                <strong>Prepare my weekly research digest</strong>
                <span>Conversation</span>
              </div>
              <Button onClick={() => setStepIndex(1)}>
                Open sample Activity
              </Button>
              <Button onClick={() => setStepIndex(2)}>
                Open sample Schedule
              </Button>
            </>
          )}
        </aside>
      </div>

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
          <Button variant="primary" onClick={onConnect}>
            Connect your Station
          </Button>
        </div>
      )}
    </div>
  );
}
