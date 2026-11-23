import type { SchedulerSchedule } from '@kontourai/station-contracts/scheduler';
import {
  AgentGlyph,
  CalendarGlyph,
  MessageGlyph,
} from '../../components/icons/Glyph';
import { PageSection } from '../../components/PageSection';
import { browserTimeZone } from '../../components/scheduler/scheduleValue';
import { scheduleSentence } from './automationRow';
import { getScheduleStarterTemplates } from './utils';
import './automations-list.css';

/** Two things a person could ask any chat; an agent proposes the automation. */
const CHAT_EXAMPLES = [
  'Every morning, tell me which tests failed overnight',
  'Remind me Friday to review open pull requests',
];

/**
 * Automations with none yet: what an automation is (when, who does what,
 * where results go), the four templates, and that any chat can propose one.
 */
export function ScheduleEmptyState({
  onSelectTemplate,
}: {
  onSelectTemplate: (template: {
    name: string;
    schedule: SchedulerSchedule;
    prompt: string;
  }) => void;
}) {
  const readerZone = browserTimeZone();
  return (
    <div className="automations-empty">
      <section
        className="automations-empty__intro"
        aria-labelledby="automations-intro-title"
      >
        <div className="automations-empty__intro-text">
          <h2 id="automations-intro-title">An agent, a task, a time</h2>
          <p>
            Pick what to do and when. Each run lands in a chat you can open,
            with the same approvals as your other chats.
          </p>
        </div>
        <ul className="automations-empty__parts" aria-label="For example">
          <li>
            <CalendarGlyph /> Every weekday at 8:00 AM
          </li>
          <li>
            <AgentGlyph /> An agent sums up new pull requests
          </li>
          <li>
            <MessageGlyph /> Results in its own chat
          </li>
        </ul>
      </section>
      <PageSection title="Start from one of these">
        <ul className="automations-empty__templates">
          {getScheduleStarterTemplates().map((template) => (
            <li key={template.name}>
              <button
                type="button"
                className="automations-empty__template"
                onClick={() =>
                  onSelectTemplate({
                    // The form takes the name people read and keeps the
                    // slug it derives hidden.
                    name: template.label,
                    schedule: template.schedule,
                    prompt: template.prompt,
                  })
                }
              >
                <span className="automations-empty__template-name">
                  {template.label}
                </span>
                <span className="automations-empty__template-text">
                  {template.description}
                </span>
                <span className="automations-empty__template-when">
                  <CalendarGlyph />{' '}
                  {scheduleSentence(template.schedule, readerZone)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PageSection>
      <PageSection title="Or ask in any chat">
        <ul className="automations-empty__asks">
          {CHAT_EXAMPLES.map((example) => (
            <li key={example}>
              <MessageGlyph /> “{example}”
            </li>
          ))}
        </ul>
      </PageSection>
    </div>
  );
}
