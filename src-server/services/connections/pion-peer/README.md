# Pion application transport peer

This production-owned native source backs the private `PionApplicationAdapter`.
It does not expose a Station API, identify a person, authorize Project access,
or implement a connection broker. Building and distributing the binary remains
a separate release decision.

The standalone Go module pins Pion WebRTC v4.2.20 and its transitive module
checksums. The module directive requires at least Go 1.26.7; the current Node
adapter additionally accepts only a reported Go 1.26 toolchain.
With Go installed, build once from this directory:

```bash
go mod download
go mod verify
go vet ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./...
go build -mod=readonly -trimpath -o ../../../../.kontourai/browser-transport/pion-peer .
```

The Node adapter currently requires POSIX private-descriptor custody and refuses
Windows before launch. A cross-compiled executable alone does not qualify that
platform. Rebuild after changes to this module. From the repository root, run:

```bash
npm run lab:browser-transport -- --peer=pion --browser-turn=tcp
npm run lab:browser-transport -- --peer=pion --browser-turn=udp
```

The Node adapter writes a private, bounded configuration containing
the browser offer, certificate paths and configured TURN credentials. The
lab supplies an owned local TURN server; the normal connector can supply a
different explicitly configured endpoint. It starts the exact local binary through Station's owned
process helper. There is no HTTP configuration endpoint or production identity
header. Pion verifies the browser certificate against its SDP; the browser's
approved Station fingerprint is supplied independently by the fixture.

Pion requires relay candidates and uses TURN/TCP in the local lab profile. The browser
can use TCP or UDP TURN control, as explicitly selected. Application data stays
inside DTLS in either case. The local TURN control connection itself is not
TLS; qualification of production TURN/TLS and real network conditions remains
separate. The profile never disables DTLS certificate verification.

The required `application` profile passes versioned newline-delimited frames
over dedicated inherited descriptors 3 and 4. Application content
never uses stdout, stderr, or the bounded message-diagnostics file. The adapter
admits at most 32 ordered reliable channels, limits each application message to 48 KiB of UTF-8,
and closes a channel before its queued sends can exceed 96 KiB. Invalid framing,
late packets, cancellation, process exit, and channel closure cannot recreate a
retired channel.

Missing and unknown profiles fail closed. The `diagnosticEcho` profile is an
explicit fixture-only mode; the production application profile refuses unknown
DataChannels and never writes application content to diagnostic files or output.

The peer publishes its actual linked Pion and Go versions. The controller records
the executable file's SHA-256 alongside that report; this is local provenance,
not remote attestation. A different Pion version or a replaced Go module is
refused. The diagnostic-echo profile records at most eight bounded messages;
the application profile does not record their content. Diagnostic publication,
echo-send and IPC publication failures terminate the peer with a nonzero exit;
it attempts to publish a failure record.
An application DataChannel send failure closes that channel. Readiness and total
peer lifetime are bounded. Cleanup closes the peer and its owned process tree.

The lab requires no hosted account or paid service. Setup may download public
Go modules, the pinned coturn image and Chromium. Dependencies remain replaceable
evaluation inputs; this fixture is not a production connector distribution.
The opt-in [self-hosted connector](../../../../docs/guides/self-hosted-broker.md)
already composes this peer with protected application dispatch and broker
signaling. The [lab guide](../../../../docs/guides/local-collaboration-lab.md)
separates transport, account/revocation, and fresh browser-UI profiles. Those
compositions do not establish native desktop/mobile delivery or qualify every
network and trust-lifecycle case.

The evaluated module uses patched `golang.org/x/net` v0.56.0 and the Go 1.26.7
minimum. The earlier Go 1.26.5/networking combination failed vulnerability
reachability checks and is not a qualified build. Rescan whenever the module or
toolchain changes; a successful transport journey does not establish dependency
security. Report unreachable module-level advisories separately from reachable
code findings.
