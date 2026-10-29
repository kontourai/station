import {
  APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE,
  groupLimitedCommandStep,
} from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import { explainFullAccessRefusal } from '../commands/errors.js';

/**
 * #3557: a group-limited full-access refusal, as every CLI command prints it:
 * the Member group is named, People comes first, and the device command (when
 * still needed) follows it as a second step, never as "Or".
 */

const CLI =
  'npx @kontourai/station-cli@nightly environment access scope e6f3f571 --add approval:full-access';
const PEOPLE_STEPS = [
  'As the operator, open Settings, then Devices, then People.',
  'Find the person this device is tied to and set their group to Admin.',
];

function refusal(grant: Record<string, unknown>) {
  return Object.assign(new Error('refused'), {
    code: APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE,
    details: {
      requested: 'never',
      requester: { kind: 'device', deviceId: 'e6f3f571', deviceName: 'Phone' },
      station: { environmentId: 'env-1' },
      grant: {
        by: 'operator',
        scope: 'approval:full-access',
        uiSteps: PEOPLE_STEPS,
        ...grant,
      },
    },
  });
}

describe('explainFullAccessRefusal for a Member', () => {
  test('with a device grant still needed: People, then the command', () => {
    const printed = explainFullAccessRefusal(
      refusal({
        groupLimited: { group: 'member', cli: CLI },
        uiSteps: [...PEOPLE_STEPS, groupLimitedCommandStep(CLI)],
      }),
      undefined,
    ) as string;
    // The appended step is printed as the command, not twice.
    expect(printed.split(CLI)).toHaveLength(2);
    expect(printed).not.toContain('3. ');
    expect(printed).toContain(
      'Device "Phone" (e6f3f571) belongs to a person in the Member group',
    );
    expect(printed).not.toMatch(/\bOr\b/);
    expect(printed.indexOf(PEOPLE_STEPS[0] as string)).toBeLessThan(
      printed.indexOf("Then, on the Station's host, run:"),
    );
    expect(printed.indexOf("Then, on the Station's host, run:")).toBeLessThan(
      printed.indexOf(CLI),
    );
  });

  test('with the device already granted: People only', () => {
    const printed = explainFullAccessRefusal(
      refusal({ groupLimited: { group: 'member' } }),
      undefined,
    ) as string;
    expect(printed).toContain('Member group');
    expect(printed).toContain(`2. ${PEOPLE_STEPS[1]}`);
    expect(printed).not.toContain('--add approval:full-access');
    expect(printed).not.toContain('Then,');
  });

  test('an older reading of the same refusal (no groupLimited) is one sequence', () => {
    const printed = explainFullAccessRefusal(
      refusal({ uiSteps: [...PEOPLE_STEPS, groupLimitedCommandStep(CLI)] }),
      undefined,
    ) as string;
    expect(printed).not.toMatch(/\bOr\b/);
    expect(printed).toContain(`3. Then, on the Station's host, run: ${CLI}`);
  });

  test('without a group limit the two device paths stay alternatives', () => {
    const printed = explainFullAccessRefusal(
      refusal({ cli: CLI }),
      undefined,
    ) as string;
    expect(printed).not.toContain('Member group');
    expect(printed).toContain('Or, in the Station desktop app:');
  });
});
