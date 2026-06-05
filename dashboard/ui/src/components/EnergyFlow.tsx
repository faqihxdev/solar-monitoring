import type { Reading, Summary, ThresholdEntry } from "../api";
import { estimateVoltageEta, practicalBattery } from "../batteryModel";
import { deriveFlows, FLOW_MIN_KW } from "../energy";
import { watts, powerKw, num } from "../format";
import { C, statusColor, statusLabel } from "../theme";
import { Battery, Plug, Sun, Workflow, Zap } from "lucide-react";
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

// Node boxes in the 1034x300 diagram coordinate space. Solar/Grid stack on the
// left, Battery in the middle, Load on the right. Box sizes hug their content
// (the cards fill their box) and gaps are kept even + tight.
const BOX = {
  solar: { x: 24, y: 20, w: 250, h: 92 },
  grid: { x: 24, y: 188, w: 250, h: 92 },
  battery: { x: 398, y: 94, w: 244, h: 112 },
  load: { x: 766, y: 98, w: 244, h: 104 },
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
  const practical = practicalBattery(latest, voltageThresholds);
  const eta = estimateVoltageEta(history, latest, voltageThresholds);

  const socRange =
    summary?.soc_min != null && summary?.soc_max != null
      ? `${Math.round(summary.soc_min)}-${Math.round(summary.soc_max)}%`
      : null;

  // Compact ETA: drop the leading "~" and fold "(24.8V)" into "/24.8V".
  const etaCompact = eta ? eta.label.replace(/^~/, "").replace(/\s*\(([\d.]+)V\)$/, "/$1V") : null;
  const batteryCaps = etaCompact
    ? [`ETA ${etaCompact}`]
    : switchT
      ? [practical.stateLabel]
      : socRange
        ? [`Range ${socRange}`]
        : [];

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
      path: "M 274 66 C 338 66, 352 150, 398 150",
      active: f.pvToBattery > FLOW_MIN_KW,
      color: C.solar,
      label: f.pvToBattery > FLOW_MIN_KW ? linkLabel(f.pvToBattery) : undefined,
      at: { x: 339, y: 108 },
    },
    {
      id: "grid-batt",
      path: "M 274 234 C 338 234, 352 150, 398 150",
      active: f.gridToBattery > FLOW_MIN_KW || f.gridToBatteryReported,
      color: C.grid,
      label: f.gridToBattery > FLOW_MIN_KW ? linkLabel(f.gridToBattery, f.gridInferred) : undefined,
      at: { x: 339, y: 192 },
    },
    {
      id: "batt-load",
      path: "M 642 150 L 766 150",
      active: f.batteryToLoad > FLOW_MIN_KW || f.batteryToLoadReported,
      color: C.discharge,
      label: f.batteryToLoad > FLOW_MIN_KW ? linkLabel(f.batteryToLoad) : undefined,
      at: { x: 704, y: 150 },
    },
    {
      id: "pv-load",
      path: "M 274 66 C 470 2, 590 2, 766 150",
      active: f.pvToLoad > FLOW_MIN_KW,
      color: C.solar,
      label: f.pvToLoad > FLOW_MIN_KW ? linkLabel(f.pvToLoad) : undefined,
      at: { x: 520, y: 30 },
    },
    {
      id: "grid-load",
      path: "M 274 234 C 470 298, 590 298, 766 150",
      active: f.gridToLoad > FLOW_MIN_KW,
      color: C.grid,
      label: f.gridToLoad > FLOW_MIN_KW ? linkLabel(f.gridToLoad, f.gridInferred) : undefined,
      at: { x: 520, y: 272 },
    },
  ];

  return (
    <div className="animate-[fadein_0.5s_ease_both] flex flex-col overflow-hidden rounded-card border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3.5 px-5 pb-1.5 pt-3.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-dim">
          <Workflow size={14} strokeWidth={1.8} /> Power flow
        </span>
      </div>

      <div className="px-5 pb-3 pt-1">
        <FlowDiagram width={1034} height={300} nodes={nodes} links={links} />
      </div>

      {unmeasuredCharge && (
        <p className="px-4 pb-3 text-xs text-faint">
          Charging path reported by DESSMonitor; charge power is not metered by this protocol.
        </p>
      )}
    </div>
  );
}
