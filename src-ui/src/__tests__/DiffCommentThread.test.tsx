/**
 * @vitest-environment jsdom
 */

import type { DiffComment } from '@kontourai/station-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DiffCommentThread } from '../components/coding-layout/DiffCommentThread';

function comment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'c1',
    projectId: 'demo',
    filePath: 'foo.ts',
    side: 'additions',
    lineNumber: 2,
    body: 'Looks off here',
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

const noop = () => {};

describe('DiffCommentThread', () => {
  test('renders existing comments and a reply affordance when not composing', () => {
    render(
      <DiffCommentThread
        comments={[comment(), comment({ id: 'c2', body: 'second note' })]}
        composing={false}
        onSubmit={noop}
        onCancel={noop}
        onStartReply={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText('Looks off here')).toBeTruthy();
    expect(screen.getByText('second note')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy();
    // No composer until the user replies.
    expect(screen.queryByLabelText('Comment')).toBeNull();
  });

  test('delete invokes onDelete with the comment id', () => {
    const onDelete = vi.fn();
    render(
      <DiffCommentThread
        comments={[comment({ id: 'abc' })]}
        composing={false}
        onSubmit={noop}
        onCancel={noop}
        onStartReply={noop}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }));
    expect(onDelete).toHaveBeenCalledWith('abc');
  });

  test('composer submits the trimmed body and disables when empty', () => {
    const onSubmit = vi.fn();
    render(
      <DiffCommentThread
        comments={[]}
        composing={true}
        onSubmit={onSubmit}
        onCancel={noop}
        onStartReply={noop}
        onDelete={noop}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Comment' });
    // Empty draft → submit disabled.
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Comment'), {
      target: { value: '  needs a guard  ' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('needs a guard');
  });

  test('cancel invokes onCancel', () => {
    const onCancel = vi.fn();
    render(
      <DiffCommentThread
        comments={[]}
        composing={true}
        onSubmit={noop}
        onCancel={onCancel}
        onStartReply={noop}
        onDelete={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
