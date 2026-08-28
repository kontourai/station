/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { WorkspacePaneBindingUnavailable } from '../WorkspacePaneBindingUnavailable';

// archive#3969: the copy is written for the reader now — the two facts each
// state has to carry are unchanged (WHICH of their things is missing, and
// that Station will not guess between candidates).
test.each([
  [
    { state: 'project-unresolvable' as const, reason: 'missing' as const },
    'That Project is gone',
    'The Project this pane was saved in no longer exists on this Station.',
  ],
  [
    { state: 'project-unresolvable' as const, reason: 'ambiguous' as const },
    'More than one Project matches',
    'This pane remembers a Project name that now fits more than one, so Station won’t guess which you meant.',
  ],
  [
    { state: 'layout-unresolvable' as const, reason: 'missing' as const },
    'That layout is gone',
    'The layout this pane was saved in no longer exists in its Project.',
  ],
  [
    { state: 'layout-unresolvable' as const, reason: 'ambiguous' as const },
    'More than one layout matches',
    'This pane remembers a layout name that now fits more than one, so Station won’t guess which you meant.',
  ],
])(
  'renders copy matching the resolver state',
  (identity, label, description) => {
    render(<WorkspacePaneBindingUnavailable identity={identity} />);

    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
  },
);
