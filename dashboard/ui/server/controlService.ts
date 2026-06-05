import { DessmonitorClient } from "./dessClient";
import { TelemetryStore, type ControlValueRecord } from "./store";
import {
  A6_FIELD_ID,
  A6_TOLERANCE_SINGLE_V,
  AUTOMATION_DAILY_WRITE_CAP,
  AUTOMATION_HARD_DAILY_WRITE_CAP,
  AUTOMATION_MIN_WRITE_INTERVAL_SECONDS,
  CONTROL_FIELDS,
  controlField,
  type ControlField,
} from "./controlCatalog";
import type { DeviceSettings, JsonRecord } from "./types";

const CONTROL_STALE_SECONDS = 5 * 60;
const VOLTAGE_ORDER_FIELDS = [
  "bat_low_voltage_protection_value",
  "bat_low_voltage_recovery_value",
  A6_FIELD_ID,
  "bat_mains_power_supply_value",
] as const;

interface ControlResponse extends JsonRecord {
  id: string;
  label: string;
  group: string;
  unit: string;
  scale: number;
  writable: boolean;
  type: string;
  raw_value: string | null;
  pack_value: number | null;
  read_at: number | null;
  stale_after: number;
  stale: boolean;
}

export interface GuardedWriteResult extends JsonRecord {
  field_id: string;
  status: "skipped" | "written" | "failed";
  reason: string;
  before: string | null;
  requested: string;
  verified: string | null;
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function dateKeyJakarta(ms = Date.now()): string {
  return new Date(ms).toLocaleDateString("sv", { timeZone: "Asia/Jakarta" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRaw(value: unknown): string {
  if (typeof value === "number") return Number(value.toFixed(3)).toString();
  return String(value ?? "").trim();
}

function numeric(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function sameValue(spec: ControlField, a: string | null, b: string): boolean {
  if (a == null) return false;
  if (spec.type === "number") {
    const an = numeric(a);
    const bn = numeric(b);
    if (an == null || bn == null) return a === b;
    const tolerance = spec.id === A6_FIELD_ID ? A6_TOLERANCE_SINGLE_V : 0.0001;
    return Math.abs(an - bn) <= tolerance;
  }
  return a === b;
}

export class ControlService {
  constructor(
    private readonly client: DessmonitorClient,
    private readonly controlStore: TelemetryStore,
    private readonly readStore: TelemetryStore,
    private readonly settings: Required<DeviceSettings>,
  ) {}

  listControls(): ControlResponse[] {
    const cached = new Map(
      this.controlStore.controlValues(this.settings.sn).map((entry) => [entry.field_id, entry]),
    );
    return CONTROL_FIELDS.map((field) => this.toControlResponse(field, cached.get(field.id) ?? null));
  }

  async readControl(fieldId: string, actor = "user", reason = "Refresh control value") {
    const spec = this.requireField(fieldId);
    const payload = await this.client.queryDeviceCtrlValue({ ...this.settings, fieldId });
    const dat = (payload.dat ?? {}) as JsonRecord;
    const raw = dat.val == null || String(dat.val).trim() === "--" ? null : String(dat.val).trim();
    const record = this.controlStore.upsertControlValue({
      deviceSn: this.settings.sn,
      fieldId,
      label: String(dat.name ?? spec.label),
      unit: spec.unit,
      scale: spec.scale,
      rawValue: raw,
      source: "device",
    });
    this.controlStore.addControlEvent({
      deviceSn: this.settings.sn,
      fieldId,
      action: "read",
      actor,
      status: "success",
      reason,
      valueAfter: raw,
      details: this.latestTelemetryDetails(),
    });
    return this.toControlResponse(spec, record);
  }

  async readAllControls(actor = "user", reason = "Refresh all control values") {
    const controls = [];
    const errors = [];
    for (const field of CONTROL_FIELDS) {
      try {
        controls.push(await this.readControl(field.id, actor, reason));
      } catch (exc) {
        errors.push({ id: field.id, error: String(exc instanceof Error ? exc.message : exc) });
        this.controlStore.addControlEvent({
          deviceSn: this.settings.sn,
          fieldId: field.id,
          action: "read",
          actor,
          status: "failed",
          reason,
          details: { error: String(exc instanceof Error ? exc.message : exc) },
        });
      }
    }
    return { controls, errors };
  }

  async guardedWrite(
    fieldId: string,
    requestedValue: unknown,
    reason: string,
    actor: "manual" | "automation" | "test" = "manual",
  ): Promise<GuardedWriteResult> {
    const spec = this.requireField(fieldId);
    const value = this.normalizeValue(spec, requestedValue);
    this.validateWritable(spec, value);

    const current = await this.readControl(fieldId, actor, "Read before guarded write");
    const before = current.raw_value;
    if (sameValue(spec, before, value)) {
      this.controlStore.addControlEvent({
        deviceSn: this.settings.sn,
        fieldId,
        action: "skip",
        actor,
        status: "skipped",
        reason: `Already at requested value. ${reason}`,
        valueBefore: before,
        valueAfter: value,
        details: this.latestTelemetryDetails(),
      });
      return { field_id: fieldId, status: "skipped", reason: "already_at_value", before, requested: value, verified: before };
    }

    if (actor === "automation") this.enforceAutomationBudget(fieldId);
    await this.validateVoltageOrdering(spec, value, actor);

    const payload = await this.client.ctrlDevice({ ...this.settings, fieldId, value });
    this.controlStore.addControlEvent({
      deviceSn: this.settings.sn,
      fieldId,
      action: "write",
      actor,
      status: "sent",
      reason,
      valueBefore: before,
      valueAfter: value,
      details: { response: payload, ...this.latestTelemetryDetails() },
    });
    if (actor === "automation") {
      this.controlStore.incrementWriteBudget(this.settings.sn, fieldId, dateKeyJakarta(), actor);
    }

    await sleep(1500);
    const verified = await this.readControl(fieldId, actor, "Verify after write");
    const verifiedRaw = verified.raw_value;
    const verifiedOk = sameValue(spec, verifiedRaw, value);
    this.controlStore.addControlEvent({
      deviceSn: this.settings.sn,
      fieldId,
      action: "verify",
      actor,
      status: verifiedOk ? "success" : "failed",
      reason: verifiedOk ? "Device read-back matched requested value" : "Device read-back did not match requested value",
      valueBefore: value,
      valueAfter: verifiedRaw,
      details: this.latestTelemetryDetails(),
    });

    return {
      field_id: fieldId,
      status: verifiedOk ? "written" : "failed",
      reason: verifiedOk ? "verified" : "verification_failed",
      before,
      requested: value,
      verified: verifiedRaw,
    };
  }

  async runA6WriteRestoreTest(): Promise<JsonRecord> {
    const original = await this.readControl(A6_FIELD_ID, "test", "Read original A6 before write-restore test");
    const originalValue = numeric(original.raw_value);
    if (originalValue == null) throw new Error("A6 is not numeric; cannot run write-restore test");
    const testValue = Number((originalValue + 0.1).toFixed(1));
    const write = await this.guardedWrite(
      A6_FIELD_ID,
      testValue,
      "Live API test: increase A6 by 0.1V and verify",
      "test",
    );
    const restore = await this.guardedWrite(
      A6_FIELD_ID,
      originalValue,
      "Live API test: restore A6 to original value",
      "test",
    );
    return { original: original.raw_value, test_value: String(testValue), write, restore };
  }

  private toControlResponse(spec: ControlField, record: ControlValueRecord | null): ControlResponse {
    const readAt = record?.read_at == null ? null : Number(record.read_at);
    const age = readAt == null ? Infinity : nowSeconds() - readAt;
    return {
      ...spec,
      raw_value: record?.raw_value ?? null,
      pack_value: record?.pack_value == null ? null : Number(record.pack_value),
      read_at: readAt,
      stale_after: CONTROL_STALE_SECONDS,
      stale: age > CONTROL_STALE_SECONDS,
    };
  }

  private requireField(fieldId: string): ControlField {
    const spec = controlField(fieldId);
    if (!spec) throw new Error(`Unknown control field: ${fieldId}`);
    return spec;
  }

  private normalizeValue(spec: ControlField, requestedValue: unknown): string {
    const raw = asRaw(requestedValue);
    if (!raw) throw new Error("Control value is required");
    if (spec.type === "number") {
      const n = numeric(raw);
      if (n == null) throw new Error(`${spec.label} requires a numeric value`);
      if (spec.min != null && n < spec.min) throw new Error(`${spec.label} must be >= ${spec.min}`);
      if (spec.max != null && n > spec.max) throw new Error(`${spec.label} must be <= ${spec.max}`);
      return Number(n.toFixed(3)).toString();
    }
    if (spec.type === "enum" && spec.options?.length) {
      if (!spec.options.some((option) => option.value === raw)) {
        throw new Error(`${spec.label} does not allow value ${raw}`);
      }
    }
    return raw;
  }

  private validateWritable(spec: ControlField, value: string): void {
    if (!spec.writable) throw new Error(`${spec.label} is read-only in this dashboard`);
    if (spec.id === A6_FIELD_ID) {
      const n = numeric(value);
      if (n == null) throw new Error("A6 requires a numeric value");
    }
  }

  private enforceAutomationBudget(fieldId: string): void {
    const budget = this.controlStore.writeBudget(this.settings.sn, fieldId, dateKeyJakarta(), "automation");
    const count = Number(budget.count ?? 0);
    const lastWriteAt = budget.last_write_at == null ? null : Number(budget.last_write_at);
    if (count >= AUTOMATION_HARD_DAILY_WRITE_CAP) {
      throw new Error(`Automation hard write cap reached (${AUTOMATION_HARD_DAILY_WRITE_CAP}/day)`);
    }
    if (count >= AUTOMATION_DAILY_WRITE_CAP) {
      throw new Error(`Automation daily write cap reached (${AUTOMATION_DAILY_WRITE_CAP}/day)`);
    }
    if (lastWriteAt != null && nowSeconds() - lastWriteAt < AUTOMATION_MIN_WRITE_INTERVAL_SECONDS) {
      const remaining = Math.ceil((AUTOMATION_MIN_WRITE_INTERVAL_SECONDS - (nowSeconds() - lastWriteAt)) / 60);
      throw new Error(`Automation cooldown active for ${remaining} more minute(s)`);
    }
  }

  private async validateVoltageOrdering(
    spec: ControlField,
    requestedValue: string,
    actor: string,
  ): Promise<void> {
    if (!VOLTAGE_ORDER_FIELDS.includes(spec.id as (typeof VOLTAGE_ORDER_FIELDS)[number])) return;
    const values = new Map<string, number>();
    for (const fieldId of VOLTAGE_ORDER_FIELDS) {
      const response =
        fieldId === spec.id
          ? { raw_value: requestedValue }
          : await this.readControl(fieldId, actor, "Read voltage threshold for ordering validation");
      const n = numeric(response.raw_value);
      if (n != null) values.set(fieldId, n);
    }
    const a4 = values.get("bat_low_voltage_protection_value");
    const a5 = values.get("bat_low_voltage_recovery_value");
    const a6 = values.get(A6_FIELD_ID);
    const a7 = values.get("bat_mains_power_supply_value");
    if (a4 == null || a5 == null || a6 == null || a7 == null) {
      throw new Error("Cannot validate voltage ordering because one A4/A5/A6/A7 value is missing");
    }
    if (!(a6 > a7 && a7 > a4)) throw new Error("Voltage ordering must satisfy A6 > A7 > A4");
    if (!(a6 > a5 && a5 > a4)) throw new Error("Voltage ordering must satisfy A6 > A5 > A4");
  }

  private latestTelemetryDetails(): JsonRecord {
    const latest = this.readStore.latestReadings(this.settings.sn);
    return {
      telemetry: latest
        ? {
            polled_at: latest.polled_at,
            battery_voltage: latest.battery_voltage,
            battery_soc: latest.battery_soc,
            working_state: latest.working_state,
            pv_power: latest.pv_power,
            load_power: latest.load_power,
            grid_power: latest.grid_power,
          }
        : null,
    };
  }
}

