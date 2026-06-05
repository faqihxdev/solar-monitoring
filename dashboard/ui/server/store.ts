import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import { parseDetailsDat, type VoltageSample } from "./details";
import { effectiveGridPower, inferEnergyFlows } from "./flows";
import { sqlJsWasmPath } from "./env";
import { BASELINE_A7_SINGLE_V } from "./controlCatalog";
import type { AuthSession, JsonRecord } from "./types";

type Row = Record<string, SqlValue>;

export interface ControlValueRecord extends JsonRecord {
  device_sn: string;
  field_id: string;
  label: string;
  unit: string;
  scale: number;
  raw_value: string | null;
  pack_value: number | null;
  source: string;
  read_at: number;
  updated_at: number;
}

export interface ControlEventInput {
  deviceSn: string;
  fieldId?: string | null;
  action: string;
  actor: string;
  status: string;
  reason: string;
  valueBefore?: string | null;
  valueAfter?: string | null;
  details?: JsonRecord;
}

export interface AutomationStateRecord extends JsonRecord {
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

const FLOW_COLUMNS = [
  "pv_to_load_kw",
  "battery_to_load_kw",
  "grid_to_load_kw",
  "pv_to_battery_kw",
  "grid_to_battery_kw",
] as const;

const FLOW_FLAG_COLUMNS = [
  "grid_to_battery_reported",
  "grid_to_battery_unmetered",
  "battery_flow_unmetered",
] as const;

const FLAT_COLUMNS = [
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
] as const;

function nowSeconds(): number {
  return Date.now() / 1000;
}

function parseNumber(raw: unknown): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text || text === "--") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function rawText(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  return text && text !== "--" ? text : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function rowToRecord(row: Row): JsonRecord {
  return { ...row };
}

function parValue(pars: JsonRecord, group: string, ...needles: string[]) {
  const items = Array.isArray(pars[group]) ? (pars[group] as unknown[]) : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as JsonRecord;
    const label = String(obj.par ?? obj.id ?? "").toLowerCase();
    if (needles.some((needle) => label.includes(needle.toLowerCase()))) {
      return { value: parseNumber(obj.val), unit: rawText(obj.unit), raw: rawText(obj.val) };
    }
  }
  return { value: null, unit: null, raw: null };
}

function flowValue(flow: JsonRecord, group: string, ...needles: string[]) {
  const items = Array.isArray(flow[group]) ? (flow[group] as unknown[]) : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as JsonRecord;
    const label = String(obj.par ?? "").toLowerCase();
    if (needles.some((needle) => label.includes(needle.toLowerCase()))) {
      const status = Number(obj.status);
      return {
        value: parseNumber(obj.val),
        status: Number.isFinite(status) ? status : null,
        raw: rawText(obj.val),
        unit: rawText(obj.unit),
      };
    }
  }
  return { value: null, status: null, raw: null, unit: null };
}

function scaleByUnit(value: number | null, unit: string | null, target: string): number | null {
  if (value == null || !unit) return value;
  const unitL = unit.toLowerCase();
  const targetL = target.toLowerCase();
  if (unitL === targetL) return value;
  if (unitL === "kw" && targetL === "w") return value * 1000;
  if (unitL === "w" && targetL === "kw") return value / 1000;
  return value;
}

