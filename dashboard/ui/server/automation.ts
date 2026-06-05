import { practicalSocPct, voltageForPracticalSoc } from "./batteryMath";
import { ControlService } from "./controlService";
import { TelemetryStore, type AutomationStateRecord } from "./store";
import {
  A6_FIELD_ID,
  A6_MAX_SINGLE_V,
  A6_MIN_SINGLE_V,
  A7_FIELD_ID,
  A7_MAX_SINGLE_V,
  A7_MIN_SINGLE_V,
  BASELINE_A6_SINGLE_V,
  BASELINE_A7_SINGLE_V,
} from "./controlCatalog";
import type { JsonRecord } from "./types";

const DEFAULT_TARGET_SOC = 90;
const DEFAULT_TARGET_TIME = "17:15";
const DEFAULT_CHECK_INTERVAL_SECONDS = 15 * 60;
const TARGET_MARGIN_PCT = 2;
const BEHIND_MARGIN_PCT = 3;
const TARGET_BASE_SOC = 25;
const SOLAR_START_TIME = "06:30";
const SOLAR_CURVE_POWER = 1.6;
const SOLAR_CURVE_STEPS = 96;
const BAND_HYSTERESIS_SINGLE_V = 0.1;

interface ProtectionBand {
  a6: number;
  a7: number;
  capped: boolean;
}

