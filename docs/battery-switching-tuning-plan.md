Final Tuning Plan: Deep Battery Use Without Chatter
===================================================

Goal
----
Use as much battery as practical without unstable mains<->inverter chatter.
The main target is no longer the lowest theoretical A6 number; it is the lowest
return-to-inverter voltage that does not immediately fall back to mains.

Current working settings (final-tuning baseline)
------------------------------------------------
- A6 (return to inverter): 12.4  (pack 24.8V)
- A7 (switch to mains):    11.7  (pack 23.4V)
- A5 (low batt recovery):  11.8  (pack 23.6V)
- A4 (low voltage protect):11.2  (pack 22.4V)
- A0: inverter priority (Inverse priority / inverse-first)
- AC charging disabled: A1/C0 + charging current 0
- SOC controls: inverter 10%, mains 5% (kept low; voltage still appears to
  dominate practical switching behavior)

Battery safety context (PowMr spec)
-----------------------------------
- Recommended discharge voltage: 11.2V (single battery)
- Max discharge voltage:         10.8V (single battery)
- Current A4 = 11.2V matches the recommended discharge voltage and remains
  0.4V above the 10.8V max/absolute discharge figure.
- Inverter manual note: low-voltage alarm is A4 + 0.5V per 12V battery
  (A4 + 1.0V on a 24V pack).

Observed finding: LiFePO4 voltage knee
--------------------------------------
Telemetry from Jun 4 around 08:00-09:30 showed that the battery voltage does
not drain linearly near the bottom of the LiFePO4 curve.

- Around 08:00-08:25, pack voltage was about 25.0V to 24.8V with SOC around
  50% to 46%.
- From about 08:30 to 08:57, pack voltage fell quickly from 24.6V to 23.4V,
  with SOC dropping from about 42% to 19%.
- Load was roughly 0.36-0.46kW while PV was only about 0.11-0.19kW, so the
  battery was still carrying a meaningful part of the load.
- At about 08:57, pack voltage reached 23.4V, matching A7 = 11.7V x2, and the
  inverter switched to mains shortly after.
- After switching to mains, voltage rebounded, then the inverter returned to
  battery and sagged again. This is the chatter risk A6 needs to control.

Important interpretation:
- A7 controls when the inverter leaves battery and goes to mains.
- A6 controls when the inverter is allowed to return from mains to battery.
- Raising A6 does not prevent the first low-voltage switch to mains; it prevents
  returning to battery too early while the pack is still near the knee.

Current final-tuning strategy
-----------------------------
- Keep A7 at 11.7V (pack 23.4V) to allow deep battery use.
- Keep A4 at 11.2V (pack 22.4V) as the protection floor.
- Keep A5 at 11.8V (pack 23.6V), just above A7 and above A4.
- Test A6 at 12.4V (pack 24.8V). This gives room above the steep discharge
  knee before returning to battery.

If chatter still appears:
- Next A6 step: 12.5V (pack 25.0V).
- Fallback A6 step: 12.6V (pack 25.2V).
- Do not raise A7 unless the goal changes from maximum battery use to earlier
  mains takeover.

Current voltage-to-SOC interpretation
-------------------------------------
The SOC percentage controls appear secondary or ignored in this setup, but the
rough voltage-equivalent SOCs are:

- A6 = 12.4V single / 24.8V pack: around the observed 46% area under load.
- A7 = 11.7V single / 23.4V pack: around the observed 19% area under load.
- A4 = 11.2V single / 22.4V pack: near empty/protection territory.

These are observed under real load and PV conditions, not resting open-circuit
SOC values. Treat them as device-specific calibration points.

Theoretical lowest safe-margin reference
----------------------------------------
This is not the current practical tuning target. It is the lowest set that still
uses the battery deeply while keeping a small margin above the battery hard edge.

Lowest sane experimental floor (single-battery values):
- A6 = 11.9V  (return from mains to inverter)
- A5 = 11.8V  (output recovery after low-voltage shutdown)
- A7 = 11.7V  (switch from inverter to mains)
- A4 = 11.2V  (low-voltage protection floor)

Equivalent 24V pack values:
- A6 = 23.8V
- A5 = 23.6V
- A7 = 23.4V
- A4 = 22.4V

Why this is the lower safe-margin set:
- A4 = 11.2V matches the PowMr recommended discharge voltage and remains
  0.4V above the 10.8V max/absolute discharge figure.
- With A4 = 11.2V, the inverter low-voltage alarm is 11.7V, so A7 = 11.7V
  switches to mains at the alarm point instead of below it.
- Keeps required ordering: A6 > A5 > A4 and A6 > A7 > A4.
- Keeps small anti-chatter margins: A6 - A7 = 0.2V and A6 - A5 = 0.1V.

More aggressive but not recommended:
- A6 = 11.6V, A5 = 11.5V, A7 = 11.4V, A4 = 11.2V.
- This operates below the inverter's derived low-voltage alarm threshold and is
  more likely to chatter, sag under load, or hit protection.

Hard constraints (must always hold)
-----------------------------------
- A6 > A5 > A4
- A6 > A7 > A4
- Keep grid charging disabled (C0, current 0).
- Do not lower A4 below 11.2V without a separate safety decision.

Pass/fail checks
----------------
PASS criteria
- No rapid oscillation after switching to mains.
- If mains takeover happens at A7, return to inverter only after battery is
  clearly above the knee.
- No low-voltage protection event triggered.

FAIL criteria
- Mains -> inverter -> mains loop within about 10-15 minutes.
- Long "stuck on mains" behavior despite battery clearly above A6 range.
- Any instability close to A4 protection.

Data to log each cycle
----------------------
- Start/end time
- A6/A5/A7/A4 values used
- Min pack voltage seen
- Voltage at each mains<->inverter transition
- SOC at each transition
- Load and PV around the transition
- Subjective result: stable / unstable

Decision target
---------------
Primary objective is not absolute minimum number.
Primary objective is: deepest practical battery use with predictable source
switching. Current best hypothesis is that A7 can stay low at 23.4V pack, while
A6 needs to be around 24.8V to 25.2V pack to avoid returning too early near the
LiFePO4 knee.
