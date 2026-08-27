/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  ChatAuthRecoveryProvider,
  useChatAuthRecovery,
} from '../components/chat-dock/ChatAuthRecoveryContext';

function FullscreenChatAuthProbe() {
  const requestAuth = useChatAuthRecovery();
  return (
    <button type="button" onClick={() => void requestAuth?.()}>
      Recover authentication
    </button>
  );
}

describe('ChatAuthRecoveryContext', () => {
  test('makes the app auth recovery available to the fullscreen placement', () => {
    const recoverAuth = vi.fn();
    render(
      <ChatAuthRecoveryProvider onRequestAuth={recoverAuth}>
        <FullscreenChatAuthProbe />
      </ChatAuthRecoveryProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Recover authentication' }),
    );

    expect(recoverAuth).toHaveBeenCalledOnce();
  });
});
