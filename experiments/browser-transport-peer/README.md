# Pion browser transport peer

This is a test-only peer for the [local browser transport lab](../../docs/guides/local-collaboration-lab.md#browser-transport-evaluation).
It echoes bounded fixture messages over Pion WebRTC. It does not expose a Station
API, identify a person, authorize Project access or implement a connection broker.

The standalone Go module pins Pion WebRTC v4.2.20 and its transitive module
checksums. Go 1.26.5 or newer is required by this fixture's module directive.
With Go installed, build once from this directory:

```bash
go mod download
go mod verify
go vet ./...
go build -mod=readonly -trimpath -o ../../.kontourai/browser-transport/pion-peer .
```

On Windows, use `pion-peer.exe` as the output filename. Rebuild after changes to
this module. From the repository root, run:

```bash
npm run lab:browser-transport -- --peer=pion --browser-turn=tcp
npm run lab:browser-transport -- --peer=pion --browser-turn=udp
```

The Node fixture controller writes a private, bounded configuration containing
the browser offer, ephemeral certificate paths and credentials for the owned
local TURN server. It starts the exact local binary through Station's owned
process helper. There is no HTTP configuration endpoint or production identity
header. Pion verifies the browser certificate against its SDP; the browser's
approved Station fingerprint is supplied independently by the fixture.

Pion requires relay candidates and uses TURN/TCP in this profile. The browser
can use TCP or UDP TURN control, as explicitly selected. Application data stays
inside DTLS in either case. The local TURN control connection itself is not
TLS; qualification of production TURN/TLS and real network conditions remains
separate. The profile never disables DTLS certificate verification.

The peer publishes its actual linked Pion and Go versions. The controller binds
the public report to the executable's SHA-256 and rejects a different Pion
version or a replaced module. It records only closed fixture diagnostics and
at most eight bounded messages. Publishing or send failures terminate with a
failure record; they do not become successful empty output. Readiness and total
peer lifetime are bounded. Cleanup closes the peer and its owned process tree.

The host does not need a user account or paid service. Setup may download public
Go modules, the pinned coturn image and Chromium. Dependencies remain replaceable
evaluation inputs; this fixture is not a production connector distribution.
Native desktop/mobile integration, production signaling, key rotation, session
revocation and membership integration retain their own acceptance.
