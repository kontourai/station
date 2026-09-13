import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';
import type { DataChannel } from 'node-datachannel';

/** Native backend facade for the owned protocol fixture; no content logging. */
export function nodeApplicationChannel(
  channel: DataChannel,
): ApplicationChannel {
  return {
    send(message) {
      const bytes = Buffer.byteLength(message);
      if (
        !channel.isOpen() ||
        bytes > channel.maxMessageSize() ||
        channel.bufferedAmount() + bytes > 96 * 1024
      )
        throw new Error('Application channel send capacity exhausted');
      if (!channel.sendMessage(message))
        throw new Error('Application channel send failed');
    },
    close: () => channel.close(),
    subscribe(message, closed) {
      let active = true;
      channel.onMessage((value) => {
        if (active) message(value);
      });
      channel.onClosed(() => {
        if (active) closed();
      });
      channel.onError(() => {
        if (active) closed();
      });
      return () => {
        active = false;
      };
    },
  };
}
