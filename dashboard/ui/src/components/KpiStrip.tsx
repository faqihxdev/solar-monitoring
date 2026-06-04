import type { ReactNode } from "react";
import { Sun, Zap, Plug, Battery } from "lucide-react";
import type { Reading, ThresholdEntry } from "../api";
import { practicalBattery } from "../batteryModel";
import { deriveFlows, FLOW_MIN_KW } from "../energy";
import { watts, powerKw, num } from "../format";
import { C, statusColor, statusShort } from "../theme";

interface Props {
  latest: Reading | null;
  voltageThresholds?: ThresholdEntry[];
}

interface Tile {
  label: string;
  icon: ReactNode;
  color: string;
  value: string;
  unit: string;
  sub: string;
}

export default function KpiStrip({ latest, voltageThresholds = [] }: Props) {
  const f = deriveFlows(latest);
  const practical = practicalBattery(latest, voltageThresholds);

  const pv = watts(latest?.pv_power);
  const load = powerKw(latest?.load_power);

  const gridV = latest?.grid_voltage;
  const gridFlow = f.gridToLoad + f.gridToBattery;
  let gridSub = f.onMains ? "Connected" : "Not in use";
  if (gridFlow > FLOW_MIN_KW) {
    const g = powerKw(gridFlow);
    gridSub = `${f.gridInferred ? "~" : ""}${g.value} ${g.unit} drawn`;
    if (f.gridToBatteryReported) gridSub += " + batt path";
  } else if (f.gridToBatteryReported) {
    gridSub = "Battery path reported";
  } else if (f.gridKw < -FLOW_MIN_KW) {
    const g = powerKw(Math.abs(f.gridKw));
    gridSub = `${g.value} ${g.unit} exported`;
  }

  const battPower = powerKw(Math.abs(f.batteryKw));
  const battColor = statusColor(latest?.battery_status);
  let battValue = "—";
  let battUnit = "";
  let battSub = `${statusShort(latest?.battery_status)} · ${practical.reportedSocLabel}`;
  if (latest?.battery_power != null && Math.abs(f.batteryKw) > FLOW_MIN_KW) {
    battValue = battPower.value;
    battUnit = battPower.unit;
    battSub = f.charging ? "Charging" : f.discharging ? "Discharging" : battSub;
  } else if (f.batteryFlowUnmetered) {
    battSub = "CHG reported, unmetered";
  } else if (latest?.battery_voltage != null) {
    battValue = num(latest.battery_voltage, 1);
    battUnit = "V";
    battSub = practical.practicalSocLabel;
  }

  let pvSub = "No production";
  if (latest?.pv_power != null && latest.pv_power > 5) {
    if (f.pvToBattery > FLOW_MIN_KW && f.pvToLoad > FLOW_MIN_KW) pvSub = "To load + battery";
    else if (f.pvToBattery > FLOW_MIN_KW) pvSub = "Charging battery";
    else if (f.pvToLoad > FLOW_MIN_KW) pvSub = "Powering load";
    else pvSub = "Producing";
  }

  let loadSub = "Idle";
  if (latest?.load_current != null && latest.load_power && latest.load_power > FLOW_MIN_KW) {
    loadSub = `${num(latest.load_current, 1)} A draw`;
  }

  const tiles: Tile[] = [
    {
      label: "Solar",
      icon: <Sun size={15} strokeWidth={1.8} />,
      color: C.solar,
      value: pv.value,
      unit: pv.unit,
      sub: pvSub,
    },
    {
      label: "Load",
      icon: <Zap size={15} strokeWidth={1.8} />,
      color: C.load,
      value: load.value,
      unit: load.unit,
      sub: loadSub,
    },
    {
      label: "Grid",
      icon: <Plug size={15} strokeWidth={1.8} />,
      color: C.grid,
      value: gridV != null ? num(gridV, 0) : "—",
      unit: gridV != null ? "V" : "",
      sub: gridSub,
    },
    {
      label: "Battery",
      icon: <Battery size={15} strokeWidth={1.8} />,
      color: battColor,
      value: battValue,
      unit: battUnit,
      sub: battSub,
    },
  ];

  return (
    <div className="kpis fade-in">
      {tiles.map((t) => (
        <div className="kpi" key={t.label} style={{ borderLeftColor: t.color }}>
          <div className="kpi__head">
            <span>{t.label}</span>
            <span style={{ color: t.color }}>{t.icon}</span>
          </div>
          <div className="kpi__value mono">
            {t.value}
            {t.unit && <span className="kpi__unit">{t.unit}</span>}
          </div>
          <div className="kpi__sub">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}
