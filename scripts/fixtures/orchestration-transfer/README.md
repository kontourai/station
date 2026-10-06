# Orchestration transfer calibration

The policy is an envelope, not a target. The real initial calibration recorded
about 39--52 KB for the bounded event window, 0.9--1.7 KB snapshots, and about
1.0 MB for a heavy live turn. The 64 KB snapshot/window ceilings intentionally
leave room for ordinary metadata growth (roughly 38--72x current snapshot
traffic) without treating one quiet fixture as a product limit. Every changed
ceiling must be attributed to the exact prior policy and the two baseline plus
candidate measurements; this explanation does not authorize a policy change.

The capture uses a fixed logical clock for its burst of fixture events. The
conversation activity projection coalesces optional stream bindings by time;
letting host scheduling control that clock can add metadata to only one of two
otherwise identical baseline captures. A delayed native completion reproduced
a 439-byte difference with the same 44 frames. Monotonic real time still bounds
capture barriers, and the recorder counts the actual HTTP transfer. This is a
byte comparison of a controlled burst, not a test of coalescing cadence or
processing latency. Application clocks and the policy ceilings are unchanged.
