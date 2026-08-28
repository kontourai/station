# Browser Preview Pane MVP (Station archive#1375)

Browser Preview is a Project-scoped Workspace Pane for a user-selected local
HTTP(S) address. Its durable state contains only the canonical Project ID, a
normalized loopback address, viewport preference, and update timestamp.
Native discovery turns that address into an ephemeral selected target/grant;
opaque Pane instance and state keys do not encode the address or grant.

## Admission and restoration

- The canonical descriptor, state parser, and instance shape live in the
  browser-bundleable Workspace Pane contracts.
- The Coding layout opens an occurrence only through the existing host prepare
  transaction. A rejected host open rolls the prepared local state back.
- Restore requires the canonical descriptor ID, opaque Browser Preview key,
  exact Project ID and source binding, and separately parsed state. Renderer
  lifecycle does not persist; every restored occurrence begins without a
  renderer-health claim.

## Availability and rendering boundary

- Browser Preview is discoverable from the known Pane catalog. Availability
  composes the archive#1370 native capability adapter with a native-owned service
  authority check at launch. A local-looking URL, platform name, browser user
  agent, or renderer connection cannot establish locality.
- The Rust host resolves the running per-user service, then accepts only one
  literal numeric loopback target (`127.0.0.0/8` or `::1`) and applies one
  total one-second TCP-connect deadline before minting a short-lived, one-time
  grant. Hostnames, including `localhost`, are rejected for the desktop preview
  with an explicit system-browser action; native discovery performs no DNS
  resolution. An arbitrary selected Station connection, remote endpoint,
  renderer, or session never becomes discovery authority. Missing service
  authority, refusal, invalid hostname, and deadline expiry each produce a
  typed result and a retry can make a fresh selection.
- The desktop host revalidates the bounded loopback URL at its typed command
  boundary, then asks the operating system to open it externally. Typed host
  rejection and opener failures remain visible in the pane. The webview has no
  Station/Tauri/plugin bridge, proxy, credential forwarding, referrer,
  permissions, or same-origin privilege.
- This MVP deliberately does not mount an iframe. A cross-origin frame cannot
  observe a redirect from a loopback origin to a remote destination, and the
  current Station web renderer cannot intercept navigation. A later host may
  add a sandboxed framed renderer only after it enforces that redirect policy.
- On supported desktop Tauri hosts, a separate native Browser Preview window
  may consume only a fresh native-owned grant. It revalidates the bounded URL,
  confines every navigation to the exact approved loopback origin, and denies
  popups/downloads. It receives no Station command,
  plugin, credential, proxy, header-rewrite, or persisted browser authority.
  Native selection observes only TCP reachability. Its typed projection
  distinguishes `reachable`, `refused`, `dns-failed`, `unreachable`, and
  `not-observed`; TLS is `not-applicable` for HTTP and `not-observed` for
  HTTPS. The separate-window launch can state that its navigation policy was
  installed and a renderer was created, but cannot establish an HTTP response,
  final navigation, page title/history, frame result, or renderer health.

## Truthful projections

Invalid input is locally knowable and rejected before persistence. The external
action is ready only after the actual native capability is reported enabled;
native-host, native-service-authority, storage, discovery, and opener failures
have distinct bounded projections where their source reports them. External
open revalidates its local address but deliberately does not claim it is
reachable. Response policy, final location, title, history, frame outcome, and
renderer health remain `NOT_VERIFIED`; this slice does not infer them from an
open or renderer-created result.

HTML and PDF File Preview kinds still supply no Browser Preview target. Their
only current handoff is an authenticated, project-bound, bounded server
attachment (`application/octet-stream`, `Content-Disposition: attachment`,
`nosniff`, `no-store`, CSP sandbox). The UI saves those bytes as a download;
it never emits `file://`, mounts trusted-origin HTML/PDF, proxies content, or
rewrites headers. A future local-server handoff must first receive the same
native discovery selection and one-time grant as Browser Preview.

## Not included

Child-webview hosting, remote targets, arbitrary request headers, credential
transport to preview content, response rewriting, and browser automation are
outside this MVP. Separate-window package interaction remains explicitly
`NOT_VERIFIED` on macOS, Windows, Linux X11/Wayland; Web/PWA and Android/iOS
remain unavailable. See the archive#1376 host spike for the conditional native-host
record and scorecard.