export function extractReadings(lastData?: JsonRecord | null, energyFlow?: JsonRecord | null) {
  const last = lastData ?? {};
  const flow = energyFlow ?? {};
  const pars = ((last.pars ?? {}) as JsonRecord) || {};
  const raw: Record<string, string | null> = {};

  const soc = parValue(pars, "bt_", "soc", "capacity");
  let pvPower = parValue(pars, "pv_", "pv power", "pv_output");
  const loadCurrent = parValue(pars, "bc_", "load current");
  const gridVoltage = parValue(pars, "gd_", "input voltage", "voltage");
  let workingState = parValue(pars, "sy_", "working state");
  if (workingState.value == null) {
    const sy = Array.isArray(pars.sy_) ? pars.sy_ : [];
    for (const item of sy) {
      if (item && typeof item === "object" && (item as JsonRecord).val != null) {
        workingState = {
          value: null,
          unit: null,
          raw: rawText((item as JsonRecord).val),
        };
        break;
      }
    }
  }

  const flowSoc = flowValue(flow, "bt_status", "bt_battery_capacity", "soc", "capacity");
  const batteryPower = flowValue(flow, "bt_status", "battery_active_power", "battery power");
  const flowPv = flowValue(flow, "pv_status", "pv_output", "pv power");
  const flowLoad = flowValue(flow, "bc_status", "load_active", "load power");
  const flowGrid = flowValue(flow, "gd_status", "grid_active", "grid");

  if (pvPower.value == null && flowPv.value != null) {
    pvPower =
      flowPv.unit?.toLowerCase() === "kw"
        ? { value: flowPv.value * 1000, unit: "W", raw: String(flowPv.value * 1000) }
        : { value: flowPv.value, unit: flowPv.unit, raw: flowPv.raw };
  }

  const batterySoc = soc.value ?? flowSoc.value;
  raw.battery_soc = soc.raw ?? flowSoc.raw;
  raw.battery_status = flowSoc.status != null ? String(flowSoc.status) : null;
  raw.battery_power = batteryPower.raw;
  raw.pv_power = pvPower.raw;
  raw.load_current = loadCurrent.raw;
  raw.load_power = flowLoad.raw;
  raw.grid_voltage = gridVoltage.raw;
  raw.grid_power = flowGrid.raw;
  raw.working_state = workingState.raw;

  return {
    readings: {
      battery_soc: batterySoc,
      battery_status: flowSoc.status,
      battery_power: batteryPower.value,
      pv_power: pvPower.value ?? scaleByUnit(flowPv.value, flowPv.unit, "W"),
      load_current: loadCurrent.value,
      load_power: flowLoad.value,
      grid_voltage: gridVoltage.value,
      grid_power: flowGrid.value,
      working_state: workingState.raw,
    } as JsonRecord,
    readingsRaw: raw,
  };
}

export class TelemetryStore {
  static readonly FLOW_COLUMNS = FLOW_COLUMNS;
  static readonly FLOW_FLAG_COLUMNS = FLOW_FLAG_COLUMNS;
  private static SQL: SqlJsStatic | null = null;
  private db: Database;

  private constructor(
    private readonly dbPath: string,
    private readonly readOnly: boolean,
    db: Database,
  ) {
    this.db = db;
    this.initDb();
  }

