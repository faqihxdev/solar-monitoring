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
  control_db_path: string;
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
  refresh_started?: boolean;
  refreshing?: boolean;
  last_refresh_at?: number | null;
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

export interface ControlOption {
  value: string;
  label: string;
}

export interface ControlEntry {
  id: string;
  label: string;
  group: "battery" | "other";
  unit: string;
  scale: number;
  writable: boolean;
  type: "number" | "enum" | "text";
  min?: number;
  max?: number;
  step?: number;
  options?: ControlOption[];
  hint?: string;
  raw_value: string | null;
  pack_value: number | null;
  read_at: number | null;
  stale_after: number;
  stale: boolean;
}

export interface ControlsResponse {
  device_sn: string;
  controls: ControlEntry[];
  errors?: { id: string; error: string }[];
  source: string;
}

export interface ControlEvent {
  id: number;
  device_sn: string;
  field_id: string | null;
  action: string;
  actor: string;
  status: string;
  reason: string;
  value_before: string | null;
  value_after: string | null;
  created_at: number;
  details?: Record<string, unknown> | null;
}

export interface ControlLogResponse {
  device_sn: string;
  events: ControlEvent[];
}

export interface AutomationState {
  device_sn: string;
  enabled: number;
  target_practical_soc: number;
  target_time: string;
  baseline_a6: number;
  baseline_a7: number;
  active_override: number;
  override_a6: number | null;
  override_a7: number | null;
  override_value: number | null;
  next_check_at: number | null;
  last_decision: string | null;
  last_reason: string | null;
  updated_at: number;
}

export interface AutomationStatus {
  enabled: boolean;
  state: AutomationState;
  decision: string;
  reason: string;
  target_voltage: number | null;
  target_a6: number | null;
  target_a7: number | null;
  target_band_capped: boolean;
  desired_practical_soc_now: number | null;
  latest: Reading | null;
  practical_soc: number | null;
  next_check_at: number | null;
}

export interface AutomationResponse {
  device_sn: string;
  automation: AutomationStatus;
  state?: AutomationState;
}

export interface AutomationUpdateRequest {
  enabled?: boolean;
  target_practical_soc?: number;
  target_time?: string;
  baseline_a6?: number;
  baseline_a7?: number;
}

export interface ControlWriteResponse {
  device_sn: string;
  result: {
    field_id: string;
    status: "skipped" | "written" | "failed";
    reason: string;
    before: string | null;
    requested: string;
    verified: string | null;
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(String(payload?.error ?? `${url} -> ${res.status}`));
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => getJson<ConfigResponse>("/api/config"),
  summary: () => getJson<SummaryResponse>("/api/summary"),
  thresholds: () => getJson<ThresholdsResponse>("/api/thresholds"),
  controlAudit: () => getJson<ControlAuditResponse>("/api/control-audit"),
  controls: () => getJson<ControlsResponse>("/api/controls"),
  controlLog: (limit = 80) => getJson<ControlLogResponse>(`/api/control-log?limit=${limit}`),
  readAllControls: () => postJson<ControlsResponse>("/api/controls/read-all"),
  readControl: (id: string) =>
    postJson<{ device_sn: string; control: ControlEntry }>(`/api/controls/${id}/read`),
  writeControl: (id: string, value: string, reason: string) =>
    postJson<ControlWriteResponse>(`/api/controls/${id}/write`, { value, reason }),
  runA6Test: () => postJson<{ device_sn: string; result: Record<string, unknown> }>("/api/controls/a6-test"),
  automation: () => getJson<AutomationResponse>("/api/automation"),
  updateAutomation: (body: AutomationUpdateRequest) =>
    postJson<AutomationResponse>("/api/automation", body),
  evaluateAutomation: () => postJson<AutomationResponse>("/api/automation/evaluate"),
  history: (hours: number) =>
    getJson<HistoryResponse>(`/api/history?hours=${hours}`),
  voltage: (hours: number) =>
    getJson<VoltageResponse>(`/api/voltage-history?hours=${hours}`),
  daily: (date: string, days = 7) =>
    getJson<DailyEnergyResponse>(`/api/daily?date=${date}&days=${days}`),
};
