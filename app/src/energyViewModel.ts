import type { Reading } from "./api";
import { deriveFlows, FLOW_MIN_KW } from "./energy";
import { powerKw } from "./format";
import { C } from "./theme";
import { estimateBatteryPower, resolveGridPower } from "../shared/energyFlows";

export type DeviceId = "solar" | "inverter" | "battery" | "home" | "grid";
export const DEVICE_NAMES: Record<DeviceId, string> = {
  solar: "Solar panels",
  inverter: "Inverter",
  battery: "Battery",
  home: "Home",
  grid: "Grid / PLN",
};
export interface EnergyConnection {
  id: "solar" | "battery" | "home" | "grid";
  from: DeviceId;
  to: DeviceId;
  label: string;
  value: string;
  flowDetail?: string;
  active: boolean;
  inferred: boolean;
  unmetered: boolean;
  minimum?: boolean;
  color: string;
}
export function powerLabel(kw: number | null | undefined): string {
  if (kw != null && kw > 0 && kw < 0.001) return "<1 W";
  const p = powerKw(kw);
  return `${p.value}${p.unit ? ` ${p.unit}` : ""}`;
}
function minimumPowerLabel(kw: number): string {
  if (kw < 0.001) {
    const watts = Math.floor(kw * 1e6) / 1000;
    return `${watts.toLocaleString("en-US", { maximumFractionDigits: 3 })} W`;
  }
  const precision = kw >= 1 ? 100 : 1000;
  return powerLabel(Math.floor(kw * precision) / precision);
}
export function energyConnections(reading: Reading | null): EnergyConnection[] {
  const f = deriveFlows(reading);
  const grid = resolveGridPower(reading ?? {});
  const gridPower = grid.kw;
  const gridMinimum = !grid.complete && gridPower != null && gridPower > 0;
  const batteryActive = f.charging || f.discharging;
  const reportedBatteryPower =
    reading?.battery_power != null && Number.isFinite(reading.battery_power)
      ? reading.battery_power
      : null;
  const batteryNeedsEstimate =
    reportedBatteryPower == null ||
    (batteryActive && reportedBatteryPower === 0);
  const batteryEstimate = estimateBatteryPower(reading ?? {});
  const batteryInferred = batteryNeedsEstimate && batteryEstimate != null;
  const batteryPower = batteryInferred ? batteryEstimate : reportedBatteryPower;
  const batteryUnmetered =
    batteryActive && batteryNeedsEstimate && !batteryInferred;
  const batteryBelowOneWatt =
    batteryPower != null &&
    Math.abs(batteryPower) > 0 &&
    Math.abs(batteryPower) < 0.001;
  const batteryPrefix = batteryInferred && !batteryBelowOneWatt ? "≈ " : "";
  const batteryDirection = f.charging
    ? "in"
    : f.discharging
      ? "out"
      : reading?.battery_status === 0
        ? "idle"
        : "";
  const batteryWatts = batteryUnmetered
    ? "Unmetered"
    : batteryPower == null
      ? null
      : batteryBelowOneWatt
        ? "<1 W"
        : `${batteryPrefix}${Math.round(Math.abs(batteryPower) * 1000).toLocaleString("en-US")} W`;
  return [
    {
      id: "solar",
      from: "solar",
      to: "inverter",
      label: "Solar DC",
      value: powerLabel(
        reading?.pv_power == null ? null : reading.pv_power / 1000,
      ),
      active: f.solarKw > FLOW_MIN_KW,
      inferred: false,
      unmetered: false,
      color: C.solar,
    },
    {
      id: "grid",
      from: (gridPower ?? 0) < 0 ? "inverter" : "grid",
      to: (gridPower ?? 0) < 0 ? "grid" : "inverter",
      label: "Grid AC",
      value: gridMinimum
        ? `≥ ${minimumPowerLabel(gridPower)}`
        : !grid.complete && (f.gridToBatteryReported || f.onMains)
          ? "Unmetered"
          : `${grid.inferred ? "≈ " : ""}${powerLabel(gridPower == null ? null : Math.abs(gridPower))}`,
      active: Math.abs(gridPower ?? 0) > 0 || f.gridToBatteryReported,
      inferred: grid.inferred,
      unmetered: !grid.complete,
      minimum: gridMinimum,
      color: C.grid,
    },
    {
      id: "battery",
      from: f.discharging ? "battery" : "inverter",
      to: f.discharging ? "inverter" : "battery",
      label: "Battery DC",
      value: batteryUnmetered
        ? "Unmetered"
        : `${batteryPrefix}${powerLabel(batteryPower == null ? null : Math.abs(batteryPower))}`,
      flowDetail:
        batteryWatts == null
          ? "Power unknown"
          : `${batteryWatts}${batteryDirection ? ` ${batteryDirection}` : ""}`,
      active: batteryActive,
      inferred: batteryInferred,
      unmetered: batteryUnmetered,
      color: f.discharging ? C.discharge : C.charge,
    },
    {
      id: "home",
      from: "inverter",
      to: "home",
      label: "Home AC",
      value: powerLabel(reading?.load_power),
      active: f.loadKw > FLOW_MIN_KW,
      inferred: false,
      unmetered: false,
      color: C.load,
    },
  ];
}
