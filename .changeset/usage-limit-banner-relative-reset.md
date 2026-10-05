---
"@kontourai/station-contracts": patch
---

The usage-limit banner now says when the limit resets in Station's one compact
relative time: "Usage limit reached · Resets in 41m" instead of a clock time
and weekday, and "Reset 3m" once it has passed. The exact date and time stay in
the reset's tooltip. A reset more than a week out reads as a short date, as
every other time on the work surfaces does.
