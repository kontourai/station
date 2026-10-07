#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: install-ci-ubuntu-packages.sh <package...>" >&2
  exit 2
fi

# Playwright's image and hosted Ubuntu runners inherit this Azure mirror.
# Keep repository suites, components, signing keys, and mirror priorities.
find /etc/apt -type f \( -name '*.list' -o -name '*.sources' -o -name 'apt-mirrors.txt' \) \
  -exec sed -i 's|https\?://azure\.archive\.ubuntu\.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' {} +

apt-get -o APT::Update::Error-Mode=any update
apt-get install --yes --no-install-recommends -- "$@"
