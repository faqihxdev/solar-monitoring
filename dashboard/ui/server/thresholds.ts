import type { DessmonitorClient } from "./dessClient";
import type { DeviceSettings } from "./types";

const A6_RETURN_FROM_PLN_V = 27.0;
const A7_SWITCH_TO_PLN_V = 25.2;
const A5_LOW_BATTERY_RECOVERY_V = 26.0;
const A4_LOW_VOLTAGE_PROTECT_V = 23.4;
const SOC_RESUME_INVERTER_PCT = 25.0;
const SOC_SWITCH_TO_MAINS_PCT = 15.0;
const PACK_VOLTAGE_SCALE = 2.0;

interface ThresholdField {
  fieldId: string;
  catalogId: string;
  label: string;
  hint: string;
  color: string;
  group: "battery_voltage" | "battery_soc";
  scale: number;
}

const THRESHOLD_FIELDS: ThresholdField[] = [
  {
    fieldId: "lithium_battery_conthigh",
    catalogId: "soc_resume_inverter",
    label: "Resume inverter",
    hint: "lithium_battery_conthigh - battery/inverter resumes when SOC >= this",
    color: "#6b9e3e",
    group: "battery_soc",
    scale: 1,
  },
  {
    fieldId: "lithium_battery_contlow",
    catalogId: "soc_to_mains",
    label: "Switch to grid",
    hint: "lithium_battery_contlow - switch to mains when SOC <= this",
    color: "#b85c2a",
    group: "battery_soc",
    scale: 1,
  },
  {
    fieldId: "bat_power_supply_value",
    catalogId: "a6_return_pln",
    label: "Return to inverter [A6]",
    hint: "A6 bat_power_supply_value (x2 = 24 V pack) - leave mains bypass when pack >= this",
    color: "#6b9e3e",
    group: "battery_voltage",
    scale: PACK_VOLTAGE_SCALE,
  },
  {
    fieldId: "bat_low_voltage_recovery_value",
    catalogId: "a5_low_recovery",
    label: "Low battery recovery [A5]",
    hint: "A5 bat_low_voltage_recovery_value (x2 = 24 V pack) - recover output after low-voltage protection",
    color: "#458f6f",
    group: "battery_voltage",
    scale: PACK_VOLTAGE_SCALE,
  },
  {
    fieldId: "bat_mains_power_supply_value",
    catalogId: "a7_switch_pln",
    label: "Switch to grid [A7]",
    hint: "A7 bat_mains_power_supply_value (x2 = 24 V pack) - mains bypass when pack <= this",
    color: "#b85c2a",
    group: "battery_voltage",
    scale: PACK_VOLTAGE_SCALE,
  },
  {
    fieldId: "bat_low_voltage_protection_value",
    catalogId: "a4_low_protection",
    label: "Low voltage protection [A4]",
    hint: "A4 bat_low_voltage_protection_value (x2 = 24 V pack) - inverter output cutoff floor",
    color: "#b14a4a",
    group: "battery_voltage",
    scale: PACK_VOLTAGE_SCALE,
  },
];

const DEFAULTS: Record<string, number> = {
  soc_resume_inverter: SOC_RESUME_INVERTER_PCT,
  soc_to_mains: SOC_SWITCH_TO_MAINS_PCT,
  a6_return_pln: A6_RETURN_FROM_PLN_V,
  a5_low_recovery: A5_LOW_BATTERY_RECOVERY_V,
  a7_switch_pln: A7_SWITCH_TO_PLN_V,
  a4_low_protection: A4_LOW_VOLTAGE_PROTECT_V,
};

function entry(spec: ThresholdField, value: number, fromDevice: boolean) {
  return {
    id: spec.catalogId,
    value,
    label: spec.label,
    hint: spec.hint,
    color: spec.color,
    field_id: spec.fieldId,
    scale: spec.scale,
    from_device: fromDevice,
  };
}

export function thresholdCatalogDefaults() {
  const catalog = { battery_voltage: [] as unknown[], battery_soc: [] as unknown[] };
  for (const spec of THRESHOLD_FIELDS) {
    catalog[spec.group].push(entry(spec, DEFAULTS[spec.catalogId], false));
  }
  return catalog;
}

export async function fetchThresholdCatalog(client: DessmonitorClient, settings: DeviceSettings) {
  const catalog = { battery_voltage: [] as unknown[], battery_soc: [] as unknown[] };
  let deviceCount = 0;

  for (const spec of THRESHOLD_FIELDS) {
    let value: number | null = null;
    let fromDevice = false;
    try {
      const payload = await client.queryDeviceCtrlValue({ ...settings, fieldId: spec.fieldId });
      const dat = (payload.dat ?? {}) as Record<string, unknown>;
      const raw = dat.val;
      if (raw != null && !["", "--"].includes(String(raw).trim())) {
        value = Number(raw) * spec.scale;
        if (Number.isFinite(value)) {
          fromDevice = true;
          deviceCount += 1;
        }
      }
    } catch {
      value = null;
    }
    catalog[spec.group].push(entry(spec, value ?? DEFAULTS[spec.catalogId], fromDevice));
  }

  return {
    thresholds: catalog,
    source:
      deviceCount === THRESHOLD_FIELDS.length ? "device" : deviceCount > 0 ? "mixed" : "defaults",
    fields_read: deviceCount,
  };
}
