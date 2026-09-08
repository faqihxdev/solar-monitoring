# Home energy interface

The overview is one connected 3D house installation, with panels on the roof and the battery and inverter mounted on the service wall. PLN connects through a continuous overhead cable. Cable ends meet modeled glands on the equipment; the solar cable leaves a panel-frame junction box. Keep the cable runs clear of intermediate clips or connector blocks. Cables use the same lighting and shadows as the hardware. Moving light streaks show direction without arrowheads. An adjacent inspector shows the selected device. The installation, graphs, daily energy, and inverter controls remain together on one scrolling page, with no tab navigation.

## Visual system

- Canvas black `#080808`, panel `#101010`, raised panel `#181818`, border `#292929`, secondary text `#a3a3a3`, primary text `#ededed`.
- Saturated yellow for solar, green for charging, orange for discharge, blue for grid, teal for home/load, and purple for battery charts. The teal home cable contrasts with its white moving streaks. The Energy sources graph is the exception: its load line, legend swatch, and tooltip use white to remain distinct over the stacked colored areas. Keep graphs vivid and readable. Color identifies energy or status, never a whole layout.
- Geist for the interface and tabular numbers. Geist Mono for device identifiers and technical values.
- Left-aligned headings and readings, a 4px spacing scale, 16px mobile gutters, 40px desktop gutters, and a 1488px container limit.
- Page order: heading, four readings in one divided strip, 3D installation beside a device inspector, graphs, daily comparison, automation, device settings, audit history. Graphs and daily energy share date controls. Existing section URLs scroll to their section without hiding other content.
- 16px panel corners, 8px controls, 44px touch targets, visible keyboard focus.

## Review against the brief

The skill search suggested green surfaces and a commerce-style 3D configurator. Those do not fit this home monitoring app. Use neutral dark surfaces and a schematic installation. The scene explains the physical connections, direction, and measurements. Keep the surrounding interface quiet.

## Behavior

Model selection updates an accessible HTML inspector. Provide camera presets and a reset without requiring drag gestures. Frame the combined installation for narrow screens and reposition its callout labels. Respect reduced motion and pause rendering offscreen. Provide an HTML connection view if WebGL is unavailable.

Update the camera matrices before projecting label leaders, and render both in the same animation frame. Coalesce drag events at the display refresh rate; resting flow animation runs at 30 fps. Keep the last reported flow animated during polling, delays, and temporary API failures. Identify old data with the last-reading badge and a delay/offline notice; animation indicates the recorded direction, not freshness. Stop motion for explicit pause, reduced motion, hidden/offscreen scenes, or no active flow.

Show a ticking Jakarta clock (GMT+7) and the elapsed time since the last successful device poll in the header, including on phones. Keep headings and device details factual. Omit decorative subtitles, generic device explanations, repeated operating modes, and repeated timestamps. Preserve estimate qualifications, error feedback, and control confirmations.

The battery callout shows whole watts with an in/out direction alongside practical SOC. Idle, unknown power, and unmetered flow stay explicit. Cables carry short, closely spaced light streaks at approximately 1.06 scene units per second.

The API and 3D labels use `app/shared/energyFlows.ts` for power inference. Preserve small positive measurements and estimates, including those below the animation threshold. Show sub-watt battery power as `<1 W`. A complete balance estimates charging as solar plus grid import minus home load, with negative grid power accounting for export. Discharging reverses that balance. A zero balance remains an approximate zero; a balance that contradicts the reported direction stays unmetered.

In mains/bypass mode, missing grid watts can be inferred from known solar, home load, and battery power. When battery watts are also missing, the existing solar-charging model assigns PLN to the home and solar to the battery. An unknown load cancels out in that specific bypass case. A confirmed grid outage or battery/off-grid mode can establish zero grid flow without a grid watt reading. Idle status can establish approximate zero battery flow.

Label estimates with `≈` and `Estimated power`. Show `≥` and `Estimated minimum` when only home demand is known during unmetered grid charging. Missing solar or unknown battery discharge cannot establish that minimum. Measured power takes priority, and known exports are allocated once between solar and battery. Solar surplus alone must not invent an export. Estimates exclude conversion losses and never replace raw telemetry.

Keep practical SOC smoothing, device control validation, confirmation, and verified writes. Do not equate missing data with zero, stale readings with live flow, or a reported charging path with measured power.

## Verification

From `app`, run `pnpm build`, `pnpm test:frontend`, and `pnpm test:ui`. Browser tests require Chromium (`pnpm exec playwright install chromium`). They use a local read-only fixture API on port 43884 and a dedicated Vite server on port 43885. Fixture telemetry is synthetic; control write responses are intercepted in the browser and never reach an inverter.

Browser coverage includes device selection, camera controls, moving and paused cable streaks, 375–1440px layouts, historical dates, control draft retention, retry behavior, reduced motion, stale or missing readings, and WebGL fallback. Screenshots are written to `app/test-results`.
