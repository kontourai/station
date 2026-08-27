/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentAddModal } from '../views/AgentAddModal';
import { ProjectKnowledgeViewerModal } from '../views/project-page/ProjectKnowledgeViewerModal';

afterEach(cleanup);

function installKeyboardViewport() {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      height: 360,
      offsetTop: 12,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

describe('responsive surface adoption', () => {
  test('agent picker opts into visual-viewport containment and reachable actions', () => {
    installKeyboardViewport();
    render(
      <AgentAddModal
        type="skills"
        availableTools={[]}
        availableSkills={[]}
        form={{
          tools: { mcpServers: [], available: [] },
          skills: [],
        }}
        setForm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const overlay = screen.getByRole('button', { name: 'Close add items' })
      .parentElement?.parentElement?.parentElement;
    expect(overlay?.classList.contains('responsive-surface-overlay')).toBe(
      true,
    );
    expect(
      overlay?.style.getPropertyValue('--responsive-visual-viewport-height'),
    ).toBe('360px');
    expect(
      overlay?.style.getPropertyValue('--responsive-visual-viewport-top'),
    ).toBe('12px');
    expect(
      overlay?.style.getPropertyValue('--responsive-visual-viewport-bottom'),
    ).toBe(`${window.innerHeight - 372}px`);
    expect(
      overlay?.firstElementChild?.classList.contains(
        'responsive-surface-panel',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  test('long knowledge viewer uses the same contained surface contract', () => {
    installKeyboardViewport();
    render(
      <ProjectKnowledgeViewerModal
        doc={{ filename: 'CONTEXT.md', chunkCount: 42 } as never}
        content={'# Context\n\nLong content '.repeat(100)}
        loading={false}
        onClose={vi.fn()}
      />,
    );

    const overlay = screen.getByRole('button', {
      name: 'Close knowledge document',
    }).parentElement?.parentElement?.parentElement;
    expect(overlay?.classList.contains('responsive-surface-overlay')).toBe(
      true,
    );
    expect(
      overlay?.firstElementChild?.classList.contains(
        'responsive-surface-panel',
      ),
    ).toBe(true);
  });
});
