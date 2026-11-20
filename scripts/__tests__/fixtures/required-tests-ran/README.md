# Captured kernel checker inputs

The macOS report records 63 tests from the earlier Seatbelt kernel run. Its
matching classification is frozen in `captured-seatbelt-profile.json`, copied
from Station main `b252782f5cd92542e0c48d1374f440a124a8394e` before adding the
three TMPDIR/workspace legs. Parser and status-mutation tests use this pair.
Neither file claims those newer tests ran.

The production profile is `scripts/required-test-profiles.json`. The workflow
argument test deliberately rejects the old macOS capture against that live
profile. The registration audit collects current test identities without
running bodies, then projects passing statuses only to test identity matching;
that projection is not kernel evidence. Actual kernel proof requires the macOS
workflow's fresh report and required-test check.

Keep the captured macOS and Linux reports unchanged. Do not fill missing live
test identities with invented passing results.
