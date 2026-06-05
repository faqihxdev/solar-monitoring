import { practicalSocPct, voltageForPracticalSoc } from "./batteryMath";
import { ControlService } from "./controlService";
import { TelemetryStore, type AutomationStateRecord } from "./store";
import {
  A6_FIELD_ID,
  A6_MAX_SINGLE_V,
  A6_MIN_SINGLE_V,
  BASELINE_A6_SINGLE_V,
} from "./controlCatalog";
import type { JsonRecord } from "./types";

const DEFAULT_TARGET_SOC = 90;
const DEFAULT_TARGET_TIME = "17:15";
const DEFAULT_CHECK_INTERVAL_SECONDS = 15 * 60;
const TARGET_MARGIN_PCT = 2;
const BEHIND_MARGIN_PCT = 3;

export interface AutomationStatus extends JsonRecord {
  enabled: boolean;
  state: AutomationStateRecord;
  decision: string;
  reason: string;
  target_voltage: number | null;
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

function todayJakartaDateKey(ms = Date.now()): string {
  return new Date(ms).toLocaleDateString("sv", { timeZone: "Asia/Jakarta" });
}

function jakartaTimestampForTime(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  const date = todayJakartaDateKey();
  return Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+07:00`) / 1000;
}

function defaultState(deviceSn: string): AutomationStateRecord {
  return {
    device_sn: deviceSn,
    enabled: 0,
    target_practical_soc: DEFAULT_TARGET_SOC,
    target_time: DEFAULT_TARGET_TIME,
    baseline_a6: BASELINE_A6_SINGLE_V,
    active_override: 0,
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
    const next: Omit<AutomationStateRecord, "device_sn" | "updated_at"> = {
      enabled,
      target_practical_soc: targetSoc,
      target_time: /^\d{2}:\d{2}$/.test(targetTime) ? targetTime : DEFAULT_TARGET_TIME,
      baseline_a6: round1(baselineA6),
      active_override: current.active_override,
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
    const desiredNow = this.desiredPracticalSocNow(state);
    return {
      enabled: Boolean(state.enabled),
      state,
      decision: state.last_decision ?? "unknown",
      reason: state.last_reason ?? "",
      target_voltage: targetVoltage,
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
    const desiredNow = this.desiredPracticalSocNow(state);
    const nextCheckAt = nowSeconds() + DEFAULT_CHECK_INTERVAL_SECONDS;

    if (!state.enabled) {
      if (state.active_override) {
        return this.restoreBaseline(state, "Automation disabled; restoring baseline A6 once");
      }
      return this.recordDecision(state, "disabled", "Automation is disabled", nextCheckAt, {
        latest,
        practical_soc: practicalSoc,
        target_voltage: targetVoltage,
        desired_practical_soc_now: desiredNow,
      });
    }

    if (voltage == null || practicalSoc == null || targetVoltage == null || desiredNow == null) {
      return this.recordDecision(
        state,
        "waiting for fresher telemetry/control read",
        "Battery voltage or target voltage is unavailable",
        nextCheckAt,
        { latest, practical_soc: practicalSoc, target_voltage: targetVoltage },
      );
    }

    const targetAt = jakartaTimestampForTime(state.target_time);
    const targetReached = practicalSoc >= state.target_practical_soc - TARGET_MARGIN_PCT;
    const targetTimePassed = nowSeconds() >= targetAt;
    if (targetReached || targetTimePassed) {
      if (state.active_override) {
        return this.restoreBaseline(
          state,
          targetReached ? "Target practical SOC reached; restoring baseline A6" : "Target time passed; restoring baseline A6",
        );
      }
      return this.recordDecision(
        state,
        "target reached, baseline active",
        targetReached ? "Target practical SOC is already satisfied" : "Target time has passed and no override is active",
        nextCheckAt,
        { latest, practical_soc: practicalSoc, target_voltage: targetVoltage },
      );
    }

    const behind = practicalSoc < desiredNow - BEHIND_MARGIN_PCT;
    if (!behind) {
      return this.recordDecision(
        state,
        "tracking target",
        `Practical SOC ${Math.round(practicalSoc)}% is on track for ${state.target_time}`,
        nextCheckAt,
        { latest, practical_soc: practicalSoc, target_voltage: targetVoltage, desired_practical_soc_now: desiredNow },
      );
    }

    const requestedA6 = round1(clamp(targetVoltage / 2, A6_MIN_SINGLE_V, A6_MAX_SINGLE_V));
    try {
      const result = await this.controlService.guardedWrite(
        A6_FIELD_ID,
        requestedA6,
        `${reason}: behind target, preserving battery until practical SOC reaches ${state.target_practical_soc}%`,
        "automation",
      );
      const nextState = this.controlStore.saveAutomationState(this.deviceSn, {
        enabled: state.enabled,
        target_practical_soc: state.target_practical_soc,
        target_time: state.target_time,
        baseline_a6: state.baseline_a6,
        active_override: result.status === "written" || result.status === "skipped" ? 1 : state.active_override,
        override_value: requestedA6,
        next_check_at: nextCheckAt,
        last_decision: "behind target, preserving battery",
        last_reason: `Requested A6 ${requestedA6.toFixed(1)}V because practical SOC is ${Math.round(practicalSoc)}% and target path expects ${Math.round(desiredNow)}%`,
      });
      return this.statusFromState(nextState, latest, practicalSoc, targetVoltage, desiredNow);
    } catch (exc) {
      return this.recordDecision(
        state,
        "cooldown/write budget exhausted",
        String(exc instanceof Error ? exc.message : exc),
        nextCheckAt,
        { latest, practical_soc: practicalSoc, target_voltage: targetVoltage, desired_practical_soc_now: desiredNow },
        "failed",
      );
    }
  }

  private async restoreBaseline(state: AutomationStateRecord, reason: string): Promise<AutomationStatus> {
    const latest = this.readStore.latestReadings(this.deviceSn);
    const practicalSoc = practicalSocPct(Number(latest?.battery_voltage ?? NaN));
    const targetVoltage = voltageForPracticalSoc(state.target_practical_soc);
    const desiredNow = this.desiredPracticalSocNow(state);
    const nextCheckAt = nowSeconds() + DEFAULT_CHECK_INTERVAL_SECONDS;
    try {
      await this.controlService.guardedWrite(A6_FIELD_ID, state.baseline_a6, reason, "automation");
      const nextState = this.controlStore.saveAutomationState(this.deviceSn, {
        enabled: state.enabled,
        target_practical_soc: state.target_practical_soc,
        target_time: state.target_time,
        baseline_a6: state.baseline_a6,
        active_override: 0,
        override_value: null,
        next_check_at: nextCheckAt,
        last_decision: "target reached, restoring baseline",
        last_reason: reason,
      });
      return this.statusFromState(nextState, latest, practicalSoc, targetVoltage, desiredNow);
    } catch (exc) {
      return this.recordDecision(
        state,
        "cooldown/write budget exhausted",
        `Could not restore baseline A6: ${String(exc instanceof Error ? exc.message : exc)}`,
        nextCheckAt,
        { latest, practical_soc: practicalSoc, target_voltage: targetVoltage },
        "failed",
      );
    }
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
      active_override: state.active_override,
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
    return this.statusFromState(
      nextState,
      details.latest as JsonRecord | null,
      details.practical_soc as number | null,
      details.target_voltage as number | null,
      details.desired_practical_soc_now as number | null,
    );
  }

  private statusFromState(
    state: AutomationStateRecord,
    latest: JsonRecord | null,
    practicalSoc: number | null,
    targetVoltage: number | null,
    desiredNow: number | null,
  ): AutomationStatus {
    return {
      enabled: Boolean(state.enabled),
      state,
      decision: state.last_decision ?? "unknown",
      reason: state.last_reason ?? "",
      target_voltage: targetVoltage,
      desired_practical_soc_now: desiredNow,
      latest,
      practical_soc: practicalSoc,
      next_check_at: state.next_check_at,
    };
  }

  private desiredPracticalSocNow(state: AutomationStateRecord): number | null {
    const targetAt = jakartaTimestampForTime(state.target_time);
    const hoursToTarget = (targetAt - nowSeconds()) / 3600;
    if (hoursToTarget <= 0) return state.target_practical_soc;
    return clamp(state.target_practical_soc - hoursToTarget * 8, 25, state.target_practical_soc);
  }
}

