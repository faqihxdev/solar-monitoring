import http from "node:http";
import { config } from "./env";
import { DessmonitorClient } from "./dessClient";
import { TelemetryStore } from "./store";
import { fetchThresholdCatalog, thresholdCatalogDefaults } from "./thresholds";
import type { DeviceSettings, JsonRecord } from "./types";

const HISTORY_POINT_FIELDS = [
  "device_gts",
  "battery_soc",
  "battery_status",
  "battery_power",
  "battery_voltage",
  "mppt_battery_voltage",
  "pv_power",
  "load_current",
  "load_power",
  "grid_voltage",
  "grid_power",
  "working_state",
  "pv_to_load_kw",
  "battery_to_load_kw",
  "grid_to_load_kw",
  "pv_to_battery_kw",
  "grid_to_battery_kw",
  "grid_to_battery_reported",
  "grid_to_battery_unmetered",
  "battery_flow_unmetered",
  "grid_power_effective",
  "grid_power_inferred",
  "battery_voltage_sampled_at",
  "battery_voltage_sampled_at_raw",
  "polled_at",
];

const CONTROL_AUDIT_FIELDS = [
  ["work_pattern_contlow", "Work pattern [A0]", "", 1],
  ["charging_gear_setting", "AC charging gear [A1]", "", 1],
  ["bat_charging_current", "AC charging current [A1]", "", 1],
  ["bat_single_battery_average_charge_setting", "Single battery average charge [A2]", "V", 2],
  ["bat_single_battery_float_charge_setting", "Single battery float charge [A3]", "V", 2],
  ["bat_low_voltage_protection_value", "Low voltage protection [A4]", "V", 2],
  ["bat_low_voltage_recovery_value", "Low battery recovery [A5]", "V", 2],
  ["bat_power_supply_value", "Return to inverter [A6]", "V", 2],
  ["bat_mains_power_supply_value", "Switch to mains [A7]", "V", 2],
  ["battery_type_conthigh", "Battery type [A10]", "", 1],
  ["lithium_battery_conthigh", "SOC to inverter", "%", 1],
  ["lithium_battery_contlow", "SOC to mains", "%", 1],
  ["power_value", "Power Value Setting", "W", 1],
] as const;

const settings: Required<DeviceSettings> = {
  pn: config.pn,
  sn: config.sn,
  devcode: config.devcode,
  devaddr: config.devaddr,
  i18n: config.i18n,
};

function isoTimestamp(unixTs: unknown): string | null {
  const ts = Number(unixTs);
  return Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
}

function row(row: JsonRecord): JsonRecord {
  return { ...row, polled_at_iso: isoTimestamp(row.polled_at) };
}

function historyPoint(input: JsonRecord): JsonRecord {
  const point: JsonRecord = {};
  for (const field of HISTORY_POINT_FIELDS) {
    if (field in input) point[field] = input[field];
  }
  point.polled_at_iso = isoTimestamp(input.polled_at);
  return point;
}

