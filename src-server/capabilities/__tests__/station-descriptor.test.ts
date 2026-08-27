/**
 * Honest in-process host-command catalog evidence. Station deliberately does
 * not publish a router descriptor until it ships the executable such a
 * descriptor must advertise.
 */

import { describe, expect, test } from 'vitest';
import {
  STATION_HOST_COMMAND_CATALOG,
  STATION_HOST_COMMAND_PRODUCT,
} from '../station-descriptor.js';

describe('STATION_HOST_COMMAND_CATALOG', () => {
  test('is an in-process catalog, not a routable executable descriptor', () => {
    for (const command of STATION_HOST_COMMAND_CATALOG) {
      expect(command).not.toHaveProperty('executableId');
      expect(command).not.toHaveProperty('packageBin');
      expect(command).not.toHaveProperty('argv');
    }
  });

  test('covers exactly the five board/task authorities', () => {
    expect(STATION_HOST_COMMAND_PRODUCT).toBe('station');
    expect(STATION_HOST_COMMAND_CATALOG.map((command) => command.path)).toEqual(
      [
        ['task', 'status'],
        ['task', 'dispatch'],
        ['task', 'block'],
        ['task', 'unblock'],
        ['session', 'resume'],
      ],
    );
  });

  test('keeps the exact side-effect and confirmation policy for every authority', () => {
    expect(
      STATION_HOST_COMMAND_CATALOG.map((command) => ({
        path: command.path.join(' '),
        sideEffect: command.sideEffect,
        confirmation: command.confirmation,
      })),
    ).toEqual([
      {
        path: 'task status',
        sideEffect: 'read-local',
        confirmation: 'never',
      },
      {
        path: 'task dispatch',
        sideEffect: 'write-local',
        confirmation: 'user-request',
      },
      {
        path: 'task block',
        sideEffect: 'write-local',
        confirmation: 'user-request',
      },
      {
        path: 'task unblock',
        sideEffect: 'write-local',
        confirmation: 'user-request',
      },
      {
        path: 'session resume',
        sideEffect: 'write-external',
        confirmation: 'user-request',
      },
    ]);
  });
});
