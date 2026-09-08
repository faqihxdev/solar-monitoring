// Preserve small readings in power arithmetic; motion thresholds belong in the UI.
const EPSILON_KW = 1e-9;
export const FLOW_THRESHOLD_KW = 0.01;

interface PowerReading {
  pv_power?: unknown;
  load_power?: unknown;
  grid_power?: unknown;
  grid_voltage?: unknown;
  battery_power?: unknown;
  battery_status?: unknown;
  working_state?: unknown;
}

function number(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function nonnegative(value: unknown): number | null {
  const result = number(value);
  return result != null && result >= 0 ? result : null;
}
function clean(value: number): number {
  return Math.abs(value) < EPSILON_KW ? 0 : value;
}
export function isMainsConnected(workingState: unknown): boolean {
  if (!workingState) return false;
  const state = String(workingState).toLowerCase();
  if (/off[\s-]?grid/.test(state)) return false;
  return ["mains", "grid", "utility", "on-line", "online"].some((token) =>
    state.includes(token),
  );
}

export interface GridPower {
  kw: number | null;
  inferred: boolean;
  complete: boolean;
}
export function resolveGridPower(reading: PowerReading): GridPower {
  const raw = number(reading.grid_power);
  if (raw != null && raw !== 0)
    return { kw: raw, inferred: false, complete: true };
  const onMains = isMainsConnected(reading.working_state);
  if (!onMains) {
    const disconnected =
      number(reading.grid_voltage) === 0 ||
      /battery|solar|inverter|off.?grid/i.test(
        String(reading.working_state ?? ""),
      );
    if (raw === 0 || disconnected)
      return { kw: 0, inferred: raw == null, complete: true };
    return { kw: null, inferred: false, complete: false };
  }
  const pvW = nonnegative(reading.pv_power);
  const load = nonnegative(reading.load_power);
  const battery = number(reading.battery_power);
  const status = number(reading.battery_status);
  const signedBattery =
    status === 0
      ? 0
      : battery != null && battery !== 0 && (status === -1 || status === 1)
        ? Math.abs(battery) * (status === -1 ? 1 : -1)
        : null;
  if (pvW != null && load != null && signedBattery != null) {
    return {
      kw: clean(load + signedBattery - pvW / 1000),
      inferred: true,
      complete: true,
    };
  }
  // In mains/bypass mode PLN supplies the home. With solar charging and no
  // battery meter, solar supplies the battery. Unknown night-time charging
  // leaves only a minimum grid demand.
  if (status === -1 && pvW != null) {
    return { kw: load, inferred: load != null, complete: pvW > 0 };
  }
  return { kw: null, inferred: false, complete: false };
}

export function estimateBatteryPower(reading: PowerReading): number | null {
  const status = number(reading.battery_status);
  if (status === 0) return 0;
  if (status !== -1 && status !== 1) return null;
  const pvW = nonnegative(reading.pv_power);
  const load = nonnegative(reading.load_power);
  const grid = resolveGridPower(reading);
  if (!grid.complete || pvW == null) return null;
  // The unknown home demand cancels PLN's home demand in bypass mode.
  if (
    load == null &&
    isMainsConnected(reading.working_state) &&
    !number(reading.grid_power) &&
    status === -1 &&
    pvW > 0
  )
    return pvW / 1000;
  if (load == null || grid.kw == null) return null;
  const netCharge = clean(pvW / 1000 + grid.kw - load);
  if ((status === -1 && netCharge < 0) || (status === 1 && netCharge > 0))
    return null;
  return Math.abs(netCharge);
}

export function splitLoadSources(
  loadKw: number,
  pvKw: number,
  onMains: boolean,
  gridImportKw: number,
): [number, number, number] {
  if (loadKw <= 0) return [0, 0, 0];
  const gridToLoad =
    gridImportKw > 0 ? Math.min(loadKw, gridImportKw) : onMains ? loadKw : 0;
  const remaining = Math.max(0, loadKw - gridToLoad);
  const pvToLoad = Math.min(pvKw, remaining);
  return [pvToLoad, Math.max(0, remaining - pvToLoad), gridToLoad];
}

export function inferEnergyFlows(
  reading: PowerReading,
): Record<string, number | boolean> {
  const pvKw = (nonnegative(reading.pv_power) ?? 0) / 1000;
  const loadKw = nonnegative(reading.load_power) ?? 0;
  const status = number(reading.battery_status);
  const battery = Math.abs(number(reading.battery_power) ?? 0);
  const onMains = isMainsConnected(reading.working_state);
  const grid = resolveGridPower(reading);
  const gridImport = Math.max(0, grid.kw ?? 0);
  const gridExport = Math.max(0, -(grid.kw ?? 0));
  const [pvToLoad, batteryToLoad, gridToLoad] = splitLoadSources(
    loadKw,
    pvKw,
    onMains && !grid.complete,
    gridImport,
  );
  const pvRemaining = Math.max(0, pvKw - pvToLoad);
  const pvToGrid = Math.min(pvRemaining, gridExport);
  const pvToBattery = status === -1 ? Math.max(0, pvRemaining - pvToGrid) : 0;
  const gridToBattery =
    status === -1 ? Math.max(0, gridImport - gridToLoad) : 0;
  const gridChargingUnknown = status === -1 && onMains && !grid.complete;
  return {
    pv_to_load_kw: pvToLoad,
    battery_to_load_kw: status === 1 ? batteryToLoad : 0,
    grid_to_load_kw: gridToLoad,
    pv_to_battery_kw: pvToBattery,
    grid_to_battery_kw: gridToBattery,
    pv_to_grid_kw: pvToGrid,
    battery_to_grid_kw: status === 1 ? Math.max(0, gridExport - pvToGrid) : 0,
    grid_to_battery_reported: gridToBattery > 0 || gridChargingUnknown,
    grid_to_battery_unmetered: gridChargingUnknown,
    battery_flow_unmetered: (status === -1 || status === 1) && battery === 0,
    on_mains: onMains,
    charging: status === -1,
    discharging: status === 1,
  };
}

export function effectiveGridPower(reading: PowerReading): {
  grid_power_kw: number;
  grid_power_inferred: boolean;
} {
  const grid = resolveGridPower(reading);
  return { grid_power_kw: grid.kw ?? 0, grid_power_inferred: grid.inferred };
}