function samplePoints(rows: JsonRecord[], maxPoints: number): JsonRecord[] {
  if (rows.length <= maxPoints) return rows;
  const lastIdx = rows.length - 1;
  const indexes = new Set<number>();
  for (let i = 0; i < maxPoints; i += 1) {
    indexes.add(Math.round((i * lastIdx) / (maxPoints - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((idx) => rows[idx]);
}

function makeDessClient(): DessmonitorClient {
  return new DessmonitorClient(config.usr, config.pwd, config.companyKey);
}

async function route(pathname: string, searchParams: URLSearchParams, store: TelemetryStore) {
  if (pathname === "/api/config") {
    return {
      device_sn: config.sn,
      device_pn: config.pn,
      db_path: config.dbPath,
      server_now: Date.now() / 1000,
    };
  }

  if (pathname === "/api/thresholds") {
    try {
      const payload = await fetchThresholdCatalog(makeDessClient(), settings);
      return { device_sn: config.sn, ...payload };
    } catch (exc) {
      return {
        device_sn: config.sn,
        thresholds: thresholdCatalogDefaults(),
        source: "defaults",
        error: String(exc instanceof Error ? exc.message : exc),
      };
    }
  }

  if (pathname === "/api/voltage-history") {
    const hours = clamp(Number(searchParams.get("hours") ?? 24), 1, 168);
    return {
      device_sn: config.sn,
      hours,
      server_now: Date.now() / 1000,
      points: store.voltageHistory(config.sn, hours).map((item) => ({
        ...item,
        sampled_at_iso: isoTimestamp(item.sampled_at),
        sampled_at_raw: item.sampled_at_raw,
      })),
    };
  }

  if (pathname === "/api/latest") {
    const reading = store.latestReadings(config.sn);
    return { device_sn: config.sn, reading: reading ? row(reading) : null };
  }

  if (pathname === "/api/history") {
    const hours = clamp(Number(searchParams.get("hours") ?? 24), 1, 168);
    const maxPoints = clamp(Number(searchParams.get("max_points") ?? 900), 200, 5000);
    const rows = samplePoints(store.history(config.sn, hours), maxPoints);
    return {
      device_sn: config.sn,
      hours,
      server_now: Date.now() / 1000,
      points: rows.map(historyPoint),
    };
  }

  if (pathname === "/api/snapshots") {
    const limit = clamp(Number(searchParams.get("limit") ?? 30), 5, 100);
    return { device_sn: config.sn, snapshots: store.recentSnapshots(config.sn, limit).map(row) };
  }

  if (pathname === "/api/daily") {
    const days = clamp(Number(searchParams.get("days") ?? 7), 1, 30);
    const todayJkt = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const endDate = searchParams.get("date") ?? todayJkt;
    const daily = store.dailyEnergyRange(config.sn, endDate, days);
    return { device_sn: config.sn, end_date: endDate, days, server_now: Date.now() / 1000, daily };
  }

  if (pathname === "/api/summary") {
    const stats = store.summary(config.sn);
    const latest = store.latestReadings(config.sn);
    const latestRaw = store.latestReadingsRaw(config.sn);
    const latestRow = latest ? row(latest) : null;
    if (latestRow && Object.keys(latestRaw).length) latestRow.readings_raw = latestRaw;
    if (latestRow) {
      latestRow.load_flows = Object.fromEntries(
        TelemetryStore.FLOW_COLUMNS.filter((key) => latestRow[key] != null).map((key) => [
          key,
          latestRow[key],
        ]),
      );
    }
    return {
      device_sn: config.sn,
      summary: {
        ...stats,
        first_polled_at_iso: isoTimestamp(stats.first_polled_at),
        last_polled_at_iso: isoTimestamp(stats.last_polled_at),
      },
      latest: latestRow,
    };
  }

  if (pathname === "/api/control-audit") {
    const client = makeDessClient();
    const controls = [];
    const errors = [];
    for (const [fieldId, label, unit, scale] of CONTROL_AUDIT_FIELDS) {
      try {
        const payload = await client.queryDeviceCtrlValue({ ...settings, fieldId });
        const dat = (payload.dat ?? {}) as JsonRecord;
        const raw = dat.val;
        let packValue: number | null = null;
        if (raw != null && scale !== 1) {
          const n = Number(raw);
          packValue = Number.isFinite(n) ? n * scale : null;
        }
        controls.push({
          id: fieldId,
          name: dat.name ?? label,
          label,
          value: raw ?? null,
          unit,
          scale,
          pack_value: packValue,
          pack_unit: packValue != null ? unit : "",
        });
      } catch (exc) {
        errors.push({ id: fieldId, error: String(exc instanceof Error ? exc.message : exc) });
      }
    }
    return { device_sn: config.sn, controls, errors, source: "device" };
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

const store = await TelemetryStore.open(config.dbPath, { readOnly: true });
const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (!url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { detail: "Not Found" });
        return;
      }
      const payload = await route(url.pathname, url.searchParams, store);
      if (payload == null) sendJson(res, 404, { detail: "Not Found" });
      else sendJson(res, 200, payload);
    } catch (exc) {
      sendJson(res, 500, { error: String(exc instanceof Error ? exc.message : exc) });
    }
  })();
});

server.listen(config.apiPort, "127.0.0.1", () => {
  console.log(`TypeScript API listening on http://127.0.0.1:${config.apiPort}`);
});
