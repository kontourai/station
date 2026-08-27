#!/usr/bin/env bash
set -euo pipefail

assets_dir=${1:-}
test -n "$assets_dir"
test -d "$assets_dir"

cd "$assets_dir"
sha256sum -c station-release-checksums.txt
sha256sum -c station-portable.tar.gz.sha256
