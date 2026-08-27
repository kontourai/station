/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { DeveloperTab } from '../types';

const tabBodies: ReadonlyArray<[DeveloperTab, string]> = [
  ['logs', 'Logs body'],
  ['system', 'System body'],
  ['telemetry', 'Telemetry body'],
  ['memory', 'Memory body'],
  ['archive', 'Archive body'],
];

vi.mock('../views/developer/LogsTab', () => ({
  default: () => <div>Logs body</div>,
}));
vi.mock('../views/developer/SystemTab', () => ({
  default: () => <div>System body</div>,
}));
vi.mock('../views/developer/TelemetryTab', () => ({
  default: () => <div>Telemetry body</div>,
}));
vi.mock('../views/developer/MemoryTab', () => ({
  default: () => <div>Memory body</div>,
}));
vi.mock('../views/developer/ArchiveTab', () => ({
  default: () => <div>Archive body</div>,
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { DeveloperView } from '../views/DeveloperView';

describe('DeveloperView tab bodies', () => {
  test.each(tabBodies)(
    'renders the distinguishing %s body',
    async (tab, label) => {
      render(<DeveloperView apiBase="http://test" tab={tab} />);
      await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
    },
  );
});
