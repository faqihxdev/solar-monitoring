import fs from "node:fs";
import path from "node:path";
import { config } from "./env";
import { DessmonitorClient } from "./dessClient";
import { extractReadings } from "./store";
import type { DeviceSettings, JsonRecord } from "./types";

const CONTROL_FIELDS = [
  "charging_gear_setting",
  "bat_charging_current",
  "work_pattern_contlow",
  "battery_type_conthigh",
  "bat_power_supply_value",
  "bat_mains_power_supply_value",
  "bat_single_battery_float_charge_setting",
  "bat_single_battery_average_charge_setting",
  "lithium_battery_conthigh",
  "lithium_battery_contlow",
];

const settings: Required<DeviceSettings> = {
  pn: config.pn,
  sn: config.sn,
  devcode: config.devcode,
  devaddr: config.devaddr,
  i18n: config.i18n,
};

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readControls(client: DessmonitorClient): Promise<JsonRecord> {
  const values: JsonRecord = {};
  for (const fieldId of CONTROL_FIELDS) {
    try {
      const payload = await client.queryDeviceCtrlValue({ ...settings, fieldId });
      values[fieldId] = ((payload.dat ?? {}) as JsonRecord).val ?? null;
    } catch (exc) {
      values[fieldId] = { error: String(exc instanceof Error ? exc.message : exc) };
    }
  }
  return values;
}

async function snapshot(client: DessmonitorClient, includeControls: boolean): Promise<JsonRecord> {
  const last = await client.queryDeviceLastData(settings);
  const flow = await client.queryDeviceEnergyFlow(settings);
  const raw = await client.queryDeviceLastRawData(settings);
  const { readings, readingsRaw } = extractReadings(
    (last.dat ?? {}) as JsonRecord,
    (flow.dat ?? {}) as JsonRecord,
  );
  const row: JsonRecord = {
    captured_at: new Date().toISOString(),
    last_gts: ((last.dat ?? {}) as JsonRecord).gts,
    flow_date: ((flow.dat ?? {}) as JsonRecord).date,
    readings,
    readings_raw: readingsRaw,
    energy_flow: flow.dat,
    last_data_table: raw.dat,
  };
  if (includeControls) row.controls = await readControls(client);
  return row;
}

const intervalMs = Number(argValue("--interval", "30")) * 1000;
const count = Number(argValue("--count", "0"));
const output = process.argv.includes("--output") ? argValue("--output", "") : "";
const controlsEvery = Number(argValue("--controls-every", "10"));

const client = new DessmonitorClient(config.usr, config.pwd, config.companyKey);
await client.authenticate();

let sample = 0;
while (count <= 0 || sample < count) {
  sample += 1;
  const includeControls = Boolean(controlsEvery && (sample - 1) % controlsEvery === 0);
  const row = await snapshot(client, includeControls);
  const line = JSON.stringify(row);
  console.log(line);
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.appendFileSync(output, `${line}\n`, "utf8");
  }
  if (count > 0 && sample >= count) break;
  await sleep(intervalMs);
}
