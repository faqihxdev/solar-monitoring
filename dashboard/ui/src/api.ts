export interface ReadingsRaw {
  [key: string]: string | null | undefined;
}

export interface Reading {
  device_gts?: string | null;
  battery_soc: number | null;
  battery_status: number | null;
  battery_power: number | null;
  battery_voltage: number | null;
  mppt_battery_voltage: number | null;
  pv_power: number | null;
  load_current: number | null;
  load_power: number | null;
  grid_voltage: number | null;
  grid_power: number | null;
  working_state: string | null;
  pv_to_load_kw: number | null;
  battery_to_load_kw: number | null;
  grid_to_load_kw: number | null;
  pv_to_battery_kw: number | null;
  grid_to_battery_kw: number | null;
  grid_to_battery_reported?: boolean | number | null;
  grid_to_battery_unmetered?: boolean | number | null;
  battery_flow_unmetered?: boolean | number | null;
  grid_power_effective?: number | null;
  grid_power_inferred?: boolean;
  battery_voltage_sampled_at?: number | null;
  battery_voltage_sampled_at_raw?: string | null;
  polled_at: number;
  polled_at_iso?: string | null;
  readings_raw?: ReadingsRaw;
}

export interface Summary {
  snapshot_count: number;
  first_polled_at: number | null;
  last_polled_at: number | null;
  soc_min: number | null;
  soc_max: number | null;
  first_polled_at_iso: string | null;
  last_polled_at_iso: string | null;
}

export interface SummaryResponse {
  device_sn: string;
  summary: Summary;
  latest: Reading | null;
  server_now?: number;
}

export interface ConfigResponse {
  device_sn: string;
  device_pn: string;
  db_path: string;
  server_now: number;
}

export type HistoryPoint = Reading;

export interface HistoryResponse {
  device_sn: string;
  hours: number;
  server_now: number;
  points: HistoryPoint[];
}

export interface VoltagePoint {
  sampled_at: number;
  sampled_at_iso: string;
  sampled_at_raw?: string | null;
  battery_voltage: number | null;
  mppt_battery_voltage: number | null;
  working_state: string | null;
  battery_soc: number | null;
}

export interface VoltageResponse {
  device_sn: string;
  hours: number;
  server_now: number;
  points: VoltagePoint[];
}

export interface ThresholdEntry {
  id: string;
  value: number;
  label: string;
  hint: string;
  color: string;
  field_id: string;
  scale: number;
  from_device: boolean;
}

export interface ThresholdsResponse {
  device_sn: string;
  thresholds: {
    battery_voltage: ThresholdEntry[];
    battery_soc: ThresholdEntry[];
  };
  source: string;
  fields_read?: number;
  error?: string;
}

export interface ControlAuditEntry {
  id: string;
  name: string;
  label: string;
  value: string | number | null;
  unit: string;
  scale: number;
  pack_value: number | null;
  pack_unit: string;
}

export interface ControlAuditResponse {
  device_sn: string;
  controls: ControlAuditEntry[];
  errors: { id: string; error: string }[];
  source: string;
  error?: string;
}

export interface DailyPoint {
  date: string;
  snapshot_count: number;
  solar_kwh: number;
  load_kwh: number;
  net_kwh: number;
  pv_to_load_kwh: number;
  pv_to_battery_kwh: number;
  battery_to_load_kwh: number;
  grid_to_load_kwh: number;
  coverage_pct: number;
}

export interface DailyEnergyResponse {
  device_sn: string;
  end_date: string;
  days: number;
  server_now: number;
  daily: DailyPoint[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  config: () => getJson<ConfigResponse>("/api/config"),
  summary: () => getJson<SummaryResponse>("/api/summary"),
  thresholds: () => getJson<ThresholdsResponse>("/api/thresholds"),
  controlAudit: () => getJson<ControlAuditResponse>("/api/control-audit"),
  history: (hours: number) =>
    getJson<HistoryResponse>(`/api/history?hours=${hours}`),
  voltage: (hours: number) =>
    getJson<VoltageResponse>(`/api/voltage-history?hours=${hours}`),
  daily: (date: string, days = 7) =>
    getJson<DailyEnergyResponse>(`/api/daily?date=${date}&days=${days}`),
};
