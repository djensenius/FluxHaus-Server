# Daily climate placement insights

`GET /climate/placement-insights/day` is the house-local daily drill-down for
the placement insights endpoint. `date` is a strict `YYYY-MM-DD` house
calendar date; when omitted it resolves to yesterday. The response includes
that resolved date and Home Assistant's configured `time_zone`.

The timeline is formed from complete 15-minute source windows. A state,
comfort-setting or occupancy change within a source window makes that
window's corresponding interpretation unknown; later values are never applied
retroactively. Missing sensor readings, unknown/conflicting units, incomplete
history and sub-millisecond boundary ambiguity remain `null`.

The timeline's `average` is the climate entity's reported temperature when its
unit/history are usable. Otherwise an approximation is emitted only when room
participation is explicitly known; it is an average of room sensors, not the
thermostat's physical sensor. The physical thermostat-associated sensor is
excluded from `rooms`; it remains in `sensors` with null room-relative metrics.
Reported daily averages and their coverage counts use the same HVAC outage and
post-recovery anchor checks as the placement endpoint.

Daily `dayOffset` and `baselineOffset` compare each room sensor with the
contemporaneous mean of the same complete, discovered indoor-room cohort while
heating or cooling is reported. The daily offset uses the selected date; the
baseline is the equal-weight mean of qualifying sampled days among the prior
14 house-calendar dates. A day qualifies with at least eight heating or two
cooling source windows. `unusual` is true only when the selected day meets that
sample minimum, at least three baseline dates meet it, and the absolute
day-vs-baseline change is at least 0.5°C. Otherwise insufficient evidence is
`null`, not normal. This temporal comparison is separate from the 14-day
endpoint's spatial/event guidance and does not imply a cause.
If Home Assistant discovery leaves possible indoor temperature sensors
unclassified, coverage marks the inventory incomplete and sensor offsets and
unusual flags remain `null` rather than treating the known-room cohort as
complete.

Wake room `overSetpoint` is the peak room reading minus the matching known
setpoint, in °C. Wake heating/cooling minutes require continuous HVAC evidence
through the full two-hour-before/two-hour-after context. A recorded wake's
`contextComplete` is true only when all 16 source windows have known HVAC
mode/action and complete readings for every discovered room sensor. An
incomplete recorded-wake context is retried using the short degraded-cache
interval; a day with no recorded wake is not degraded for that reason.
`contextRetryable` distinguishes missing or unfinished source evidence from
source-window alignment alone. A wake between 15-minute boundaries can have
incomplete context metrics without repeatedly retrying a complete past day.
Wake `heatingMinutes` and `coolingMinutes` integrate known HVAC change intervals;
`unknownMinutes` reports periods covered by an HVAC gap or missing action.
Timeline buckets remain unknown if an HVAC change crosses their boundary.
Recorded select history is authoritative for wake detection, including when its
observations are ambiguous; climate presets are used only when select history
is absent.
