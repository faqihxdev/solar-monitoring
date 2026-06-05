# Mini PC RS485 Direct Monitoring Plan

Goal
----
Move the solar dashboard toward a local, mini-PC-hosted monitoring setup that can
read the Zamdon inverter directly over RS485 instead of depending only on
DESSMonitor cloud polling.

This is future work. The current application still uses DESSMonitor API data.

Current findings
----------------
- A used mini PC or thin client is better value than a small SBC for this
  project. It runs normal x86 Linux, Node.js, pnpm, and the existing dashboard
  stack with fewer compatibility issues.
- Best low-cost target: Dell Wyse 5070 with Celeron J4105, 4GB RAM, and at
  least 64GB SSD, ideally 128GB SSD.
- Other acceptable options: HP T630, HP T620, Lenovo ThinkCentre Tiny, Dell
  OptiPlex Micro.
- Avoid ESP32, Arduino, Raspberry Pi Pico, and similar microcontrollers for
  hosting this project. They can poll Modbus, but they cannot host the current
  Node/React dashboard without a major rewrite.
- Avoid Dell Wyse 3040 unless budget is the only priority. Its 2GB RAM and
  8GB eMMC storage are tight for Linux plus Node plus local history.

Recommended hardware
--------------------
- Mini PC:
  - Minimum: 4GB RAM, 64GB SSD.
  - Preferred: 4GB-8GB RAM, 128GB SSD.
  - Must include power adapter.
- RS485 adapter:
  - Buy an isolated USB-to-RS485 adapter if possible.
  - Tokopedia search terms: `USB RS485 isolated`, `USB RS485 FTDI isolated`,
    `USB RS485 CH340 isolated`.
  - Prefer adapters with clear A/B terminals and Linux support.
- Cabling:
  - Mini PC USB -> USB-to-RS485 adapter.
  - Adapter A -> inverter RS485-A.
  - Adapter B -> inverter RS485-B.
  - If no response, A/B may need to be swapped.

Manual evidence
---------------
The ZD-T manual in `docs/zd-t-1000w-6000w-hybrid-off-grid-solar-inverter-user-manual.pdf`
shows:

- Optional RS485 communication port.
- Separate APP data collector module interface for WiFi/GPRS monitoring.
- Appendix for `485 Communication Port`.
- Pin definition naming `RS485-A`, `RS485-B`, and `NC` for not connected.

This means direct monitoring should use the RS485 port, not a plain USB cable
into the inverter.

Why this matters
----------------
DESSMonitor appears to provide cloud-backed readings on a slow cadence. Direct
RS485 polling would make the dashboard independent of that cloud delay.

Expected local polling cadence:
- 1-5 seconds for live telemetry experiments.
- 5 seconds as a reasonable first stable default.
- 10-30 seconds for dashboard refresh if storage writes become too frequent.
- 1-5 minutes for aggregated long-term history.

Unknowns to resolve
-------------------
- Exact Modbus baud rate, parity, stop bits, and slave ID for this inverter.
- Exact Zamdon ZD-T register map and scaling factors.
- Whether all desired fields are available locally:
  - PV voltage/current/power.
  - Battery voltage/SOC/status/power.
  - Load power/current.
  - Grid voltage/power.
  - Working state.
  - Alarm/fault code.
- Whether control writes are supported locally and which registers are safe to
  write.

Reasonable first assumptions for discovery:
- Modbus RTU over RS485.
- Serial settings: 9600 baud, 8 data bits, no parity, 1 stop bit.
- Slave ID: 1.
- Start read-only using function code 04, then test function code 03 if needed.

Do not implement control writes until the register map is confirmed.

Software architecture
---------------------
Keep the current DESSMonitor path working and add local RS485 as a separate
source.

Proposed source modes:
- `dess`: current cloud-backed DESSMonitor poller.
- `rs485`: local direct inverter poller.
- `hybrid`: local RS485 for fast telemetry, DESSMonitor retained for controls
  or fields not yet mapped locally.

Suggested environment variables:
- `SOLAR_DATA_SOURCE=dess|rs485|hybrid`
- `ZAMDON_RS485_PORT=/dev/ttyUSB0`
- `ZAMDON_RS485_BAUD=9600`
- `ZAMDON_RS485_SLAVE_ID=1`
- `ZAMDON_RS485_POLL_SECONDS=5`

Implementation phases
---------------------
1. Hardware smoke test
   - Install Debian or Ubuntu Server on the mini PC.
   - Confirm the USB-RS485 adapter appears as `/dev/ttyUSB0`.
   - Add the service user to the Linux `dialout` group.
   - Use a Modbus scan tool to verify the inverter responds read-only.

2. Register discovery
   - Start with common serial settings: 9600 8N1, slave ID 1.
   - Scan small register ranges with function code 04.
   - Compare live values against the inverter LCD:
     - battery voltage,
     - PV voltage,
     - load,
     - AC input/output voltage.
   - Record confirmed register address, scale, unit, and meaning in a new docs
     register map.

3. Read-only local poller
   - Add a Node dependency such as `modbus-serial`.
   - Add a server-side module for RS485 reads, separate from `dessClient`.
   - Convert Modbus readings into the existing telemetry field names used by
     `TelemetryStore`.
   - Keep all writes disabled.

4. Storage integration
   - Write confirmed RS485 readings into the existing SQLite/sql.js telemetry
     schema.
   - Mark the reading source as local if a source field is added later.
   - Keep DESS polling available as a fallback.

5. Dashboard integration
   - Reuse the current UI components.
   - Show a small data source indicator: DESS, RS485, or hybrid.
   - Preserve existing chart and history behavior.

6. Control investigation
   - Only after read-only monitoring is stable, request or discover an official
     write-register map.
   - Add a separate safety review before writing inverter parameters locally.
   - Keep guardrails similar to the existing control and automation logic.

Risks and guardrails
--------------------
- RS485 A/B polarity may be reversed on labels across adapters. If there is no
  response, swap A and B before changing software assumptions.
- Some inverter ports power WiFi/GPRS dongles and may expose RS485 plus power.
  Do not connect to power pins; use only A/B/GND if documented.
- Prefer isolated RS485 adapters because the inverter is connected to high-power
  electrical equipment.
- Never brute-force write registers.
- Start with read-only polling and compare against the LCD before trusting
  values.

Decision
--------
Buying a mini PC remains a good idea even before direct RS485 is implemented.
It can host the current dashboard immediately using DESSMonitor, then later
become the local RS485 monitoring host once the register map is confirmed.
