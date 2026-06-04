export const FLOW_THRESHOLD_KW = 0.01;

type Reading = Record<string, unknown>;

function numeric(value: unknown, fallback = 0): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

export function isMainsConnected(workingState: unknown): boolean {
  if (!workingState) return false;
  const state = String(workingState).toLowerCase();
  return ["mains", "grid", "utility", "on-line", "online"].some((token) =>
    state.includes(token),
  );
}

export function splitLoadSources(
  loadKw: number,
  pvKw: number,
  onMains: boolean,
  gridImportKw: number,
): [number, number, number] {
  if (loadKw <= FLOW_THRESHOLD_KW) return [0, 0, 0];
  const gridToLoad = onMains
    ? gridImportKw > FLOW_THRESHOLD_KW
      ? Math.min(loadKw, gridImportKw)
      : loadKw
    : gridImportKw > FLOW_THRESHOLD_KW
      ? Math.min(loadKw, gridImportKw)
      : 0;
  const remaining = Math.max(0, loadKw - gridToLoad);
  if (remaining <= FLOW_THRESHOLD_KW) return [0, 0, gridToLoad];
  const pvToLoad = Math.min(pvKw, remaining);
  const batteryToLoad = Math.max(0, remaining - pvToLoad);
  return [pvToLoad, batteryToLoad, gridToLoad];
}

export function inferEnergyFlows(reading: Reading): Record<string, number | boolean> {
  const pvKw = Math.max(0, numeric(reading.pv_power) / 1000);
  const loadKw = Math.max(0, numeric(reading.load_power));
  const gridKw = numeric(reading.grid_power);
  const battMag = Math.max(0, Math.abs(numeric(reading.battery_power)));
  let status = Number(reading.battery_status ?? 0);
  if (!Number.isFinite(status)) status = 0;
  const onMains = isMainsConnected(reading.working_state);

  const gridImport = gridKw > FLOW_THRESHOLD_KW ? gridKw : 0;
  const gridExport = gridKw < -FLOW_THRESHOLD_KW ? -gridKw : 0;

  const [pvToLoad, batteryToLoad, gridToLoad] = splitLoadSources(
    loadKw,
    pvKw,
    onMains,
    gridImport,
  );

  let pvRemain = Math.max(0, pvKw - pvToLoad);
  let pvToBattery = 0;
  let gridToBattery = 0;
  let gridToBatteryReported = false;
  let gridToBatteryUnmetered = false;

  if (status === -1) {
    if (pvRemain > FLOW_THRESHOLD_KW) {
      pvToBattery = pvRemain;
    }
    const measuredGridToBattery = Math.max(0, gridImport - gridToLoad);
    if (measuredGridToBattery > FLOW_THRESHOLD_KW) {
      gridToBattery = measuredGridToBattery;
      gridToBatteryReported = true;
    } else if (onMains && pvToBattery <= FLOW_THRESHOLD_KW) {
      // DESS often marks charging status while reporting 0 kW battery/grid power.
      gridToBattery = battMag > FLOW_THRESHOLD_KW ? battMag : 0;
      gridToBatteryReported = true;
      gridToBatteryUnmetered = gridToBattery <= FLOW_THRESHOLD_KW;
    }
  }

  pvRemain = Math.max(0, pvKw - pvToLoad - pvToBattery);

  return {
    pv_to_load_kw: pvToLoad,
    battery_to_load_kw: batteryToLoad,
    grid_to_load_kw: gridToLoad,
    pv_to_battery_kw: pvToBattery,
    grid_to_battery_kw: gridToBattery,
    pv_to_grid_kw: pvRemain,
    battery_to_grid_kw: gridExport,
    grid_to_battery_reported: gridToBatteryReported,
    grid_to_battery_unmetered: gridToBatteryUnmetered,
    battery_flow_unmetered: status === -1 && battMag <= FLOW_THRESHOLD_KW,
    on_mains: onMains,
    charging: status === -1,
    discharging: status === 1,
  };
}

export function effectiveGridPower(reading: Reading): {
  grid_power_kw: number;
  grid_power_inferred: boolean;
} {
  const apiKw = numeric(reading.grid_power);
  if (Math.abs(apiKw) > FLOW_THRESHOLD_KW) {
    return { grid_power_kw: apiKw, grid_power_inferred: false };
  }

  let inferredImport: number;
  let inferredExport: number;
  if (reading.grid_to_load_kw != null && reading.grid_to_battery_kw != null) {
    inferredImport = numeric(reading.grid_to_load_kw) + numeric(reading.grid_to_battery_kw);
    inferredExport = numeric(reading.pv_to_grid_kw) + numeric(reading.battery_to_grid_kw);
  } else {
    const flows = inferEnergyFlows(reading);
    inferredImport = numeric(flows.grid_to_load_kw) + numeric(flows.grid_to_battery_kw);
    inferredExport = numeric(flows.pv_to_grid_kw) + numeric(flows.battery_to_grid_kw);
  }

  if (inferredImport > FLOW_THRESHOLD_KW) {
    return { grid_power_kw: inferredImport, grid_power_inferred: true };
  }
  if (inferredExport > FLOW_THRESHOLD_KW) {
    return { grid_power_kw: -inferredExport, grid_power_inferred: true };
  }
  return { grid_power_kw: apiKw, grid_power_inferred: false };
}
