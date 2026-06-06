import type { Reading } from "./api";
import { isOnMains } from "./format";

export const FLOW_MIN_KW = 0.01;

export interface Flows {
  pvToLoad: number;
  pvToBattery: number;
  batteryToLoad: number;
  batteryToLoadReported: boolean;
  gridToLoad: number;
  gridToBattery: number;
  solarKw: number;
  loadKw: number;
  gridKw: number;
  batteryKw: number;
  soc: number | null;
  status: number;
  onMains: boolean;
  charging: boolean;
  discharging: boolean;
  gridInferred: boolean;
  gridToBatteryReported: boolean;
  gridToBatteryUnmetered: boolean;
  batteryFlowUnmetered: boolean;
}

function n(v: number | null | undefined): number {
  return v == null || Number.isNaN(v) ? 0 : Number(v);
}

export function deriveFlows(r: Reading | null | undefined): Flows {
  const status = Math.trunc(n(r?.battery_status));
  const pvToLoad = n(r?.pv_to_load_kw);
  const batteryToLoad = n(r?.battery_to_load_kw);
  const gridToLoad = n(r?.grid_to_load_kw);
  const loadKw = n(r?.load_power);
  const batteryToLoadReported =
    status === 1 &&
    batteryToLoad > 0 &&
    batteryToLoad <= FLOW_MIN_KW &&
    loadKw > FLOW_MIN_KW &&
    pvToLoad + gridToLoad > FLOW_MIN_KW;
  return {
    pvToLoad,
    pvToBattery: n(r?.pv_to_battery_kw),
    batteryToLoad,
    batteryToLoadReported,
    gridToLoad,
    gridToBattery: n(r?.grid_to_battery_kw),
    solarKw: n(r?.pv_power) / 1000,
    loadKw,
    gridKw: r?.grid_power_effective != null ? n(r.grid_power_effective) : n(r?.grid_power),
    batteryKw: n(r?.battery_power),
    soc: r?.battery_soc ?? null,
    status,
    onMains: isOnMains(r?.working_state),
    charging: status === -1,
    discharging: status === 1,
    gridInferred: Boolean(r?.grid_power_inferred),
    gridToBatteryReported: Boolean(r?.grid_to_battery_reported),
    gridToBatteryUnmetered: Boolean(r?.grid_to_battery_unmetered),
    batteryFlowUnmetered: Boolean(r?.battery_flow_unmetered),
  };
}

export interface LoadSplit {
  name: "Solar" | "Battery" | "Grid";
  kw: number;
  pct: number;
}

export function loadSplit(r: Reading | null | undefined): LoadSplit[] {
  const f = deriveFlows(r);
  const all: LoadSplit[] = [
    { name: "Solar", kw: f.pvToLoad, pct: 0 },
    { name: "Battery", kw: f.batteryToLoad, pct: 0 },
    { name: "Grid", kw: f.gridToLoad, pct: 0 },
  ];
  const parts = all.filter((p) => p.kw > FLOW_MIN_KW);
  const total = parts.reduce((s, p) => s + p.kw, 0);
  if (total <= FLOW_MIN_KW) return [];
  return parts
    .map((p) => ({ ...p, pct: Math.round((p.kw / total) * 100) }))
    .sort((a, b) => b.kw - a.kw);
}
