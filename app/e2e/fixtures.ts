import type {
  AutomationResponse,
  ControlEntry,
  DailyPoint,
  Reading,
  ThresholdEntry,
} from "../src/api";

export function sampleReading(overrides: Partial<Reading> = {}): Reading {
  return {
    battery_soc: 83,
    battery_status: -1,
    battery_power: 1.42,
    battery_voltage: 26.7,
    mppt_battery_voltage: 26.8,
    pv_power: 3240,
    load_current: 7.9,
    load_power: 1.82,
    grid_voltage: 231,
    grid_power: 0,
    working_state: "Solar / battery",
    pv_to_load_kw: 1.82,
    battery_to_load_kw: 0,
    grid_to_load_kw: 0,
    pv_to_battery_kw: 1.42,
    grid_to_battery_kw: 0,
    polled_at: Date.now() / 1000,
    ...overrides,
  };
}
export function fixturePayload(pathname: string) {
  const now = Date.now() / 1000;
  const latest = sampleReading();
  const date = new Date().toLocaleDateString("sv", {
    timeZone: "Asia/Jakarta",
  });
  const thresholds: ThresholdEntry[] = [
    {
      id: "a7_switch_pln",
      value: 23.4,
      label: "A7 switch to PLN",
      hint: "Switch to mains",
      color: "#98afc4",
      field_id: "bat_mains_power_supply_value",
      scale: 2,
      from_device: true,
    },
    {
      id: "a6_return_pln",
      value: 25.2,
      label: "A6 return to battery",
      hint: "Return to inverter",
      color: "#a3bda5",
      field_id: "bat_power_supply_value",
      scale: 2,
      from_device: true,
    },
    {
      id: "a4_low_protection",
      value: 22.4,
      label: "Low protection",
      hint: "Protection floor",
      color: "#e39189",
      field_id: "bat_low_voltage_protection_value",
      scale: 2,
      from_device: true,
    },
  ];
  const controls: ControlEntry[] = [
    {
      id: "power_value",
      label: "Rated output",
      group: "other",
      unit: "W",
      scale: 1,
      writable: false,
      type: "number",
      raw_value: "5500",
      pack_value: 5500,
      read_at: now,
      stale_after: 300,
      stale: false,
    },
    {
      id: "bat_power_supply_value",
      label: "A6 return to battery",
      group: "battery",
      unit: "V",
      scale: 2,
      writable: true,
      type: "number",
      min: 11.2,
      max: 13.5,
      step: 0.1,
      raw_value: "12.6",
      pack_value: 25.2,
      read_at: now,
      stale_after: 300,
      stale: false,
      hint: "Return to battery above this voltage.",
    },
    {
      id: "bat_mains_power_supply_value",
      label: "A7 switch to PLN",
      group: "battery",
      unit: "V",
      scale: 2,
      writable: true,
      type: "number",
      min: 11.2,
      max: 13.5,
      step: 0.1,
      raw_value: "11.7",
      pack_value: 23.4,
      read_at: now,
      stale_after: 300,
      stale: false,
    },
    {
      id: "work_pattern_contlow",
      label: "Output priority",
      group: "other",
      unit: "",
      scale: 1,
      writable: true,
      type: "enum",
      options: [
        { value: "sbu", label: "Solar, battery, utility" },
        { value: "sub", label: "Solar, utility, battery" },
      ],
      raw_value: "sbu",
      pack_value: null,
      read_at: now,
      stale_after: 300,
      stale: false,
    },
  ];
  const points = Array.from({ length: 144 }, (_, i) => {
    const solar = Math.max(
      0,
      Math.sin((i / 144) * Math.PI) * 3.8 + Math.sin(i * 0.4) * 0.2,
    );
    const load =
      0.9 + Math.sin(i * 0.25) * 0.15 + (i > 80 && i < 105 ? 1.1 : 0);
    return sampleReading({
      polled_at: now - (144 - i) * 300,
      pv_power: solar * 1000,
      load_power: load,
      battery_soc: 32 + i * 0.35,
      battery_voltage: 24.6 + (i / 144) * 2.1,
      battery_status: solar > load ? -1 : 1,
      pv_to_load_kw: Math.min(load, solar),
      pv_to_battery_kw: Math.max(0, solar - load),
      battery_to_load_kw: Math.max(0, load - solar),
    });
  });
  const daily: DailyPoint[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (6 - i));
    const solar = [16.3, 18.7, 15.4, 22.1, 19.2, 21.6, 18.42][i],
      load = [12.8, 13.2, 14.1, 13.8, 15.1, 14.5, 12.76][i];
    return {
      date: d.toISOString().slice(0, 10),
      snapshot_count: 1450,
      solar_kwh: solar,
      load_kwh: load,
      net_kwh: solar - load,
      pv_to_load_kwh: 8.94,
      pv_to_battery_kwh: 9.48,
      battery_to_load_kwh: 3.28,
      grid_to_load_kwh: 0.54,
      coverage_pct: 98,
    };
  });
  const automation: AutomationResponse = {
    device_sn: "PREVIEW-DATA",
    automation: {
      enabled: true,
      decision: "Target reached: holding override",
      reason: "Battery is on track for the afternoon target.",
      target_voltage: 26.9,
      target_a6: 13.4,
      target_a7: 12.8,
      target_band_capped: false,
      desired_practical_soc_now: 72,
      practical_soc: 82,
      next_check_at: now + 300,
      latest,
      state: {
        device_sn: "PREVIEW-DATA",
        enabled: 1,
        target_practical_soc: 95,
        target_time: "17:15",
        baseline_a6: 12.6,
        baseline_a7: 11.7,
        active_override: 1,
        override_a6: 13.4,
        override_a7: 12.8,
        override_value: null,
        next_check_at: now + 300,
        last_decision: "holding override",
        last_reason: "On track",
        updated_at: now,
      },
    },
  };
  const common = { device_sn: "PREVIEW-DATA", server_now: now };
  switch (pathname) {
    case "/api/config":
      return {
        ...common,
        device_pn: "Preview",
        db_path: "",
        control_db_path: "",
      };
    case "/api/summary":
      return {
        ...common,
        latest,
        summary: {
          snapshot_count: 1450,
          first_polled_at: now - 86400,
          last_polled_at: now,
          soc_min: 32,
          soc_max: 83,
          first_polled_at_iso: new Date((now - 86400) * 1000).toISOString(),
          last_polled_at_iso: new Date(now * 1000).toISOString(),
        },
      };
    case "/api/thresholds":
      return {
        ...common,
        thresholds: { battery_voltage: thresholds, battery_soc: [] },
        source: "preview",
      };
    case "/api/controls":
      return { ...common, controls, source: "preview" };
    case "/api/history":
      return { ...common, hours: 12, points };
    case "/api/voltage-history":
      return {
        ...common,
        hours: 12,
        points: points.map((p) => ({
          sampled_at: p.polled_at,
          sampled_at_iso: new Date(p.polled_at * 1000).toISOString(),
          battery_voltage: p.battery_voltage,
          mppt_battery_voltage: p.mppt_battery_voltage,
          battery_soc: p.battery_soc,
          working_state: p.working_state,
        })),
      };
    case "/api/daily":
      return { ...common, end_date: date, days: 7, daily };
    case "/api/automation":
      return automation;
    case "/api/control-log":
      return {
        ...common,
        events: [
          {
            id: 1,
            device_sn: "PREVIEW-DATA",
            field_id: "bat_power_supply_value",
            action: "read",
            actor: "monitor",
            status: "success",
            reason: "Verified the current battery return voltage.",
            value_before: "12.6",
            value_after: "12.6",
            created_at: now - 180,
          },
        ],
      };
    default:
      return { error: "Preview endpoint not found" };
  }
}
