import type { Reading, Summary, ThresholdEntry } from "../api";
import { estimatePracticalEta, medianVoltage, practicalBattery } from "../batteryModel";
import { deriveFlows, FLOW_MIN_KW } from "../energy";
import { watts, powerKw, num } from "../format";
import { C, statusColor, statusLabel } from "../theme";
import { Battery, Plug, Sun, Zap } from "lucide-react";
import {
  FlowDiagram,
  RailNode,
  RingNode,
  StackNode,
  type DiagramLink,
  type DiagramNode,
} from "./flowNodes";

interface Props {
  latest: Reading | null;
  summary: Summary | null;
  socThresholds: ThresholdEntry[];
  voltageThresholds: ThresholdEntry[];
  history: Reading[];
  /** Rated output (kW) from the "Power Value Setting" control; load gauge max. */
  loadMaxKw: number | null;
}

// Node boxes fill the 1034×300 viewBox edge-to-edge so the scaled SVG aligns
// with the content area (no internal side margins).
const BOX = {
  solar: { x: 0, y: 20, w: 250, h: 92 },
  grid: { x: 0, y: 188, w: 250, h: 92 },
  battery: { x: 398, y: 94, w: 244, h: 112 },
  load: { x: 790, y: 98, w: 244, h: 104 },
};

/** Compact link number, e.g. "0.42" (W) or "1.2k" (kW), with optional "~". */
function linkLabel(kw: number, inferred = false): string {
  const p = powerKw(kw);
  return `${inferred ? "~" : ""}${p.value}${p.unit === "kW" ? "k" : ""}`;
}

