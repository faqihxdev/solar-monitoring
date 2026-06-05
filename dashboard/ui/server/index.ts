import http from "node:http";
import { config } from "./env";
import { DessmonitorClient } from "./dessClient";
import { TelemetryStore } from "./store";
import { fetchThresholdCatalog, thresholdCatalogDefaults } from "./thresholds";
import { ControlService } from "./controlService";
import { AutomationEngine } from "./automation";
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

interface ApiContext {
  readStore: TelemetryStore;
  controlStore: TelemetryStore;
  controlService: ControlService;
  automation: AutomationEngine;
}

async function route(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: JsonRecord,
  context: ApiContext,
) {
  const { readStore: store, controlStore, controlService, automation } = context;
  if (pathname === "/api/config") {
    return {
      device_sn: config.sn,
      device_pn: config.pn,
      db_path: config.dbPath,
      control_db_path: config.controlDbPath,
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
    const { controls: readControls, errors } = await controlService.readAllControls(
      "user",
      "Control audit refresh",
    );
    const important = new Set([
      "work_pattern_contlow",
      "charging_gear_setting",
      "bat_charging_current",
      "bat_single_battery_average_charge_setting",
      "bat_single_battery_float_charge_setting",
      "bat_low_voltage_protection_value",
      "bat_low_voltage_recovery_value",
      "bat_power_supply_value",
      "bat_mains_power_supply_value",
      "battery_type_conthigh",
      "lithium_battery_conthigh",
      "lithium_battery_contlow",
      "power_value",
    ]);
    const controls = readControls
      .filter((entry) => important.has(String(entry.id)))
      .map((entry) => ({
        id: entry.id,
        name: entry.label,
        label: entry.label,
        value: entry.raw_value,
        unit: entry.unit,
        scale: entry.scale,
        pack_value: entry.pack_value,
        pack_unit: entry.pack_value != null ? entry.unit : "",
      }));
    return { device_sn: config.sn, controls, errors, source: "device" };
  }

  if (pathname === "/api/controls" && method === "GET") {
    return { device_sn: config.sn, controls: controlService.listControls(), source: "cache" };
  }

  if (pathname === "/api/control-log" && method === "GET") {
    const limit = clamp(Number(searchParams.get("limit") ?? 80), 10, 250);
    return { device_sn: config.sn, events: controlStore.controlEvents(config.sn, limit) };
  }

  if (pathname === "/api/controls/read-all" && method === "POST") {
    const payload = await controlService.readAllControls("manual", "Manual read-all refresh");
    return { device_sn: config.sn, ...payload };
  }

  const readMatch = pathname.match(/^\/api\/controls\/([^/]+)\/read$/);
  if (readMatch && method === "POST") {
    const control = await controlService.readControl(readMatch[1], "manual", "Manual control refresh");
    return { device_sn: config.sn, control };
  }

  const writeMatch = pathname.match(/^\/api\/controls\/([^/]+)\/write$/);
  if (writeMatch && method === "POST") {
    const result = await controlService.guardedWrite(
      writeMatch[1],
      body.value,
      String(body.reason ?? "Manual control write"),
      "manual",
    );
    return { device_sn: config.sn, result };
  }

  if (pathname === "/api/controls/a6-test" && method === "POST") {
    const result = await controlService.runA6WriteRestoreTest();
    return { device_sn: config.sn, result };
  }

  if (pathname === "/api/automation" && method === "GET") {
    return { device_sn: config.sn, automation: automation.status() };
  }

  if (pathname === "/api/automation" && method === "POST") {
    const state = automation.updateState(body);
    const status = body.enabled === false ? await automation.evaluate("Manual disable") : automation.status();
    return { device_sn: config.sn, state, automation: status };
  }

  if (pathname === "/api/automation/evaluate" && method === "POST") {
    return { device_sn: config.sn, automation: await automation.evaluate("Manual evaluation") };
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

function errorStatus(message: string): number {
  if (
    message === "Invalid JSON request body" ||
    message === "Request body too large" ||
    message === "Control value is required" ||
    message.startsWith("Unknown control field:") ||
    message.includes("requires a numeric value") ||
    message.includes("must be >=") ||
    message.includes("must be <=") ||
    message.includes("does not allow value") ||
    message.includes("is read-only") ||
    message.startsWith("Voltage ordering must") ||
    message.startsWith("Cannot validate voltage ordering")
  ) {
    return 400;
  }
  return 500;
}

function readBody(req: http.IncomingMessage): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).length > 128 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord);
      } catch {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

const readStore = await TelemetryStore.open(config.dbPath, { readOnly: true });
const controlStore = await TelemetryStore.open(config.controlDbPath);
const controlClient = makeDessClient();
const controlService = new ControlService(controlClient, controlStore, readStore, settings);
const automation = new AutomationEngine(readStore, controlStore, controlService, config.sn);
const context: ApiContext = { readStore, controlStore, controlService, automation };

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (!url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { detail: "Not Found" });
        return;
      }
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" || method === "PATCH" ? await readBody(req) : {};
      const payload = await route(method, url.pathname, url.searchParams, body, context);
      if (payload == null) sendJson(res, 404, { detail: "Not Found" });
      else sendJson(res, 200, payload);
    } catch (exc) {
      const message = String(exc instanceof Error ? exc.message : exc);
      sendJson(res, errorStatus(message), { error: message });
    }
  })();
});

server.listen(config.apiPort, "127.0.0.1", () => {
  console.log(`TypeScript API listening on http://127.0.0.1:${config.apiPort}`);
});

let automationRunning = false;
const automationIntervalMs = Number(process.env.AUTOMATION_CHECK_INTERVAL_SECONDS ?? "900") * 1000;
setInterval(() => {
  if (automationRunning) return;
  automationRunning = true;
  void automation
    .evaluate("Scheduled automation check")
    .catch((exc) => {
      controlStore.addControlEvent({
        deviceSn: config.sn,
        fieldId: "bat_power_supply_value",
        action: "automation_decision",
        actor: "automation",
        status: "failed",
        reason: String(exc instanceof Error ? exc.message : exc),
      });
    })
    .finally(() => {
      automationRunning = false;
    });
}, automationIntervalMs);
