#!/bin/bash
set -euo pipefail

# Publish only a fully initialized swap file. Existing unknown files are never
# reformatted; interrupted temporary files are never enrolled automatically.
prepare_station_swap() (
  local swap_file="$1"
  local active staging=''
  active=$(swapon --show=NAME --noheadings)
  if printf '%s\n' "$active" | grep -Fxq "$swap_file"; then
    return 0
  fi
  if [ -e "$swap_file" ] || [ -L "$swap_file" ]; then
    if [ ! -f "$swap_file" ] || [ -L "$swap_file" ] || [ "$(blkid -p -s TYPE -o value "$swap_file")" != swap ]; then
      echo 'Existing swap path is not a validated swap file; preserve and inspect it before recovery.' >&2
      return 1
    fi
  else
    staging=$(mktemp "${swap_file}.preparing.XXXXXX")
    trap 'if [ -n "$staging" ]; then rm -f -- "$staging"; fi' EXIT
    chmod 600 "$staging"
    fallocate -l 2G "$staging"
    mkswap "$staging" >/dev/null
    [ "$(blkid -p -s TYPE -o value "$staging")" = swap ]
    # Same-directory link publication refuses an existing destination. Remove
    # the temporary name before activating the final file.
    ln -- "$staging" "$swap_file"
    rm -f -- "$staging"
    staging=''
  fi
  swapon "$swap_file"
)

main() {
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io ca-certificates curl
fi
systemctl enable --now docker
install -d -m 0700 /var/lib/station
install -d -m 0700 -o 1000 -g 1000 /var/lib/station/home /var/lib/station/workspace
prepare_station_swap /var/lib/station/swapfile
if ! grep -Fq '/var/lib/station/swapfile none swap sw 0 0' /etc/fstab; then
  echo '/var/lib/station/swapfile none swap sw 0 0' >> /etc/fstab
fi
printf 'Station host bootstrap complete; application image enrollment is a separate step.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
