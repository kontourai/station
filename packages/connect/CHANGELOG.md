# @kontourai/station-connect

## Private bundled changes

These changes are included in Station source and bundles. Connect remains private; this records no public version or publication.

- Add an opt-in native WebRTC diagnostic echo client adapter for trusted relay signaling. (Retained from `native-echo-client.md`.)

- Let a host-owned signaling adapter reuse the encrypted Pion application channel while requiring an explicit positive trust decision before signaling. (Retained from `native-pion-signaling.md`.)

- Allow a host-owned signaling adapter to pin one validated client ID and nonce before Pion offer and Station-proof construction. Browser connections retain their existing generated identity when no provider is supplied. (Retained from `pinned-native-pion-identity.md`.)

- Add an optional self-hosted browser broker transport with independently approved Station signing trust, bounded signaling, fresh-peer reconnect and encrypted Fetch channels. Device, account and Project authority remain separate from the transport. (Retained from `self-hosted-browser-transport.md`.)

- Accept native relay setup links with longer configurable expiry or no time expiry. The invitation wire shape is unchanged. Existing receiver builds with a five-minute validation ceiling need five-minute invitations until updated. (Retained from `native-relay-invitation-expiry.md`.)
