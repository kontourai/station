#!/usr/bin/env bash
# Applies the three workflow fixes that the reporting session could not push
# (its credential lacks the `workflow` scope) and clears the two Nightly locks.
# Run from any clean clone of kontourai/station with your own credentials:
#   git fetch origin claude/pending-workflow-fixes
#   git show origin/claude/pending-workflow-fixes:.pending-workflow-fixes/apply.sh | bash
set -euo pipefail
src=origin/claude/pending-workflow-fixes
git fetch origin main claude/pending-workflow-fixes
for tag in nightly-recovery-lock nightly-promotion-fence; do
  if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
    git push origin ":refs/tags/$tag"
  else
    echo "tag $tag already absent"
  fi
done
apply() {
  git checkout -B "$1" origin/main
  git show "$src:.pending-workflow-fixes/$2" | git am
  git push origin "HEAD:refs/heads/$1"
}
apply claude/fleet-admit-dependencies 0001-fix-nightly-install-dependencies-before-admit-fleet-.patch
apply claude/ios-init-signing-template 0001-fix-ios-regenerate-the-Xcode-project-with-the-manual.patch
apply claude/perf-jobs-skip-pull-request 0001-fix-ci-run-the-one-hour-performance-lanes-only-after.patch
echo "done: three branches pushed, tags cleared"
