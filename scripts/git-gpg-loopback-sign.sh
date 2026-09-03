#!/usr/bin/env bash
set -euo pipefail

: "${TESTFLIGHT_AUTHORITY_GPG_PASSPHRASE_FILE:?passphrase file is required}"
test -f "$TESTFLIGHT_AUTHORITY_GPG_PASSPHRASE_FILE"

exec gpg \
  --batch \
  --no-tty \
  --pinentry-mode loopback \
  --passphrase-file "$TESTFLIGHT_AUTHORITY_GPG_PASSPHRASE_FILE" \
  "$@"
