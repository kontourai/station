#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: CLOC=/path/to/cloc $0 <before-commit> <after-commit>" >&2
  exit 2
fi

cloc_bin=${CLOC:-cloc}
if [[ $("$cloc_bin" --version) != 2.06 ]]; then
  echo 'This report requires cloc 2.06.' >&2
  exit 2
fi

before=$(git rev-parse --verify "$1^{commit}")
after=$(git rev-parse --verify "$2^{commit}")
scratch=$(mktemp -d "${TMPDIR:-/tmp}/monument-loc.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT

for side in before after; do
  commit=$before
  if [[ $side == after ]]; then commit=$after; fi
  mkdir "$scratch/$side"
  git archive "$commit" src-server/services packages/monument |
    tar -xf - -C "$scratch/$side"
  "$cloc_bin" --quiet --timeout=60 --json "$scratch/$side/src-server/services" > "$scratch/$side-station.json"
  "$cloc_bin" --quiet --timeout=60 --json "$scratch/$side/packages/monument" > "$scratch/$side-monument.json"
done

python3 - "$scratch" "$before" "$after" <<'PY'
import json
import pathlib
import sys

root, before, after = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
print(f'cloc 2.06; before {before}; after {after}')
for name in ('station', 'monument'):
    values = []
    for side in ('before', 'after'):
        with (root / f'{side}-{name}.json').open() as report:
            values.append(json.load(report)['SUM']['code'])
    print(f'{name}: {values[0]} -> {values[1]} ({values[1] - values[0]:+d} code lines)')
PY
