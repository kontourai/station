/** @vitest-environment jsdom */
import {
  type ApprovalFullAccessRefusalDetails,
  groupLimitedCommandStep,
} from '@kontourai/station-contracts/orchestration';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { FullAccessRefusalCard } from '../FullAccessRefusalCard';

/**
 * #3557: when the person's Station group stops full access, the card says so
 * and orders the remedy: make them Admin on People, THEN (when the device
 * also lacks the grant) run the host command. Never "Or".
 */

const CLI =
  'npx @kontourai/station-cli@nightly environment access scope e6f3f571 --add approval:full-access';
const PEOPLE_STEPS = [
  'As the operator, open Settings, then Devices, then People.',
  'Find the person this device is tied to and set their group to Admin.',
];

function details(
  grant: Partial<NonNullable<ApprovalFullAccessRefusalDetails['grant']>>,
): ApprovalFullAccessRefusalDetails {
  return {
    requested: 'never',
    requester: { kind: 'device', deviceId: 'e6f3f571', deviceName: 'Phone' },
    station: { environmentId: 'env-1' },
    grant: {
      by: 'operator',
      scope: 'approval:full-access',
      uiSteps: PEOPLE_STEPS,
      ...grant,
    },
  };
}

function card(value: ApprovalFullAccessRefusalDetails) {
  render(
    <FullAccessRefusalCard
      notice={{ outcome: 'pick-not-applied', details: value }}
    />,
  );
  return screen.getByTestId('full-access-refusal');
}

afterEach(cleanup);

describe('a group-limited full-access refusal', () => {
  test('with a device grant still needed: People first, then the command, never "Or"', () => {
    // The wire shape: the command in groupLimited, and appended as a step
    // for clients that predate it.
    const text = card(
      details({
        groupLimited: { group: 'member', cli: CLI },
        uiSteps: [...PEOPLE_STEPS, groupLimitedCommandStep(CLI)],
      }),
    ).textContent as string;
    expect(text).toContain('belongs to a person in the Member group');
    expect(text).not.toMatch(/\bOr\b/);
    const people = text.indexOf(PEOPLE_STEPS[0] as string);
    const then = text.indexOf("Then, on the Station's host");
    const command = text.indexOf(CLI);
    expect(people).toBeGreaterThan(-1);
    expect(then).toBeGreaterThan(people);
    expect(command).toBeGreaterThan(then);
    // The appended step is shown as the command, not twice.
    expect(text.split(CLI)).toHaveLength(2);
  });

  test('an older client, which drops groupLimited, still reads one sequence', () => {
    // What a pre-#3557 parser keeps of the same wire shape: no
    // groupLimited, no top-level cli, the command as the last step.
    const element = card(
      details({ uiSteps: [...PEOPLE_STEPS, groupLimitedCommandStep(CLI)] }),
    );
    const text = element.textContent as string;
    expect(text).not.toMatch(/\bOr\b/);
    const steps = [...element.querySelectorAll('li')].map(
      (item) => item.textContent,
    );
    expect(steps.at(-1)).toContain(CLI);
    expect(steps.at(0)).toBe(PEOPLE_STEPS[0]);
  });

  test('with the device already granted: only the People steps', () => {
    const element = card(details({ groupLimited: { group: 'member' } }));
    expect(element.textContent).toContain(
      'belongs to a person in the Member group',
    );
    expect(element.textContent).toContain(PEOPLE_STEPS[1]);
    expect(element.textContent).not.toContain('--add approval:full-access');
    expect(element.querySelector('pre')).toBeNull();
  });

  test('without a group limit the device grant keeps its two alternatives', () => {
    const text = card(
      details({
        cli: CLI,
        uiSteps: ["Open the Station desktop app on the Station's host."],
      }),
    ).textContent as string;
    expect(text).not.toContain('Member group');
    expect(text).toContain('Or, in the Station desktop app:');
  });
});
