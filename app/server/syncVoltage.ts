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
  options: { maxPages?: number; pagesize?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const pagesize = options.pagesize ?? 50;
  const maxPages = options.maxPages ?? 32;
  const detailsPages: JsonRecord[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    if (options.signal?.aborted) break;
    const payload = await client.queryDeviceDataOneDayPaging({
      ...settings,
      date,
      page,
      pagesize,
    });
    const dat = (payload.dat ?? {}) as JsonRecord;
    detailsPages.push(dat);
    const rows = Array.isArray(dat.row) ? dat.row : [];
    if (rows.length < pagesize || options.signal?.aborted) break;
  }
  return detailsPages.length ? store.syncDetailsVoltagePages(settings.sn, detailsPages) : 0;
}

export async function syncVoltageForHours(
  client: DessmonitorClient,
  store: TelemetryStore,
  settings: DeviceSettings,
  hours = 24,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  store.purgeFutureVoltageReadings(settings.sn);
  let total = 0;
  for (const date of datesForHours(hours)) {
    if (options.signal?.aborted) break;
    total += await syncVoltageForDate(client, store, settings, date, options);
  }
  return total;
}

export async function syncTodayVoltageReadings(
  client: DessmonitorClient,
  store: TelemetryStore,
  settings: DeviceSettings,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  store.purgeFutureVoltageReadings(settings.sn);
  return syncVoltageForDate(client, store, settings, localDateKey(Date.now()), options);
}