export default function EnergyFlow({
  latest,
  summary,
  socThresholds,
  voltageThresholds,
  history,
  loadMaxKw,
}: Props) {
  const f = deriveFlows(latest);
  const switchT = socThresholds.find((t) => t.id === "soc_to_mains");
  // Smooth the voltage over a trailing window before mapping to practical SOC,
  // so the displayed gauge does not jump on 0.2V steps / load transients.
  // The raw pack voltage is still shown unsmoothed on the ring metric below.
  const smoothedVoltage = medianVoltage(
    [
      ...history.map((r) => ({ t: r.polled_at, v: r.battery_voltage })),
      ...(latest ? [{ t: latest.polled_at, v: latest.battery_voltage }] : []),
    ],
    latest?.polled_at,
  );
  const practical = practicalBattery(
    latest && smoothedVoltage != null ? { ...latest, battery_voltage: smoothedVoltage } : latest,
    voltageThresholds,
  );
  const eta = estimatePracticalEta(history, latest, voltageThresholds);

  const socRange =
    summary?.soc_min != null && summary?.soc_max != null
      ? `${Math.round(summary.soc_min)}-${Math.round(summary.soc_max)}%`
      : null;

  // Compact ETA: drop the leading "~"; target is expressed on the practical SOC guide.
  const etaCompact = eta ? eta.label.replace(/^~/, "") : null;
  const baseCap = etaCompact
    ? `ETA ${etaCompact}`
    : switchT
      ? practical.stateLabel
      : socRange
        ? `Range ${socRange}`
        : null;
  // Surface the smoothed (15-min median) pack voltage that the practical SOC %
  // is derived from, so it's clear the ring isn't computed off the raw reading.
  const smoothedCap = smoothedVoltage != null ? `SOC from ${num(smoothedVoltage, 1)}V avg` : null;
  const batteryCaps = [baseCap, smoothedCap].filter((c): c is string => Boolean(c));

  const solarActive = (latest?.pv_power ?? 0) > 5;
  const loadActive = f.loadKw > FLOW_MIN_KW;
  const gridActive =
    f.gridToLoad > FLOW_MIN_KW ||
    f.gridToBattery > FLOW_MIN_KW ||
    f.gridToBatteryReported ||
    Math.abs(f.gridKw) > FLOW_MIN_KW;
  const battActive = f.charging || f.discharging;

  const pv = watts(latest?.pv_power);
  const load = powerKw(latest?.load_power);
  const battColor = statusColor(latest?.battery_status);
  const battState = statusLabel(latest?.battery_status);

  const unmeasuredCharge =
    f.charging && f.pvToBattery <= FLOW_MIN_KW && f.gridToBattery <= FLOW_MIN_KW;

  let solarMeta = "No production";
  if (solarActive) {
    if (f.pvToLoad > FLOW_MIN_KW && f.pvToBattery > FLOW_MIN_KW) solarMeta = "To load + batt";
    else if (f.pvToBattery > FLOW_MIN_KW) solarMeta = "Charging batt";
    else if (f.pvToLoad > FLOW_MIN_KW) solarMeta = "To load";
    else solarMeta = "Producing";
  }

  // Grid state mirrors the qualitative style of the solar node — the actual
  // power numbers live on the links, not inside the node.
  let gridSub = f.onMains ? "On mains" : "Standby";
  if (!f.onMains && f.gridKw < -FLOW_MIN_KW) gridSub = "Exporting";

  // Load gauge: scale against the rated output, falling back to recent peak.
  const historyPeak = history.reduce(
    (m, r) => (r.load_power != null && r.load_power > m ? r.load_power : m),
    0,
  );
  const loadCeiling = loadMaxKw != null && loadMaxKw > FLOW_MIN_KW ? loadMaxKw : historyPeak;
  const meterPct = loadCeiling > FLOW_MIN_KW ? (f.loadKw / loadCeiling) * 100 : null;
  const ceil = powerKw(loadCeiling);
  const loadCap =
    meterPct != null
      ? `${Math.round(meterPct)}% of ${ceil.value} ${ceil.unit} max`
      : loadActive
        ? "Active"
        : "Idle";
  const loadRight =
    latest?.load_current != null && f.loadKw > FLOW_MIN_KW
      ? `${num(latest.load_current, 1)} A`
      : undefined;

  const nodes: DiagramNode[] = [
    {
      id: "solar",
      box: BOX.solar,
      el: (
        <StackNode
          label="Solar"
          icon={Sun}
          color={C.solar}
          active={solarActive}
          value={solarActive ? pv.value : "0"}
          unit={solarActive ? pv.unit : "W"}
          sub={solarMeta}
        />
      ),
    },
    {
      id: "grid",
      box: BOX.grid,
      el: (
        <StackNode
          label="Grid"
          icon={Plug}
          color={C.grid}
          active={gridActive}
          value={latest?.grid_voltage != null ? num(latest.grid_voltage, 0) : "—"}
          unit="V"
          sub={gridSub}
        />
      ),
    },
    {
      id: "battery",
      box: BOX.battery,
      el: (
        <RingNode
          label="Battery"
          icon={Battery}
          color={battColor}
          active={battActive}
          pct={practical.practicalSocPct}
          sub={battState}
          metric={latest?.battery_voltage != null ? num(latest.battery_voltage, 1) : undefined}
          metricUnit="V"
          caps={batteryCaps}
        />
      ),
    },
    {
      id: "load",
      box: BOX.load,
      el: (
        <RailNode
          label="Load"
          icon={Zap}
          color={C.load}
          active={loadActive}
          value={loadActive ? load.value : "0"}
          unit={loadActive ? load.unit : "W"}
          right={loadRight}
          meterPct={meterPct}
          cap={loadCap}
        />
      ),
    },
  ];

  const links: DiagramLink[] = [
    {
      id: "pv-batt",
      path: "M 250 66 C 324 66, 352 150, 398 150",
      active: f.pvToBattery > FLOW_MIN_KW,
      color: C.solar,
      label: f.pvToBattery > FLOW_MIN_KW ? linkLabel(f.pvToBattery) : undefined,
      at: { x: 324, y: 108 },
    },
    {
      id: "grid-batt",
      path: "M 250 234 C 324 234, 352 150, 398 150",
      active: f.gridToBattery > FLOW_MIN_KW || f.gridToBatteryReported,
      color: C.grid,
      label: f.gridToBattery > FLOW_MIN_KW ? linkLabel(f.gridToBattery, f.gridInferred) : undefined,
      at: { x: 324, y: 192 },
    },
    {
      id: "batt-load",
      path: "M 642 150 L 790 150",
      active: f.batteryToLoad > FLOW_MIN_KW || f.batteryToLoadReported,
      color: C.discharge,
      label: f.batteryToLoad > FLOW_MIN_KW ? linkLabel(f.batteryToLoad) : undefined,
      at: { x: 716, y: 150 },
    },
    {
      id: "pv-load",
      path: "M 250 66 C 470 2, 610 2, 790 150",
      active: f.pvToLoad > FLOW_MIN_KW,
      color: C.solar,
      label: f.pvToLoad > FLOW_MIN_KW ? linkLabel(f.pvToLoad) : undefined,
      at: { x: 520, y: 30 },
    },
    {
      id: "grid-load",
      path: "M 250 234 C 470 298, 610 298, 790 150",
      active: f.gridToLoad > FLOW_MIN_KW,
      color: C.grid,
      label: f.gridToLoad > FLOW_MIN_KW ? linkLabel(f.gridToLoad, f.gridInferred) : undefined,
      at: { x: 520, y: 272 },
    },
  ];

  return (
    <div className="animate-[fadein_0.5s_ease_both]">
      <FlowDiagram width={1034} height={300} nodes={nodes} links={links} />

      {unmeasuredCharge && (
        <p className="mt-2 text-xs text-faint">
          Charging path reported by DESSMonitor; charge power is not metered by this protocol.
        </p>
      )}
    </div>
  );
}
