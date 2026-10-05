# Enroll an operator passkey

An operator passkey lets you sign in as this Station's operator from a paired
browser without pasting the operator credential. This guide covers **enrollment
only**. Signing in with a passkey and approving device-access changes with one
arrive in later slices of [#3257](https://github.com/kontourai/station/issues/3257);
until then an enrolled passkey is stored but nothing accepts it yet.

## Before you start

- Station must be reachable at an **HTTPS name**, not an IP address. WebAuthn
  scopes a passkey to a domain, so a Station reachable only by IP has no remote
  operator sign-in.
- Set `STATION_TRUSTED_CONSENT_ORIGIN` to the HTTPS origin that reaches the
  consent listener, as described in
  [Reaching the consent origin over HTTPS](deployment.md#reaching-the-consent-origin-over-https).
  The passkey's relying-party ID is that origin's host, so enroll from the
  same name you will use later. Without this setting enrollment is
  unavailable and the page and the CLI both say so.
- The browser must already be **paired** with this Station and open on the
  same host name as the consent origin. A passkey is not a way to pair.
- You need a shell on the Station host: confirmation is a host-side step.

## Enroll

1. In the paired browser, open `<consent origin>/operator/passkeys/enroll` and
   choose **Start**. The page shows a six-digit code, for example `482 913`.
2. On the Station host, confirm the code you see in the browser:

   ```bash
   station environment operator passkeys approve 482913
   ```

   Any paired device can open a request, and a device chooses its own name, so
   the name proves nothing. The host listing (`station environment operator
   passkeys`) therefore shows, for each request, the device id (first eight
   characters), when it was paired and its scopes, and it **never shows the
   code**. On a terminal, `approve` prints those details and asks you to
   confirm before it commits. Without a terminal, pass the id of the device you
   expect, which must match the requesting device or nothing is confirmed:

   ```bash
   station environment operator passkeys approve 482913 --device aaaa1111
   ```

   A device that names itself like the operator's own browser is shown as a
   paired device that calls itself that, never as the operator. You type the
   code from the browser, so confirming means comparing the two screens, not
   copying one. The code works once and expires after five minutes. Five wrong
   codes in five minutes lock confirmation (including the right code) until
   the window passes. `deny <code>` rejects a request, and also withdraws one
   you approved by mistake until the passkey has been created.
3. The page advances to **Create passkey**. Name it, choose **Create passkey**,
   and complete the browser or operating-system prompt. Station requires user
   verification (biometric or PIN), asks for no attestation, and accepts any
   authenticator, including a synced passkey. Only the public key is stored.
4. Enroll a **second** passkey, such as a security key or another device, so
   losing one does not lock you out. Each passkey needs its own host
   confirmation; one confirmation enrolls one passkey.

## Manage passkeys on the host

```bash
station environment operator passkeys                 # list passkeys and pending requests
station environment operator passkeys approve <code> [--device <id-prefix>]  # confirm the code the browser shows
station environment operator passkeys deny <code>     # reject a request, or withdraw an approval
station environment operator passkeys revoke <id>     # revoke a passkey by the id in the list
```

These commands run only against a Station on this machine, the same as
`station environment access approve`. Revoking from the host needs no passkey.
Revoking a passkey remotely, with a step-up from a different passkey, comes
later.

Passkeys are kept in `authentication/operator-passkeys.sqlite` under the
Station home. The file is created when the first enrollment begins; a Station
without `STATION_TRUSTED_CONSENT_ORIGIN` never creates it. It is a private file (mode 0600 in a 0700 directory) that
holds each passkey's credential id, public key, signature counter, transports and label.

## What can go wrong

| Message | Meaning |
| --- | --- |
| Enrollment is unavailable | `STATION_TRUSTED_CONSENT_ORIGIN` is not set. |
| The request with that code was not opened by the device you named | `--device` does not match the requesting device. Nothing was confirmed; list the requests and check who asked. |
| The device that opened this request is no longer paired | It was revoked or unpaired after asking. Nothing was confirmed. |
| No pending enrollment request has that code | The code is wrong, was already used, or expired. |
| Too many wrong codes | Wait for the five-minute window, then retry. |
| The passkey could not be verified for this Station | The browser's origin or the authenticator's relying-party ID did not match the configured origin, or user verification was skipped. Nothing was saved; start again. |
| Open this page from a browser paired with this Station | The browser has no paired-device cookie for this host name. |
