import type { DessmonitorClient } from "./dessClient";
import type { TelemetryStore } from "./store";
import type { DeviceSettings, JsonRecord } from "./types";

function localDateKey(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function datesForHours(hours: number): string[] {
  const now = Date.now();
  const seen = new Set<string>();
  const days: string[] = [];
  for (let t = now; t >= now - hours * 3600_000 - 86_400_000; t -= 86_400_000) {
    const key = localDateKey(t);
    if (!seen.has(key)) {
      seen.add(key);
      days.push(key);
    }
  }
  return days.sort();
}

export async function syncVoltageForDate(
  client: DessmonitorClient,
  store: TelemetryStore,
  settings: DeviceSettings,
  date: string,
  options: { maxPages?: number; pagesize?: number } = {},
): Promise<number> {
  const pagesize = options.pagesize ?? 50;
  const maxPages = options.maxPages ?? 32;
  let total = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await client.queryDeviceDataOneDayPaging({
      ...settings,
      date,
      page,
      pagesize,
    });
    const dat = (payload.dat ?? {}) as JsonRecord;
    total += store.syncDetailsVoltage(settings.sn, dat);
    const rows = Array.isArray(dat.row) ? dat.row : [];
    if (rows.length < pagesize) break;
  }
  return total;
}

export async function syncVoltageForHours(
  client: DessmonitorClient,
  store: TelemetryStore,
  settings: DeviceSettings,
  hours = 24,
): Promise<number> {
  store.purgeFutureVoltageReadings(settings.sn);
  let total = 0;
  for (const date of datesForHours(hours)) {
    total += await syncVoltageForDate(client, store, settings, date);
  }
  return total;
}

export async function syncTodayVoltageReadings(
  client: DessmonitorClient,
  store: TelemetryStore,
  settings: DeviceSettings,
): Promise<number> {
  store.purgeFutureVoltageReadings(settings.sn);
  return syncVoltageForDate(client, store, settings, localDateKey(Date.now()));
}
