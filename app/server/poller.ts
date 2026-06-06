import { config } from "./env";
import { DessmonitorApiError, DessmonitorClient } from "./dessClient";
import { TelemetryStore } from "./store";
import { syncTodayVoltageReadings, syncVoltageForHours } from "./syncVoltage";
import type { DeviceSettings, JsonRecord } from "./types";

const settings: Required<DeviceSettings> = {
  pn: config.pn,
  sn: config.sn,
  devcode: config.devcode,
  devaddr: config.devaddr,
  i18n: config.i18n,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clock(): string {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

async function ensureSession(client: DessmonitorClient, store: TelemetryStore): Promise<void> {
  const saved = store.loadSession();
  if (saved && saved.expires_at > Date.now() / 1000 + 60) {
    client.setSession(saved.token, saved.secret, saved.expires_at);
    return;
  }
  await client.authenticate();
  if (!client.token || !client.secret) throw new Error("Authentication did not return a token");
  store.saveSession(client.token, client.secret, client.expiresAt);
}

function formatStatus(status: unknown): string {
  if (status === 1) return "discharging";
  if (status === -1) return "charging";
  if (status === 0) return "idle";
  return "unknown";
}

function formatLogLine(gts: unknown, readings: JsonRecord): string {
  const parts = [`gts=${String(gts ?? "unknown")}`];
  if (typeof readings.battery_soc === "number") parts.push(`soc=${readings.battery_soc}%`);
  parts.push(`battery=${formatStatus(readings.battery_status)}`);
  if (typeof readings.pv_power === "number") parts.push(`pv=${readings.pv_power}W`);
  if (typeof readings.load_current === "number") parts.push(`load=${readings.load_current}A`);
  return parts.join(", ");
}

const intervalMs = Number(process.env.POLL_INTERVAL_SECONDS ?? "5") * 1000;
const detailsIntervalMs = Number(process.env.DETAILS_SYNC_INTERVAL_SECONDS ?? "120") * 1000;
const backfillHours = Number(process.env.DETAILS_BACKFILL_HOURS ?? "168");
const backfillOnStart = process.env.DETAILS_BACKFILL_ON_START === "1";
const noRecordRetryDelayMs = Number(process.env.NO_RECORD_RETRY_DELAY_MS ?? "750");
const noRecordLogIntervalMs = Number(process.env.NO_RECORD_LOG_INTERVAL_SECONDS ?? "60") * 1000;

let lastNoRecordLogAt = 0;
let suppressedNoRecordErrors = 0;

function logNoRecordError(error: DessmonitorApiError): void {
  if (noRecordLogIntervalMs <= 0) {
    console.error(`[${clock()}] API warning: ${error.message}`);
    return;
  }

  const now = Date.now();
  if (!lastNoRecordLogAt || now - lastNoRecordLogAt >= noRecordLogIntervalMs) {
    const suffix =
      suppressedNoRecordErrors > 0 ? ` (${suppressedNoRecordErrors} similar errors suppressed)` : "";
    console.error(`[${clock()}] API warning: ${error.message}${suffix}`);
    suppressedNoRecordErrors = 0;
    lastNoRecordLogAt = now;
    return;
  }

  suppressedNoRecordErrors += 1;
}

async function querySnapshotWithRetry(
  client: DessmonitorClient,
  pollSettings: Required<DeviceSettings>,
): Promise<{ lastPayload: JsonRecord; flowPayload: JsonRecord }> {
  try {
    const lastPayload = await client.queryDeviceLastData(pollSettings);
    const flowPayload = await client.queryDeviceEnergyFlow(pollSettings);
    return { lastPayload, flowPayload };
  } catch (exc) {
    if (!(exc instanceof DessmonitorApiError) || exc.code !== 12) throw exc;
    logNoRecordError(exc);
    if (noRecordRetryDelayMs > 0) await sleep(noRecordRetryDelayMs);
    const lastPayload = await client.queryDeviceLastData(pollSettings);
    const flowPayload = await client.queryDeviceEnergyFlow(pollSettings);
    return { lastPayload, flowPayload };
  }
}

const client = new DessmonitorClient(config.usr, config.pwd, config.companyKey);
const store = await TelemetryStore.open(config.dbPath);

console.log(`Polling device ${settings.sn} every ${intervalMs / 1000}s`);
console.log("Sources: querySPDeviceLastData + webQueryDeviceEnergyFlowEs");
console.log(`Details voltage sync: every ${detailsIntervalMs / 1000}s`);
console.log(
  `ERR_NO_RECORD handling: retry once after ${noRecordRetryDelayMs}ms, log interval ${
    noRecordLogIntervalMs / 1000
  }s`,
);
console.log(`Database: ${config.dbPath}`);
console.log("Press Ctrl+C to stop.\n");

let lastDetailsSync = Date.now();
if (backfillOnStart) {
  try {
    await ensureSession(client, store);
    const count = await syncVoltageForHours(client, store, settings, backfillHours);
    if (count) console.log(`[${clock()}] voltage backfill: ${count} row(s)`);
  } catch (exc) {
    console.error(`[${clock()}] voltage backfill skipped: ${String(exc)}`);
  }
}

while (true) {
  try {
    await ensureSession(client, store);
    const { lastPayload, flowPayload } = await querySnapshotWithRetry(client, settings);
    const lastData = (lastPayload.dat ?? {}) as JsonRecord;
    const energyFlow = (flowPayload.dat ?? {}) as JsonRecord;
    const payload = store.buildPayload(lastData, energyFlow);
    const changed = store.saveIfChanged(settings.sn, payload);
    const summary = formatLogLine(payload.gts, (payload.readings ?? {}) as JsonRecord);
    if (changed) {
      console.log(`[${clock()}] CHANGE saved (${summary}, total=${store.snapshotCount(settings.sn)})`);
    } else {
      console.log(`[${clock()}] unchanged (${summary})`);
    }

    const now = Date.now();
    if (now - lastDetailsSync >= detailsIntervalMs) {
      const count = await syncTodayVoltageReadings(client, store, settings);
      lastDetailsSync = now;
      if (count) {
        const latest = store.latestVoltage(settings.sn);
        console.log(
          `[${clock()}] voltage sync: ${count} row(s), latest ${latest?.battery_voltage ?? "n/a"} V`,
        );
      }
    }
  } catch (exc) {
    if (exc instanceof DessmonitorApiError) {
      if (exc.code === 12) logNoRecordError(exc);
      else console.error(`[${clock()}] API error: ${exc.message}`);
    } else {
      console.error(`[${clock()}] error: ${String(exc)}`);
    }
  }
  await sleep(intervalMs);
}