export interface AutomationStatus extends JsonRecord {
  enabled: boolean;
  state: AutomationStateRecord;
  decision: string;
  reason: string;
  target_voltage: number | null;
  target_a6: number | null;
  target_a7: number | null;
  target_band_capped: boolean;
  desired_practical_soc_now: number | null;
  latest: JsonRecord | null;
  practical_soc: number | null;
  next_check_at: number | null;
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function ceil1(value: number): number {
  return Math.ceil((value - 1e-9) * 10) / 10;
}

function numeric(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function targetProtectionBand(targetVoltage: number | null): ProtectionBand | null {
  if (targetVoltage == null) return null;
  const rawA7 = targetVoltage / 2;
  const maxA7 = Math.min(A7_MAX_SINGLE_V, A6_MAX_SINGLE_V - BAND_HYSTERESIS_SINGLE_V);
  let a7 = ceil1(clamp(rawA7, A7_MIN_SINGLE_V, maxA7));
  let a6 = round1(clamp(a7 + BAND_HYSTERESIS_SINGLE_V, A6_MIN_SINGLE_V, A6_MAX_SINGLE_V));
  if (a6 <= a7) a7 = round1(a6 - BAND_HYSTERESIS_SINGLE_V);
  return {
    a6,
    a7,
    capped: rawA7 < A7_MIN_SINGLE_V || rawA7 > maxA7,
  };
}

function todayJakartaDateKey(ms = Date.now()): string {
  return new Date(ms).toLocaleDateString("sv", { timeZone: "Asia/Jakarta" });
}

function jakartaTimestampForTime(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  const date = todayJakartaDateKey();
  return Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+07:00`) / 1000;
}

function solarOpportunityWeight(t: number, start: number, end: number): number {
  if (end <= start || t <= start || t >= end) return 0;
  const x = (t - start) / (end - start);
  return Math.pow(Math.sin(Math.PI * x), SOLAR_CURVE_POWER);
}

function solarOpportunityFraction(now: number, start: number, end: number): number {
  if (end <= start) return now >= end ? 1 : 0;
  if (now <= start) return 0;
  if (now >= end) return 1;

  const integrateTo = (until: number) => {
    const span = until - start;
    const step = span / SOLAR_CURVE_STEPS;
    let area = 0;
    for (let i = 0; i < SOLAR_CURVE_STEPS; i += 1) {
      const a = start + i * step;
      const b = a + step;
      area += ((solarOpportunityWeight(a, start, end) + solarOpportunityWeight(b, start, end)) / 2) * step;
    }
    return area;
  };

  const total = integrateTo(end);
  if (total <= 0) return 1;
  return clamp(integrateTo(now) / total, 0, 1);
}

function defaultState(deviceSn: string): AutomationStateRecord {
  return {
    device_sn: deviceSn,
    enabled: 0,
    target_practical_soc: DEFAULT_TARGET_SOC,
    target_time: DEFAULT_TARGET_TIME,
    baseline_a6: BASELINE_A6_SINGLE_V,
    baseline_a7: BASELINE_A7_SINGLE_V,
    active_override: 0,
    override_a6: null,
    override_a7: null,
    override_value: null,
    next_check_at: null,
    last_decision: "disabled",
    last_reason: "Automation is disabled",
    updated_at: nowSeconds(),
  };
}

export class AutomationEngine {
  constructor(
    private readonly readStore: TelemetryStore,
    private readonly controlStore: TelemetryStore,
    private readonly controlService: ControlService,
    private readonly deviceSn: string,
  ) {}

  getState(): AutomationStateRecord {
    return this.controlStore.automationState(this.deviceSn) ?? defaultState(this.deviceSn);
  }

  updateState(patch: JsonRecord): AutomationStateRecord {
    const current = this.getState();
    const enabled = patch.enabled == null ? current.enabled : patch.enabled ? 1 : 0;
    const targetSoc = clamp(
      Number(patch.target_practical_soc ?? current.target_practical_soc),
      0,
      100,
    );
    const targetTime = String(patch.target_time ?? current.target_time);
    const baselineA6 = clamp(
      Number(patch.baseline_a6 ?? current.baseline_a6),
      A6_MIN_SINGLE_V,
      A6_MAX_SINGLE_V,
    );
    const baselineA7 = clamp(
      Number(patch.baseline_a7 ?? current.baseline_a7),
      A7_MIN_SINGLE_V,
      A7_MAX_SINGLE_V,
    );
    const next: Omit<AutomationStateRecord, "device_sn" | "updated_at"> = {
      enabled,
      target_practical_soc: targetSoc,
      target_time: /^\d{2}:\d{2}$/.test(targetTime) ? targetTime : DEFAULT_TARGET_TIME,
      baseline_a6: round1(baselineA6),
      baseline_a7: round1(Math.min(baselineA7, baselineA6 - BAND_HYSTERESIS_SINGLE_V)),
      active_override: current.active_override,
      override_a6: current.override_a6,
      override_a7: current.override_a7,
      override_value: current.override_value,
      next_check_at: current.next_check_at,
      last_decision: enabled ? "tracking target" : "disabled",
      last_reason: enabled ? "Automation settings updated" : "Automation disabled by user",
    };
    const saved = this.controlStore.saveAutomationState(this.deviceSn, next);
    this.controlStore.addControlEvent({
      deviceSn: this.deviceSn,
      fieldId: A6_FIELD_ID,
      action: "automation_config",
      actor: "manual",
      status: "success",
      reason: String(next.last_reason),
      details: { state: saved },
    });
    return saved;
  }

  status(): AutomationStatus {
    const state = this.getState();
    const latest = this.readStore.latestReadings(this.deviceSn);
    const practicalSoc = practicalSocPct(Number(latest?.battery_voltage ?? NaN));
    const targetVoltage = voltageForPracticalSoc(state.target_practical_soc);
    const band = targetProtectionBand(targetVoltage);
    const desiredNow = this.desiredPracticalSocNow(state);
    return {
      enabled: Boolean(state.enabled),
      state,
      decision: state.last_decision ?? "unknown",
      reason: state.last_reason ?? "",
      target_voltage: targetVoltage,
      target_a6: band?.a6 ?? null,
      target_a7: band?.a7 ?? null,
      target_band_capped: Boolean(band?.capped),
      desired_practical_soc_now: desiredNow,
      latest,
      practical_soc: practicalSoc,
      next_check_at: state.next_check_at,
    };
  }

  async evaluate(reason = "Scheduled automation check"): Promise<AutomationStatus> {
    const state = this.getState();
    const latest = this.readStore.latestReadings(this.deviceSn);
    const voltage = latest?.battery_voltage == null ? null : Number(latest.battery_voltage);
    const practicalSoc = practicalSocPct(voltage);
    const targetVoltage = voltageForPracticalSoc(state.target_practical_soc);
    const targetBand = targetProtectionBand(targetVoltage);
    const desiredNow = this.desiredPracticalSocNow(state);
    const nextCheckAt = nowSeconds() + DEFAULT_CHECK_INTERVAL_SECONDS;

    if (!state.enabled) {
      if (state.active_override) {
        return this.restoreBaseline(state, "Automation disabled; restoring baseline A6/A7 once");
      }
      return this.recordDecision(state, "disabled", "Automation is disabled", nextCheckAt, {
        latest,
        practical_soc: practicalSoc,
        target_voltage: targetVoltage,
        target_a6: targetBand?.a6 ?? null,
        target_a7: targetBand?.a7 ?? null,
        target_band_capped: Boolean(targetBand?.capped),
        desired_practical_soc_now: desiredNow,
      });
    }

    if (voltage == null || practicalSoc == null || targetVoltage == null || targetBand == null || desiredNow == null) {
      return this.recordDecision(
        state,
        "waiting for fresher telemetry/control read",
        "Battery voltage or target voltage is unavailable",
        nextCheckAt,
        {
          latest,
          practical_soc: practicalSoc,
          target_voltage: targetVoltage,
          target_a6: targetBand?.a6 ?? null,
          target_a7: targetBand?.a7 ?? null,
          target_band_capped: Boolean(targetBand?.capped),
        },
      );
    }

    const targetAt = jakartaTimestampForTime(state.target_time);
    const targetReached = practicalSoc >= state.target_practical_soc - TARGET_MARGIN_PCT;
    const targetTimePassed = nowSeconds() >= targetAt;
    if (targetTimePassed) {
      if (state.active_override) {
        return this.restoreBaseline(state, "Target time passed; restoring baseline A6/A7");
      }
      return this.recordDecision(
        state,
        "target time passed, baseline active",
        "Target time has passed and no override is active",
        nextCheckAt,
        {
          latest,
          practical_soc: practicalSoc,
          target_voltage: targetVoltage,
          target_a6: targetBand.a6,
          target_a7: targetBand.a7,
          target_band_capped: targetBand.capped,
        },
      );
    }

    if (targetReached) {
      return this.applyProtectionBand(
        state,
        targetBand,
        "target reached, holding protection band",
        `${reason}: target practical SOC is satisfied; holding A6/A7 band until ${state.target_time}`,
        nextCheckAt,
        latest,
        practicalSoc,
        targetVoltage,
        desiredNow,
      );
    }

    const behind = practicalSoc < desiredNow - BEHIND_MARGIN_PCT;
    if (!behind) {
      if (state.active_override) {
        return this.applyProtectionBand(
          state,
          targetBand,
          "tracking target, holding protection band",
          `${reason}: practical SOC is on track; keeping A6/A7 band active until ${state.target_time}`,
          nextCheckAt,
          latest,
          practicalSoc,
          targetVoltage,
          desiredNow,
        );
      }
      return this.recordDecision(
        state,
        "tracking target",
        `Practical SOC ${Math.round(practicalSoc)}% is on track for ${state.target_time}`,
        nextCheckAt,
        {
          latest,
          practical_soc: practicalSoc,
          target_voltage: targetVoltage,
          target_a6: targetBand.a6,
          target_a7: targetBand.a7,
          target_band_capped: targetBand.capped,
          desired_practical_soc_now: desiredNow,
        },
      );
    }

    return this.applyProtectionBand(
      state,
      targetBand,
      "behind target, preserving battery",
      `${reason}: behind target, preserving battery with A6/A7 band until practical SOC reaches ${state.target_practical_soc}%`,
      nextCheckAt,
      latest,
      practicalSoc,
      targetVoltage,
      desiredNow,
    );
  }

  private async restoreBaseline(state: AutomationStateRecord, reason: string): Promise<AutomationStatus> {
    const latest = this.readStore.latestReadings(this.deviceSn);
    const practicalSoc = practicalSocPct(Number(latest?.battery_voltage ?? NaN));
    const targetVoltage = voltageForPracticalSoc(state.target_practical_soc);
    const targetBand = targetProtectionBand(targetVoltage);
    const desiredNow = this.desiredPracticalSocNow(state);
    const nextCheckAt = nowSeconds() + DEFAULT_CHECK_INTERVAL_SECONDS;
    const baselineBand = { a6: state.baseline_a6, a7: state.baseline_a7, capped: false };
    try {
      await this.writeBand(state, baselineBand, reason);
      const nextState = this.controlStore.saveAutomationState(this.deviceSn, {
        enabled: state.enabled,
        target_practical_soc: state.target_practical_soc,
        target_time: state.target_time,
        baseline_a6: state.baseline_a6,
        baseline_a7: state.baseline_a7,
        active_override: 0,
        override_a6: null,
        override_a7: null,
        override_value: null,
        next_check_at: nextCheckAt,
        last_decision: "target reached, restoring baseline",
        last_reason: reason,
      });
      return this.statusFromState(nextState, latest, practicalSoc, targetVoltage, desiredNow, targetBand);
    } catch (exc) {
      return this.recordDecision(
        state,
        "cooldown/write budget exhausted",
        `Could not restore baseline A6/A7: ${String(exc instanceof Error ? exc.message : exc)}`,
        nextCheckAt,
        {
          latest,
          practical_soc: practicalSoc,
          target_voltage: targetVoltage,
          target_a6: targetBand?.a6 ?? null,
          target_a7: targetBand?.a7 ?? null,
          target_band_capped: Boolean(targetBand?.capped),
        },
        "failed",
      );
    }
  }

  private async applyProtectionBand(
    state: AutomationStateRecord,
    band: ProtectionBand,
    decision: string,
    reason: string,
    nextCheckAt: number,
    latest: JsonRecord | null,
    practicalSoc: number,
    targetVoltage: number,
    desiredNow: number,
  ): Promise<AutomationStatus> {
    try {
      const results = await this.writeBand(state, band, reason);
      const failed = results.find((result) => result.status === "failed");
      if (failed) throw new Error(`${failed.field_id} verification failed`);
      const capText = band.capped ? " capped by inverter voltage limits" : "";
      const nextState = this.controlStore.saveAutomationState(this.deviceSn, {
        enabled: state.enabled,
        target_practical_soc: state.target_practical_soc,
        target_time: state.target_time,
        baseline_a6: state.baseline_a6,
        baseline_a7: state.baseline_a7,
        active_override: 1,
        override_a6: band.a6,
        override_a7: band.a7,
        override_value: band.a6,
        next_check_at: nextCheckAt,
        last_decision: decision,
        last_reason: `Requested A6 ${band.a6.toFixed(1)}V / A7 ${band.a7.toFixed(1)}V${capText}; practical SOC is ${Math.round(practicalSoc)}% and the solar-weighted target path expects ${Math.round(desiredNow)}%`,
      });
      return this.statusFromState(nextState, latest, practicalSoc, targetVoltage, desiredNow, band);
    } catch (exc) {
      return this.recordDecision(
        state,
        "cooldown/write budget exhausted",
        String(exc instanceof Error ? exc.message : exc),
        nextCheckAt,
        {
          latest,
          practical_soc: practicalSoc,
          target_voltage: targetVoltage,
          target_a6: band.a6,
          target_a7: band.a7,
          target_band_capped: band.capped,
          desired_practical_soc_now: desiredNow,
        },
        "failed",
      );
    }
  }

  private async writeBand(state: AutomationStateRecord, band: ProtectionBand, reason: string) {
    const current = this.currentBand(state);
    const canWriteA6First = band.a6 > current.a7;
    const canWriteA7First = current.a6 > band.a7;
    if (!canWriteA6First && !canWriteA7First) {
      throw new Error("Cannot safely transition A6/A7 band while preserving A6 > A7");
    }
    const order = canWriteA6First && band.a7 >= current.a7 ? [A6_FIELD_ID, A7_FIELD_ID] : [A7_FIELD_ID, A6_FIELD_ID];
    const results = [];
    for (const fieldId of order) {
      results.push(
        await this.controlService.guardedWrite(
          fieldId,
          fieldId === A6_FIELD_ID ? band.a6 : band.a7,
          reason,
          "automation",
        ),
      );
    }
    return results;
  }

  private currentBand(state: AutomationStateRecord): { a6: number; a7: number } {
    const cachedA6 = numeric(this.controlStore.controlValue(this.deviceSn, A6_FIELD_ID)?.raw_value);
    const cachedA7 = numeric(this.controlStore.controlValue(this.deviceSn, A7_FIELD_ID)?.raw_value);
    if (cachedA6 != null && cachedA7 != null) return { a6: cachedA6, a7: cachedA7 };
    if (!state.active_override) return { a6: state.baseline_a6, a7: state.baseline_a7 };
    return {
      a6: state.override_a6 ?? state.override_value ?? state.baseline_a6,
      a7: state.override_a7 ?? state.baseline_a7,
    };
  }

  private recordDecision(
    state: AutomationStateRecord,
    decision: string,
    reason: string,
    nextCheckAt: number | null,
    details: JsonRecord,
    status = "skipped",
  ): AutomationStatus {
    const nextState = this.controlStore.saveAutomationState(this.deviceSn, {
      enabled: state.enabled,
      target_practical_soc: state.target_practical_soc,
      target_time: state.target_time,
      baseline_a6: state.baseline_a6,
      baseline_a7: state.baseline_a7,
      active_override: state.active_override,
      override_a6: state.override_a6,
      override_a7: state.override_a7,
      override_value: state.override_value,
      next_check_at: nextCheckAt,
      last_decision: decision,
      last_reason: reason,
    });
    this.controlStore.addControlEvent({
      deviceSn: this.deviceSn,
      fieldId: A6_FIELD_ID,
      action: "automation_decision",
      actor: "automation",
      status,
      reason,
      details,
    });
    const band =
      typeof details.target_a6 === "number" && typeof details.target_a7 === "number"
        ? { a6: details.target_a6, a7: details.target_a7, capped: Boolean(details.target_band_capped) }
        : null;
    return this.statusFromState(
      nextState,
      details.latest as JsonRecord | null,
      details.practical_soc as number | null,
      details.target_voltage as number | null,
      details.desired_practical_soc_now as number | null,
      band,
    );
  }

  private statusFromState(
    state: AutomationStateRecord,
    latest: JsonRecord | null,
    practicalSoc: number | null,
    targetVoltage: number | null,
    desiredNow: number | null,
    band: ProtectionBand | null = targetProtectionBand(targetVoltage),
  ): AutomationStatus {
    return {
      enabled: Boolean(state.enabled),
      state,
      decision: state.last_decision ?? "unknown",
      reason: state.last_reason ?? "",
      target_voltage: targetVoltage,
      target_a6: band?.a6 ?? null,
      target_a7: band?.a7 ?? null,
      target_band_capped: Boolean(band?.capped),
      desired_practical_soc_now: desiredNow,
      latest,
      practical_soc: practicalSoc,
      next_check_at: state.next_check_at,
    };
  }

  private desiredPracticalSocNow(state: AutomationStateRecord): number | null {
    if (state.target_practical_soc <= TARGET_BASE_SOC) return state.target_practical_soc;
    const startAt = jakartaTimestampForTime(SOLAR_START_TIME);
    const targetAt = jakartaTimestampForTime(state.target_time);
    const now = nowSeconds();
    if (now >= targetAt) return state.target_practical_soc;
    if (targetAt <= startAt) return TARGET_BASE_SOC;

    const progress = solarOpportunityFraction(now, startAt, targetAt);
    const desired = TARGET_BASE_SOC + (state.target_practical_soc - TARGET_BASE_SOC) * progress;
    return clamp(desired, TARGET_BASE_SOC, state.target_practical_soc);
  }
}

