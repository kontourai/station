#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io ca-certificates curl
fi
systemctl enable --now docker
install -d -m 0700 /var/lib/station
install -d -m 0700 -o 1000 -g 1000 /var/lib/station/home /var/lib/station/workspace
if [ ! -f /var/lib/station/swapfile ]; then
  fallocate -l 2G /var/lib/station/swapfile
  chmod 600 /var/lib/station/swapfile
  mkswap /var/lib/station/swapfile
fi
if ! swapon --show=NAME --noheadings | grep -Fxq /var/lib/station/swapfile; then
  swapon /var/lib/station/swapfile
fi
if ! grep -Fq '/var/lib/station/swapfile none swap sw 0 0' /etc/fstab; then
  echo '/var/lib/station/swapfile none swap sw 0 0' >> /etc/fstab
fi
printf 'Station host bootstrap complete; application image enrollment is a separate step.\n'