  static async open(dbPath: string, options: { readOnly?: boolean } = {}) {
    if (!this.SQL) {
      this.SQL = await initSqlJs({ locateFile: sqlJsWasmPath });
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const data = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : undefined;
    return new TelemetryStore(dbPath, Boolean(options.readOnly), new this.SQL.Database(data));
  }

  private refresh(): void {
    if (!this.readOnly || !TelemetryStore.SQL || !fs.existsSync(this.dbPath)) return;
    this.db.close();
    this.db = new TelemetryStore.SQL.Database(fs.readFileSync(this.dbPath));
    this.initDb();
  }

  private flush(): void {
    if (this.readOnly) return;
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token TEXT NOT NULL,
        secret TEXT NOT NULL,
        expires_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_state (
        device_sn TEXT PRIMARY KEY,
        last_hash TEXT NOT NULL,
        last_gts TEXT,
        last_polled_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telemetry_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_sn TEXT NOT NULL,
        device_gts TEXT,
        data_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        polled_at REAL NOT NULL,
        battery_soc REAL,
        battery_status INTEGER,
        battery_power REAL,
        battery_voltage REAL,
        mppt_battery_voltage REAL,
        pv_power REAL,
        load_current REAL,
        load_power REAL,
        grid_voltage REAL,
        grid_power REAL,
        working_state TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_sn_time
        ON telemetry_snapshots(device_sn, polled_at DESC);
      CREATE TABLE IF NOT EXISTS battery_voltage_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_sn TEXT NOT NULL,
        sampled_at REAL NOT NULL,
        sampled_at_raw TEXT,
        battery_voltage REAL NOT NULL,
        mppt_battery_voltage REAL,
        working_state TEXT,
        battery_soc REAL,
        UNIQUE(device_sn, sampled_at)
      );
      CREATE INDEX IF NOT EXISTS idx_voltage_sn_time
        ON battery_voltage_readings(device_sn, sampled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_soc
        ON telemetry_snapshots(device_sn, battery_soc, polled_at DESC);
      CREATE TABLE IF NOT EXISTS control_values (
        device_sn TEXT NOT NULL,
        field_id TEXT NOT NULL,
        label TEXT NOT NULL,
        unit TEXT NOT NULL,
        scale REAL NOT NULL,
        raw_value TEXT,
        pack_value REAL,
        source TEXT NOT NULL,
        read_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (device_sn, field_id)
      );
      CREATE TABLE IF NOT EXISTS control_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_sn TEXT NOT NULL,
        field_id TEXT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        value_before TEXT,
        value_after TEXT,
        details_json TEXT,
        created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_control_events_device_time
        ON control_events(device_sn, created_at DESC);
      CREATE TABLE IF NOT EXISTS automation_state (
        device_sn TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        target_practical_soc REAL NOT NULL,
        target_time TEXT NOT NULL,
        baseline_a6 REAL NOT NULL,
        baseline_a7 REAL,
        active_override INTEGER NOT NULL,
        override_a6 REAL,
        override_a7 REAL,
        override_value REAL,
        next_check_at REAL,
        last_decision TEXT,
        last_reason TEXT,
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_write_budget (
        device_sn TEXT NOT NULL,
        field_id TEXT NOT NULL,
        date_key TEXT NOT NULL,
        actor TEXT NOT NULL,
        count INTEGER NOT NULL,
        last_write_at REAL,
        PRIMARY KEY (device_sn, field_id, date_key, actor)
      );
    `);
    this.ensureColumns("telemetry_snapshots", {
      battery_soc: "REAL",
      battery_status: "INTEGER",
      battery_power: "REAL",
      battery_voltage: "REAL",
      mppt_battery_voltage: "REAL",
      pv_power: "REAL",
      load_current: "REAL",
      load_power: "REAL",
      grid_voltage: "REAL",
      grid_power: "REAL",
      working_state: "TEXT",
      pv_to_load_kw: "REAL",
      battery_to_load_kw: "REAL",
      grid_to_load_kw: "REAL",
      pv_to_battery_kw: "REAL",
      grid_to_battery_kw: "REAL",
      grid_to_battery_reported: "INTEGER",
      grid_to_battery_unmetered: "INTEGER",
      battery_flow_unmetered: "INTEGER",
    });
    this.ensureColumns("battery_voltage_readings", { sampled_at_raw: "TEXT" });
    this.ensureColumns("automation_state", {
      baseline_a7: "REAL",
      override_a6: "REAL",
      override_a7: "REAL",
    });
    this.flush();
  }

  private ensureColumns(table: string, columns: Record<string, string>): void {
    const existing = new Set(this.queryAll(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
    for (const [column, type] of Object.entries(columns)) {
      if (!existing.has(column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private queryAll(sql: string, params: SqlValue[] = []): Row[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Row[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as Row);
      return rows;
    } finally {
      stmt.free();
    }
  }

  private queryOne(sql: string, params: SqlValue[] = []): Row | null {
    return this.queryAll(sql, params)[0] ?? null;
  }

  loadSession(): AuthSession | null {
    this.refresh();
    const row = this.queryOne("SELECT token, secret, expires_at FROM auth_session WHERE id = 1");
    return row
      ? { token: String(row.token), secret: String(row.secret), expires_at: Number(row.expires_at) }
      : null;
  }

  saveSession(token: string, secret: string, expiresAt: number): void {
    this.db.run(
      `
      INSERT INTO auth_session (id, token, secret, expires_at, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        token = excluded.token,
        secret = excluded.secret,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      `,
      [token, secret, expiresAt, nowSeconds()],
    );
    this.flush();
  }

  upsertControlValue(args: {
    deviceSn: string;
    fieldId: string;
    label: string;
    unit: string;
    scale: number;
    rawValue: string | null;
    source: string;
    readAt?: number;
  }): ControlValueRecord {
    const readAt = args.readAt ?? nowSeconds();
    const rawNumber = args.rawValue == null ? null : Number(args.rawValue);
    const packValue =
      args.scale !== 1 && rawNumber != null && Number.isFinite(rawNumber)
        ? rawNumber * args.scale
        : null;
    this.db.run(
      `
      INSERT INTO control_values (
        device_sn, field_id, label, unit, scale, raw_value,
        pack_value, source, read_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_sn, field_id) DO UPDATE SET
        label = excluded.label,
        unit = excluded.unit,
        scale = excluded.scale,
        raw_value = excluded.raw_value,
        pack_value = excluded.pack_value,
        source = excluded.source,
        read_at = excluded.read_at,
        updated_at = excluded.updated_at
      `,
      [
        args.deviceSn,
        args.fieldId,
        args.label,
        args.unit,
        args.scale,
        args.rawValue,
        packValue,
        args.source,
        readAt,
        readAt,
      ],
    );
    this.flush();
    return this.controlValue(args.deviceSn, args.fieldId) as ControlValueRecord;
  }

  controlValue(deviceSn: string, fieldId: string): ControlValueRecord | null {
    this.refresh();
    const row = this.queryOne(
      `
      SELECT device_sn, field_id, label, unit, scale, raw_value,
             pack_value, source, read_at, updated_at
      FROM control_values
      WHERE device_sn = ? AND field_id = ?
      `,
      [deviceSn, fieldId],
    );
    return row ? (rowToRecord(row) as ControlValueRecord) : null;
  }

  controlValues(deviceSn: string): ControlValueRecord[] {
    this.refresh();
    return this.queryAll(
      `
      SELECT device_sn, field_id, label, unit, scale, raw_value,
             pack_value, source, read_at, updated_at
      FROM control_values
      WHERE device_sn = ?
      ORDER BY field_id ASC
      `,
      [deviceSn],
    ).map((item) => rowToRecord(item) as ControlValueRecord);
  }

  addControlEvent(input: ControlEventInput): JsonRecord {
    const createdAt = nowSeconds();
    this.db.run(
      `
      INSERT INTO control_events (
        device_sn, field_id, action, actor, status, reason,
        value_before, value_after, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.deviceSn,
        input.fieldId ?? null,
        input.action,
        input.actor,
        input.status,
        input.reason,
        input.valueBefore ?? null,
        input.valueAfter ?? null,
        input.details ? JSON.stringify(input.details) : null,
        createdAt,
      ],
    );
    this.flush();
    return this.queryOne(
      `
      SELECT id, device_sn, field_id, action, actor, status, reason,
             value_before, value_after, details_json, created_at
      FROM control_events
      WHERE id = last_insert_rowid()
      `,
    ) as JsonRecord;
  }

  controlEvents(deviceSn: string, limit = 80): JsonRecord[] {
    this.refresh();
    return this.queryAll(
      `
      SELECT id, device_sn, field_id, action, actor, status, reason,
             value_before, value_after, details_json, created_at
      FROM control_events
      WHERE device_sn = ?
      ORDER BY created_at DESC
      LIMIT ?
      `,
      [deviceSn, limit],
    ).map((item) => {
      const event = rowToRecord(item);
      event.details = parseJsonObject(event.details_json);
      delete event.details_json;
      return event;
    });
  }

  automationState(deviceSn: string): AutomationStateRecord | null {
    this.refresh();
    const row = this.queryOne(
      `
      SELECT device_sn, enabled, target_practical_soc, target_time,
             baseline_a6, COALESCE(baseline_a7, ?) AS baseline_a7,
             active_override,
             COALESCE(override_a6, override_value) AS override_a6,
             override_a7,
             override_value,
             next_check_at,
             last_decision, last_reason, updated_at
      FROM automation_state
      WHERE device_sn = ?
      `,
      [BASELINE_A7_SINGLE_V, deviceSn],
    );
    return row ? (rowToRecord(row) as AutomationStateRecord) : null;
  }

  saveAutomationState(
    deviceSn: string,
    state: Omit<AutomationStateRecord, "device_sn" | "updated_at">,
  ): AutomationStateRecord {
    const updatedAt = nowSeconds();
    this.db.run(
      `
      INSERT INTO automation_state (
        device_sn, enabled, target_practical_soc, target_time,
        baseline_a6, baseline_a7, active_override, override_a6, override_a7, override_value, next_check_at,
        last_decision, last_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_sn) DO UPDATE SET
        enabled = excluded.enabled,
        target_practical_soc = excluded.target_practical_soc,
        target_time = excluded.target_time,
        baseline_a6 = excluded.baseline_a6,
        baseline_a7 = excluded.baseline_a7,
        active_override = excluded.active_override,
        override_a6 = excluded.override_a6,
        override_a7 = excluded.override_a7,
        override_value = excluded.override_value,
        next_check_at = excluded.next_check_at,
        last_decision = excluded.last_decision,
        last_reason = excluded.last_reason,
        updated_at = excluded.updated_at
      `,
      [
        deviceSn,
        state.enabled as SqlValue,
        state.target_practical_soc as SqlValue,
        state.target_time as SqlValue,
        state.baseline_a6 as SqlValue,
        state.baseline_a7 as SqlValue,
        state.active_override as SqlValue,
        state.override_a6 as SqlValue,
        state.override_a7 as SqlValue,
        state.override_value as SqlValue,
        state.next_check_at as SqlValue,
        state.last_decision as SqlValue,
        state.last_reason as SqlValue,
        updatedAt,
      ],
    );
    this.flush();
    return this.automationState(deviceSn) as AutomationStateRecord;
  }

  writeBudget(deviceSn: string, fieldId: string, dateKey: string, actor: string): JsonRecord {
    this.refresh();
    const row = this.queryOne(
      `
      SELECT device_sn, field_id, date_key, actor, count, last_write_at
      FROM automation_write_budget
      WHERE device_sn = ? AND field_id = ? AND date_key = ? AND actor = ?
      `,
      [deviceSn, fieldId, dateKey, actor],
    );
    return row ? rowToRecord(row) : { device_sn: deviceSn, field_id: fieldId, date_key: dateKey, actor, count: 0, last_write_at: null };
  }

  incrementWriteBudget(deviceSn: string, fieldId: string, dateKey: string, actor: string): JsonRecord {
    const now = nowSeconds();
    this.db.run(
      `
      INSERT INTO automation_write_budget (device_sn, field_id, date_key, actor, count, last_write_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(device_sn, field_id, date_key, actor) DO UPDATE SET
        count = count + 1,
        last_write_at = excluded.last_write_at
      `,
      [deviceSn, fieldId, dateKey, actor, now],
    );
    this.flush();
    return this.writeBudget(deviceSn, fieldId, dateKey, actor);
  }

  buildPayload(lastData: JsonRecord, energyFlow: JsonRecord): JsonRecord {
    const { readings, readingsRaw } = extractReadings(lastData, energyFlow);
    return {
      gts: lastData.gts,
      last_data: lastData,
      energy_flow: energyFlow,
      readings,
      readings_raw: readingsRaw,
      load_flows: inferEnergyFlows(readings),
    };
  }

  saveIfChanged(deviceSn: string, payload: JsonRecord): boolean {
    const deviceGts = payload.gts == null ? null : String(payload.gts);
    const readings = (payload.readings ?? {}) as JsonRecord;
    const flows = (payload.load_flows ?? inferEnergyFlows(readings)) as JsonRecord;
    const dataHash = createHash("sha256")
      .update(
        stableStringify({
          gts: deviceGts,
          readings,
          readings_raw: payload.readings_raw ?? {},
          load_flows: flows,
        }),
      )
      .digest("hex");
    const row = this.queryOne("SELECT last_hash FROM device_state WHERE device_sn = ?", [deviceSn]);
    const now = nowSeconds();

    if (row && row.last_hash === dataHash) {
      this.db.run("UPDATE device_state SET last_polled_at = ? WHERE device_sn = ?", [now, deviceSn]);
      this.flush();
      return false;
    }

    const columns = ["device_sn", "device_gts", "data_hash", "payload_json", "polled_at"];
    const values: SqlValue[] = [deviceSn, deviceGts, dataHash, JSON.stringify(payload), now];
    for (const column of FLAT_COLUMNS) {
      columns.push(column);
      values.push((readings[column] as SqlValue) ?? null);
    }
    for (const column of FLOW_COLUMNS) {
      columns.push(column);
      values.push((flows[column] as SqlValue) ?? null);
    }
    for (const column of FLOW_FLAG_COLUMNS) {
      columns.push(column);
      values.push(flows[column] ? 1 : 0);
    }

    this.db.run(
      `INSERT INTO telemetry_snapshots (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      values,
    );
    this.db.run(
      `
      INSERT INTO device_state (device_sn, last_hash, last_gts, last_polled_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_sn) DO UPDATE SET
        last_hash = excluded.last_hash,
        last_gts = excluded.last_gts,
        last_polled_at = excluded.last_polled_at
      `,
      [deviceSn, dataHash, deviceGts, now],
    );
    this.flush();
    return true;
  }

  snapshotCount(deviceSn: string): number {
    this.refresh();
    return Number(
      this.queryOne("SELECT COUNT(*) AS count FROM telemetry_snapshots WHERE device_sn = ?", [deviceSn])
        ?.count ?? 0,
    );
  }

  latestReadingsRaw(deviceSn: string): JsonRecord {
    this.refresh();
    const row = this.queryOne(
      "SELECT payload_json FROM telemetry_snapshots WHERE device_sn = ? ORDER BY polled_at DESC LIMIT 1",
      [deviceSn],
    );
    return payloadReadingsRaw(row?.payload_json);
  }

  latestVoltage(deviceSn: string): JsonRecord | null {
    this.refresh();
    const row = this.queryOne(
      `
      SELECT sampled_at, sampled_at_raw, battery_voltage, mppt_battery_voltage, working_state, battery_soc
      FROM battery_voltage_readings
      WHERE device_sn = ?
      ORDER BY sampled_at DESC
      LIMIT 1
      `,
      [deviceSn],
    );
    return row ? rowToRecord(row) : null;
  }

  upsertVoltageSamples(deviceSn: string, samples: VoltageSample[]): number {
    let count = 0;
    for (const sample of samples) {
      if (sample.sampled_at_raw) {
        this.db.run(
          `
          DELETE FROM battery_voltage_readings
          WHERE device_sn = ? AND sampled_at_raw = ? AND sampled_at <> ?
          `,
          [deviceSn, sample.sampled_at_raw, sample.sampled_at],
        );

        this.db.run(
          `
          DELETE FROM battery_voltage_readings
          WHERE device_sn = ? AND sampled_at_raw IS NULL
            AND (
              sampled_at BETWEEN ? AND ?
              OR sampled_at BETWEEN ? AND ?
            )
          `,
          [
            deviceSn,
            sample.sampled_at - 3602,
            sample.sampled_at - 3598,
            sample.sampled_at + 3598,
            sample.sampled_at + 3602,
          ],
        );
      }
      this.db.run(
        `
        INSERT INTO battery_voltage_readings (
          device_sn, sampled_at, sampled_at_raw, battery_voltage,
          mppt_battery_voltage, working_state, battery_soc
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_sn, sampled_at) DO UPDATE SET
          sampled_at_raw = excluded.sampled_at_raw,
          battery_voltage = excluded.battery_voltage,
          mppt_battery_voltage = excluded.mppt_battery_voltage,
          working_state = excluded.working_state,
          battery_soc = excluded.battery_soc
        `,
        [
          deviceSn,
          sample.sampled_at,
          sample.sampled_at_raw,
          sample.battery_voltage,
          sample.mppt_battery_voltage,
          sample.working_state,
          sample.battery_soc,
        ],
      );
      count += 1;
    }
    if (count) this.flush();
    return count;
  }

  syncDetailsVoltage(deviceSn: string, detailsDat: JsonRecord): number {
    return this.upsertVoltageSamples(deviceSn, parseDetailsDat(detailsDat));
  }

  purgeFutureVoltageReadings(deviceSn: string, graceSeconds = 300): number {
    const before = this.queryOne(
      "SELECT COUNT(*) AS count FROM battery_voltage_readings WHERE device_sn = ? AND sampled_at > ?",
      [deviceSn, nowSeconds() + graceSeconds],
    );
    this.db.run("DELETE FROM battery_voltage_readings WHERE device_sn = ? AND sampled_at > ?", [
      deviceSn,
      nowSeconds() + graceSeconds,
    ]);
    const count = Number(before?.count ?? 0);
    if (count) this.flush();
    return count;
  }

  voltageHistory(deviceSn: string, hours = 24): JsonRecord[] {
    this.refresh();
    return this.queryAll(
      `
      SELECT sampled_at, sampled_at_raw, battery_voltage, mppt_battery_voltage, working_state, battery_soc
      FROM battery_voltage_readings
      WHERE device_sn = ? AND sampled_at >= ? AND sampled_at <= ?
      ORDER BY sampled_at ASC
      `,
      [deviceSn, nowSeconds() - hours * 3600, nowSeconds() + 120],
    ).map(rowToRecord);
  }

  latestReadings(deviceSn: string): JsonRecord | null {
    this.refresh();
    const row = this.queryOne(
      `
      SELECT device_gts, battery_soc, battery_status, battery_power,
             battery_voltage, mppt_battery_voltage, pv_power, load_current,
             load_power, grid_voltage, grid_power, working_state, pv_to_load_kw,
             battery_to_load_kw, grid_to_load_kw, pv_to_battery_kw,
             grid_to_battery_kw, grid_to_battery_reported,
             grid_to_battery_unmetered, battery_flow_unmetered, polled_at
      FROM telemetry_snapshots
      WHERE device_sn = ?
      ORDER BY polled_at DESC
      LIMIT 1
      `,
      [deviceSn],
    );
    if (!row) return null;
    const item = attachFlows(rowToRecord(row));
    this.attachLatestVoltage(item, deviceSn);
    return item;
  }

  history(deviceSn: string, hours = 24): JsonRecord[] {
    this.refresh();
    const rows = this.queryAll(
      `
      SELECT id, polled_at, device_gts, battery_soc, battery_status,
             battery_power, battery_voltage, mppt_battery_voltage,
             pv_power, load_current, load_power, grid_voltage,
             grid_power, working_state, pv_to_load_kw,
             battery_to_load_kw, grid_to_load_kw, pv_to_battery_kw,
             grid_to_battery_kw, grid_to_battery_reported,
             grid_to_battery_unmetered, battery_flow_unmetered
      FROM telemetry_snapshots
      WHERE device_sn = ? AND polled_at >= ?
      ORDER BY polled_at ASC
      `,
      [deviceSn, nowSeconds() - hours * 3600],
    ).map((row) => attachFlows(rowToRecord(row)));
    this.attachVoltageToPoints(deviceSn, rows);
    return rows;
  }

  recentSnapshots(deviceSn: string, limit = 30): JsonRecord[] {
    this.refresh();
    const rows = this.queryAll(
      `
      SELECT id, polled_at, device_gts, battery_soc, battery_status,
             battery_power, battery_voltage, mppt_battery_voltage,
             pv_power, load_current, load_power, grid_voltage,
             grid_power, working_state, pv_to_load_kw,
             battery_to_load_kw, grid_to_load_kw, pv_to_battery_kw,
             grid_to_battery_kw, grid_to_battery_reported,
             grid_to_battery_unmetered, battery_flow_unmetered, payload_json
      FROM telemetry_snapshots
      WHERE device_sn = ?
      ORDER BY polled_at DESC
      LIMIT ?
      `,
      [deviceSn, limit],
    );
    const result = rows.map((row) => {
      const item = rowToRecord(row);
      const payloadJson = item.payload_json;
      delete item.payload_json;
      const raw = payloadReadingsRaw(payloadJson);
      if (Object.keys(raw).length) item.readings_raw = raw;
      return attachFlows(item);
    });
    this.attachVoltageToPoints(deviceSn, result);
    return result;
  }

  dailyEnergy(deviceSn: string, date: string): JsonRecord {
    this.refresh();
    // UTC+7 (Asia/Jakarta): midnight local = midnight UTC minus 7h
    const [y, m, d] = date.split("-").map(Number);
    const startUnix = Date.UTC(y, m - 1, d, 0, 0, 0) / 1000 - 7 * 3600;
    const endUnix = startUnix + 86400;

    const rows = this.queryAll(
      `
      SELECT polled_at, battery_status, battery_power, pv_power, load_power,
             grid_power, working_state
      FROM telemetry_snapshots
      WHERE device_sn = ? AND polled_at >= ? AND polled_at < ?
      ORDER BY polled_at ASC
      `,
      [deviceSn, startUnix, endUnix],
    );

    let solarKwh = 0;
    let loadKwh = 0;
    let pvToLoadKwh = 0;
    let pvToBattKwh = 0;
    let battToLoadKwh = 0;
    let gridToLoadKwh = 0;
    let coverageSec = 0;

    for (let i = 0; i + 1 < rows.length; i++) {
      const row = rows[i];
      const flows = inferEnergyFlows(row);
      const dt = Number(rows[i + 1].polled_at) - Number(row.polled_at);
      const dtCapped = Math.min(dt, 900); // cap 15 min to skip offline gaps
      const dtH = dtCapped / 3600;
      solarKwh += (Number(row.pv_power ?? 0) / 1000) * dtH;
      loadKwh += Number(row.load_power ?? 0) * dtH;
      pvToLoadKwh += Number(flows.pv_to_load_kw ?? 0) * dtH;
      pvToBattKwh += Number(flows.pv_to_battery_kw ?? 0) * dtH;
      battToLoadKwh += Number(flows.battery_to_load_kw ?? 0) * dtH;
      gridToLoadKwh += Number(flows.grid_to_load_kw ?? 0) * dtH;
      coverageSec += dtCapped;
    }

    return {
      date,
      snapshot_count: rows.length,
      solar_kwh: round2(solarKwh),
      load_kwh: round2(loadKwh),
      net_kwh: round2(solarKwh - loadKwh),
      pv_to_load_kwh: round2(pvToLoadKwh),
      pv_to_battery_kwh: round2(pvToBattKwh),
      battery_to_load_kwh: round2(battToLoadKwh),
      grid_to_load_kwh: round2(gridToLoadKwh),
      coverage_pct: Math.min(100, Math.round(coverageSec / 864)),
    };
  }

  dailyEnergyRange(deviceSn: string, endDate: string, days: number): JsonRecord[] {
    const result: JsonRecord[] = [];
    for (let i = days - 1; i >= 0; i--) {
      result.push(this.dailyEnergy(deviceSn, offsetDate(endDate, -i)));
    }
    return result;
  }

  summary(deviceSn: string): JsonRecord {
    this.refresh();
    return rowToRecord(
      this.queryOne(
        `
        SELECT COUNT(*) AS snapshot_count, MIN(polled_at) AS first_polled_at,
               MAX(polled_at) AS last_polled_at, MIN(battery_soc) AS soc_min,
               MAX(battery_soc) AS soc_max
        FROM telemetry_snapshots
        WHERE device_sn = ?
        `,
        [deviceSn],
      ) ?? {},
    );
  }

  private attachLatestVoltage(item: JsonRecord, deviceSn: string): void {
    const voltage = this.latestVoltage(deviceSn);
    if (!voltage) return;
    if (item.battery_voltage == null) item.battery_voltage = voltage.battery_voltage;
    if (item.mppt_battery_voltage == null) item.mppt_battery_voltage = voltage.mppt_battery_voltage;
    item.battery_voltage_sampled_at = voltage.sampled_at;
    item.battery_voltage_sampled_at_raw = voltage.sampled_at_raw;
  }

  private attachVoltageToPoints(deviceSn: string, points: JsonRecord[]): void {
    if (!points.length) return;
    const since = Math.min(...points.map((point) => Number(point.polled_at)));
    const voltageRows = this.queryAll(
      `
      SELECT sampled_at, sampled_at_raw, battery_voltage, mppt_battery_voltage
      FROM battery_voltage_readings
      WHERE device_sn = ? AND sampled_at >= ?
      ORDER BY sampled_at ASC
      `,
      [deviceSn, since - 600],
    ).map(rowToRecord);
    for (const point of points) {
      if (point.battery_voltage != null) continue;
      const match = nearestVoltage(Number(point.polled_at), voltageRows, 600);
      if (!match) continue;
      point.battery_voltage = match.battery_voltage;
      point.mppt_battery_voltage = match.mppt_battery_voltage;
      point.battery_voltage_sampled_at = match.sampled_at;
      point.battery_voltage_sampled_at_raw = match.sampled_at_raw;
    }
  }
}

function payloadReadingsRaw(payloadJson: unknown): JsonRecord {
  if (!payloadJson) return {};
  try {
    const payload = JSON.parse(String(payloadJson)) as JsonRecord;
    return payload.readings_raw && typeof payload.readings_raw === "object"
      ? (payload.readings_raw as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

function parseJsonObject(payloadJson: unknown): JsonRecord | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(String(payloadJson));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function attachFlows(item: JsonRecord): JsonRecord {
  const flows = inferEnergyFlows(item);
  for (const column of FLOW_COLUMNS) item[column] = flows[column];
  for (const column of FLOW_FLAG_COLUMNS) item[column] = Boolean(flows[column]);
  const effective = effectiveGridPower(item);
  item.grid_power_effective = effective.grid_power_kw;
  item.grid_power_inferred = effective.grid_power_inferred;
  return item;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function offsetDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function nearestVoltage(polledAt: number, voltageRows: JsonRecord[], window: number): JsonRecord | null {
  let best: JsonRecord | null = null;
  let bestDelta = window + 1;
  for (const row of voltageRows) {
    const delta = Math.abs(Number(row.sampled_at) - polledAt);
    if (delta <= window && delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}
