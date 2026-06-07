export type ControlValueType = "number" | "enum" | "text";

export interface ControlOption {
  value: string;
  label: string;
}

export interface ControlField {
  id: string;
  label: string;
  group: "battery" | "other";
  unit: string;
  scale: number;
  writable: boolean;
  type: ControlValueType;
  min?: number;
  max?: number;
  step?: number;
  options?: ControlOption[];
  hint?: string;
}

export const A6_FIELD_ID = "bat_power_supply_value";
export const A7_FIELD_ID = "bat_mains_power_supply_value";
export const BASELINE_A6_SINGLE_V = 12.4;
export const BASELINE_A7_SINGLE_V = 11.7;
export const A6_MIN_SINGLE_V = 12.4;
export const A6_MAX_SINGLE_V = 13.5;
export const A7_MIN_SINGLE_V = 11.2;
export const A7_MAX_SINGLE_V = A6_MAX_SINGLE_V;
export const A6_TOLERANCE_SINGLE_V = 0.05;
export const AUTOMATION_MIN_WRITE_INTERVAL_SECONDS = 5 * 60;
export const AUTOMATION_DAILY_WRITE_CAP = 96;
export const AUTOMATION_HARD_DAILY_WRITE_CAP = 192;

export const CONTROL_FIELDS: ControlField[] = [
  {
    id: "bat_single_battery_average_charge_setting",
    label: "Single battery average charge [A2]",
    group: "battery",
    unit: "V",
    scale: 2,
    writable: true,
    type: "number",
    min: 12,
    max: 15,
    step: 0.1,
    hint: "Per-12V setting; pack value is shown as x2.",
  },
  {
    id: "bat_low_voltage_protection_value",
    label: "Low voltage protection [A4]",
    group: "battery",
    unit: "V",
    scale: 2,
    writable: true,
    type: "number",
    min: 10.8,
    max: 12.5,
    step: 0.1,
    hint: "Protection floor. Keep 11.2V unless intentionally changing battery safety margin.",
  },
  {
    id: A6_FIELD_ID,
    label: "Return to inverter [A6]",
    group: "battery",
    unit: "V",
    scale: 2,
    writable: true,
    type: "number",
    min: A6_MIN_SINGLE_V,
    max: A6_MAX_SINGLE_V,
    step: 0.1,
    hint: "Automation uses this as the battery-preserve lever.",
  },
  {
    id: "bat_single_battery_float_charge_setting",
    label: "Single battery float charge [A3]",
    group: "battery",
    unit: "V",
    scale: 2,
    writable: true,
    type: "number",
    min: 12,
    max: 14.5,
    step: 0.1,
  },
  {
    id: A7_FIELD_ID,
    label: "Switch to grid [A7]",
    group: "battery",
    unit: "V",
    scale: 2,
    writable: true,
    type: "number",
    min: A7_MIN_SINGLE_V,
    max: A7_MAX_SINGLE_V,
    step: 0.1,
    hint: "Battery-to-PLN threshold. Must stay below A6; automation does not change this.",
  },
  {
    id: "bat_charging_current",
    label: "AC charging current [A1]",
    group: "battery",
    unit: "A",
    scale: 1,
    writable: true,
    type: "number",
    min: 0,
    max: 60,
    step: 1,
    hint: "Keep 0A when grid charging is disabled.",
  },
  {
    id: "bat_low_voltage_recovery_value",
    label: "Low battery recovery [A5]",
    group: "battery",
    unit: "V",
    scale: 2,
    writable: true,
    type: "number",
    min: 11.3,
    max: 13.5,
    step: 0.1,
  },
  {
    id: "lithium_battery_conthigh",
    label: "Lithium battery to inverter SOC",
    group: "other",
    unit: "%",
    scale: 1,
    writable: true,
    type: "number",
    min: 0,
    max: 100,
    step: 1,
  },
  {
    id: "charging_gear_setting",
    label: "Charging gear setting",
    group: "other",
    unit: "",
    scale: 1,
    writable: true,
    type: "enum",
    options: [
      { value: "C0", label: "C0 - AC charging disabled" },
      { value: "C1", label: "C1 - AC charging enabled" },
    ],
  },
  {
    id: "generator_mode_setting",
    label: "Generator mode setting",
    group: "other",
    unit: "",
    scale: 1,
    writable: true,
    type: "enum",
    options: [
      { value: "0", label: "Normal mode" },
      { value: "1", label: "Generator mode" },
    ],
  },
  {
    id: "energy_use_modelph",
    label: "Remote switch setting",
    group: "other",
    unit: "",
    scale: 1,
    writable: false,
    type: "enum",
    options: [
      { value: "0", label: "Off state" },
      { value: "1", label: "Power-on state" },
    ],
    hint: "Read-only here because this field may reflect the physical remote switch.",
  },
  {
    id: "lithium_battery_low_voltage_conthigh",
    label: "Lithium battery low voltage recovery SOC",
    group: "other",
    unit: "%",
    scale: 1,
    writable: true,
    type: "number",
    min: 0,
    max: 100,
    step: 1,
  },
  {
    id: "power_value",
    label: "Power Value Setting",
    group: "other",
    unit: "W",
    scale: 1,
    writable: false,
    type: "number",
  },
  {
    id: "lithium_battery_contlow",
    label: "Lithium battery to mains SOC",
    group: "other",
    unit: "%",
    scale: 1,
    writable: true,
    type: "number",
    min: 0,
    max: 100,
    step: 1,
  },
  {
    id: "output_voltage",
    label: "Output voltage",
    group: "other",
    unit: "",
    scale: 1,
    writable: true,
    type: "enum",
    options: [
      { value: "220", label: "220V" },
      { value: "230", label: "230V" },
    ],
  },
  {
    id: "current_limit_setting",
    label: "Current Limit Setting",
    group: "other",
    unit: "A",
    scale: 1,
    writable: true,
    type: "number",
    min: 0,
    max: 60,
    step: 1,
  },
  {
    id: "lithium_battery_charging_contlow",
    label: "Lithium battery discharge cut-off SOC",
    group: "other",
    unit: "%",
    scale: 1,
    writable: true,
    type: "number",
    min: 0,
    max: 100,
    step: 1,
  },
  {
    id: "lithium_battery_low_voltage_contlow",
    label: "Reserved charging cut-off SOC",
    group: "other",
    unit: "%",
    scale: 1,
    writable: false,
    type: "number",
    hint: "Reserved field in device docs; leave unchanged.",
  },
  {
    id: "frequency_setting",
    label: "Frequency",
    group: "other",
    unit: "",
    scale: 1,
    writable: true,
    type: "enum",
    options: [
      { value: "50", label: "50Hz" },
      { value: "60", label: "60Hz" },
    ],
  },
  {
    id: "lithium_battery_charging_conthigh",
    label: "Lithium battery charging cut-off SOC",
    group: "other",
    unit: "%",
    scale: 1,
    writable: true,
    type: "number",
    min: 0,
    max: 100,
    step: 1,
  },
  {
    id: "battery_type_conthigh",
    label: "Battery type [A10]",
    group: "other",
    unit: "",
    scale: 1,
    writable: false,
    type: "text",
  },
  {
    id: "battery_restart",
    label: "Battery restart",
    group: "other",
    unit: "",
    scale: 1,
    writable: false,
    type: "text",
  },
  {
    id: "work_pattern_contlow",
    label: "Work pattern [A0]",
    group: "other",
    unit: "",
    scale: 1,
    writable: true,
    type: "enum",
    options: [
      { value: "3", label: "Inverse priority" },
    ],
  },
];

export function controlField(fieldId: string): ControlField | undefined {
  return CONTROL_FIELDS.find((field) => field.id === fieldId);
}

